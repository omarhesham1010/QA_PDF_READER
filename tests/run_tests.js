const fs = require('fs');
const path = require('path');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

const DETECT_PADDING = 20;

function detectQuestionRegions(textContent, canvasWidth, canvasHeight, viewport) {
  const questionYPositions = [];
  for (const item of textContent.items) {
    if (!item.str) continue;
    const normalized = item.str.replace(/\u0640/g, '').replace(/\s+/g, ' ').trim();
    if (normalized.includes('السؤال') || normalized.toLowerCase().startsWith('question') || normalized.toLowerCase().startsWith('q:')) {
      const [, , , , pdfX, pdfY] = item.transform;
      const [canvasX, canvasY] = viewport.convertToViewportPoint(pdfX, pdfY);
      questionYPositions.push({ y: canvasY, x: canvasX });
    }
  }

  if (questionYPositions.length === 0) {
    const pageText = textContent.items.map(it => it.str).join(' ');
    const arabicRegex = /(?<![\u0621-\u064A])([\u0623\u0628\u062c\u062f])(?![\u0621-\u064A])/g;
    const arabicMatches = pageText.match(arabicRegex);
    const uniqueArabic = new Set(arabicMatches || []);

    const latinRegex = /(?<![A-Za-z])([ABCD])(?![A-Za-z])/g;
    const latinMatches = pageText.match(latinRegex);
    const uniqueLatin = new Set(latinMatches || []);

    const hasArabicOptions = uniqueArabic.size >= 3;
    const hasLatinOptions = uniqueLatin.size >= 3;
    const isAnswerKey = pageText.includes('الإجابات') && !pageText.includes('قارن');

    if ((hasArabicOptions || hasLatinOptions) && !isAnswerKey) {
      return [{ x1: 0, y1: 0, x2: canvasWidth, y2: canvasHeight, qIdx: 0 }];
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
    regions.push({ x1: 0, y1, x2: canvasWidth, y2 });
  }
  return regions;
}

function fixArabicPDFText(text) {
  if (!text) return { text: '', heuristicsApplied: false };
  const original = text;
  text = text.replace(/\uFFFD/g, '');
  text = text.replace(/األ/g, 'الأ').replace(/اإل/g, 'الإ').replace(/اآل/g, 'الآ')
    .replace(/اال/g, 'الا').replace(/ىل/g, 'لى').replace(/ىع/g, 'عى').replace(/ىف/g, 'فى');
  const cleaned = text.trim();
  return { text: cleaned, heuristicsApplied: original !== cleaned && cleaned.length > 0 };
}

function evaluateExtractionQuality(text, rawText, heuristicsApplied = false) {
  if (!text.trim()) return { failed: true };
  const regex = heuristicsApplied ? /(^|\s)[\u0600-\u06FF](?=\s|$)/g : /(^|\s)[a-zA-Z\u0600-\u06FF](?=\s|$)/g;
  const singleLetters = text.match(regex);
  if (singleLetters && singleLetters.length >= 3 && text.length < 15) return { failed: true };
  return { failed: false };
}

function findOptionBoundary(textContent, qY1, qY2, viewport) {
  const ARABIC_LETTERS = ['\u0623', '\u0628', '\u062c', '\u062f'];
  const LATIN_LETTERS  = ['A', 'B', 'C', 'D'];
  
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

  if (items.length === 0) return { options: ['', '', '', ''], requiresOcr: true, confidence: 0 };

  const latinCount  = items.filter(it => LATIN_LETTERS.includes(it.norm)).length;
  const arabicCount = items.filter(it => ARABIC_LETTERS.includes(it.norm)).length;
  const useLatin    = latinCount > arabicCount;
  const OPTION_LETTERS = useLatin ? LATIN_LETTERS : ARABIC_LETTERS;

  const optionRegex = useLatin ? /(?<![A-Za-z])([ABCD])(?![A-Za-z])/ : /(?<![\u0621-\u064A])([أبجد])(?![\u0621-\u064A])/;
  
  const allCandidates = [];
  for (const it of items) {
    const match = it.norm.match(optionRegex);
    if (match) {
      allCandidates.push({ letter: match[1], item: it, y: it.y, x: it.x });
    } else if (OPTION_LETTERS.includes(it.norm)) {
      allCandidates.push({ letter: it.norm, item: it, y: it.y, x: it.x });
    }
  }

  const clusters = [];
  for (const cand of allCandidates) {
    let placed = false;
    for (const cluster of clusters) {
      if (Math.abs(cluster.y - cand.y) <= 30) {
        cluster.candidates.push(cand);
        cluster.uniqueLetters.add(cand.letter);
        placed = true; break;
      }
    }
    if (!placed) clusters.push({ y: cand.y, candidates: [cand], uniqueLetters: new Set([cand.letter]) });
  }

  clusters.sort((a, b) => b.uniqueLetters.size - a.uniqueLetters.size || b.y - a.y);
  const bestCluster = clusters[0];

  const labelItems = {};
  if (bestCluster) {
    for (const letter of OPTION_LETTERS) {
      const cands = bestCluster.candidates.filter(c => c.letter === letter).sort((a, b) => a.x - b.x);
      if (cands.length > 0) labelItems[letter] = cands[cands.length - 1].item;
    }
  }

  if (Object.keys(labelItems).length === 0) return { options: ['', '', '', ''], requiresOcr: true, confidence: 0 };

  const presentLabels = OPTION_LETTERS.map(l => ({ letter: l, item: labelItems[l] })).filter(x => x.item);
  const rows = [];
  presentLabels.sort((a, b) => a.item.y - b.item.y);
  for (const pl of presentLabels) {
    let placed = false;
    for (const row of rows) {
      if (Math.abs(row.y - pl.item.y) <= 15) {
        row.labels.push(pl);
        placed = true; break;
      }
    }
    if (!placed) rows.push({ y: pl.item.y, labels: [pl] });
  }

  rows.forEach(row => {
    if (useLatin) row.labels.sort((a, b) => a.item.x - b.item.x);
    else row.labels.sort((a, b) => b.item.x - a.item.x);
  });

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
  let detectedCount = 0;
  for (const letter of OPTION_LETTERS) {
    const bounds = boundaries[letter];
    if (!bounds) { optionMap[letter] = ''; continue; }

    const regionItems = items.filter(c => 
      c !== labelItems[letter] && !OPTION_LETTERS.includes(c.norm) &&
      c.y >= bounds.yMin && c.y < bounds.yMax && c.x <= bounds.xMax && c.x > bounds.xMin
    );

    if (regionItems.length > 0) {
      regionItems.sort((a, b) => Math.abs(a.y - b.y) > 10 ? a.y - b.y : b.x - a.x);
      const rawText = regionItems.map(c => c.norm).join(' ');
      const { text, heuristicsApplied } = fixArabicPDFText(rawText);
      optionMap[letter] = text;
      if (!evaluateExtractionQuality(text, rawText, heuristicsApplied).failed) detectedCount++;
    }
  }

  return {
    options: OPTION_LETTERS.map(l => optionMap[l] || ''),
    confidence: detectedCount / 4,
    requiresOcr: (detectedCount / 4) < 0.5
  };
}

async function runTest(pdfPath) {
  console.log(`\n=== Testing: ${path.basename(pdfPath)} ===`);
  if (!fs.existsSync(pdfPath)) { console.log("File not found!"); return; }

  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({
    data, disableFontFace: true, fontExtraProperties: true,
    cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/standard_fonts/'
  }).promise;

  let totalQ = 0;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 2.0 });
    const textContent = await page.getTextContent();
    const regions = detectQuestionRegions(textContent, viewport.width, viewport.height, viewport);

    for (const reg of regions) {
      const result = findOptionBoundary(textContent, reg.y1, reg.y2, viewport);
      totalQ++;
      console.log(`Q${totalQ} (P${i}): Conf=${Math.round(result.confidence*100)}% Options: ${result.options.join(' | ')}`);
    }
  }
  console.log(`--- Total Questions Detected: ${totalQ} ---`);
}

async function main() {
  const args = process.argv.slice(2);
  const pdfDir = 'tests';
  const files = fs.readdirSync(pdfDir).filter(f => f.endsWith('.pdf'));

  if (args.length > 0) {
    const search = args[0];
    const file = files.find(f => f.includes(search) || files.indexOf(f).toString() === search);
    if (file) await runTest(path.join(pdfDir, file));
    else console.log("No matching PDF found.");
  } else {
    for (const f of files) await runTest(path.join(pdfDir, f));
  }
}

main().catch(console.error);
