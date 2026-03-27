const fs = require('fs');
const path = require('path');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

async function debug121() {
  const pdfPath = 'd:/Repos/QA_PDF_READER/tests/121.pdf';
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({ data, disableFontFace: true }).promise;
  console.log(`Pages: ${doc.numPages}`);
  const page = await doc.getPage(1);
  const text = await page.getTextContent();
  console.log(`Page 1 items: ${text.items.length}`);
  text.items.slice(0, 50).forEach(it => {
    if (it.str.trim()) console.log(`"${it.str.trim()}"`);
  });
}

debug121().catch(console.error);
