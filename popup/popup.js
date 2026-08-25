/**
 * popup.js – Lens Popup logic
 * Communicates with the active tab's content script to toggle activation.
 */

const YW_STORAGE_KEY = 'yw_annotations';

let isActive = false;

const toggleBtn = document.getElementById('toggle-btn');
const btnIcon = document.getElementById('btn-icon');
const btnLabel = document.getElementById('btn-label');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const statCount = document.getElementById('stat-count');
const statPage = document.getElementById('stat-page');

/* ---- Update UI based on active state ---- */
function setUI(active) {
  isActive = active;
  if (active) {
    statusDot.classList.add('active');
    statusText.textContent = 'Active – inspect mode on';
    statusText.style.color = '#10b981';
    btnIcon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>';
    btnLabel.textContent = 'Deactivate';
    toggleBtn.classList.add('deactivate');
  } else {
    statusDot.classList.remove('active');
    statusText.textContent = 'Inactive';
    statusText.style.color = '#64748b';
    btnIcon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>';
    btnLabel.textContent = 'Activate Lens';
    toggleBtn.classList.remove('deactivate');
  }
}

/* ---- Query annotation count for current tab ---- */
async function loadStats(tab) {
  try {
    const url = new URL(tab.url);
    const pageKey = url.origin + url.pathname;
    const hostname = url.hostname.replace('www.', '');
    statPage.textContent = hostname.length > 14 ? hostname.slice(0, 13) + '…' : hostname;

    chrome.storage.local.get([YW_STORAGE_KEY], result => {
      const all = result[YW_STORAGE_KEY] || {};
      const data = all[pageKey];
      statCount.textContent = data ? data.comments.length : '0';
    });
  } catch {
    statPage.textContent = 'Local';
    statCount.textContent = '—';
  }
}

/* ---- Get current tab ---- */
async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/* ---- Programmatic injection for already-open tabs ---- */
async function injectContentScript(tabId) {
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ['content/content.css']
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/content.js']
  });
  // Give the script a moment to initialise
  await new Promise(r => setTimeout(r, 250));
}

/* ---- Show button loading state ---- */
function setBtnLoading(loading) {
  toggleBtn.disabled = loading;
  if (loading) {
    btnIcon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="animation: spin 1s linear infinite;"><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line></svg>';
    btnLabel.textContent = 'Injecting…';
    toggleBtn.style.opacity = '0.7';
  } else {
    toggleBtn.style.opacity = '1';
  }
}

/* ---- Is the URL injectable? (not chrome://, chrome-extension://, etc.) ---- */
function isInjectableTab(tab) {
  if (!tab || !tab.url) return false;
  return !tab.url.startsWith('chrome://') &&
         !tab.url.startsWith('chrome-extension://') &&
         !tab.url.startsWith('edge://') &&
         !tab.url.startsWith('about:') &&
         !tab.url.startsWith('devtools://');
}

/* ---- Toggle ---- */
toggleBtn.addEventListener('click', async () => {
  const tab = await getCurrentTab();
  if (!tab || !tab.id) return;

  if (!isInjectableTab(tab)) {
    // Truly uninjectable pages
    setUI(false);
    btnIcon.textContent = '⚠';
    btnLabel.textContent = 'Open a website first';
    setTimeout(() => setUI(false), 2000);
    return;
  }

  // First try: content script already running?
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'YW_TOGGLE' });
    setUI(response && response.active);
    await loadStats(tab);
    return;
  } catch {
    // Not injected yet — inject it now
  }

  // Second try: programmatically inject, then toggle
  setBtnLoading(true);
  try {
    await injectContentScript(tab.id);
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'YW_TOGGLE' });
    setUI(response && response.active);
    await loadStats(tab);
  } catch (injectErr) {
    setUI(false);
    btnIcon.textContent = '⚠';
    btnLabel.textContent = 'Reload the page & retry';
    setTimeout(() => setUI(false), 2500);
  } finally {
    setBtnLoading(false);
  }
});

/* ---- Init: query state on open ---- */
(async () => {
  const tab = await getCurrentTab();
  if (!tab || !tab.id) return;

  await loadStats(tab);

  if (!isInjectableTab(tab)) {
    statusText.textContent = 'Navigate to a webpage first';
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'YW_GET_STATE' });
    setUI(response && response.active);
  } catch {
    // Content script not loaded yet — show inactive (will inject on click)
    setUI(false);
  }
})();
