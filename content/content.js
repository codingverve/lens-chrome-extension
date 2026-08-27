/**
 * content.js – Main orchestrator for Lens Chrome Extension
 *
 * Loads all modules (overlay, annotations, sidebar) and wires them together.
 * Activated via message from popup or background service worker.
 */

/* ============================================================
   INLINE: annotations.js
   ============================================================ */

const YW_STORAGE_KEY = 'yw_annotations';

function buildSelector(element) {
  if (!element || element === document.body) return 'body';
  if (element.id && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(element.id)) {
    return '#' + element.id;
  }
  const parts = [];
  let current = element;
  while (current && current !== document.documentElement) {
    let sel = current.tagName.toLowerCase();
    const classes = Array.from(current.classList)
      .filter(c => c.length > 1 && !/^\d/.test(c) && !/^(css|styles?|sc-|_|yw-)/.test(c))
      .slice(0, 2);
    if (classes.length > 0) sel += '.' + classes.join('.');
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(el => el.tagName === current.tagName);
      if (siblings.length > 1) sel += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    }
    parts.unshift(sel);
    if (current.id && /^[a-zA-Z]/.test(current.id)) { parts[0] = '#' + current.id; break; }
    current = current.parentElement;
  }
  return parts.join(' > ');
}

function getPageKey(url) {
  try { const u = new URL(url || window.location.href); return u.origin + u.pathname; }
  catch { return window.location.href; }
}

function loadAnnotations(url) {
  const key = getPageKey(url);
  return new Promise(resolve => {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      console.warn('Lens: Storage not available. Please refresh the page if you recently reloaded the extension.');
      return resolve({ version: 1, page: { title: document.title, url: key }, comments: [] });
    }
    try {
      chrome.storage.local.get([YW_STORAGE_KEY], result => {
        if (chrome.runtime.lastError) console.warn(chrome.runtime.lastError);
        const all = (result && result[YW_STORAGE_KEY]) ? result[YW_STORAGE_KEY] : {};
        resolve(all[key] || { version: 1, page: { title: document.title, url: key }, comments: [] });
      });
    } catch (e) {
      console.warn('Lens:', e);
      resolve({ version: 1, page: { title: document.title, url: key }, comments: [] });
    }
  });
}

function saveAnnotations(data, url) {
  const key = getPageKey(url);
  return new Promise(resolve => {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      console.warn('Lens: Storage not available. Please refresh the page if you recently reloaded the extension.');
      return resolve();
    }
    try {
      chrome.storage.local.get([YW_STORAGE_KEY], result => {
        if (chrome.runtime.lastError) console.warn(chrome.runtime.lastError);
        const all = (result && result[YW_STORAGE_KEY]) ? result[YW_STORAGE_KEY] : {};
        all[key] = data;
        chrome.storage.local.set({ [YW_STORAGE_KEY]: all }, () => {
          if (chrome.runtime.lastError) console.warn(chrome.runtime.lastError);
          resolve();
        });
      });
    } catch (e) {
      console.warn('Lens:', e);
      resolve();
    }
  });
}

async function upsertAnnotation(element, commentText) {
  const selector = buildSelector(element);
  const tag = element.tagName;
  const data = await loadAnnotations();
  const existing = data.comments.find(c => c.selector === selector);
  if (existing) {
    existing.comment = commentText;
    existing.updatedAt = Date.now();
  } else {
    data.comments.push({
      id: 'yw_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      selector, tag,
      textContent: (element.textContent || '').trim().slice(0, 60),
      comment: commentText,
      createdAt: Date.now()
    });
  }
  await saveAnnotations(data);
  return data;
}

async function deleteAnnotation(selector) {
  const data = await loadAnnotations();
  data.comments = data.comments.filter(c => c.selector !== selector);
  await saveAnnotations(data);
  return data;
}

async function getAnnotationForElement(element) {
  const selector = buildSelector(element);
  const data = await loadAnnotations();
  return data.comments.find(c => c.selector === selector) || null;
}

function exportJSON(data) {
  const clean = {
    version: data.version,
    page: data.page,
    comments: data.comments.map(({ selector, tag, comment }) => ({ selector, tag, comment }))
  };
  return JSON.stringify(clean, null, 2);
}

/* ============================================================
   INLINE: overlay.js
   ============================================================ */

const SKIP_TAGS = new Set(['HTML', 'HEAD', 'SCRIPT', 'STYLE', 'META', 'LINK', 'NOSCRIPT']);

/**
 * Returns true if the element belongs to the extension itself or is
 * otherwise un-inspectable. The toolbar, overlays, popovers, and
 * banners are all excluded so the tool can never inspect itself.
 */
function isSkippable(el) {
  if (!el || !el.tagName) return true;
  if (SKIP_TAGS.has(el.tagName)) return true;
  // Exclude anything that carries the yw- namespace
  if (el.id && el.id.startsWith('yw-')) return true;
  if (el.classList && Array.from(el.classList).some(c => c.startsWith('yw-'))) return true;
  // Walk up the tree – if any ancestor is the toolbar or our UI elements, skip
  if (el.closest && el.closest('#yw-toolbar, #yw-widget-trigger, #yw-sidebar-panel, #yw-popover, #yw-json-modal, .yw-toast, #yw-active-banner')) return true;
  return false;
}

let hoverOverlay = null, selectedOverlay = null, elementLabel = null;
let marginOverlay = null, paddingOverlay = null, inspectorPanel = null;
let currentHovered = null, currentSelected = null;
let isPaused = false;
let isHoverDisabled = false;

function createOverlayElements() {
  hoverOverlay = document.createElement('div');
  hoverOverlay.className = 'yw-highlight-overlay';
  hoverOverlay.style.display = 'none';
  document.body.appendChild(hoverOverlay);

  marginOverlay = document.createElement('div');
  marginOverlay.className = 'yw-margin-overlay';
  marginOverlay.style.display = 'none';
  document.body.appendChild(marginOverlay);

  paddingOverlay = document.createElement('div');
  paddingOverlay.className = 'yw-padding-overlay';
  paddingOverlay.style.display = 'none';
  document.body.appendChild(paddingOverlay);

  selectedOverlay = document.createElement('div');
  selectedOverlay.className = 'yw-selected-overlay';
  selectedOverlay.style.display = 'none';
  document.body.appendChild(selectedOverlay);

  elementLabel = document.createElement('div');
  elementLabel.className = 'yw-element-label';
  elementLabel.style.display = 'none';
  document.body.appendChild(elementLabel);

  inspectorPanel = document.createElement('div');
  inspectorPanel.id = 'yw-inspector-panel';
  inspectorPanel.className = 'yw-hidden';
  document.body.appendChild(inspectorPanel);
}

function positionOverlayFixed(overlay, el) {
  if (!el) { overlay.style.display = 'none'; return; }
  const rect = el.getBoundingClientRect();
  overlay.style.display = 'block';
  // Clamp to viewport so the overlay never crops at edges
  const top = Math.max(0, rect.top);
  const left = Math.max(0, rect.left);
  const right = Math.min(window.innerWidth, rect.right);
  const bottom = Math.min(window.innerHeight, rect.bottom);
  overlay.style.top = top + 'px';
  overlay.style.left = left + 'px';
  overlay.style.width = Math.max(0, right - left) + 'px';
  overlay.style.height = Math.max(0, bottom - top) + 'px';
}

function updateHoverOverlay(el) {
  if (!el) { 
    hoverOverlay.style.display = 'none'; 
    elementLabel.style.display = 'none'; 
    if (inspectorPanel) inspectorPanel.classList.add('yw-hidden');
    if (marginOverlay) marginOverlay.style.display = 'none';
    if (paddingOverlay) paddingOverlay.style.display = 'none';
    return; 
  }
  
  positionOverlayFixed(hoverOverlay, el);
  
  if (activeToolId !== 'moveSelect') {
    if (inspectorPanel) inspectorPanel.classList.add('yw-hidden');
    if (marginOverlay) marginOverlay.style.display = 'none';
    if (paddingOverlay) paddingOverlay.style.display = 'none';
    
    const rect = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    const cls = Array.from(el.classList).filter(c => !c.startsWith('yw-')).slice(0, 1).join('');
    elementLabel.textContent = cls ? `${tag}.${cls}` : tag;
    elementLabel.style.display = 'block';
    const labelTop = rect.top - 22;
    elementLabel.style.top = (labelTop > 4 ? labelTop : rect.bottom + 4) + 'px';
    elementLabel.style.left = Math.max(4, rect.left) + 'px';
  } else {
    elementLabel.style.display = 'none';
    updateInspectorPanel(el);
  }
}

function updateInspectorPanel(el) {
  if (!inspectorPanel) return;
  inspectorPanel.classList.remove('yw-hidden');

  const style = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();

  // ── Margin overlay ──────────────────────────────────
  const mt = parseFloat(style.marginTop) || 0;
  const mr = parseFloat(style.marginRight) || 0;
  const mb = parseFloat(style.marginBottom) || 0;
  const ml = parseFloat(style.marginLeft) || 0;
  if (mt || mr || mb || ml) {
    marginOverlay.style.display = 'block';
    marginOverlay.style.top    = (rect.top  - mt) + 'px';
    marginOverlay.style.left   = (rect.left - ml) + 'px';
    marginOverlay.style.width  = (rect.width  + ml + mr) + 'px';
    marginOverlay.style.height = (rect.height + mt + mb) + 'px';
    marginOverlay.style.borderWidth = `${mt}px ${mr}px ${mb}px ${ml}px`;
    marginOverlay.style.borderStyle = 'solid';
    marginOverlay.style.borderColor = 'rgba(246, 178, 107, 0.5)';
  } else {
    marginOverlay.style.display = 'none';
  }

  // ── Padding overlay ───────────────────────────────
  const pt = parseFloat(style.paddingTop) || 0;
  const pr = parseFloat(style.paddingRight) || 0;
  const pb = parseFloat(style.paddingBottom) || 0;
  const pl = parseFloat(style.paddingLeft) || 0;
  if (pt || pr || pb || pl) {
    paddingOverlay.style.display = 'block';
    paddingOverlay.style.top    = rect.top  + 'px';
    paddingOverlay.style.left   = rect.left + 'px';
    paddingOverlay.style.width  = rect.width  + 'px';
    paddingOverlay.style.height = rect.height + 'px';
    paddingOverlay.style.borderWidth = `${pt}px ${pr}px ${pb}px ${pl}px`;
    paddingOverlay.style.borderStyle = 'solid';
    paddingOverlay.style.borderColor = 'rgba(126, 211, 138, 0.55)';
  } else {
    paddingOverlay.style.display = 'none';
  }

  // ── Helpers ─────────────────────────────────────
  const selector = buildSelector(el);
  const tag = el.tagName.toLowerCase();
  const cls = Array.from(el.classList).filter(c => !c.startsWith('yw-')).slice(0, 2).join('.');
  const displaySel = selector.length > 38 ? '…' + selector.slice(-38) : selector;

  // Compact a computed value: trim trailing zeros from colours, shorten 0px
  function fmt(v) {
    if (!v) return '—';
    v = v.trim();
    // '0px 0px 0px 0px' → '0'
    if (/^(0px\s*)+$/.test(v)) return '0';
    return v;
  }

  function swatchRow(color, label) {
    return `<span class="yw-inspector-color-row">
      <span class="yw-inspector-swatch" style="background:${color}"></span>
      <span class="yw-inspector-val">${escapeHtml(label)}</span>
    </span>`;
  }

  function row(key, val) {
    return `<div class="yw-inspector-row">
      <span class="yw-inspector-key">${key}</span>
      <span class="yw-inspector-val">${escapeHtml(String(val))}</span>
    </div>`;
  }

  function colorRow(key, color) {
    return `<div class="yw-inspector-row">
      <span class="yw-inspector-key">${key}</span>
      ${swatchRow(color, color)}
    </div>`;
  }

  function divider() {
    return '<div class="yw-inspector-divider"></div>';
  }

  const fSize  = style.fontSize  || '';
  const fFamily = (style.fontFamily || '').split(',')[0].replace(/['"]/g,'').trim();
  const fWeight = style.fontWeight || '';
  const lHeight = style.lineHeight || '';
  const display = style.display   || '';
  const pos     = style.position  || '';
  const margin  = fmt(style.margin);
  const padding = fmt(style.padding);
  const color   = style.color || '';
  const bg      = style.backgroundColor || '';
  const border  = style.border || '';
  const radius  = style.borderRadius || '';
  const opacity = style.opacity || '';
  const zIndex  = style.zIndex || '';

  inspectorPanel.innerHTML = `
    <div class="yw-inspector-header">
      <span class="yw-inspector-tag">${escapeHtml(tag.toUpperCase())}${cls ? '.' + escapeHtml(cls) : ''}</span>
      <span class="yw-inspector-selector" title="${escapeHtml(selector)}">${escapeHtml(displaySel)}</span>
    </div>
    <div class="yw-inspector-size">
      <span>${Math.round(rect.width)}</span>
      <span class="yw-inspector-size-x">×</span>
      <span>${Math.round(rect.height)}</span>
      <span class="yw-inspector-size-x">px</span>
    </div>
    <div class="yw-inspector-body">
      ${row('display', display)}
      ${row('position', pos)}
      ${divider()}
      ${row('margin', margin)}
      ${row('padding', padding)}
      ${divider()}
      ${colorRow('color', color)}
      ${colorRow('background', bg)}
      ${divider()}
      ${row('font', fSize + ' / ' + fWeight)}
      ${row('family', fFamily)}
      ${row('line-h', lHeight)}
      ${radius && radius !== '0px' ? row('radius', radius) : ''}
      ${opacity && opacity !== '1' ? row('opacity', opacity) : ''}
      ${zIndex && zIndex !== 'auto' ? row('z-index', zIndex) : ''}
    </div>
  `;

  // ── Position panel near the element, clamped to viewport ──
  const PW = 260;
  const PH = inspectorPanel.scrollHeight || 220;
  const MARGIN = 12;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Prefer: below the element, left-aligned to it
  let top  = rect.bottom + MARGIN;
  let left = rect.left;

  // Flip above if no room below
  if (top + PH > vh - MARGIN) {
    top = rect.top - PH - MARGIN;
  }
  // If still off-screen above, pin to top
  if (top < MARGIN) top = MARGIN;

  // Clamp horizontally
  if (left + PW > vw - MARGIN) left = vw - PW - MARGIN;
  if (left < MARGIN) left = MARGIN;

  inspectorPanel.style.top  = top  + 'px';
  inspectorPanel.style.left = left + 'px';
}

function updateSelectedOverlay(el) {
  if (!el) { selectedOverlay.style.display = 'none'; return; }
  positionOverlayFixed(selectedOverlay, el);
}

function onScroll() {
  if (currentHovered) updateHoverOverlay(currentHovered);
  if (currentSelected) updateSelectedOverlay(currentSelected);
}

function onMouseMove(e) {
  if (isPaused || isHoverDisabled) return;
  const el = e.target;
  if (isSkippable(el) || el === currentHovered) return;
  currentHovered = el;
  updateHoverOverlay(el);
  if (typeof updateMeasurements === 'function') updateMeasurements();
}

function onOverlayClick(e) {
  if (isPaused || isHoverDisabled) return;
  const el = e.target;
  if (isSkippable(el)) return;
  e.stopPropagation();
  e.preventDefault();
  
  if (activeToolId === 'moveSelect') {
    currentSelected = el;
    updateSelectedOverlay(el);
    return;
  }
  
  currentSelected = el;
  updateSelectedOverlay(el);
  hoverOverlay.style.display = 'none';
  elementLabel.style.display = 'none';
  if (typeof updateMeasurements === 'function') updateMeasurements();
  document.dispatchEvent(new CustomEvent('yw:elementSelected', { detail: { element: el } }));
}

function onKeyDown(e) {
  if (isPaused || isHoverDisabled) return;
  const tag = document.activeElement && document.activeElement.tagName;
  const isInputFocused = tag === 'INPUT' || tag === 'TEXTAREA' || (document.activeElement && document.activeElement.isContentEditable);
  
  if (e.key === 'Escape') { closePopover(); clearSelection(); return; }
  
  if (isInputFocused && !(e.ctrlKey || e.altKey)) return;

  let next = null;
  if (!currentSelected) return;
  
  if (e.key === '[' || e.key === 'ArrowUp') { e.preventDefault(); next = currentSelected.parentElement; }
  else if (e.key === ']' || e.key === 'ArrowDown') { e.preventDefault(); next = currentSelected.firstElementChild; }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); next = currentSelected.previousElementSibling; }
  else if (e.key === 'ArrowRight') { e.preventDefault(); next = currentSelected.nextElementSibling; }
  
  if (next && !isSkippable(next)) {
    currentSelected = next;
    updateSelectedOverlay(next);
    updateHoverOverlay(next);
    next.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    document.dispatchEvent(new CustomEvent('yw:elementSelected', { detail: { element: next } }));
  }
}

function highlightElement(el) {
  if (!el) { hoverOverlay.style.display = 'none'; elementLabel.style.display = 'none'; return; }
  updateHoverOverlay(el);
}

function clearHighlight() {
  hoverOverlay.style.display = 'none';
  elementLabel.style.display = 'none';
}

function startOverlay() {
  if (!hoverOverlay) createOverlayElements();
  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('click', onOverlayClick, true);
  document.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('keydown', onKeyDown, true);
  if (typeof onGlobalKeyDown === 'function') {
    document.addEventListener('keydown', onGlobalKeyDown, true);
    document.addEventListener('keyup', onGlobalKeyUp, true);
  }
}

function stopOverlay() {
  document.removeEventListener('mousemove', onMouseMove, true);
  document.removeEventListener('click', onOverlayClick, true);
  document.removeEventListener('scroll', onScroll, { passive: true });
  document.removeEventListener('keydown', onKeyDown, true);
  if (typeof onGlobalKeyDown === 'function') {
    document.removeEventListener('keydown', onGlobalKeyDown, true);
    document.removeEventListener('keyup', onGlobalKeyUp, true);
  }
  if (hoverOverlay) hoverOverlay.style.display = 'none';
  if (selectedOverlay) selectedOverlay.style.display = 'none';
  if (elementLabel) elementLabel.style.display = 'none';
  currentHovered = null; currentSelected = null;
  if (typeof clearMeasureLines === 'function') {
    isAltPressed = false;
    clearMeasureLines();
  }
}

function clearSelection() { 
  currentSelected = null; 
  if (selectedOverlay) selectedOverlay.style.display = 'none'; 
  if (typeof clearMeasureLines === 'function') clearMeasureLines();
}


/* ============================================================
   INLINE: sidebar.js (Replaces Bottom Sheet)
   ============================================================ */

let jsonModalEl = null;

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ----------------------------------------------------------------
   SVG Icons — exact paths from the Paper design file (2A-0)
   Each icon that lives in a 32×32 button uses a 20×20 icon area.
   ---------------------------------------------------------------- */
const Icons = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>',
  code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>',

  // ── Paper-design icons ──────────────────────────────────────────
  // Button 1 – Move/Select (star/sparkle — the Lens logo, first button, default selected)
  // 18×18 SVG centered in 20×20 wrapper (75% × 75% at 12.5% offset)
  moveSelect: `<div style="box-sizing:border-box;flex-shrink:0;height:20px;position:relative;width:20px"><svg viewBox="0 0 18 18" width="18" height="18" xmlns="http://www.w3.org/2000/svg" style="width:75%;height:75%;overflow:visible;top:12.5%;left:12.5%;position:absolute"><path d="M6.803 1.630C6.803 1.630 12.836 3.991 12.836 3.991C16.316 5.352 18.056 6.033 17.999 7.113C17.941 8.193 16.125 8.689 12.493 9.679C11.412 9.974 10.871 10.121 10.496 10.496C10.121 10.871 9.974 11.412 9.679 12.493C8.689 16.125 8.193 17.941 7.113 17.999C6.033 18.056 5.352 16.316 3.991 12.836C3.991 12.836 1.630 6.803 1.630 6.803C0.204 3.159 -0.509 1.338 0.414 0.414C1.338 -0.509 3.159 0.204 6.803 1.630Z" vector-effect="non-scaling-stroke" fill="none" stroke="currentColor" stroke-linejoin="round"/></svg></div>`,

  // Button 2 – Comments (chat bubble)
  // 19×19 SVG centered in 20×20 wrapper (~79.17% at 10.4% offset)
  comments: `<div style="box-sizing:border-box;flex-shrink:0;height:20px;position:relative;width:20px"><svg viewBox="0 0 19 19" width="19" height="19" xmlns="http://www.w3.org/2000/svg" style="width:79.1667%;height:79.1667%;left:10.4004%;top:10.4167%;overflow:visible;position:absolute"><path d="M19.000 9.500C19.000 14.747 14.747 19.000 9.500 19.000C7.872 19.000 6.339 18.590 5.000 17.869C3.132 16.862 1.875 17.798 0.766 17.966C0.598 17.991 0.430 17.930 0.310 17.810C0.127 17.627 0.093 17.345 0.194 17.107C0.629 16.082 1.028 14.138 0.483 12.500C0.170 11.557 0.000 10.548 0.000 9.500C0.000 4.253 4.253 0.000 9.500 0.000C14.747 0.000 19.000 4.253 19.000 9.500Z" vector-effect="non-scaling-stroke" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`,

  // Button 3 – Copy All (two overlapping rounded rects)
  // 24×24 SVG positioned at 0,0 in 20×20 wrapper (overflow:visible)
  copyAll: `<div style="box-sizing:border-box;flex-shrink:0;height:20px;position:relative;width:20px"><svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg" style="left:0;top:0;width:24px;height:24px;overflow:visible;position:absolute"><path transform="matrix(1 0 0 1 7.5 7.5)" d="M0.000 7.000C0.000 3.700 0.000 2.050 1.025 1.025C2.050 0.000 3.700 0.000 7.000 0.000C10.300 0.000 11.950 0.000 12.975 1.025C14.000 2.050 14.000 3.700 14.000 7.000C14.000 10.300 14.000 11.950 12.975 12.975C11.950 14.000 10.300 14.000 7.000 14.000C3.700 14.000 2.050 14.000 1.025 12.975C0.000 11.950 0.000 10.300 0.000 7.000Z" vector-effect="non-scaling-stroke" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path transform="matrix(1 0 0 1 2.5 2.5)" d="M5.000 14.000C3.604 14.000 2.905 14.000 2.344 13.804C1.339 13.452 0.548 12.661 0.196 11.656C-0.000 11.095 0.000 10.396 0.000 9.000C0.000 9.000 0.000 7.000 0.000 7.000C0.000 3.700 0.000 2.050 1.025 1.025C2.050 0.000 3.700 0.000 7.000 0.000C7.000 0.000 9.000 0.000 9.000 0.000C10.396 0.000 11.095 -0.000 11.656 0.196C12.661 0.548 13.452 1.339 13.804 2.344C14.000 2.905 14.000 3.604 14.000 5.000" vector-effect="non-scaling-stroke" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`,

  // Button 4 – Settings (gear / cog)
  // 24×24 SVG positioned at 0,0 in 20×20 wrapper (overflow:visible)
  settings: `<div style="box-sizing:border-box;flex-shrink:0;height:20px;position:relative;width:20px"><svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg" style="left:0;top:0;width:24px;height:24px;overflow:visible;position:absolute"><path transform="matrix(1 0 0 1 8.5 8.5)" d="M7.000 3.500C7.000 5.433 5.433 7.000 3.500 7.000C1.567 7.000 0.000 5.433 0.000 3.500C0.000 1.567 1.567 0.000 3.500 0.000C5.433 0.000 7.000 1.567 7.000 3.500Z" vector-effect="non-scaling-stroke" fill="none" stroke="currentColor" stroke-linecap="round"/><path transform="matrix(1 0 0 1 2 2.689)" d="M19.011 11.407C19.533 11.267 19.794 11.196 19.897 11.062C20.000 10.927 20.000 10.711 20.000 10.278C20.000 10.278 20.000 8.344 20.000 8.344C20.000 7.911 20.000 7.695 19.897 7.560C19.794 7.426 19.533 7.355 19.011 7.214C17.061 6.688 15.840 4.649 16.343 2.712C16.482 2.179 16.551 1.912 16.485 1.756C16.419 1.600 16.229 1.492 15.850 1.277C15.850 1.277 14.125 0.298 14.125 0.298C13.753 0.086 13.567 -0.019 13.400 0.003C13.233 0.026 13.044 0.214 12.667 0.590C11.208 2.045 8.794 2.045 7.334 0.589C6.957 0.213 6.769 0.025 6.602 0.003C6.435 -0.020 6.249 0.086 5.877 0.297C5.877 0.297 4.152 1.277 4.152 1.277C3.773 1.492 3.583 1.600 3.517 1.756C3.451 1.912 3.520 2.179 3.658 2.712C4.161 4.649 2.940 6.688 0.989 7.214C0.467 7.355 0.206 7.426 0.103 7.560C0.000 7.695 0.000 7.911 0.000 8.344C0.000 8.344 0.000 10.278 0.000 10.278C0.000 10.711 0.000 10.927 0.103 11.062C0.206 11.196 0.467 11.267 0.989 11.407C2.939 11.933 4.160 13.972 3.657 15.910C3.518 16.443 3.449 16.709 3.515 16.866C3.581 17.022 3.771 17.130 4.150 17.345C4.150 17.345 5.875 18.324 5.875 18.324C6.247 18.536 6.433 18.641 6.600 18.619C6.767 18.596 6.956 18.408 7.333 18.032C8.793 16.575 11.209 16.575 12.669 18.032C13.046 18.408 13.234 18.596 13.401 18.619C13.568 18.641 13.754 18.535 14.127 18.324C14.127 18.324 15.851 17.345 15.851 17.345C16.231 17.130 16.420 17.022 16.486 16.866C16.553 16.709 16.483 16.443 16.345 15.910C15.841 13.972 17.061 11.933 19.011 11.407Z" vector-effect="non-scaling-stroke" fill="none" stroke="currentColor" stroke-linecap="round"/></svg></div>`,

  // Button 5 – Grid (hash / # shape) — direct 20×20 SVG, no wrapper needed
  grid: `<svg viewBox="0 0 20 20" width="20" height="20" xmlns="http://www.w3.org/2000/svg" style="overflow:visible;flex-shrink:0"><path transform="translate(7 3)" d="M-1.167-0.5L-1.167 14.5" vector-effect="non-scaling-stroke" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path transform="translate(17 3)" d="M-2.833-0.5L-2.833 14.5" vector-effect="non-scaling-stroke" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path transform="translate(3 7)" d="M14.5-1.167L-0.5-1.167" vector-effect="non-scaling-stroke" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path transform="translate(3 17)" d="M14.5-2.833L-0.5-2.833" vector-effect="non-scaling-stroke" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg>`
};

function showToast(msg, type = 'success') {
  const existing = document.querySelector('.yw-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = `yw-toast yw-${type}`;
  toast.innerHTML = `${type === 'success' ? Icons.check : Icons.x} <span>${escapeHtml(msg)}</span>`;
  document.body.appendChild(toast);
  setTimeout(() => { toast.classList.add('yw-toast-out'); setTimeout(() => toast.remove(), 300); }, 2000);
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;top:-9999px';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  });
}

function showJSONModal(data) {
  if (jsonModalEl) jsonModalEl.remove();
  const jsonStr = exportJSON(data);
  jsonModalEl = document.createElement('div');
  jsonModalEl.id = 'yw-json-modal';
  jsonModalEl.innerHTML = `
    <div class="yw-json-modal-box">
      <div class="yw-json-modal-header">
        <span class="yw-json-modal-title">Annotation JSON</span>
        <button class="yw-json-modal-close" id="yw-json-close">${Icons.x}</button>
      </div>
      <pre class="yw-json-pre">${escapeHtml(jsonStr)}</pre>
      <div class="yw-json-modal-footer">
        <button class="yw-btn yw-btn-outline" id="yw-json-modal-close2">Close</button>
        <button class="yw-btn yw-btn-primary" id="yw-json-modal-copy">${Icons.copyAll} Copy JSON</button>
      </div>
    </div>`;
  document.body.appendChild(jsonModalEl);
  jsonModalEl.addEventListener('click', (e) => { if (e.target === jsonModalEl) closeJSONModal(); });
  document.getElementById('yw-json-close').addEventListener('click', closeJSONModal);
  document.getElementById('yw-json-modal-close2').addEventListener('click', closeJSONModal);
  document.getElementById('yw-json-modal-copy').addEventListener('click', () => {
    copyToClipboard(jsonStr); showToast('JSON copied!', 'success');
  });
}
function closeJSONModal() { if (jsonModalEl) { jsonModalEl.remove(); jsonModalEl = null; } }

let toolbarEl = null;

/* ----------------------------------------------------------------
   Active tool state
   'moveSelect' | 'comments' | 'copyAll' | 'settings' | 'grid'
   ---------------------------------------------------------------- */
let activeToolId = 'moveSelect';

function setActiveTool(toolId) {
  activeToolId = toolId;
  // Reflect in the overlay: when "comments" or inspector tool is active,
  // re-enable hover/click. Otherwise let the tool control it.
  if (toolId === 'moveSelect') {
    isHoverDisabled = false;
    isPaused = false;
    clearHighlight();
  } else {
    // All other tools pause the hover inspector so the toolbar can't inspect itself
    // and so UX is clear about which mode is active.
    clearHighlight();
    clearSelection();
    currentHovered = null;
  }

  // Update button visual state
  if (!toolbarEl) return;
  toolbarEl.querySelectorAll('.yw-toolbar-btn').forEach(btn => {
    btn.classList.remove('yw-active-toggle');
  });
  const activeBtn = toolbarEl.querySelector(`[data-tool="${toolId}"]`);
  if (activeBtn) {
    activeBtn.classList.add('yw-active-toggle');
    
    // Snap sliding background to the active button if mouse is not currently hovering
    const hoverBg = toolbarEl.querySelector('#yw-hover-bg');
    const itemsContainer = toolbarEl.querySelector('#yw-toolbar-items');
    if (hoverBg && itemsContainer && !toolbarEl.matches(':hover')) {
      const containerRect = itemsContainer.getBoundingClientRect();
      const btnRect = activeBtn.getBoundingClientRect();
      const offsetY = btnRect.top - containerRect.top;
      hoverBg.style.transform = `translateY(${offsetY}px)`;
      hoverBg.style.opacity = '1';
    }
  }
}

function createToolbarWidget() {
  if (toolbarEl) toolbarEl.remove();

  toolbarEl = document.createElement('div');
  toolbarEl.id = 'yw-toolbar';

  toolbarEl.innerHTML = `
    <!-- Floating Label -->
    <div id="yw-floating-label" class="yw-floating-label">
      <div id="yw-label-scroller" class="yw-label-scroller">
        <div class="yw-label-item">Select & Inspect</div>
        <div class="yw-label-item">Add Comment</div>
        <div class="yw-label-item">Copy All Annotations</div>
        <div class="yw-label-item">Settings</div>
        <div class="yw-label-item">Grid</div>
      </div>
    </div>
    <div id="yw-toolbar-items">
      
      <!-- Sliding Hover Background -->
      <div id="yw-hover-bg" class="yw-hover-bg"></div>

      <!-- Button 1: Move / Select -->
      <button class="yw-toolbar-btn yw-active-toggle" id="yw-move-btn" data-tool="moveSelect" data-tooltip="Select & Inspect">
        ${Icons.moveSelect}
      </button>

      <!-- Button 2: Comments -->
      <button class="yw-toolbar-btn" id="yw-comments-btn" data-tool="comments" data-tooltip="Add Comment">
        ${Icons.comments}
      </button>

      <!-- Button 3: Copy All -->
      <button class="yw-toolbar-btn" id="yw-copy-btn" data-tool="copyAll" data-tooltip="Copy All Annotations">
        ${Icons.copyAll}
      </button>

      <!-- Button 4: Settings (with popover) -->
      <button class="yw-toolbar-btn yw-has-popover" id="yw-settings-btn" data-tool="settings" data-tooltip="Settings">
        ${Icons.settings}
        <div class="yw-settings-popover">
          <label class="yw-settings-row">
            <input type="checkbox" id="yw-delete-on-copy" style="cursor:pointer;" />
            <span>Clear comments on Copy All</span>
          </label>
        </div>
      </button>

      <!-- Button 5: Grid (with popover) -->
      <button class="yw-toolbar-btn yw-has-popover" id="yw-grid-btn" data-tool="grid" data-tooltip="Grid">
        ${Icons.grid}
        <div class="yw-settings-popover yw-grid-popover">
          <div class="yw-grid-toggle-row">
            <span>Enable Grid</span>
            <input type="checkbox" id="yw-grid-active-chk" style="cursor:pointer;" />
          </div>
          <div class="yw-grid-setting">
            <label><span>Columns</span><span class="yw-setting-val" id="yw-grid-cols-val">12</span></label>
            <input type="range" id="yw-grid-cols" min="1" max="24" value="12" />
          </div>
          <div class="yw-grid-setting">
            <label><span>Gutter (px)</span><span class="yw-setting-val" id="yw-grid-gap-val">24</span></label>
            <input type="number" id="yw-grid-gap" value="24" min="0" />
          </div>
          <div class="yw-grid-setting">
            <label><span>Margin (px)</span><span class="yw-setting-val" id="yw-grid-margin-val">24</span></label>
            <input type="number" id="yw-grid-margin" value="24" min="0" />
          </div>
          <div class="yw-grid-setting">
            <label><span>Color</span></label>
            <input type="color" id="yw-grid-color" value="#ef4444" style="width:100%;height:28px;cursor:pointer;padding:0;background:transparent;border:none;" />
          </div>
          <div class="yw-grid-setting">
            <label><span>Opacity (%)</span><span class="yw-setting-val" id="yw-grid-opacity-val">10</span></label>
            <input type="range" id="yw-grid-opacity" min="0" max="100" value="10" />
          </div>
        </div>
      </button>

    </div>
  `;
  document.body.appendChild(toolbarEl);

  // ── Button: Move / Select ──────────────────────────────────────
  document.getElementById('yw-move-btn').addEventListener('click', () => {
    setActiveTool('moveSelect');
    isHoverDisabled = false;
    isPaused = false;
    closeAllPopovers();
  });

  // ── Button: Comments (toggle hover inspector) ──────────────────
  // In "comments" mode the user clicks an element to annotate it.
  document.getElementById('yw-comments-btn').addEventListener('click', () => {
    const wasActive = activeToolId === 'comments';
    closeAllPopovers();
    if (wasActive) {
      // Toggle off → go back to move/select
      setActiveTool('moveSelect');
      isHoverDisabled = false;
      isPaused = false;
    } else {
      setActiveTool('comments');
      isHoverDisabled = false;
      isPaused = false;
    }
  });

  // ── Button: Copy All ───────────────────────────────────────────
  document.getElementById('yw-copy-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    closeAllPopovers();
    setActiveTool('copyAll');
    const data = await loadAnnotations();
    if (!data.comments.length) {
      showToast('Nothing to copy yet!', 'error');
      // Revert active state since no action happened
      setActiveTool('moveSelect');
      return;
    }
    copyToClipboard(exportJSON(data));
    showToast('JSON copied to clipboard!', 'success');
    const chk = document.getElementById('yw-delete-on-copy');
    if (chk && chk.checked) {
      data.comments = [];
      await saveAnnotations(data);
    }
    // Brief highlight then revert
    setTimeout(() => setActiveTool('moveSelect'), 800);
  });

  // ── Button: Settings ──────────────────────────────────────────
  const settingsBtn = document.getElementById('yw-settings-btn');
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target.closest('.yw-settings-popover')) return;
    const wasOpen = settingsBtn.classList.contains('yw-popover-open');
    closeAllPopovers();
    if (!wasOpen) {
      settingsBtn.classList.add('yw-popover-open');
      setActiveTool('settings');
      isPaused = true;
      clearHighlight();
    } else {
      setActiveTool('moveSelect');
      isPaused = false;
    }
  });

  // ── Button: Grid ──────────────────────────────────────────────
  const gridBtn = document.getElementById('yw-grid-btn');
  gridBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target.closest('.yw-grid-popover')) return;
    if (!pageGridEl) initGridControls();
    const wasOpen = gridBtn.classList.contains('yw-popover-open');
    closeAllPopovers();
    if (!wasOpen) {
      gridBtn.classList.add('yw-popover-open');
      setActiveTool('grid');
      isPaused = true;
      clearHighlight();
    } else {
      setActiveTool('moveSelect');
      isPaused = false;
    }
  });

  // ── Close popovers on outside click ───────────────────────────
  document.addEventListener('click', (e) => {
    if (settingsBtn.classList.contains('yw-popover-open') && !settingsBtn.contains(e.target)) {
      settingsBtn.classList.remove('yw-popover-open');
      if (activeToolId === 'settings') { setActiveTool('moveSelect'); isPaused = false; }
    }
    if (gridBtn.classList.contains('yw-popover-open') && !gridBtn.contains(e.target)) {
      gridBtn.classList.remove('yw-popover-open');
      if (activeToolId === 'grid') { setActiveTool('moveSelect'); isPaused = false; }
    }
  });

  // ── Persist settings ──────────────────────────────────────────
  chrome.storage.local.get(['yw_delete_on_copy'], res => {
    const chk = document.getElementById('yw-delete-on-copy');
    if (chk) {
      chk.checked = !!res.yw_delete_on_copy;
      chk.addEventListener('change', (e) => {
        chrome.storage.local.set({ yw_delete_on_copy: e.target.checked });
      });
    }
  });

  // Apply initial active state visually
  setActiveTool('moveSelect');

  // ── Hover effects (Sliding BG & Label) ──────────────────────────
  const hoverBg = document.getElementById('yw-hover-bg');
  const floatingLabel = document.getElementById('yw-floating-label');
  const itemsContainer = document.getElementById('yw-toolbar-items');
  const allBtns = toolbarEl.querySelectorAll('.yw-toolbar-btn');

  function updateHoverPosition(targetBtn) {
    if (!targetBtn) {
      hoverBg.style.opacity = '0';
      floatingLabel.classList.remove('yw-visible');
      return;
    }

    if (targetBtn.classList.contains('yw-active-toggle')) {
      hoverBg.style.opacity = '0';
    } else {
      hoverBg.style.opacity = '1';
    }

    const containerRect = itemsContainer.getBoundingClientRect();
    const btnRect = targetBtn.getBoundingClientRect();
    const offsetY = btnRect.top - containerRect.top;
    hoverBg.style.transform = `translateY(${offsetY}px)`;

    // Move floating label container
    const labelY = btnRect.top - containerRect.top + (btnRect.height / 2);
    floatingLabel.style.transform = `translateY(calc(${labelY}px - 50%))`;
    floatingLabel.classList.add('yw-visible');

    // Scroll inner text to match hovered button
    const btnIndex = Array.from(allBtns).indexOf(targetBtn);
    const scroller = document.getElementById('yw-label-scroller');
    if (scroller && btnIndex >= 0) {
      scroller.style.transform = `translateY(${btnIndex * -28}px)`;
    }
  }

  function resetToActive() {
    allBtns.forEach(b => b.classList.remove('yw-hovered'));
    hoverBg.style.opacity = '0';
    floatingLabel.classList.remove('yw-visible');
  }

  allBtns.forEach(btn => {
    btn.addEventListener('mouseenter', () => {
      allBtns.forEach(b => b.classList.remove('yw-hovered'));
      btn.classList.add('yw-hovered');
      updateHoverPosition(btn);
    });
  });

  toolbarEl.addEventListener('mouseleave', () => resetToActive());

  // Need a small timeout so layout is calculated before snapping bg
  setTimeout(() => resetToActive(), 50);
}

function closeAllPopovers() {
  const settingsBtn = document.getElementById('yw-settings-btn');
  const gridBtn = document.getElementById('yw-grid-btn');
  if (settingsBtn) settingsBtn.classList.remove('yw-popover-open');
  if (gridBtn) gridBtn.classList.remove('yw-popover-open');
}

/* ============================================================
   GRID OVERLAY LOGIC
   ============================================================ */

let pageGridEl = null;
let gridState = { active: false, cols: 12, gap: 24, margin: 24, color: '#ef4444', opacity: 10 };

function initGridControls() {
  if (pageGridEl) return;
  pageGridEl = document.createElement('div');
  pageGridEl.id = 'yw-page-grid';
  pageGridEl.style.display = gridState.active ? 'flex' : 'none';
  document.body.appendChild(pageGridEl);

  renderPageGrid();

  const bindInput = (id, prop, type = 'number') => {
    const el = document.getElementById(id);
    const valEl = document.getElementById(id + '-val');
    if (!el) return;
    el.addEventListener('input', (e) => {
      let val = e.target.value;
      if (type === 'checkbox') val = e.target.checked;
      else if (type === 'number') val = Number(val);
      
      gridState[prop] = val;
      if (valEl) valEl.textContent = val;
      if (type === 'checkbox') pageGridEl.style.display = gridState.active ? 'flex' : 'none';
      renderPageGrid();
    });
  };

  bindInput('yw-grid-active-chk', 'active', 'checkbox');
  bindInput('yw-grid-cols', 'cols', 'number');
  bindInput('yw-grid-gap', 'gap', 'number');
  bindInput('yw-grid-margin', 'margin', 'number');
  bindInput('yw-grid-opacity', 'opacity', 'number');
  bindInput('yw-grid-color', 'color', 'string');
}

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}` : '239, 68, 68';
}

function renderPageGrid() {
  if (!pageGridEl) return;
  pageGridEl.innerHTML = '<div id="yw-page-grid-inner"></div>';
  const inner = pageGridEl.firstElementChild;
  
  inner.style.gridTemplateColumns = `repeat(${gridState.cols}, 1fr)`;
  inner.style.gap = `${gridState.gap}px`;
  inner.style.padding = `0 ${gridState.margin}px`;
  
  const rgb = hexToRgb(gridState.color);
  for (let i = 0; i < gridState.cols; i++) {
    const col = document.createElement('div');
    col.className = 'yw-grid-col';
    col.style.backgroundColor = `rgba(${rgb}, ${gridState.opacity / 100})`;
    inner.appendChild(col);
  }
}

function showSidebarWidget() {
  if (!toolbarEl) createToolbarWidget();
  toolbarEl.style.display = 'flex';
}

function hideSidebarWidget() {
  if (toolbarEl) toolbarEl.style.display = 'none';
}

function refreshSidebarWidget(data) {
  // no-op for now since annotation list is hidden
}

/* ============================================================
   POPOVER
   ============================================================ */

let popoverEl = null;

async function openPopover(element) {
  closePopover();
  const existing = await getAnnotationForElement(element);
  const selector = buildSelector(element);
  const tag = element.tagName.toLowerCase();

  popoverEl = document.createElement('div');
  popoverEl.id = 'yw-popover';

  const cls = Array.from(element.classList).filter(c => !c.startsWith('yw-')).slice(0, 1).join('');
  const displaySel = (selector.length > 35 ? '…' + selector.slice(-35) : selector);

  popoverEl.innerHTML = `
    <div class="yw-popover-header">
      <span class="yw-tag">${tag.toUpperCase()}${cls ? '.' + cls : ''}</span>
      <span class="yw-selector" title="${escapeHtml(selector)}">${escapeHtml(displaySel)}</span>
      <button class="yw-popover-close" id="yw-popover-close">${Icons.x}</button>
    </div>
    <div class="yw-popover-body">
      <textarea id="yw-comment-input" placeholder="Describe the change you want AI to make here…">${existing ? escapeHtml(existing.comment) : ''}</textarea>
      <div class="yw-popover-actions">
        ${existing ? `<button class="yw-btn yw-btn-danger" id="yw-delete-btn">${Icons.trash} Delete</button>` : ''}
        <button class="yw-btn yw-btn-outline" id="yw-cancel-btn">Cancel</button>
        <button class="yw-btn yw-btn-primary" id="yw-save-btn">${existing ? 'Update' : 'Save'}</button>
      </div>
    </div>
    <div class="yw-keynav-hint">
      <span class="yw-key">Alt</span>/<span class="yw-key">Ctrl</span> + 
      <span class="yw-key">[</span> Parent &nbsp;
      <span class="yw-key">]</span> Child &nbsp;
      <span class="yw-key">←</span><span class="yw-key">→</span> Sibling &nbsp;
      <span class="yw-key">Esc</span> Close
    </div>`;

  document.body.appendChild(popoverEl);

  const rect = element.getBoundingClientRect();
  const pw = 320, ph = 200;
  let top = rect.bottom + 10, left = rect.left;
  if (top + ph > window.innerHeight - 60) top = Math.max(10, rect.top - ph - 10);
  if (left + pw > window.innerWidth - 10) left = window.innerWidth - pw - 10;
  left = Math.max(10, left);
  popoverEl.style.top = top + 'px';
  popoverEl.style.left = left + 'px';

  setTimeout(() => {
    const ta = document.getElementById('yw-comment-input');
    if (ta) { 
      ta.focus(); 
      ta.setSelectionRange(ta.value.length, ta.value.length); 
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          document.getElementById('yw-save-btn').click();
        }
      });
    }
  }, 80);

  document.getElementById('yw-popover-close').addEventListener('click', closePopover);
  document.getElementById('yw-cancel-btn').addEventListener('click', closePopover);

  document.getElementById('yw-save-btn').addEventListener('click', async () => {
    const comment = document.getElementById('yw-comment-input').value.trim();
    if (!comment) { showToast('Please enter a comment', 'error'); return; }
    const data = await upsertAnnotation(element, comment);
    closePopover();
    refreshSidebarWidget(data);
    showToast('Annotation saved!', 'success');
  });

  const deleteBtn = document.getElementById('yw-delete-btn');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async () => {
      const data = await deleteAnnotation(selector);
      closePopover();
      clearSelection();
      refreshSidebarWidget(data);
      showToast('Annotation deleted', 'success');
    });
  }
}

function closePopover() {
  if (popoverEl) { popoverEl.remove(); popoverEl = null; }
}

/* ============================================================
   MEASURE TOOL (Figma-like)
   ============================================================ */

let measureContainer = null;
let isAltPressed = false;

function initMeasureTool() {
  if (measureContainer) return;
  measureContainer = document.createElement('div');
  measureContainer.id = 'yw-measure-container';
  document.body.appendChild(measureContainer);
}

function clearMeasureLines() {
  if (measureContainer) measureContainer.innerHTML = '';
}

function drawMeasureLine(x, y, w, h, text, isHorizontal) {
  const line = document.createElement('div');
  line.className = 'yw-measure-line ' + (isHorizontal ? 'yw-measure-line-x' : 'yw-measure-line-y');
  
  const safeX = isNaN(x) ? 0 : Math.round(x);
  const safeY = isNaN(y) ? 0 : Math.round(y);
  const safeW = isNaN(w) || w <= 0 ? 1 : Math.round(w);
  const safeH = isNaN(h) || h <= 0 ? 1 : Math.round(h);

  line.style.left = `${safeX}px`;
  line.style.top = `${safeY}px`;
  line.style.width = `${safeW}px`;
  line.style.height = `${safeH}px`;
  
  const numText = parseInt(text);
  if (!isNaN(numText) && numText > 0) {
    const badge = document.createElement('div');
    badge.className = 'yw-measure-badge';
    badge.textContent = text;
    badge.style.left = `${safeX + (safeW / 2)}px`;
    badge.style.top = `${safeY + (safeH / 2)}px`;
    measureContainer.appendChild(badge);
  }
  measureContainer.appendChild(line);
}

function updateMeasurements() {
  clearMeasureLines();
  if (!isAltPressed || !currentSelected || !currentHovered || currentSelected === currentHovered) return;
  
  initMeasureTool();
  
  const r1 = currentSelected.getBoundingClientRect();
  const r2 = currentHovered.getBoundingClientRect();
  
  const overlapX = Math.max(0, Math.min(r1.right, r2.right) - Math.max(r1.left, r2.left));
  const overlapY = Math.max(0, Math.min(r1.bottom, r2.bottom) - Math.max(r1.top, r2.top));
  
  const cx = overlapX > 0 ? (Math.max(r1.left, r2.left) + Math.min(r1.right, r2.right)) / 2 : r1.left + r1.width / 2;
  const cy = overlapY > 0 ? (Math.max(r1.top, r2.top) + Math.min(r1.bottom, r2.bottom)) / 2 : r1.top + r1.height / 2;

  const isInside = (r1.left >= r2.left && r1.right <= r2.right && r1.top >= r2.top && r1.bottom <= r2.bottom) || 
                   (r2.left >= r1.left && r2.right <= r1.right && r2.top >= r1.top && r2.bottom <= r1.bottom);

  if (isInside) {
    drawMeasureLine(cx, Math.min(r1.top, r2.top), 0, Math.abs(r1.top - r2.top), Math.round(Math.abs(r1.top - r2.top)), false);
    drawMeasureLine(cx, Math.min(r1.bottom, r2.bottom), 0, Math.abs(r1.bottom - r2.bottom), Math.round(Math.abs(r1.bottom - r2.bottom)), false);
    drawMeasureLine(Math.min(r1.left, r2.left), cy, Math.abs(r1.left - r2.left), 0, Math.round(Math.abs(r1.left - r2.left)), true);
    drawMeasureLine(Math.min(r1.right, r2.right), cy, Math.abs(r1.right - r2.right), 0, Math.round(Math.abs(r1.right - r2.right)), true);
  } else {
    if (r2.bottom < r1.top) {
      drawMeasureLine(cx, r2.bottom, 0, r1.top - r2.bottom, Math.round(r1.top - r2.bottom), false);
    } else if (r2.top > r1.bottom) {
      drawMeasureLine(cx, r1.bottom, 0, r2.top - r1.bottom, Math.round(r2.top - r1.bottom), false);
    }
    
    if (r2.right < r1.left) {
      drawMeasureLine(r2.right, cy, r1.left - r2.right, 0, Math.round(r1.left - r2.right), true);
    } else if (r2.left > r1.right) {
      drawMeasureLine(r1.right, cy, r2.left - r1.right, 0, Math.round(r2.left - r1.right), true);
    }
  }
}

function onGlobalKeyDown(e) {
  if ((e.key === 'Alt' || e.altKey) && !isAltPressed) {
    isAltPressed = true;
    updateMeasurements();
  }
}

function onGlobalKeyUp(e) {
  if (e.key === 'Alt' || !e.altKey) {
    isAltPressed = false;
    clearMeasureLines();
  }
}

/* ============================================================
   ACTIVE BANNER
   ============================================================ */

let bannerEl = null;

function showActiveBanner() {
  if (bannerEl) return;
  bannerEl = document.createElement('div');
  bannerEl.id = 'yw-active-banner';
  bannerEl.innerHTML = `<div class="yw-active-dot"></div> Lens Active &nbsp;·&nbsp; Click any element &nbsp;·&nbsp; <span style="opacity:0.6;">↑↓←→ navigate</span>`;
  document.body.appendChild(bannerEl);
}
function hideActiveBanner() {
  if (bannerEl) { bannerEl.remove(); bannerEl = null; }
}

/* ============================================================
   MAIN ACTIVATION LOGIC
   ============================================================ */

let isActive = false;

function activate() {
  if (isActive) return;
  isActive = true;
  startOverlay();
  showSidebarWidget();
  showActiveBanner();

  document.addEventListener('yw:elementSelected', onElementSelected);
  chrome.runtime.sendMessage({ type: 'YW_ACTIVATED' });
}

function deactivate() {
  if (!isActive) return;
  isActive = false;
  stopOverlay();
  hideSidebarWidget();
  hideActiveBanner();
  closePopover();
  closeJSONModal();
  document.removeEventListener('yw:elementSelected', onElementSelected);
  chrome.runtime.sendMessage({ type: 'YW_DEACTIVATED' });
}

async function onElementSelected(e) {
  const { element } = e.detail;
  if (!element) return;
  
  await openPopover(element);
}

/* ---- Listen for messages from popup / background ---- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'YW_TOGGLE') {
    if (isActive) deactivate(); else activate();
    sendResponse({ active: isActive });
  } else if (msg.type === 'YW_GET_STATE') {
    sendResponse({ active: isActive });
  } else if (msg.type === 'YW_ACTIVATE') {
    activate(); sendResponse({ active: true });
  } else if (msg.type === 'YW_DEACTIVATE') {
    deactivate(); sendResponse({ active: false });
  }
  return true; // keep message channel open for async
});

/* ---- Report state on load (so popup can read it) ---- */
chrome.runtime.sendMessage({ type: 'YW_CONTENT_READY' }).catch(() => {});
