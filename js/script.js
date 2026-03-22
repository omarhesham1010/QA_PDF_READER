// ============================
// CONFIGURATION
// ============================
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const RENDER_SCALE = 2.0;

/** Padding (px on rendered canvas) to add above/below each question region */
const DETECT_PADDING = 10;

/** 
 * إعدادات قص الصورة الافتراضية (بالبكسل - على حجم الـ Canvas)
 */
const GLOBAL_CROP = {
  TOP: 5,
  BOTTOM: 15,
  LEFT: 5,
  RIGHT: 5
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

// Global configuration for UI and visual debug
window.appConfig = {
  debugMode: false
};

function toggleDebugMode() {
  const checkbox = document.getElementById('debugModeCheckbox');
  if (checkbox) window.appConfig.debugMode = checkbox.checked;
  if (appState.currentIndex >= 0) {
    selectQuestion(appState.currentIndex);
  }
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
    // Support both Arabic 'السؤال' and Latin 'Question'
    if (normalized.includes('السؤال') || normalized.toLowerCase().startsWith('question') || normalized.toLowerCase().startsWith('q:')) {
      // Transform PDF coordinates to canvas pixel coordinates
      // item.transform = [scaleX, skewX, skewY, scaleY, x, y]
      const [, , , , pdfX, pdfY] = item.transform;
      // convert PDF user space to canvas pixels using viewport
      const [canvasX, canvasY] = viewport.convertToViewportPoint(pdfX, pdfY);
      questionYPositions.push({ y: canvasY, x: canvasX });
    }
  }

  if (questionYPositions.length === 0) {
    // FALLBACK for PDFs that don't use 'السؤال'
    // Support both Arabic (أ ب ج د) and Latin (A B C D) option labels
    const pageText = textContent.items.map(it => it.str).join(' ');

    const arabicRegex = /(?<![\u0621-\u064A])([\u0623\u0628\u062c\u062f])(?![\u0621-\u064A])/g;
    const arabicMatches = pageText.match(arabicRegex);
    const uniqueArabic = new Set(arabicMatches || []);

    const latinRegex = /(?<![A-Za-z])([ABCD])(?![A-Za-z])/g;
    const latinMatches = pageText.match(latinRegex);
    const uniqueLatin = new Set(latinMatches || []);

    const isAnswerKey = pageText.includes('الإجابات') && !pageText.includes('قارن');
    const isCoverPage = textContent.items.length < 20;

    const hasArabicOptions = uniqueArabic.size >= 3;
    const hasLatinOptions = uniqueLatin.size >= 3;

    if ((hasArabicOptions || hasLatinOptions) && !isAnswerKey && !isCoverPage) {
      // Fix: Added x1, x2 to ensure image captures full width
      return [{ x1: 0, y1: 0, x2: canvasWidth, y2: canvasHeight, qIdx: 0 }];
    }
    return [];
  }

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
      <button class="delete-q-btn" onclick="deleteQuestion(event, ${idx})" title="حذف السؤال">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          <line x1="10" y1="11" x2="10" y2="17"></line>
          <line x1="14" y1="11" x2="14" y2="17"></line>
        </svg>
      </button>
    `;
    item.addEventListener('click', () => selectQuestion(idx));
    list.appendChild(item);
  });
}

/**
 * Delete a question from the list.
 * @param {Event} event 
 * @param {number} idx 
 */
function deleteQuestion(event, idx) {
  event.stopPropagation(); // Prevent selectQuestion from firing

  if (!confirm('هل أنت متأكد من حذف هذا السؤال؟')) return;

  const deletedQ = appState.questions[idx];
  appState.questions.splice(idx, 1);

  // If no questions left, reset
  if (appState.questions.length === 0) {
    resetState();
  } else {
    // Always render list after modifying data
    renderQuestionList();

    if (appState.currentIndex === idx) {
      // If we deleted the current question, select the nearest available
      const nextIdx = Math.min(idx, appState.questions.length - 1);
      selectQuestion(nextIdx);
    } else {
      // Adjust currentIndex if an item before it was deleted
      if (appState.currentIndex > idx) {
        appState.currentIndex--;
      }
      // Restore active highlight for the current question (since its index may have changed)
      if (appState.currentIndex >= 0) {
        const activeItem = document.getElementById(`q-item-${appState.currentIndex}`);
        if (activeItem) activeItem.classList.add('active');
      }
    }
  }

  updateStats();
  showToast(`تم حذف السؤال ${deletedQ.id}`, 'success');

  // Disable export button if no questions left
  if (appState.questions.length === 0) {
    document.getElementById('exportBtn').disabled = true;
  }
}

// ============================
// QUESTION SELECTION & DISPLAY
// ============================

/**
 * Select and display a question by its list index.
 * @param {number} idx
 */
async function selectQuestion(idx) {
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

  // If debug mode is ON, we re-render and draw boxes; otherwise use the cached image
  if (window.appConfig.debugMode && q.debugBoxes) {
    const dataUrl = await renderWithDebugBoxes(q);
    document.getElementById('q-image').src = dataUrl;
  } else {
    document.getElementById('q-image').src = q.imageDataUrl;
  }

  document.getElementById('q-title').textContent = `السؤال ${q.id}`;

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

/**
 * Renders the question image WITH debug bounding boxes overlay.
 */
async function renderWithDebugBoxes(q) {
  const canvas = document.getElementById('pdf-canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  
  // Re-render the base image first
  await rerenderQuestionImage(q);
  
  // Now draw the boxes on top of the CROP (need to offset by crop coords)
  const { region } = q._raw;
  const adj = q.cropAdjust;
  const offsetX = region.x1 + adj.left;
  const offsetY = region.y1 + adj.top;

  // Draw boxes
  if (q.debugBoxes) {
    q.debugBoxes.forEach(box => {
      const b = box.bounds;
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#ef4444'; // Red for the box
      ctx.strokeRect(b.xMin - offsetX, b.yMin - offsetY, (b.xMax - b.xMin), (b.yMax - b.yMin));
      
      ctx.fillStyle = '#ef4444';
      ctx.font = 'bold 16px Inter, sans-serif';
      ctx.fillText(box.letter, b.xMin - offsetX + 5, b.yMin - offsetY + 20);
    });
  }

  return canvas.toDataURL('image/png');
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

  const viewport = page.getViewport({ scale: RENDER_SCALE });
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
        requiresOCR: q.requiresOcr,
        confidence: q.confidence || 0,
        fragments: q.totalFragments || 0,
        optionsMetrics: q.metrics || {}
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
  if (!text) return { text: '', heuristicsApplied: false };
  const original = text;

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

  const cleaned = text.trim();
  return {
    text: cleaned,
    heuristicsApplied: original !== cleaned && cleaned.length > 0
  };
}

/**
 * مرحلة التقييم التلقائي (Quality Check)
 * Evaluate extracted text quality to decide if OCR fallback is needed.
 * @param {string} text - The cleaned text
 * @param {string} rawText - The raw text before cleanup
 * @returns {boolean} true if text appears corrupted
 */
function evaluateExtractionQuality(text, rawText, heuristicsApplied = false) {
  if (!text.trim()) return { failed: true, reason: 'empty' };
  if (rawText && rawText.includes('\uFFFD') && !heuristicsApplied)
    return { failed: true, reason: 'corrupted_encoding' };

  // Check for excessive single letters (fragmentation: e.g. "ب ي ن" or "b e t w e e n")
  const regex = heuristicsApplied ? /(^|\s)[\u0600-\u06FF](?=\s|$)/g : /(^|\s)[a-zA-Z\u0600-\u06FF](?=\s|$)/g;
  const singleLetters = text.match(regex);
  if (singleLetters && singleLetters.length >= 3 && text.length < 15)
    return { failed: true, reason: 'fragmented' };

  return { failed: false, reason: null };
}

// ============================
// OPTION BOUNDARY DETECTION
// ============================

/**
 * Arabic MCQ option markers: أ ب ج د (equivalent to A B C D).
 * Uses cluster-based detection to find the true options row,
 * avoiding watermarks/headers that also contain Arabic letters.
 *
 * @param {TextContent} textContent - pdf.js page text content
 * @param {number} qY1 - question region top (canvas px)
 * @param {number} qY2 - question region bottom (canvas px)
 * @param {PageViewport} viewport
 * @returns {{ firstOptionY: number|null, options: string[], requiresOcr: boolean, metrics: object }}
 */
function findOptionBoundary(textContent, qY1, qY2, viewport) {
  const ARABIC_LETTERS = ['\u0623', '\u0628', '\u062c', '\u062f'];
  const LATIN_LETTERS  = ['A', 'B', 'C', 'D'];
  const ALL_OPTION_LETTERS = [...ARABIC_LETTERS, ...LATIN_LETTERS];

  // Collect all text items in the question region
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

  if (items.length === 0) return { firstOptionY: null, options: ['', '', '', ''], requiresOcr: true, metrics: {}, confidence: 0 };

  // Auto-detect: Latin A/B/C/D vs Arabic أ/ب/ج/د
  const latinCount  = items.filter(it => LATIN_LETTERS.includes(it.norm)).length;
  const arabicCount = items.filter(it => ARABIC_LETTERS.includes(it.norm)).length;
  const useLatin    = latinCount > arabicCount;
  const OPTION_LETTERS = useLatin ? LATIN_LETTERS : ARABIC_LETTERS;

  const optionRegex = useLatin
    ? /(?<![A-Za-z])([ABCD])(?![A-Za-z])/
    : /(?<![\u0621-\u064A])([\u0623\u0628\u062c\u062f])(?![\u0621-\u064A])/;

  const allCandidates = [];
  for (const it of items) {
    if (OPTION_LETTERS.includes(it.norm)) {
      allCandidates.push({ letter: it.norm, item: it, y: it.y, x: it.x });
      continue;
    }
    const match = it.norm.match(optionRegex);
    if (match) {
      allCandidates.push({ letter: match[1], item: it, y: it.y, x: it.x });
    }
  }

  // Megaclusters logic for robust row detection
  const megaclusters = [];
  for (const c of allCandidates) {
    let merged = false;
    for (const mega of megaclusters) {
      if (Math.abs(mega.y - c.y) <= 15) {
        mega.candidates.push(c);
        mega.uniqueLetters.add(c.letter);
        mega.y = (mega.y * (mega.candidates.length - 1) + c.y) / mega.candidates.length;
        merged = true;
        break;
      }
    }
    if (!merged) {
      megaclusters.push({ y: c.y, candidates: [c], uniqueLetters: new Set([c.letter]) });
    }
  }

  megaclusters.sort((a, b) => b.uniqueLetters.size - a.uniqueLetters.size || b.y - a.y);
  const bestCluster = megaclusters[0];

  const labelItems = {};
  if (bestCluster) {
    for (const letter of OPTION_LETTERS) {
      const cands = bestCluster.candidates.filter(c => c.letter === letter).sort((a, b) => a.x - b.x);
      if (cands.length > 0) {
        labelItems[letter] = cands[cands.length - 1].item;
      }
    }
  }

  if (Object.keys(labelItems).length === 0) {
    for (const item of items) {
      if (OPTION_LETTERS.includes(item.norm) && !labelItems[item.norm]) {
        labelItems[item.norm] = item;
      }
    }
  }

  if (Object.keys(labelItems).length === 0) {
    return { firstOptionY: null, options: ['', '', '', ''], requiresOcr: true, metrics: {}, confidence: 0, lettersDetected: false };
  }

  const presentLabels = OPTION_LETTERS.map(l => ({ letter: l, item: labelItems[l] })).filter(x => x.item);
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
  
  // RTL sorting for Arabic, LTR sorting for Latin
  rows.forEach(row => {
    if (useLatin) {
      row.labels.sort((a, b) => a.item.x - b.item.x); // LTR
    } else {
      row.labels.sort((a, b) => b.item.x - a.item.x); // RTL
    }
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
  const metrics = {};
  let totalFragments = 0;
  let anyOptionCorruptedOrFragmented = false;
  const debugBoxes = [];

  for (const letter of OPTION_LETTERS) {
    const bounds = boundaries[letter];
    if (!bounds) {
      optionMap[letter] = '';
      metrics[letter] = { fragmentCount: 0, failed: true, reason: 'empty_region' };
      continue;
    }

    debugBoxes.push({ letter, bounds });

    const regionItems = items.filter(c =>
      c !== labelItems[letter] &&
      !OPTION_LETTERS.includes(c.norm) &&
      c.y >= bounds.yMin && c.y < bounds.yMax &&
      c.x <= bounds.xMax && c.x > bounds.xMin
    );

    if (regionItems.length > 0) {
      // Deduplicate overlapping items (bold rendering artifact)
      const uniqueItems = [];
      for (const it of regionItems) {
        const isDupe = uniqueItems.some(u =>
          u.norm === it.norm && Math.abs(u.x - it.x) < 5 && Math.abs(u.y - it.y) < 5
        );
        if (!isDupe) uniqueItems.push(it);
      }
      uniqueItems.sort((a, b) => {
        if (Math.abs(a.y - b.y) > 10) return a.y - b.y;
        return b.x - a.x;
      });
      const rawText = uniqueItems.map(c => c.norm).join(' ').replace(/\s+/g, ' ').trim();
      const { text: cleanedText, heuristicsApplied } = fixArabicPDFText(rawText);
      optionMap[letter] = cleanedText;
      const evalQuality = evaluateExtractionQuality(cleanedText, rawText, heuristicsApplied);
      if (evalQuality.failed) anyOptionCorruptedOrFragmented = true;
      totalFragments += uniqueItems.length;
      metrics[letter] = {
        fragmentCount: uniqueItems.length,
        text: cleanedText,
        failed: evalQuality.failed,
        reason: evalQuality.reason,
        heuristicsApplied
      };
    } else {
      optionMap[letter] = '';
      metrics[letter] = { fragmentCount: 0, text: '', failed: true, reason: 'empty_region' };
    }
  }

  let optionsDetected = 0;
  for (const letter of OPTION_LETTERS) {
    if (optionMap[letter] && !metrics[letter].failed) optionsDetected++;
  }
  let penalty = 0;
  if (anyOptionCorruptedOrFragmented) penalty += 0.2;
  if (totalFragments > 20) penalty += 0.1;
  let confidence = (optionsDetected / 4) - penalty;
  confidence = Math.max(0, Math.min(1, confidence));
  const requiresOcr = confidence < 0.5;

  const labelYs = presentLabels.map(pl => pl.item.y);
  const firstOptionY = labelYs.length > 0 ? Math.min(...labelYs) : null;

  return {
    firstOptionY,
    options: OPTION_LETTERS.map(l => optionMap[l] || ''),
    metrics,
    requiresOcr,
    confidence,
    debugBoxes,
    totalFragments
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

    const viewport = page.getViewport({ scale: RENDER_SCALE });

    canvas.width = viewport.width;
    canvas.height = viewport.height;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

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

      // SRecords Diagnostic Logging (supports Latin and Arabic labels)
      console.log(`\n=== تشخيص السؤال ${globalId} (صفحة ${pageNum}) ===`);
      console.log(`Confidence Score: ${Math.round((optData.confidence || 0) * 100)}%`);
      console.log(`Requires OCR Fallback? ${optData.requiresOcr ? 'YES ⚠️' : 'No ✅'}`);
      if (optData.metrics) {
        Object.keys(optData.metrics).forEach(letter => {
          const m = optData.metrics[letter];
          if (m) console.log(`   خيار [${letter}]: CleanTextLength=${(m.text || '').length}, Fragments=${m.fragmentCount}, Failed Quality=${m.failed}`);
        });
      }

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
        optionTexts: optData.options,
        requiresOcr: optData.requiresOcr,
        confidence: optData.confidence,
        debugBoxes: optData.debugBoxes,
        totalFragments: optData.totalFragments,
        metrics: optData.metrics,
        _raw: {
          pageNum,
          region,
          imageCropBottom,
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