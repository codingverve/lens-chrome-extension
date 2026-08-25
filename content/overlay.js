/**
 * overlay.js – Hover highlight & element selection logic for Ye Wala
 * Manages:
 *   - Hover outline overlay
 *   - Selected element overlay
 *   - Keyboard navigation (↑ parent, ↓ first child, ← prev sibling, → next sibling)
 *   - Click handler → opens annotation popover
 */

/* ---- Elements we skip ---- */
const SKIP_TAGS = new Set(['HTML', 'HEAD', 'SCRIPT', 'STYLE', 'META', 'LINK', 'NOSCRIPT']);
const YW_PREFIX = 'yw-'; // skip our own injected elements

function isSkippable(el) {
  if (!el || !el.tagName) return true;
  if (SKIP_TAGS.has(el.tagName)) return true;
  if (el.id && el.id.startsWith(YW_PREFIX)) return true;
  if (el.classList && Array.from(el.classList).some(c => c.startsWith(YW_PREFIX))) return true;
  return false;
}

/* ---- Overlay elements ---- */
let hoverOverlay = null;
let selectedOverlay = null;
let elementLabel = null;
let currentHovered = null;
let currentSelected = null;

function createOverlayElements() {
  hoverOverlay = document.createElement('div');
  hoverOverlay.className = 'yw-highlight-overlay';
  hoverOverlay.style.display = 'none';
  document.body.appendChild(hoverOverlay);

  selectedOverlay = document.createElement('div');
  selectedOverlay.className = 'yw-selected-overlay';
  selectedOverlay.style.display = 'none';
  document.body.appendChild(selectedOverlay);

  elementLabel = document.createElement('div');
  elementLabel.className = 'yw-element-label';
  elementLabel.style.display = 'none';
  document.body.appendChild(elementLabel);
}

function positionOverlay(overlay, el) {
  if (!el) { overlay.style.display = 'none'; return; }
  const rect = el.getBoundingClientRect();
  overlay.style.display = 'block';
  overlay.style.top = (rect.top + window.scrollY - 2) + 'px';
  overlay.style.left = (rect.left + window.scrollX - 2) + 'px';
  overlay.style.width = (rect.width + 4) + 'px';
  overlay.style.height = (rect.height + 4) + 'px';
}

function positionOverlayFixed(overlay, el) {
  if (!el) { overlay.style.display = 'none'; return; }
  const rect = el.getBoundingClientRect();
  overlay.style.display = 'block';
  overlay.style.top = (rect.top - 2) + 'px';
  overlay.style.left = (rect.left - 2) + 'px';
  overlay.style.width = (rect.width + 4) + 'px';
  overlay.style.height = (rect.height + 4) + 'px';
}

function updateHoverOverlay(el) {
  if (!el) { hoverOverlay.style.display = 'none'; elementLabel.style.display = 'none'; return; }
  positionOverlayFixed(hoverOverlay, el);

  // Position label: above element, or below if no room
  const rect = el.getBoundingClientRect();
  const tag = el.tagName.toLowerCase();
  const cls = Array.from(el.classList).filter(c => !c.startsWith('yw-')).slice(0, 1).join('');
  elementLabel.textContent = cls ? `${tag}.${cls}` : tag;
  elementLabel.style.display = 'block';

  const labelTop = rect.top - 22;
  if (labelTop > 4) {
    elementLabel.style.top = labelTop + 'px';
  } else {
    elementLabel.style.top = (rect.bottom + 4) + 'px';
  }
  elementLabel.style.left = Math.max(4, rect.left) + 'px';
}

function updateSelectedOverlay(el) {
  if (!el) { selectedOverlay.style.display = 'none'; return; }
  positionOverlayFixed(selectedOverlay, el);
}

/* ---- Scroll update ---- */
function onScroll() {
  if (currentHovered) updateHoverOverlay(currentHovered);
  if (currentSelected) updateSelectedOverlay(currentSelected);
}

/* ---- Hover handler ---- */
function onMouseMove(e) {
  const el = e.target;
  if (isSkippable(el) || el === currentHovered) return;
  currentHovered = el;
  updateHoverOverlay(el);
}

function onMouseLeave() {
  currentHovered = null;
  updateHoverOverlay(null);
}

/* ---- Click handler ---- */
function onClick(e) {
  const el = e.target;
  if (isSkippable(el)) return;
  e.stopPropagation();
  e.preventDefault();

  currentSelected = el;
  updateSelectedOverlay(el);
  hoverOverlay.style.display = 'none';
  elementLabel.style.display = 'none';

  // Fire custom event so content.js can open the popover
  document.dispatchEvent(new CustomEvent('yw:elementSelected', { detail: { element: el } }));
}

/* ---- Keyboard navigation ---- */
function navigateElement(direction) {
  if (!currentSelected) return;

  let next = null;
  switch (direction) {
    case 'parent':
      next = currentSelected.parentElement;
      break;
    case 'child':
      next = currentSelected.firstElementChild;
      break;
    case 'prev':
      next = currentSelected.previousElementSibling;
      break;
    case 'next':
      next = currentSelected.nextElementSibling;
      break;
  }

  if (next && !isSkippable(next)) {
    currentSelected = next;
    updateSelectedOverlay(next);
    next.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    document.dispatchEvent(new CustomEvent('yw:elementSelected', { detail: { element: next } }));
  }
}

function onKeyDown(e) {
  // Don't interfere when typing in inputs
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement.isContentEditable) return;

  if (e.key === 'ArrowUp') { e.preventDefault(); navigateElement('parent'); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); navigateElement('child'); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); navigateElement('prev'); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); navigateElement('next'); }
}

/* ---- Highlight an element externally (from bottom sheet hover) ---- */
function highlightElement(el) {
  if (!el) { hoverOverlay.style.display = 'none'; elementLabel.style.display = 'none'; return; }
  updateHoverOverlay(el);
}

function clearHighlight() {
  hoverOverlay.style.display = 'none';
  elementLabel.style.display = 'none';
}

/* ---- Public: Start/Stop overlay ---- */
function startOverlay() {
  if (!hoverOverlay) createOverlayElements();
  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('keydown', onKeyDown, true);
}

function stopOverlay() {
  document.removeEventListener('mousemove', onMouseMove, true);
  document.removeEventListener('click', onClick, true);
  document.removeEventListener('scroll', onScroll, { passive: true });
  document.removeEventListener('keydown', onKeyDown, true);
  if (hoverOverlay) hoverOverlay.style.display = 'none';
  if (selectedOverlay) selectedOverlay.style.display = 'none';
  if (elementLabel) elementLabel.style.display = 'none';
  currentHovered = null;
  currentSelected = null;
}

function clearSelection() {
  currentSelected = null;
  if (selectedOverlay) selectedOverlay.style.display = 'none';
}

function getSelectedElement() {
  return currentSelected;
}
