const fs = require('fs');
const path = require('path');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

async function debug76() {
  const pdfPath = path.join(__dirname, '76.pdf');
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({
    data, disableFontFace: true, fontExtraProperties: true,
    cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/standard_fonts/'
  }).promise;

  console.log(`Total Pages: ${doc.numPages}`);

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 2.0 });
    const textContent = await page.getTextContent();

    console.log(`\n======= PAGE ${i} =======`);
    console.log(`Canvas: ${viewport.width} x ${viewport.height}`);
    console.log(`Text items: ${textContent.items.length}`);
    
    // Print ALL text items with their coordinates
    for (const item of textContent.items) {
      if (!item.str || !item.str.trim()) continue;
      const [, , , , pdfX, pdfY] = item.transform;
      const [cx, cy] = viewport.convertToViewportPoint(pdfX, pdfY);
      const norm = item.str.replace(/\u0640/g, '').replace(/\s+/g, ' ').trim();
      console.log(`  [${Math.round(cx)}, ${Math.round(cy)}] "${norm}" (raw: "${item.str.trim()}")`);
    }

    // Check for question markers
    const pageText = textContent.items.map(it => it.str).join(' ');
    console.log(`\n--- Full page text (joined): ---`);
    console.log(pageText.substring(0, 500));
    
    // Check for السؤال
    const hasSualMarker = pageText.includes('السؤال');
    console.log(`\nHas 'السؤال': ${hasSualMarker}`);
    
    // Check for Question
    const hasQuestionMarker = pageText.toLowerCase().includes('question');
    console.log(`Has 'Question': ${hasQuestionMarker}`);

    // Check for Latin ABCD
    const latinRegex = /(?<![A-Za-z])([ABCD])(?![A-Za-z])/g;
    const latinMatches = pageText.match(latinRegex);
    console.log(`Latin ABCD matches: ${JSON.stringify(latinMatches)}`);
    
    // Check for Arabic أبجد
    const arabicRegex = /(?<![\u0621-\u064A])([\u0623\u0628\u062c\u062f])(?![\u0621-\u064A])/g;
    const arabicMatches = pageText.match(arabicRegex);
    console.log(`Arabic أبجد matches: ${JSON.stringify(arabicMatches)}`);

    // Check for common English question patterns
    const numberDot = pageText.match(/\b\d+\s*[\.\)]\s/g);
    console.log(`Numbered patterns (1. or 1)): ${JSON.stringify(numberDot)}`);
  }
}

debug76().catch(console.error);
