/**
 * service_worker.js – Ye Wala Background Service Worker (MV3)
 * Handles:
 *   - Tracking active/inactive state per tab
 *   - Updating badge count
 *   - Relaying messages
 */

const YW_STORAGE_KEY = 'yw_annotations';
const tabStates = {}; // tabId → boolean (active)

/* ---- Extension icon badge ---- */
async function updateBadge(tabId) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) { chrome.action.setBadgeText({ text: '' }); return; }

    const url = new URL(tab.url);
    const pageKey = url.origin + url.pathname;

    chrome.storage.local.get([YW_STORAGE_KEY], result => {
      const all = result[YW_STORAGE_KEY] || {};
      const data = all[pageKey];
      const count = data ? data.comments.length : 0;
      const isActive = tabStates[tabId] || false;

      chrome.action.setBadgeBackgroundColor({ color: isActive ? '#7C3AED' : '#334155' });
      chrome.action.setBadgeText({ text: count > 0 ? String(count) : (isActive ? '●' : '') });
    });
  } catch {}
}

/* ---- Message handler ---- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab ? sender.tab.id : null;

  if (msg.type === 'YW_ACTIVATED' && tabId) {
    tabStates[tabId] = true;
    updateBadge(tabId);
  } else if (msg.type === 'YW_DEACTIVATED' && tabId) {
    tabStates[tabId] = false;
    updateBadge(tabId);
  } else if (msg.type === 'YW_CONTENT_READY' && tabId) {
    updateBadge(tabId);
  }

  sendResponse({});
  return true;
});

/* ---- Update badge when tab changes ---- */
chrome.tabs.onActivated.addListener(({ tabId }) => {
  updateBadge(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') {
    // Reset state for navigated tab
    tabStates[tabId] = false;
    updateBadge(tabId);
  }
});

/* ---- Storage change → update badge ---- */
chrome.storage.onChanged.addListener(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) updateBadge(tab.id);
});

/* ---- Set initial badge style ---- */
chrome.action.setBadgeBackgroundColor({ color: '#7C3AED' });
