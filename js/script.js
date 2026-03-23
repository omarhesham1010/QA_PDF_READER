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
  TOP: 0,
  BOTTOM: 0,
  LEFT: 0,
  RIGHT: 0
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
  numeralType: 'en', // 'en' | 'ar'
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
  if (!list) return;
  list.innerHTML = '';

  appState.questions.forEach((q, idx) => {
    const isMissing = q.optionTexts && q.optionTexts.some(t => !t || t === `خيار ${q.options[q.optionTexts.indexOf(t)]}`);
    const item = document.createElement('div');
    item.className = 'q-item' + 
      (q.correct ? ' answered' : '') + 
      (q.requiresOcr ? ' needs-ocr' : '') + 
      (isMissing ? ' missing-options' : '');
    item.id = `q-item-${idx}`;

    item.innerHTML = `
      <span class="q-number">${q.id}</span>
      <span class="q-badge"></span>
      <button class="delete-q-btn" onclick="deleteQuestion(event, ${idx})" title="حذف السؤال">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
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
  // Fix race condition: Save any active edit before switching
  const activeEditing = document.querySelector('.answer-option-text.editing');
  if (activeEditing) {
    // Determine which letter was being edited
    const optLabel = activeEditing.closest('.answer-option');
    if (optLabel) {
      const letter = optLabel.id.replace('opt-', '');
      saveOptionEdit(letter);
    }
  }

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

  // Initialize Visual Cropper
  await initVisualCropper(q);

  // Update answer radio buttons and display extracted option text
  const optionKeys = ['A', 'B', 'C', 'D'];
  optionKeys.forEach((letter, i) => {
    const opt = document.getElementById(`opt-${letter}`);
    const radio = opt.querySelector('input[type=radio]');
    radio.checked = q.correct === letter;
    opt.classList.toggle('selected', q.correct === letter);

    // Show extracted option text if available, else generic label
    const textEl = opt.querySelector('.answer-option-text');
    let text = (q.optionTexts && q.optionTexts[i]) || `خيار ${letter}`;
    
    // Visual cue for missing/defaulted options
    const isDefault = !q.optionTexts || !q.optionTexts[i] || q.optionTexts[i] === `خيار ${letter}`;
    opt.classList.toggle('missing', isDefault);

    // Apply numeral conversion if needed
    if (appState.numeralType === 'ar') {
      text = convertNumerals(text, true);
    } else if (appState.numeralType === 'en') {
      text = convertNumerals(text, false);
    }

    textEl.textContent = text;
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

/**
 * Enable editing for an MCQ option text.
 * @param {Event} event 
 * @param {string} letter - 'A' | 'B' | 'C' | 'D'
 */
function enableOptionEdit(event, letter) {
  event.preventDefault();
  event.stopPropagation(); // Avoid triggering selectAnswer

  const opt = document.getElementById(`opt-${letter}`);
  const textEl = opt.querySelector('.answer-option-text');

  if (textEl.getAttribute('contenteditable') === 'true') return;

  textEl.setAttribute('contenteditable', 'true');
  textEl.classList.add('editing');
  textEl.focus();

  // Select all text
  const range = document.createRange();
  range.selectNodeContents(textEl);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  // Save on blur or Enter
  const onBlur = () => {
    saveOptionEdit(letter);
    textEl.removeEventListener('blur', onBlur);
    textEl.removeEventListener('keydown', onKeydown);
  };

  const onKeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      textEl.blur();
    }
  };

  textEl.addEventListener('blur', onBlur);
  textEl.addEventListener('keydown', onKeydown);
}

/**
 * Save the edited MCQ option text.
 * @param {string} letter - 'A' | 'B' | 'C' | 'D'
 */
function saveOptionEdit(letter) {
  if (appState.currentIndex < 0) return;

  const q = appState.questions[appState.currentIndex];
  const opt = document.getElementById(`opt-${letter}`);
  if (!opt) return;

  const textEl = opt.querySelector('.answer-option-text');
  let newText = textEl.textContent.trim();

  // CLEANUP: Strip redundant markers (e.g. "A)", "1-", etc.)
  newText = cleanOptionText(newText, letter);

  textEl.setAttribute('contenteditable', 'false');
  textEl.classList.remove('editing');
  textEl.textContent = newText || `خيار ${letter}`; // Fallback if empty

  const optionKeys = ['A', 'B', 'C', 'D'];
  const idx = optionKeys.indexOf(letter);

  if (!q.optionTexts) {
    q.optionTexts = q.options.slice();
  }
  
  const oldText = q.optionTexts[idx];
  q.optionTexts[idx] = newText;

  if (oldText !== newText) {
    showToast('تم حفظ وتنظيف التعديل', 'success');
    updateStats();
    
    // Update individual option UI
    opt.classList.toggle('missing', !newText || newText === `خيار ${letter}`);
    
    // Update sidebar badge if missing status changed
    const isAnyMissing = q.optionTexts.some((t, i) => !t || t === `خيار ${['A','B','C','D'][i]}`);
    const listItem = document.getElementById(`q-item-${appState.currentIndex}`);
    if (listItem) {
      listItem.classList.toggle('missing-options', isAnyMissing);
    }
  }
}

/**
 * Clean option text by removing redundant markers (e.g. "A)", "1-", etc.)
 * @param {string} text 
 * @param {string} letter 
 * @returns {string}
 */
function cleanOptionText(text, letter) {
  if (!text) return '';

  // 1. Remove markers like "A)", "A-", "A.", "(A)", "A :"
  // Supports both Latin (A-D) and Arabic (أ-د)
  const arabicLetter = convertOptionLetterToArabic(letter);
  const patterns = [
    new RegExp(`^\\s*\\(?${letter}[\\)\\-\\.\\:\\/\\s]+`, 'i'),
    new RegExp(`^\\s*\\(?${arabicLetter}[\\)\\-\\.\\:\\/\\s]+`)
  ];

  let cleaned = text;
  patterns.forEach(p => {
    cleaned = cleaned.replace(p, '');
  });

  // 2. Remove numeric markers like "1)", "1-", "1."
  cleaned = cleaned.replace(/^\s*\d+[\)\-\.\:\/]\s*/, '');

  return cleaned.trim();
}

/**
 * Helper to get Arabic equivalent of A/B/C/D
 */
function convertOptionLetterToArabic(letter) {
  const map = { 'A': 'أ', 'B': 'ب', 'C': 'ج', 'D': 'د' };
  return map[letter] || letter;
}

// ============================
// MANUAL CROP ADJUSTMENT
// ============================

/**
 * Re-crop the current question image with manual offset values.
 * (DEPRECATED - replaced by visual cropper, but kept for compatibility if needed)
 */
function applyManualCrop() {
  if (appState.currentIndex < 0) return;
  const q = appState.questions[appState.currentIndex];

  rerenderQuestionImage(q).then(dataUrl => {
    q.imageDataUrl = dataUrl;
    document.getElementById('q-image').src = dataUrl;
    showToast('تم تطبيق القص', 'success');
  });
}

// ============================
// VISUAL CROPPER
// ============================

let _cropperState = {
  isDragging: false,
  activeHandle: null,
  startX: 0,
  startY: 0,
  initialBox: null,
  q: null,
  contextPadding: 150, // Match the value in rerenderQuestionImage
  globalEventsSet: false
};

/**
 * Initialize the visual cropper for the selected question.
 */
async function initVisualCropper(q) {
  _cropperState.q = q;
  const viewport = document.getElementById('cropper-viewport');
  const img = document.getElementById('q-image');
  const box = document.getElementById('crop-box');

  // Show the region WITH context padding
  const fullDataUrl = await rerenderQuestionImage(q, true);
  img.src = fullDataUrl;

  img.onload = () => {
    updateCropUI(q);
    // Setup events ONLY once globally
    if (!_cropperState.eventsInitialized) {
      setupCropperEvents();
      _cropperState.eventsInitialized = true;
    }
  };
}

/**
 * Update the crop box UI based on current question adjustments.
 */
function updateCropUI(q) {
  const img = document.getElementById('q-image');
  const box = document.getElementById('crop-box');
  if (!img || !box || !img.clientWidth) return;

  const imgW = img.clientWidth;
  const imgH = img.clientHeight;

  const { region } = q._raw;
  const cropBottom = q._raw.imageCropBottom || region.y2;

  // The 'full' image dimensions INCLUDE context padding
  const fullW = (region.x2 - region.x1) + (_cropperState.contextPadding * 2);
  const fullH = (cropBottom - region.y1) + (_cropperState.contextPadding * 2);

  const scaleX = imgW / fullW;
  const scaleY = imgH / fullH;

  // The crop box starts at the index (contextPadding) relative to the top-left of the full image
  // PLUS the user's manual cropAdjust increments.
  const left = (_cropperState.contextPadding + q.cropAdjust.left) * scaleX;
  const top = (_cropperState.contextPadding + q.cropAdjust.top) * scaleY;

  const width = (region.x2 - region.x1 - q.cropAdjust.left - q.cropAdjust.right) * scaleX;
  const height = (cropBottom - region.y1 - q.cropAdjust.top - q.cropAdjust.bottom) * scaleY;

  box.style.left = left + 'px';
  box.style.top = top + 'px';
  box.style.width = width + 'px';
  box.style.height = height + 'px';
}

/**
 * Set up global interaction events (mouse + touch).
 */
function setupCropperEvents() {
  const box = document.getElementById('crop-box');
  if (!box) return;

  // Dragging the whole box
  const onBoxStart = (e) => {
    // We don't stopPropagation here normally, but we need to identify the target
    startDrag(e, 'move');
  };
  box.addEventListener('mousedown', onBoxStart);
  box.addEventListener('touchstart', onBoxStart, { passive: false });

  // Resizing via handles
  document.querySelectorAll('.crop-handle').forEach(h => {
    const handleType = h.getAttribute('data-handle');
    const onHandleStart = (e) => {
      e.stopPropagation(); // CRITICAL: Prevent bubbling to #crop-box (which triggers 'move')
      startDrag(e, handleType);
    };
    h.addEventListener('mousedown', onHandleStart);
    h.addEventListener('touchstart', onHandleStart, { passive: false });
  });

  // Global move/end listeners (only added once)
  if (!_cropperState.globalEventsSet) {
    window.addEventListener('mousemove', (e) => doDrag(e));
    window.addEventListener('touchmove', (e) => doDrag(e), { passive: false });
    window.addEventListener('mouseup', () => endDrag());
    window.addEventListener('touchend', () => endDrag());
    _cropperState.globalEventsSet = true;
  }
}

function startDrag(e, handle = 'move') {
  if (!_cropperState.q) return;

  // Support both mouse and touch
  const clientX = e.type.startsWith('touch') ? e.touches[0].clientX : e.clientX;
  const clientY = e.type.startsWith('touch') ? e.touches[0].clientY : e.clientY;

  e.preventDefault();
  const box = document.getElementById('crop-box');

  _cropperState.isDragging = true;
  _cropperState.activeHandle = handle;
  _cropperState.startX = clientX;
  _cropperState.startY = clientY;
  _cropperState.initialBox = {
    left: parseFloat(box.style.left),
    top: parseFloat(box.style.top),
    width: parseFloat(box.style.width),
    height: parseFloat(box.style.height)
  };
}

function doDrag(e) {
  if (!_cropperState.isDragging) return;
  e.preventDefault();

  const clientX = e.type.startsWith('touch') ? e.touches[0].clientX : e.clientX;
  const clientY = e.type.startsWith('touch') ? e.touches[0].clientY : e.clientY;

  const dx = clientX - _cropperState.startX;
  const dy = clientY - _cropperState.startY;

  const img = document.getElementById('q-image');
  const box = document.getElementById('crop-box');
  const init = _cropperState.initialBox;
  const handle = _cropperState.activeHandle;

  let newLeft = init.left;
  let newTop = init.top;
  let newWidth = init.width;
  let newHeight = init.height;

  // Constraints: keep box inside image
  const maxW = img.clientWidth;
  const maxH = img.clientHeight;

  if (handle === 'move') {
    newLeft = Math.max(0, Math.min(maxW - init.width, init.left + dx));
    newTop = Math.max(0, Math.min(maxH - init.height, init.top + dy));
  } else {
    // Resizing
    const minS = 30; // Min box size
    if (handle.includes('l')) {
      newLeft = Math.max(0, Math.min(init.left + init.width - minS, init.left + dx));
      newWidth = init.width + (init.left - newLeft);
    }
    if (handle.includes('r')) {
      newWidth = Math.max(minS, Math.min(maxW - init.left, init.width + dx));
    }
    if (handle.includes('t')) {
      newTop = Math.max(0, Math.min(init.top + init.height - minS, init.top + dy));
      newHeight = init.height + (init.top - newTop);
    }
    if (handle.includes('b')) {
      newHeight = Math.max(minS, Math.min(maxH - init.top, init.height + dy));
    }
  }

  box.style.left = newLeft + 'px';
  box.style.top = newTop + 'px';
  box.style.width = newWidth + 'px';
  box.style.height = newHeight + 'px';

  syncCropToState();
}

function syncCropToState() {
  const q = _cropperState.q;
  const img = document.getElementById('q-image');
  const box = document.getElementById('crop-box');

  const imgW = img.clientWidth;
  const imgH = img.clientHeight;

  const { region } = q._raw;
  const cropBottom = q._raw.imageCropBottom || region.y2;

  const fullW = (region.x2 - region.x1) + (_cropperState.contextPadding * 2);
  const fullH = (cropBottom - region.y1) + (_cropperState.contextPadding * 2);

  const scaleX = fullW / imgW;
  const scaleY = fullH / imgH;

  const left = parseFloat(box.style.left);
  const top = parseFloat(box.style.top);
  const width = parseFloat(box.style.width);
  const height = parseFloat(box.style.height);

  // Map UI box coordinates back to cropAdjust values
  // Formula: UI_Left = (contextPadding + cropAdjust.left) * scale
  // -> cropAdjust.left = (UI_Left / scale) - contextPadding
  q.cropAdjust = {
    left: Math.round((left * scaleX) - _cropperState.contextPadding),
    top: Math.round((top * scaleY) - _cropperState.contextPadding),
    right: Math.round(((imgW - (left + width)) * scaleX) - _cropperState.contextPadding),
    bottom: Math.round(((imgH - (top + height)) * scaleY) - _cropperState.contextPadding)
  };
}

function endDrag() {
  if (!_cropperState.isDragging) return;
  _cropperState.isDragging = false;

  // Re-save question if needed (state is already updated in doDrag)
  updateStats();
}

/**
 * Reset to automatic/default crop.
 */
function resetCrop() {
  if (!_cropperState.q) return;
  _cropperState.q.cropAdjust = { top: 5, bottom: 15, left: 5, right: 5 };
  updateCropUI(_cropperState.q);
  showToast('تمت إعادة تعيين القص', 'success');
}

/**
 * Re-render a single question's image using stored raw crop region + adjustments.
 * @param {object} q - question object
 * @returns {Promise<string>} data URL
 */
async function rerenderQuestionImage(q, full = false) {
  const canvas = document.getElementById('pdf-canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  const { region } = q._raw;

  // When 'full' is true (for the cropper view), we add substantial padding 
  // to give the user "smart" context around the question.
  const contextPadding = full ? 150 : 0;
  const adj = full ? { top: 0, bottom: 0, left: 0, right: 0 } : q.cropAdjust;

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

  // Calculate coordinates with context padding for the 'full' view
  const x1 = Math.max(0, region.x1 - contextPadding + adj.left);
  const y1 = Math.max(0, region.y1 - contextPadding + adj.top);

  // Note: for the full view, we want to expand OUTWARDS, so we subtract from x1/y1 and add to x2/y2
  const x2 = Math.min(canvas.width, region.x2 + contextPadding - adj.right);
  const cropBottom = q._raw.imageCropBottom || region.y2;
  const y2 = Math.min(canvas.height, cropBottom + contextPadding - adj.bottom);

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

  // Header stats
  const totalEl = document.getElementById('header-stat-total');
  if (totalEl) totalEl.textContent = total;

  const answeredEl = document.getElementById('header-stat-answered');
  if (answeredEl) answeredEl.textContent = answered;

  const pctEl = document.getElementById('header-completion-pct');
  if (pctEl) pctEl.textContent = pct + '%';

  // Show/Hide header stats
  const headerStats = document.getElementById('header-stats');
  if (headerStats) {
    headerStats.style.display = total > 0 ? 'flex' : 'none';
  }
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
  const list = document.getElementById('question-list');
  if (list) list.innerHTML = '';
  document.getElementById('exportBtn').disabled = true;
  document.getElementById('empty-state').style.display = '';
  document.getElementById('question-viewer').classList.remove('visible');
  updateStats();
}

// ============================
// THEME TOGGLE
// ============================

/**
 * Toggle between light and dark themes.
 */
function toggleTheme() {
  const html = document.documentElement;
  const currentTheme = html.getAttribute('data-theme') || 'dark';
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  html.setAttribute('data-theme', newTheme);
  localStorage.setItem('theme', newTheme);
}

// Initialize theme on load
(function initTheme() {
  const savedTheme = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
})();

// ============================
// NUMERAL TOGGLE
// ============================

/**
 * Toggle between English and Arabic numerals.
 */
function toggleNumerals() {
  appState.numeralType = appState.numeralType === 'en' ? 'ar' : 'en';
  document.documentElement.setAttribute('data-nums', appState.numeralType);
  localStorage.setItem('numeralType', appState.numeralType);

  // Re-render current question to update display
  if (appState.currentIndex >= 0) {
    selectQuestion(appState.currentIndex);
  }
}

/**
 * Convert numerals in a string between English and Arabic.
 * @param {string} text 
 * @param {boolean} toAr - if true, English -> Arabic; else Arabic -> English
 * @returns {string}
 */
function convertNumerals(text, toAr) {
  const en = '0123456789'.split('');
  const ar = '٠١٢٣٤٥٦٧٨٩'.split('');

  if (toAr) {
    return text.replace(/[0-9]/g, (d) => ar[en.indexOf(d)]);
  } else {
    return text.replace(/[٠-٩]/g, (d) => en[ar.indexOf(d)]);
  }
}

/**
 * Initialize numeral preference.
 */
(function initNumerals() {
  const saved = localStorage.getItem('numeralType') || 'en';
  appState.numeralType = saved;
  document.documentElement.setAttribute('data-nums', saved);
})();

// ============================
// ARABIC TEXT CLEANUP
// ============================

/**
 * Fix common Arabic PDF extraction issues (e.g. reversed ligatures).
 * @param {string} text
 * @returns {string}
 */
// ============================
// ARABIC PDF TEXT NORMALIZATION PIPELINE
// ============================

const ARABIC_NORM_CONFIG = {
  // 1. Corrupted characters to remove
  garbageRegex: /[\uFFFD\u200B-\u200F\uFEFF]/g,

  // 2. Normalization map (reduce variations)
  normalizationMap: {
    'إ': 'ا', 'أ': 'ا', 'آ': 'ا', 'ٱ': 'ا',
    'ى': 'ي'
  },

  // 3. Common PDF Ligature/Artifact map
  artifactMap: {
    'األ': 'الأ',
    'اإل': 'الإ',
    'اآل': 'الآ',
    'اال': 'الا',
    'ىل': 'لى',
    'ىع': 'عى',
    'ىف': 'فى'
  },

  // 4. Expected Dictionary (Full words)
  dictionary: [
    'أكبر', 'أصغر', 'يساوي', 'المعطيات', 'كافية', 'غير',
    'القيمتان', 'متساويتان', 'متساوية', 'متساويين',
    'الأولى', 'الثانية', 'الثالثة', 'الرابعة'
  ],

  // 5. Short fragments -> Dictionary expanded matches
  autocorrectMap: {
    'أك': 'أكبر',
    'أص': 'أصغر'
    // 'غ': 'غير' // Removed to avoid "غير ير" issue; handled by context/fragment repair
  }
};

/**
 * Stage 1: Remove corrupted PDF characters.
 */
function removeCorruptedChars(text) {
  return text.replace(ARABIC_NORM_CONFIG.garbageRegex, '');
}

/**
 * Stage 2: Normalize letter variants to base forms.
 */
function normalizeArabicLetters(text) {
  let result = text;
  Object.entries(ARABIC_NORM_CONFIG.normalizationMap).forEach(([variant, base]) => {
    result = result.split(variant).join(base);
  });
  return result;
}

/**
 * Stage 3: Fix common PDF ligatures and extraction artifacts.
 */
function fixPdfArtifacts(text) {
  let result = text;
  Object.entries(ARABIC_NORM_CONFIG.artifactMap).forEach(([broken, fixed]) => {
    result = result.split(broken).join(fixed);
  });
  return result;
}

/**
 * Stage 4: Intelligently merge fragmented Arabic words.
 */
function repairFragments(text) {
  // Merge fragments like "غ ير" or "الم عطيات"
  // Logic: if a space is preceded/followed by parts of a dictionary word, merge them.
  let result = text;
  ARABIC_NORM_CONFIG.dictionary.forEach(word => {
    if (word.length < 3) return;
    for (let i = 1; i < word.length; i++) {
        const part1 = word.substring(0, i);
        const part2 = word.substring(i);
        const broken = `${part1} ${part2}`;
        result = result.split(broken).join(word);
    }
  });
  return result;
}

/**
 * Stage 5: Expand short fragments to expected dictionary terms.
 */
function applyDictionaryAutocorrect(text) {
  let result = text;
  // Stage 5: Expand short fragments to expected dictionary terms.
  Object.entries(ARABIC_NORM_CONFIG.autocorrectMap).forEach(([short, full]) => {
    const regex = new RegExp(`(^|\\s)${short}(?=\\s|$)`, 'g');
    result = result.replace(regex, `$1${full}`);
  });

  // Specific contextual / legacy fixes
  result = result.replace(/(^|\s)غ(?=\s+كافية)/g, '$1غير');
  result = result.replace(/غير\s+كافية/g, 'غير كافية');
  result = result.replace(/المعطيات\s+غير/g, 'المعطيات غير');
  
  return result;
}

/**
 * Stage 6: Final whitespace normalization.
 */
function cleanWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Structured Arabic Normalization Pipeline.
 * Replaces the old fragmented fixArabicPDFText logic.
 * @param {string} text
 * @returns {object} { text: string, heuristicsApplied: boolean }
 */
function fixArabicPDFText(text) {
  if (!text) return { text: '', heuristicsApplied: false };
  const original = text;
  
  let current = text;
  current = removeCorruptedChars(current);
  current = fixPdfArtifacts(current); // Artifacts first before normalization
  current = normalizeArabicLetters(current);
  current = repairFragments(current);
  current = applyDictionaryAutocorrect(current);
  current = cleanWhitespace(current);
  
  return {
    text: current,
    heuristicsApplied: original !== current && current.length > 0
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
  const LATIN_LETTERS = ['A', 'B', 'C', 'D'];
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
  const latinCount = items.filter(it => LATIN_LETTERS.includes(it.norm)).length;
  const arabicCount = items.filter(it => ARABIC_LETTERS.includes(it.norm)).length;
  const useLatin = latinCount > arabicCount;
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
  if (megaclusters.length > 0) {
    // Collect the BEST instance of each letter across ALL clusters in the region
    // This handles cases where markers are slightly misaligned vertically
    for (const letter of OPTION_LETTERS) {
      const allCandsForLetter = megaclusters
        .flatMap(m => m.candidates)
        .filter(c => c.letter === letter)
        .sort((a, b) => a.x - b.x);
      
      if (allCandsForLetter.length > 0) {
        // Pick the one that belongs to the largest cluster or is the most "stable"
        // For now, just pick the rightmost for Arabic or leftmost for Latin? 
        // No, let's pick the one from the largest cluster if possible.
        const fromBestCluster = allCandsForLetter.find(c => bestCluster.candidates.includes(c));
        labelItems[letter] = fromBestCluster ? fromBestCluster.item : allCandsForLetter[0].item;
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

  // Determine direction based on the actual labels found in the chosen cluster
  const foundArabic = ARABIC_LETTERS.some(l => !!labelItems[l]);
  const foundLatin = LATIN_LETTERS.some(l => !!labelItems[l]);
  const finalUseLatin = (foundLatin && !foundArabic);

  rows.forEach(row => {
    if (finalUseLatin) {
      row.labels.sort((a, b) => a.item.x - b.item.x); // LTR
    } else {
      row.labels.sort((a, b) => b.item.x - a.item.x); // RTL
    }
  });

  const boundaries = {};
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const prevRow = rows[r - 1];
    const nextRow = rows[r + 1];

    const yMin = prevRow ? (prevRow.y + row.y) / 2 : row.y - 25;
    const yMax = nextRow ? (row.y + nextRow.y) / 2 : row.y + 50;

    for (const pl of row.labels) {
        boundaries[pl.letter] = { yMin, yMax };
    }
  }

  const optionMap = {};
  const metrics = {};
  const debugBoxes = [];
  const optionBins = {};
  OPTION_LETTERS.forEach(l => {
    optionMap[l] = '';
    optionBins[l] = [];
    if (boundaries[l]) {
        // For debug visualization: center around the label
        debugBoxes.push({ 
            letter: l, 
            bounds: { 
                yMin: boundaries[l].yMin, 
                yMax: boundaries[l].yMax,
                xMin: labelItems[l].x - 180, 
                xMax: labelItems[l].x + 40
            } 
        });
    }
  });

  // Assign every non-label item to its nearest label in the reading direction
  for (const it of items) {
    if (OPTION_LETTERS.includes(it.norm)) continue;
    
    // If this item was used as a label position, we need to extract the text PART
    const usedAsLabelEntry = Object.entries(labelItems).find(([l, item]) => item === it);
    let itemNorm = it.norm;
    if (usedAsLabelEntry) {
      const [letter, ] = usedAsLabelEntry;
      const letterAr = convertOptionLetterToArabic(letter);
      const patterns = [
        new RegExp(`^\\s*\\(?${letter}[\\)\\-\\.\\:\\/\\s]+`, 'i'),
        new RegExp(`^\\s*\\(?${letterAr}[\\)\\-\\.\\:\\/\\s]+`)
      ];
      patterns.forEach(p => { itemNorm = itemNorm.replace(p, ''); });
      if (!itemNorm.trim()) continue; // Was ONLY a label
    }

    let bestLetter = null;
    let minDistance = Infinity;

    for (const letter of OPTION_LETTERS) {
      const bounds = boundaries[letter];
      const labelItem = labelItems[letter];
      if (!bounds || !labelItem) continue;

      if (it.y >= bounds.yMin && it.y < bounds.yMax) {
        if (finalUseLatin) {
          const dx = it.x - labelItem.x;
          if (dx > -15 && dx < minDistance) {
            minDistance = dx;
            bestLetter = letter;
          }
        } else {
          // RTL: Label is to the RIGHT of the text
          const dx = labelItem.x - it.x;
          // Log for debugging Q3
          if (it.norm.includes('القيمة')) {
            console.log(`[DEBUG Proximity] Item: "${it.norm}", Label: ${letter}, dx: ${dx}`);
          }
          if (dx > -15 && dx < minDistance) {
            minDistance = dx;
            bestLetter = letter;
          }
        }
      }
    }

    if (bestLetter) {
        // Carry the simplified/stripped text if it was a combined object
        const itToPush = usedAsLabelEntry ? { ...it, norm: itemNorm.trim() } : it;
        optionBins[bestLetter].push(itToPush);
    }
  }

  let totalFragments = 0;
  let anyOptionCorruptedOrFragmented = false;

  for (const letter of OPTION_LETTERS) {
    const regionItems = optionBins[letter];
    if (regionItems.length > 0) {
      const uniqueItems = [];
      for (const it of regionItems) {
        const isDupe = uniqueItems.some(u =>
          u.norm === it.norm && Math.abs(u.x - it.x) < 5 && Math.abs(u.y - it.y) < 5
        );
        if (!isDupe) uniqueItems.push(it);
      }
      uniqueItems.sort((a, b) => {
        if (Math.abs(a.y - b.y) > 8) return a.y - b.y;
        return finalUseLatin ? a.x - b.x : b.x - a.x;
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