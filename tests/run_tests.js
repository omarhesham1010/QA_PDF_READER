const fs = require('fs');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

const DETECT_PADDING = 20;

function detectQuestionRegions(textContent, canvasHeight, viewport) {
  const questionYPositions = [];
  for (const item of textContent.items) {
    if (!item.str) continue;
    const normalized = item.str.replace(/\u0640/g, '').replace(/\s+/g, ' ').trim();
    if (normalized.includes('السؤال')) {
      const [, , , , pdfX, pdfY] = item.transform;
      const [canvasX, canvasY] = viewport.convertToViewportPoint(pdfX, pdfY);
      questionYPositions.push({ y: canvasY, x: canvasX });
    }
  }
  if (questionYPositions.length === 0) {
    const ARABIC_LETTERS = ['\u0623', '\u0628', '\u062c', '\u062d', '\u062f', '\u0647', '\u0648']; // Added more Arabic letters for robustness
    const hasOptions = textContent.items.some(it => ARABIC_LETTERS.includes(it.str.trim()));
    if (hasOptions) {
      return [{ y1: 0, y2: canvasHeight, qIdx: 0 }];
    }
    return [];
  }
  questionYPositions.sort((a, b) => a.y - b.y);

  const regions = [];
  for (let i = 0; i < questionYPositions.length; i++) {
    const y1 = Math.max(0, questionYPositions[i].y - DETECT_PADDING);
    const y2 = i + 1 < questionYPositions.length
      ? Math.min(canvasHeight, questionYPositions[i + 1].y - DETECT_PADDING)
      : canvasHeight;
    regions.push({ y1, y2 });
  }
  return regions;
}

function fixArabicPDFText(text) {
  if (!text) return text;
  text = text.replace(/\uFFFD/g, '');
  text = text.replace(/األ/g, 'الأ').replace(/اإل/g, 'الإ').replace(/اآل/g, 'الآ')
    .replace(/اال/g, 'الا').replace(/ىل/g, 'لى').replace(/ىع/g, 'عى').replace(/ىف/g, 'فى');
  text = text.replace(/(^|\s)أك(?=\s|$)/g, '$1أكبر');
  text = text.replace(/أك$/g, 'أكبر');
  text = text.replace(/أك\s/g, 'أكبر ');
  text = text.replace(/غ\s*كافية/g, 'غير كافية');
  text = text.replace(/^[يى]\s*المعطيات/g, 'المعطيات');
  text = text.replace(/^[يى]\s*غير\s*كافية/g, 'المعطيات غير كافية');
  if (text.trim() === 'ي' || text.trim() === 'ى' || text.trim() === 'غ') text = 'المعطيات غير كافية';
  return text.trim();
}

function evaluateExtractionQuality(text, rawText) {
  if (!text.trim()) return true;
  if (rawText && rawText.includes('\uFFFD')) return true;
  const singleLetters = text.match(/(^|\s)[\u0600-\u06FF](?=\s|$)/g);
  if (singleLetters && singleLetters.length >= 3 && text.length < 15) return true;
  return false;
}

function findOptionBoundary(textContent, qY1, qY2, viewport) {
  const ARABIC_LETTERS = ['\u0623', '\u0628', '\u062c', '\u062f'];
  const items = [];
  for (const item of textContent.items) {
    if (!item.str) continue;
    const [, , , , pdfX, pdfY] = item.transform;
    const [cx, cy] = viewport.convertToViewportPoint(pdfX, pdfY);
    if (cy >= qY1 && cy <= qY2) {
      const norm = item.str.replace(/\u0640/g, '').replace(/\s+/g, ' ').trim();
      if (norm) items.push({ norm, y: cy, x: cx });
    }
  }

  // Group candidates for each letter by Y coordinate (tolerance 60px) to find the TRUE options row, avoiding watermarks
  // We use a regex that matches أ, ب, ج, د only if they are not preceded or followed by another Arabic letter
  // This matches "أ)" or "60أ" or " أ ", but perfectly ignores "أحمد"
  const optionRegex = /(?<![\u0621-\u064A])([أبجد])(?![\u0621-\u064A])/;
  const allCandidates = [];
  for (const it of items) {
    const match = it.norm.match(optionRegex);
    if (match) {
      allCandidates.push({ letter: match[1], item: it, y: it.y, x: it.x, norm: match[1] });
    }
  }

  const clusters = [];
  for (const cand of allCandidates) {
    let placed = false;
    for (const cluster of clusters) {
      if (Math.abs(cluster.y - cand.y) <= 30) {
        cluster.candidates.push(cand);
        cluster.uniqueLetters.add(cand.letter);
        cluster.y = (cluster.y * (cluster.candidates.length - 1) + cand.y) / cluster.candidates.length;
        placed = true;
        break;
      }
    }
    if (!placed) {
      clusters.push({ y: cand.y, candidates: [cand], uniqueLetters: new Set([cand.letter]) });
    }
  }

  // Merge clusters that belong to the same 2x2 grid (Y distance <= 300, no intersecting letters)
  const megaclusters = [];
  for (const c of clusters) {
    let merged = false;
    for (const mega of megaclusters) {
      if (Math.abs(mega.y - c.y) <= 300) {
        let overlap = false;
        for (const letter of c.uniqueLetters) {
          if (mega.uniqueLetters.has(letter)) { overlap = true; break; }
        }
        if (!overlap) {
          mega.candidates.push(...c.candidates);
          for (const l of c.uniqueLetters) mega.uniqueLetters.add(l);
          mega.y = (mega.y * mega.candidates.length + c.y * c.candidates.length) / (mega.candidates.length + c.candidates.length);
          merged = true;
          break;
        }
      }
    }
    if (!merged) {
      megaclusters.push({ y: c.y, candidates: [...c.candidates], uniqueLetters: new Set(c.uniqueLetters) });
    }
  }

  // The true options row is the cluster containing the most unique Arabic option letters
  // Tie wrapper: prefer the cluster that is lower on the page (larger Y)
  megaclusters.sort((a, b) => b.uniqueLetters.size - a.uniqueLetters.size || b.y - a.y);
  
  if (items.some(i => i.norm === '7')) {
    console.log("PAGE 8 CLUSTERS:", JSON.stringify(clusters, (k,v) => (k==='uniqueLetters' ? [...v] : v), 2));
  }
  
  const bestCluster = megaclusters[0];

  const labelItems = {};
  if (bestCluster) {
    const ARABIC_LETTERS = ['أ', 'ب', 'ج', 'د'];
    for (const letter of ARABIC_LETTERS) {
      const cands = bestCluster.candidates.filter(c => c.letter === letter).sort((a, b) => a.x - b.x);
      if (cands.length > 0) {
        labelItems[letter] = cands[cands.length - 1].item; // أقصى اليمين
      }
    }
  }

  if (Object.keys(labelItems).length === 0) {
    return { options: ['', '', '', ''], requiresOcr: true };
  }

  const presentLabels = ARABIC_LETTERS.map(l => ({ letter: l, item: labelItems[l] })).filter(x => x.item);
  const rows = [];
  presentLabels.sort((a, b) => a.item.y - b.item.y);
  for (const pl of presentLabels) {
    let placed = false;
    for (const row of rows) {
      if (Math.abs(row.y - pl.item.y) <= 15) {
        row.labels.push(pl);
        row.y = (row.y * (row.labels.length - 1) + pl.item.y) / row.labels.length;
        placed = true;
        break;
      }
    }
    if (!placed) rows.push({ y: pl.item.y, labels: [pl] });
  }

  rows.sort((a, b) => a.y - b.y);
  rows.forEach(row => row.labels.sort((a, b) => b.item.x - a.item.x));

  const boundaries = {};
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const nextRow = rows[r + 1];
    for (let i = 0; i < row.labels.length; i++) {
      const pl = row.labels[i];
      const nextPl = row.labels[i + 1];
      boundaries[pl.letter] = {
        yMin: row.y - 20,
        yMax: nextRow ? nextRow.y - 10 : row.y + 40,
        xMax: pl.item.x + 30,
        xMin: nextPl ? nextPl.item.x + 20 : -Infinity
      };
    }
  }

  const optionMap = {};
  let requiresOcr = false;

  for (const letter of ARABIC_LETTERS) {
    const bounds = boundaries[letter];
    if (!bounds) {
      optionMap[letter] = '';
      requiresOcr = true;
      continue;
    }

    const regionItems = items.filter(c =>
      c !== labelItems[letter] &&
      !ARABIC_LETTERS.includes(c.norm) &&
      c.y >= bounds.yMin && c.y < bounds.yMax &&
      c.x <= bounds.xMax && c.x > bounds.xMin
    );

    if (regionItems.length > 0) {
      regionItems.sort((a, b) => {
        if (Math.abs(a.y - b.y) > 10) return a.y - b.y;
        return b.x - a.x;
      });
      const rawText = regionItems.map(c => c.norm).join(' ').replace(/\s+/g, ' ').trim();
      const cleanedText = fixArabicPDFText(rawText);
      optionMap[letter] = cleanedText;
      if (evaluateExtractionQuality(cleanedText, rawText)) requiresOcr = true;
    } else {
      optionMap[letter] = '';
      requiresOcr = true;
    }
  }

  return {
    options: ARABIC_LETTERS.map(l => optionMap[l] || ''),
    requiresOcr
  };
}

async function runTest(pdfPath) {
  console.log(`\n\n--- Testing ${pdfPath} ---`);
  if (!fs.existsSync(pdfPath)) {
    console.log("File not found!");
    return;
  }
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({
    data,
    disableFontFace: true,
    fontExtraProperties: true,
    cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/standard_fonts/'
  }).promise;

  let gId = 1;
  for (let i = 1; i <= doc.numPages; i++) { 
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 2.5 });
    const canvasHeight = viewport.height;

    const textContent = await page.getTextContent();
    const regions = detectQuestionRegions(textContent, canvasHeight, viewport);

    for (const region of regions) {
      const result = findOptionBoundary(textContent, region.y1, region.y2, viewport);
      console.log(`Q${gId} (Page ${i}): [OCR needed? ${result.requiresOcr}]`);
      console.log(`   Options:`, result.options);
      gId++;
    }
  }
}

async function main() {
  await runTest('121.pdf');
}

main().catch(console.error);
