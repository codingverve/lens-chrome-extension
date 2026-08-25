/**
 * bottomSheet.js – Floating bottom sheet for Ye Wala
 * Shows all annotations, search, JSON view, copy, and row interactions.
 */

let sheetEl = null;
let isSheetVisible = false;
let isDragging = false;
let dragStartY = 0;
let dragStartHeight = 0;
const SHEET_MIN_HEIGHT = 52; // collapsed (header only)
const SHEET_DEFAULT_HEIGHT = 240;
const SHEET_MAX_HEIGHT = 520;

/* ---- JSON Modal ---- */
let jsonModalEl = null;

function showJSONModal(data) {
  if (jsonModalEl) jsonModalEl.remove();

  const jsonStr = exportJSON(data);
  jsonModalEl = document.createElement('div');
  jsonModalEl.id = 'yw-json-modal';
  jsonModalEl.innerHTML = `
    <div class="yw-json-modal-box">
      <div class="yw-json-modal-header">
        <span class="yw-json-modal-title">📋 Annotation JSON</span>
        <button class="yw-json-modal-close" id="yw-json-close">✕</button>
      </div>
      <pre class="yw-json-pre">${escapeHtml(jsonStr)}</pre>
      <div class="yw-json-modal-footer">
        <button class="yw-btn yw-btn-secondary" id="yw-json-modal-close2">Close</button>
        <button class="yw-btn yw-btn-primary" id="yw-json-modal-copy">Copy JSON</button>
      </div>
    </div>
  `;
  document.body.appendChild(jsonModalEl);

  jsonModalEl.addEventListener('click', (e) => {
    if (e.target === jsonModalEl) closeJSONModal();
  });
  document.getElementById('yw-json-close').addEventListener('click', closeJSONModal);
  document.getElementById('yw-json-modal-close2').addEventListener('click', closeJSONModal);
  document.getElementById('yw-json-modal-copy').addEventListener('click', () => {
    copyToClipboard(jsonStr);
    showToast('JSON copied!', 'success');
  });
}

function closeJSONModal() {
  if (jsonModalEl) { jsonModalEl.remove(); jsonModalEl = null; }
}

/* ---- Toast ---- */
function showToast(msg, type = 'success') {
  const existing = document.querySelector('.yw-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  const icon = type === 'success' ? '✓' : '✕';
  toast.className = `yw-toast yw-${type}`;
  toast.innerHTML = `<span class="yw-toast-icon">${icon}</span> ${msg}`;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('yw-toast-out');
    setTimeout(() => toast.remove(), 350);
  }, 2200);
}

/* ---- Clipboard ---- */
function copyToClipboard(text) {
  navigator.clipboard.writeText(text).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  });
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ---- Create Bottom Sheet ---- */
function createBottomSheet() {
  if (sheetEl) sheetEl.remove();

  sheetEl = document.createElement('div');
  sheetEl.id = 'yw-bottom-sheet';
  sheetEl.style.height = SHEET_DEFAULT_HEIGHT + 'px';
  sheetEl.innerHTML = `
    <div class="yw-sheet-drag-handle" id="yw-drag-handle"></div>
    <div class="yw-sheet-header">
      <div class="yw-sheet-logo">
        <div class="yw-sheet-logo-icon">✦</div>
        <span class="yw-sheet-title">Ye Wala</span>
        <span class="yw-sheet-count" id="yw-annotation-count">0</span>
      </div>
      <div class="yw-sheet-spacer"></div>
      <div class="yw-search-wrap">
        <span class="yw-search-icon">🔍</span>
        <input class="yw-sheet-search" id="yw-search-input" type="text" placeholder="Search..." />
      </div>
      <button class="yw-sheet-btn" id="yw-view-json-btn">{ } JSON</button>
      <button class="yw-sheet-btn yw-sheet-btn-copy" id="yw-copy-btn">⎘ Copy</button>
    </div>
    <div class="yw-annotation-list" id="yw-annotation-list">
      <div class="yw-empty-state">
        <div class="yw-empty-icon">🎯</div>
        <div class="yw-empty-title">No annotations yet</div>
        <div class="yw-empty-desc">Hover over any element and click to annotate it.<br/>Your annotations will appear here.</div>
      </div>
    </div>
  `;
  document.body.appendChild(sheetEl);

  // Drag to resize
  const handle = document.getElementById('yw-drag-handle');
  handle.addEventListener('mousedown', startDrag);

  // Search
  document.getElementById('yw-search-input').addEventListener('input', (e) => {
    renderAnnotationList(null, e.target.value);
  });

  // View JSON
  document.getElementById('yw-view-json-btn').addEventListener('click', async () => {
    const data = await loadAnnotations();
    showJSONModal(data);
  });

  // Copy
  document.getElementById('yw-copy-btn').addEventListener('click', async () => {
    const data = await loadAnnotations();
    if (!data.comments.length) {
      showToast('Nothing to copy yet!', 'error');
      return;
    }
    const json = exportJSON(data);
    copyToClipboard(json);

    const copyBtn = document.getElementById('yw-copy-btn');
    copyBtn.classList.add('yw-copied');
    copyBtn.textContent = '✓ Copied!';
    showToast('JSON copied to clipboard!', 'success');
    setTimeout(() => {
      copyBtn.classList.remove('yw-copied');
      copyBtn.textContent = '⎘ Copy';
    }, 2000);
  });
}

/* ---- Render Annotation List ---- */
async function renderAnnotationList(data, searchQuery = '') {
  if (!sheetEl) return;

  if (!data) data = await loadAnnotations();
  const listEl = document.getElementById('yw-annotation-list');
  const countEl = document.getElementById('yw-annotation-count');
  if (!listEl) return;

  const query = (searchQuery || '').toLowerCase();
  const filtered = query
    ? data.comments.filter(c =>
        c.comment.toLowerCase().includes(query) ||
        c.selector.toLowerCase().includes(query) ||
        (c.tag || '').toLowerCase().includes(query)
      )
    : data.comments;

  if (countEl) countEl.textContent = data.comments.length;

  if (!filtered.length) {
    listEl.innerHTML = `
      <div class="yw-empty-state">
        ${query
          ? `<div class="yw-empty-icon">🔍</div><div class="yw-empty-title">No matches</div><div class="yw-empty-desc">Try a different search term.</div>`
          : `<div class="yw-empty-icon">🎯</div><div class="yw-empty-title">No annotations yet</div><div class="yw-empty-desc">Hover over any element and click to annotate it.</div>`
        }
      </div>`;
    return;
  }

  listEl.innerHTML = filtered.map((ann, i) => `
    <div class="yw-annotation-row" data-selector="${escapeHtml(ann.selector)}" data-index="${i}">
      <span class="yw-row-index">${String(i + 1).padStart(2, '0')}</span>
      <div class="yw-row-info">
        <div class="yw-row-meta">
          <span class="yw-row-tag">${ann.tag || 'EL'}</span>
          <span class="yw-row-selector" title="${escapeHtml(ann.selector)}">${escapeHtml(ann.selector)}</span>
        </div>
        <div class="yw-row-comment">${escapeHtml(ann.comment)}</div>
      </div>
      <div class="yw-row-actions">
        <button class="yw-row-action-btn yw-edit" data-selector="${escapeHtml(ann.selector)}" title="Edit">✏</button>
        <button class="yw-row-action-btn yw-delete" data-selector="${escapeHtml(ann.selector)}" title="Delete">✕</button>
      </div>
    </div>
  `).join('');

  // Bind row events
  listEl.querySelectorAll('.yw-annotation-row').forEach(row => {
    const selector = row.dataset.selector;

    // Hover → highlight element
    row.addEventListener('mouseenter', () => {
      try {
        const el = document.querySelector(selector);
        if (el) highlightElement(el);
      } catch {}
    });
    row.addEventListener('mouseleave', () => clearHighlight());

    // Click → scroll to element
    row.addEventListener('click', (e) => {
      if (e.target.classList.contains('yw-row-action-btn')) return;
      try {
        const el = document.querySelector(selector);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch {}
    });
  });

  // Edit buttons
  listEl.querySelectorAll('.yw-row-action-btn.yw-edit').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const selector = btn.dataset.selector;
      try {
        const el = document.querySelector(selector);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          document.dispatchEvent(new CustomEvent('yw:elementSelected', { detail: { element: el } }));
        }
      } catch {}
    });
  });

  // Delete buttons
  listEl.querySelectorAll('.yw-row-action-btn.yw-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const selector = btn.dataset.selector;
      const data = await deleteAnnotation(selector);
      renderAnnotationList(data, searchQuery);
      showToast('Annotation deleted', 'success');
      document.dispatchEvent(new CustomEvent('yw:annotationsUpdated', { detail: data }));
    });
  });
}

/* ---- Drag to resize ---- */
function startDrag(e) {
  isDragging = true;
  dragStartY = e.clientY;
  dragStartHeight = sheetEl.offsetHeight;
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', stopDrag);
}
function onDragMove(e) {
  if (!isDragging) return;
  const delta = dragStartY - e.clientY;
  const newH = Math.min(SHEET_MAX_HEIGHT, Math.max(SHEET_MIN_HEIGHT, dragStartHeight + delta));
  sheetEl.style.height = newH + 'px';
}
function stopDrag() {
  isDragging = false;
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', stopDrag);
}

/* ---- Show / Hide ---- */
function showBottomSheet() {
  if (!sheetEl) createBottomSheet();
  sheetEl.style.display = 'flex';
  isSheetVisible = true;
  renderAnnotationList();
}

function hideBottomSheet() {
  if (sheetEl) sheetEl.style.display = 'none';
  isSheetVisible = false;
}

function refreshBottomSheet(data) {
  if (isSheetVisible) renderAnnotationList(data);
}
