const fs = require('fs');
const path = require('path');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

const DETECT_PADDING = 20;

function detectQuestionRegions(textContent, canvasWidth, canvasHeight, viewport) {
  const KASHIDA = '\u0640';
  const questionYPositions = [];
  const numericMarkerRegex = /^\s*(\d+|[A-Za-z])\s*[\.\-\)]\s*$/;
  const commonNumberedPattern = /^\s*\d+\s*[\.\-\)]\s+/;

  for (const item of textContent.items) {
    if (!item.str) continue;
    const normalized = item.str.replace(/\u0640/g, '').replace(/\s+/g, ' ').trim();
    const isExplicitMarker = normalized.includes('السؤال') || 
                            normalized.toLowerCase().startsWith('question') || 
                            normalized.toLowerCase().startsWith('q:');
    const isNumericMarker = numericMarkerRegex.test(normalized) || 
                           commonNumberedPattern.test(normalized);

    if (isExplicitMarker || isNumericMarker) {
      const [, , , , pdfX, pdfY] = item.transform;
      const [canvasX, canvasY] = viewport.convertToViewportPoint(pdfX, pdfY);
      
      if (isNumericMarker && !isExplicitMarker) {
        const isOnRightEdge = canvasX > (canvasWidth * 0.7); 
        const isOnLeftEdge = canvasX < (canvasWidth * 0.3);  
        if (!isOnRightEdge && !isOnLeftEdge) continue; 
      }
      questionYPositions.push({ y: canvasY, x: canvasX, str: normalized });
    }
  }

  return { explicit: questionYPositions.length, regions: questionYPositions.length };
}

async function debug121() {
  const pdfPath = 'd:/Repos/QA_PDF_READER/tests/121.pdf';
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({ data, disableFontFace: true }).promise;
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 2.0 });
  const text = await page.getTextContent();
  
  const result = detectQuestionRegions(text, viewport.width, viewport.height, viewport);
  console.log(`Page 1 Results: ${JSON.stringify(result)}`);
  
  console.log('Top 20 items:');
  text.items.slice(0, 20).forEach(it => {
    if (it.str.trim()) {
       const [, , , , pdfX, pdfY] = it.transform;
       const [cx, cy] = viewport.convertToViewportPoint(pdfX, pdfY);
       console.log(`[${Math.round(cx)}, ${Math.round(cy)}] "${it.str.trim()}"`);
    }
  });
}

debug121().catch(console.error);
