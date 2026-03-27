const fs = require('fs');
const path = require('path');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

async function check76() {
  const pdfPath = 'd:/Repos/QA_PDF_READER/tests/76.pdf';
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  console.log('Loading PDF...');
  const doc = await pdfjsLib.getDocument({
    data,
    disableFontFace: true,
  }).promise;
  console.log(`Pages: ${doc.numPages}`);
  const page = await doc.getPage(1);
  const text = await page.getTextContent();
  console.log(`Items on Page 1: ${text.items.length}`);
  console.log('First 10 items:');
  text.items.slice(0, 10).forEach(it => console.log(`"${it.str}"`));
}

check76().catch(console.error);
