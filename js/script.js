// ============================
// CONFIGURATION
// ============================
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

/** Scale at which to render each PDF page for screenshot quality */
const RENDER_SCALE = 2.5;

/** Padding (px on rendered canvas) to add above/below each question region */
const DETECT_PADDING = 20;

/** 
 * إعدادات قص الصورة الافتراضية (بالبكسل - على حجم الـ Canvas)
 * يمكنك تعديل هذه الأرقام لضبط القص من جميع الاتجاهات 
 */
const GLOBAL_CROP = {
  TOP: 0,      // موجب = بيقص من فوق أكتر (بينزل لتحت)
  BOTTOM: 40, // سالب = بينزل لتحت أكتر قبل الخيارات (بيسيب مساحة)، موجب = بيقص أكتر 
  LEFT: 80,     // موجب = بيقص من الشمال أكتر (بيدخل لجوه)
  RIGHT: 220     // موجب = بيقص من اليمين أكتر (بيدخل لجوه)
};

// ============================
// APP STATE
// ============================
/**
 * Main data model.
 * @type {{ questions: Array<{id:number, imageDataUrl:string, options:string[], correct:string|null, cropAdjust:{top:number,bottom:number,left:number,right:number}}> }}
 */
const appState = {
  questions: [],
  currentIndex: -1,
  pdfDoc: null,
};

// ============================
// PDF UPLOAD & PROCESSING
// ============================

/**
 * Handle PDF file selection.
 * Loads the PDF with pdf.js and starts processing.
 */
document.getElementById('pdfInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file || file.type !== 'application/pdf') {
    showToast('الرجاء اختيار ملف PDF صالح', 'error');
    return;
  }
  document.getElementById('fileName').textContent = file.name;
  resetState();

  showProgress('جاري تحميل الـ PDF...', 0);

  const arrayBuffer = await file.arrayBuffer();
  try {
    // Provide CMaps and Standard Fonts so pdf.js can accurately render Arabic fonts
    appState.pdfDoc = await pdfjsLib.getDocument({
      data: arrayBuffer,
      cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/standard_fonts/',
      fontExtraProperties: true,
      disableFontFace: true
    }).promise;
    await processPdf(appState.pdfDoc);
  } catch (err) {
    showToast('خطأ في قراءة الـ PDF: ' + err.message, 'error');
    hideProgress();
  }
  // Reset file input so same file can be re-uploaded
  e.target.value = '';
});

/**
 * Iterate over all PDF pages, render each to a canvas,
 * detect question blocks, and capture screenshots.
 * @param {import('pdfjs-dist').PDFDocumentProxy} pdfDoc
 */
async function processPdf(pdfDoc) {
  const totalPages = pdfDoc.numPages;
  const canvas = document.getElementById('pdf-canvas');
  const ctx = canvas.getContext('2d');

  /**
   * Each entry: { pageImg: ImageData, pageCanvas: HTMLCanvasElement,
   *               regions: [{y1, y2}] }
   * We collect all pages first, then assign global question IDs.
   */
  let allQuestions = [];
  let globalId = 1;

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const progress = Math.round(((pageNum - 1) / totalPages) * 80);
    showProgress(`معالجة الصفحة ${pageNum} من ${totalPages}...`, progress);

    const page = await pdfDoc.getPage(pageNum);

    // Render the page to the hidden canvas at high scale
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: ctx, viewport }).promise;

    // Extract text with positions to find "السؤال" occurrences
    const textContent = await page.getTextContent();
    const regions = detectQuestionRegions(textContent, canvas.width, canvas.height, viewport);

    // For each region, crop from canvas and save as data URL
    for (const region of regions) {
      const imageDataUrl = cropCanvasRegion(
        canvas, region.x1, region.y1, region.x2 - region.x1, region.y2 - region.y1
      );
      allQuestions.push({
        id: globalId++,
        imageDataUrl,
        // Raw crop coords (for manual adjustment)
        _raw: { canvas: { width: canvas.width, height: canvas.height }, region },
        // Adjustment offsets in px (on the rendered canvas)
        cropAdjust: { top: 0, bottom: 0, left: 0, right: 0 },
        options: ['A', 'B', 'C', 'D'],
        correct: null,
      });
    }
  }

  showProgress('جاري بناء الواجهة...', 90);

  // Store in state
  appState.questions = allQuestions;

  if (allQuestions.length === 0) {
    showToast('لم يتم اكتشاف أي أسئلة. تأكد أن الملف يحتوي على "السؤال"', 'error');
    hideProgress();
    return;
  }

  renderQuestionList();
  updateStats();
  document.getElementById('exportBtn').disabled = false;
  hideProgress();
  showToast(`✓ تم اكتشاف ${allQuestions.length} سؤال بنجاح`, 'success');

  // Auto-select first question
  selectQuestion(0);
}

/**
 * Detect question regions on a rendered page.
 * Searches text items for "السؤال" and computes bounding boxes.
 *
 * @param {import('pdfjs-dist').TextContent} textContent
 * @param {number} canvasWidth
 * @param {number} canvasHeight
 * @param {import('pdfjs-dist').PageViewport} viewport
 * @returns {Array<{x1:number,y1:number,x2:number,y2:number}>}
 */
function detectQuestionRegions(textContent, canvasWidth, canvasHeight, viewport) {
  // Collect Y positions (in canvas px) where "السؤال" is found.
  // We normalize each text item by stripping Tatweel/Kashida (ـ U+0640)
  // characters before matching, because many Arabic PDFs elongate letters
  // with kashida (e.g. "السـؤال" instead of "السؤال").
  const KASHIDA = '\u0640'; // Arabic Tatweel character
  const questionYPositions = [];

  for (const item of textContent.items) {
    if (!item.str) continue;
    // Normalize: remove kashida + collapse repeated whitespace
    const normalized = item.str.replace(/\u0640/g, '').replace(/\s+/g, ' ').trim();
    if (normalized.includes('السؤال')) {
      // Transform PDF coordinates to canvas pixel coordinates
      // item.transform = [scaleX, skewX, skewY, scaleY, x, y]
      const [, , , , pdfX, pdfY] = item.transform;
      // convert PDF user space to canvas pixels using viewport
      const [canvasX, canvasY] = viewport.convertToViewportPoint(pdfX, pdfY);
      questionYPositions.push({ y: canvasY, x: canvasX });
    }
  }

  if (questionYPositions.length === 0) return [];

  // Sort by Y (top to bottom)
  questionYPositions.sort((a, b) => a.y - b.y);

  // Build regions: from each question Y to the next question Y (or page bottom)
  const regions = [];
  for (let i = 0; i < questionYPositions.length; i++) {
    const y1 = Math.max(0, questionYPositions[i].y - DETECT_PADDING);
    const y2 = i + 1 < questionYPositions.length
      ? Math.min(canvasHeight, questionYPositions[i + 1].y - DETECT_PADDING)
      : canvasHeight;

    regions.push({
      x1: 0,
      y1,
      x2: canvasWidth,
      y2,
    });
  }

  return regions;
}

/**
 * Crop a rectangular region from a canvas and return a PNG data URL.
 * @param {HTMLCanvasElement} sourceCanvas
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @returns {string} data URL
 */
function cropCanvasRegion(sourceCanvas, x, y, w, h) {
  const offscreen = document.createElement('canvas');
  offscreen.width = Math.max(1, Math.round(w));
  offscreen.height = Math.max(1, Math.round(h));
  const octx = offscreen.getContext('2d');
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(
    sourceCanvas,
    Math.round(x), Math.round(y), Math.round(w), Math.round(h),
    0, 0, offscreen.width, offscreen.height
  );
  return offscreen.toDataURL('image/png');
}

// ============================
// QUESTION LIST RENDERING
// ============================

/**
 * Build the sidebar question list UI.
 */
function renderQuestionList() {
  const list = document.getElementById('question-list');
  list.innerHTML = '';
  document.getElementById('question-count').textContent = appState.questions.length;

  appState.questions.forEach((q, idx) => {
    const item = document.createElement('div');
    item.className = 'q-item' + (q.correct ? ' answered' : '') + (q.requiresOcr ? ' needs-ocr' : '');
    item.id = `q-item-${idx}`;

    let ocrIcon = q.requiresOcr ? '<span class="ocr-icon" title="جودة استخراج النص ضعيفة (تحتاج OCR)">⚠️</span>' : '';
    item.innerHTML = `
      <span class="q-number">Q${q.id}</span>
      <span class="q-badge"></span>
      ${ocrIcon}
    `;
    item.addEventListener('click', () => selectQuestion(idx));
    list.appendChild(item);
  });
}

// ============================
// QUESTION SELECTION & DISPLAY
// ============================

/**
 * Select and display a question by its list index.
 * @param {number} idx
 */
function selectQuestion(idx) {
  const q = appState.questions[idx];
  if (!q) return;

  appState.currentIndex = idx;

  // Update sidebar active state
  document.querySelectorAll('.q-item').forEach(el => el.classList.remove('active'));
  const activeItem = document.getElementById(`q-item-${idx}`);
  if (activeItem) {
    activeItem.classList.add('active');
    activeItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // Show viewer, hide empty state
  document.getElementById('empty-state').style.display = 'none';
  const viewer = document.getElementById('question-viewer');
  viewer.classList.add('visible');

  // Update image
  document.getElementById('q-title').textContent = `السؤال ${q.id}`;
  document.getElementById('q-image').src = q.imageDataUrl;

  // Reset crop inputs to this question's adjustments
  document.getElementById('cropTop').value = q.cropAdjust.top;
  document.getElementById('cropBottom').value = q.cropAdjust.bottom;
  document.getElementById('cropLeft').value = q.cropAdjust.left;
  document.getElementById('cropRight').value = q.cropAdjust.right;

  // Update answer radio buttons and display extracted option text
  const optionKeys = ['A', 'B', 'C', 'D'];
  optionKeys.forEach((letter, i) => {
    const opt = document.getElementById(`opt-${letter}`);
    const radio = opt.querySelector('input[type=radio]');
    radio.checked = q.correct === letter;
    opt.classList.toggle('selected', q.correct === letter);

    // Show extracted option text if available, else generic label
    const textEl = opt.querySelector('.answer-option-text');
    const extracted = q.optionTexts && q.optionTexts[i];
    textEl.textContent = extracted || `خيار ${letter}`;
  });
}

// ============================
// ANSWER SELECTION
// ============================

/**
 * Record the selected answer for the current question.
 * @param {string} letter - 'A' | 'B' | 'C' | 'D'
 */
function selectAnswer(letter) {
  if (appState.currentIndex < 0) return;
  const q = appState.questions[appState.currentIndex];
  q.correct = letter;

  // Update option visual states
  ['A', 'B', 'C', 'D'].forEach(l => {
    document.getElementById(`opt-${l}`).classList.toggle('selected', l === letter);
  });

  // Update sidebar badge
  const listItem = document.getElementById(`q-item-${appState.currentIndex}`);
  if (listItem) listItem.classList.add('answered');

  updateStats();

  // Auto-advance to next unanswered question (UX improvement)
  const nextIdx = appState.questions.findIndex(
    (q, i) => i > appState.currentIndex && !q.correct
  );
  if (nextIdx !== -1) {
    setTimeout(() => selectQuestion(nextIdx), 300);
  }
}

// ============================
// MANUAL CROP ADJUSTMENT
// ============================

/**
 * Re-crop the current question image with manual offset values.
 */
function applyManualCrop() {
  if (appState.currentIndex < 0) return;
  const q = appState.questions[appState.currentIndex];
  const adj = {
    top: parseInt(document.getElementById('cropTop').value) || 0,
    bottom: parseInt(document.getElementById('cropBottom').value) || 0,
    left: parseInt(document.getElementById('cropLeft').value) || 0,
    right: parseInt(document.getElementById('cropRight').value) || 0,
  };
  q.cropAdjust = adj;

  // Re-render from raw region + offset
  const { region } = q._raw;
  const canvas = document.getElementById('pdf-canvas');

  // Re-render the page again to apply crop correctly
  // (we re-render using stored pdfDoc)
  rerenderQuestionImage(q).then(dataUrl => {
    q.imageDataUrl = dataUrl;
    document.getElementById('q-image').src = dataUrl;
    showToast('تم تطبيق القص', 'success');
  });
}

/**
 * Re-render a single question's image using stored raw crop region + adjustments.
 * @param {object} q - question object
 * @returns {Promise<string>} data URL
 */
async function rerenderQuestionImage(q) {
  const canvas = document.getElementById('pdf-canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  const { region } = q._raw;
  const adj = q.cropAdjust;

  // Find which page this question is on by global id ordering
  // We need to re-render the correct PDF page.
  // For simplicity, we track pageNum in _raw during initial processing.
  const pageNum = q._raw.pageNum;
  if (!pageNum || !appState.pdfDoc) return q.imageDataUrl;

  const page = await appState.pdfDoc.getPage(pageNum);

  const scale = window.devicePixelRatio * 2 || 4;
  const viewport = page.getViewport({ scale });
  canvas.width = viewport.width;
  canvas.height = viewport.height;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  await page.render({
    canvasContext: ctx,
    viewport: viewport
  }).promise;

  const x1 = Math.max(0, region.x1 + adj.left);
  const y1 = Math.max(0, region.y1 + adj.top);
  const x2 = Math.min(canvas.width, region.x2 - adj.right);
  // Use imageCropBottom (stops before options) rather than full region.y2
  const cropBottom = q._raw.imageCropBottom || region.y2;
  const y2 = Math.min(canvas.height, cropBottom - adj.bottom);

  return cropCanvasRegion(canvas, x1, y1, x2 - x1, y2 - y1);
}

// ============================
// ZIP EXPORT
// ============================

/**
 * Export all question images + JSON data as a ZIP file.
 */
async function exportZip() {
  if (appState.questions.length === 0) {
    showToast('لا توجد أسئلة للتصدير', 'error');
    return;
  }

  showToast('جاري إنشاء الـ ZIP...', '');
  const btn = document.getElementById('exportBtn');
  const origContent = btn.innerHTML;
  btn.innerHTML = '<div class="spinner"></div> جاري التصدير...';
  btn.disabled = true;

  try {
    const zip = new JSZip();
    const questionsFolder = zip.folder('questions');

    // Build JSON data model
    const jsonData = { questions: [] };

    for (const q of appState.questions) {
      const filename = `${q.id}.png`;

      // Convert data URL to binary
      const base64 = q.imageDataUrl.split(',')[1];
      questionsFolder.file(filename, base64, { base64: true });

      const letterToIndex = { 'A': 0, 'B': 1, 'C': 2, 'D': 3 };
      let finalOptions = q.options;
      let finalCorrect = q.correct;

      // Use extracted Arabic text if available, fallback to A/B/C/D if empty
      if (q.optionTexts) {
        finalOptions = q.optionTexts.map((text, i) => text.trim() || q.options[i]);
        if (q.correct && letterToIndex[q.correct] !== undefined) {
          finalCorrect = finalOptions[letterToIndex[q.correct]];
        }
      }

      jsonData.questions.push({
        id: q.id,
        image: `questions/${filename}`,
        options: finalOptions,
        correct: finalCorrect,
      });
    }

    // Add JSON file
    zip.file('questions.json', JSON.stringify(jsonData, null, 2));

    // Generate and download ZIP
    const blob = await zip.generateAsync({ type: 'blob' });
    saveAs(blob, 'exam_questions.zip');
    showToast('✓ تم تصدير الـ ZIP بنجاح', 'success');

  } catch (err) {
    showToast('خطأ في إنشاء الـ ZIP: ' + err.message, 'error');
  } finally {
    btn.innerHTML = origContent;
    btn.disabled = false;
  }
}

// ============================
// STATS
// ============================

/**
 * Update the stats panel.
 */
function updateStats() {
  const total = appState.questions.length;
  const answered = appState.questions.filter(q => q.correct).length;
  const pct = total > 0 ? Math.round((answered / total) * 100) : 0;

  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-answered').textContent = answered;
  document.getElementById('completion-bar').style.width = pct + '%';
  document.getElementById('completion-text').textContent = `${pct}% مكتمل`;
}

// ============================
// PROGRESS BAR
// ============================

function showProgress(label, pct) {
  const container = document.getElementById('progress-container');
  container.classList.add('visible');
  document.getElementById('progress-label').textContent = label;
  document.getElementById('progress-bar').style.width = pct + '%';
}

function hideProgress() {
  document.getElementById('progress-container').classList.remove('visible');
}

// ============================
// TOAST NOTIFICATIONS
// ============================

let _toastTimer = null;

/**
 * Show a toast notification.
 * @param {string} msg
 * @param {'success'|'error'|''} type
 */
function showToast(msg, type = '') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = 'show ' + type;
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    toast.className = '';
  }, 3000);
}

// ============================
// RESET STATE
// ============================

/**
 * Reset app state for a new PDF.
 */
function resetState() {
  appState.questions = [];
  appState.currentIndex = -1;
  document.getElementById('question-list').innerHTML = '';
  document.getElementById('question-count').textContent = '0';
  document.getElementById('exportBtn').disabled = true;
  document.getElementById('empty-state').style.display = '';
  document.getElementById('question-viewer').classList.remove('visible');
  updateStats();
}

// ============================
// ARABIC TEXT CLEANUP
// ============================

/**
 * Fix common Arabic PDF extraction issues (e.g. reversed ligatures).
 * @param {string} text
 * @returns {string}
 */
function fixArabicPDFText(text) {
  if (!text) return text;
  
  // إزالة أي رموز غير معرفة نتجت عن قراءة خاطئة للخط
  text = text.replace(/\uFFFD/g, '');

  // فك الكلمات المعكوسة الناتجة عن الـ PDF (خطوة أساسية للغة العربية)
  text = text
    .replace(/األ/g, 'الأ')
    .replace(/اإل/g, 'الإ')
    .replace(/اآل/g, 'الآ')
    .replace(/اال/g, 'الا')
    .replace(/ىل/g, 'لى')
    .replace(/ىع/g, 'عى')
    .replace(/ىف/g, 'فى');

  // استعادة الكلمات المحذوفة بالكامل بسبب خطوط الأكاديميات التي لا تدعم تشفير بعض الحروف
  text = text.replace(/(^|\s)أك(?=\s|$)/g, '$1أكبر');
  text = text.replace(/أك$/g, 'أكبر');
  text = text.replace(/أك\s/g, 'أكبر ');
  
  text = text.replace(/غ\s*كافية/g, 'غير كافية');
  text = text.replace(/^[يى]\s*المعطيات/g, 'المعطيات');
  text = text.replace(/^[يى]\s*غير\s*كافية/g, 'المعطيات غير كافية');
  if (text.trim() === 'ي' || text.trim() === 'ى' || text.trim() === 'غ') text = 'المعطيات غير كافية';

  // تنظيف أي مسافات زائدة
  return text.trim();
}

/**
 * مرحلة التقييم التلقائي (Quality Check)
 * Evaluate extracted text quality to decide if OCR fallback is needed.
 * @param {string} text - The cleaned text
 * @param {string} rawText - The raw text before cleanup
 * @returns {boolean} true if text appears corrupted
 */
function evaluateExtractionQuality(text, rawText) {
  if (!text.trim()) return true; // Empty text means extraction failed entirely
  if (rawText && rawText.includes('\uFFFD')) return true; // Missing glyph mapping directly detected
  
  // Check for excessive single Arabic letters (fragmentation: e.g. "ب ي ن" instead of "بين")
  // If a short text has 3 or more isolated single characters separated by spaces, it's mostly garbage.
  const singleLetters = text.match(/(^|\s)[\u0600-\u06FF](?=\s|$)/g);
  if (singleLetters && singleLetters.length >= 3 && text.length < 15) return true;
  
  return false;
}

// ============================
// OPTION BOUNDARY DETECTION
// ============================

/**
 * Arabic MCQ option markers: أ ب ج د (equivalent to A B C D).
 * Searches text items in a question's Y range for these markers,
 * returning the first option Y (for image cropping) and extracted text.
 *
 * @param {TextContent} textContent - pdf.js page text content
 * @param {number} qY1 - question region top (canvas px)
 * @param {number} qY2 - question region bottom (canvas px)
 * @param {PageViewport} viewport
 * @returns {{ firstOptionY: number|null, options: string[] }}
 */
function findOptionBoundary(textContent, qY1, qY2, viewport) {
  /**
   * Detects Arabic MCQ options in a question region.
   *
   * In this PDF, each option consists of TWO separate text items at ~same Y:
   *   1. A single Arabic letter: أ / ب / ج / د  (the label, at a higher X = more right in RTL)
   *   2. The option value text (at a lower X = to the left of the label)
   *
   * We find each label item, then find its paired value as the item at
   * approximately the same Y with the closest X to the left of the label.
   */
  const ARABIC_LETTERS = ['\u0623', '\u0628', '\u062c', '\u062f'];

  // Collect items in question region
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

  if (items.length === 0) return { firstOptionY: null, options: ['', '', '', ''], requiresOcr: true };
  items.sort((a, b) => a.y - b.y);

  // Find each Arabic letter item
  const labelItems = {};
  for (const item of items) {
    if (ARABIC_LETTERS.includes(item.norm) && !labelItems[item.norm]) {
      labelItems[item.norm] = item;
    }
  }

  if (Object.keys(labelItems).length === 0) {
    return { firstOptionY: null, options: ['', '', '', ''], requiresOcr: true };
  }

  // Group labels into rows to define 2D bounding boxes (شبكة ديناميكية تمشي مع أي تصميم)
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
    if (!placed) {
      rows.push({ y: pl.item.y, labels: [pl] });
    }
  }

  // Sort rows top-to-bottom, and labels inside right-to-left
  rows.sort((a, b) => a.y - b.y);
  rows.forEach(row => row.labels.sort((a, b) => b.item.x - a.item.x));

  // Define strict 2D boundaries for each option's territory
  const boundaries = {};
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const nextRow = rows[r + 1];
    for (let i = 0; i < row.labels.length; i++) {
      const pl = row.labels[i];
      const nextPl = row.labels[i + 1];

      boundaries[pl.letter] = {
        yMin: row.y - 20,
        // قفل الحد السفلي على 40 بكسل كحد أقصى لمنع التقاط نصوص الـ Footer أو الـ Watermarks
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
      requiresOcr = true; // مساحة الخيار غير موجودة نهائياً أو مكسورة جداً
      continue; 
    }

    const regionItems = items.filter(c => 
      c !== labelItems[letter] &&
      !ARABIC_LETTERS.includes(c.norm) &&
      c.y >= bounds.yMin && c.y < bounds.yMax &&
      c.x <= bounds.xMax && c.x > bounds.xMin
    );

    if (regionItems.length > 0) {
      // Sort multi-line options: top-to-bottom, then right-to-left
      regionItems.sort((a, b) => {
        if (Math.abs(a.y - b.y) > 10) return a.y - b.y;
        return b.x - a.x;
      });
      // Raw string Before cleanup
      const rawText = regionItems.map(c => c.norm).join(' ').replace(/\s+/g, ' ').trim();
      const cleanedText = fixArabicPDFText(rawText);
      
      optionMap[letter] = cleanedText;
      
      // تقييم الجودة لتحديد هل فشل الاستخراج لهذا الخيار
      if (evaluateExtractionQuality(cleanedText, rawText)) {
        requiresOcr = true;
      }
    } else {
      optionMap[letter] = '';
      requiresOcr = true; // نص فارغ تماماً لخيار تم العثور على حرفه
    }
  }

  // firstOptionY = Y of first label found
  const labelYs = presentLabels.map(pl => pl.item.y);
  const firstOptionY = labelYs.length > 0 ? Math.min(...labelYs) : null;

  return {
    firstOptionY,
    options: ARABIC_LETTERS.map(l => optionMap[l] || ''),
    requiresOcr
  };
}

// ============================
// MAIN PROCESS PDF
// ============================
async function processPdf(pdfDoc) {
  const totalPages = pdfDoc.numPages;
  const canvas = document.getElementById('pdf-canvas');
  const ctx = canvas.getContext('2d', { alpha: false });

  let allQuestions = [];
  let globalId = 1;

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const progress = Math.round(((pageNum - 1) / totalPages) * 85);
    showProgress(`معالجة الصفحة ${pageNum} من ${totalPages}...`, progress);

    const page = await pdfDoc.getPage(pageNum);

    const scale = window.devicePixelRatio * 2 || 4;
    const viewport = page.getViewport({ scale });

    canvas.width = viewport.width;
    canvas.height = viewport.height;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    console.log("Canvas resolution:", canvas.width, canvas.height);
    console.log("Viewport scale:", scale);

    await page.render({
      canvasContext: ctx,
      viewport: viewport
    }).promise;

    // Get text items for question detection
    const textContent = await page.getTextContent();
    const regions = detectQuestionRegions(textContent, canvas.width, canvas.height, viewport);

    for (const region of regions) {
      // Detect where answer options start so we can crop them OUT of the image
      const optData = findOptionBoundary(textContent, region.y1, region.y2, viewport);

      // Image bottom = just above first option (or full region if no options found)
      const imageCropBottom = optData.firstOptionY !== null
        ? Math.max(region.y1 + 40, optData.firstOptionY - GLOBAL_CROP.BOTTOM)
        : region.y2;

      const cropX = region.x1 + GLOBAL_CROP.LEFT;
      const cropY = region.y1 + GLOBAL_CROP.TOP;
      const cropW = (region.x2 - region.x1) - GLOBAL_CROP.LEFT - GLOBAL_CROP.RIGHT;
      const cropH = (imageCropBottom - region.y1) - GLOBAL_CROP.TOP;

      const imageDataUrl = cropCanvasRegion(
        canvas, cropX, cropY, cropW, cropH
      );
      allQuestions.push({
        id: globalId++,
        imageDataUrl,
        optionTexts: optData.options, // extracted Arabic option text ['', '', '', '']
        requiresOcr: optData.requiresOcr, // Flag if the extracted text failed the quality check
        _raw: {
          pageNum,                 // store page number for re-rendering
          region,
          imageCropBottom,  // used by manual crop adjustment
          canvasWidth: canvas.width,
          canvasHeight: canvas.height,
        },
        cropAdjust: { top: 0, bottom: 0, left: 0, right: 0 },
        options: ['A', 'B', 'C', 'D'],
        correct: null,
      });
    }
  }

  showProgress('جاري بناء الواجهة...', 95);
  appState.questions = allQuestions;

  if (allQuestions.length === 0) {
    showToast('لم يتم اكتشاف أي أسئلة. تأكد أن الملف يحتوي على كلمة "السؤال"', 'error');
    hideProgress();
    return;
  }

  renderQuestionList();
  updateStats();
  document.getElementById('exportBtn').disabled = false;
  hideProgress();
  showToast(`✓ تم اكتشاف ${allQuestions.length} سؤال`, 'success');
  selectQuestion(0);
}