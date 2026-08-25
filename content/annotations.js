/**
 * annotations.js – CRUD layer for Ye Wala
 * Persists annotations per URL using chrome.storage.local.
 * Schema: { version: 1, page: { title, url }, comments: [{ id, selector, tag, textContent, comment }] }
 */

const YW_STORAGE_KEY = 'yw_annotations';

/**
 * Builds a robust, unique CSS selector for a DOM element.
 * Favors id > data attributes > nth-child chain.
 */
function buildSelector(element) {
  if (!element || element === document.body) return 'body';

  // If element has an id, use it directly
  if (element.id && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(element.id)) {
    return '#' + element.id;
  }

  const parts = [];
  let current = element;

  while (current && current !== document.documentElement) {
    let selector = current.tagName.toLowerCase();

    // Add meaningful class names (skip dynamic/utility ones)
    const classes = Array.from(current.classList)
      .filter(c => c.length > 1 && !/^\d/.test(c) && !/^(css|styles?|sc-|_|yw-)/.test(c))
      .slice(0, 2);

    if (classes.length > 0) {
      selector += '.' + classes.join('.');
    }

    // Add nth-child if needed for uniqueness
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        el => el.tagName === current.tagName
      );
      if (siblings.length > 1) {
        const idx = siblings.indexOf(current) + 1;
        selector += `:nth-of-type(${idx})`;
      }
    }

    parts.unshift(selector);
    if (current.id && /^[a-zA-Z]/.test(current.id)) {
      parts[0] = '#' + current.id;
      break; // id is unique enough, stop here
    }
    current = current.parentElement;
  }

  return parts.join(' > ');
}

/**
 * Get the normalised storage key for current URL.
 */
function getPageKey(url) {
  try {
    const u = new URL(url || window.location.href);
    return u.origin + u.pathname; // ignore query/hash
  } catch {
    return window.location.href;
  }
}

/**
 * Load all annotations for the current page.
 * Returns Promise<{ version, page, comments: [] }>
 */
async function loadAnnotations(url) {
  const key = getPageKey(url);
  return new Promise(resolve => {
    chrome.storage.local.get([YW_STORAGE_KEY], result => {
      const all = result[YW_STORAGE_KEY] || {};
      if (all[key]) {
        resolve(all[key]);
      } else {
        resolve({
          version: 1,
          page: { title: document.title, url: key },
          comments: []
        });
      }
    });
  });
}

/**
 * Save annotation data for current page.
 */
async function saveAnnotations(data, url) {
  const key = getPageKey(url);
  return new Promise(resolve => {
    chrome.storage.local.get([YW_STORAGE_KEY], result => {
      const all = result[YW_STORAGE_KEY] || {};
      all[key] = data;
      chrome.storage.local.set({ [YW_STORAGE_KEY]: all }, resolve);
    });
  });
}

/**
 * Upsert a comment for a given element.
 * Returns the updated annotation object.
 */
async function upsertAnnotation(element, commentText) {
  const selector = buildSelector(element);
  const tag = element.tagName;
  const textContent = (element.textContent || '').trim().slice(0, 60);
  const data = await loadAnnotations();

  const existing = data.comments.find(c => c.selector === selector);
  if (existing) {
    existing.comment = commentText;
    existing.updatedAt = Date.now();
  } else {
    data.comments.push({
      id: 'yw_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      selector,
      tag,
      textContent,
      comment: commentText,
      createdAt: Date.now()
    });
  }

  await saveAnnotations(data);
  return data;
}

/**
 * Delete annotation by selector.
 */
async function deleteAnnotation(selector) {
  const data = await loadAnnotations();
  data.comments = data.comments.filter(c => c.selector !== selector);
  await saveAnnotations(data);
  return data;
}

/**
 * Get existing annotation for an element, or null.
 */
async function getAnnotationForElement(element) {
  const selector = buildSelector(element);
  const data = await loadAnnotations();
  return data.comments.find(c => c.selector === selector) || null;
}

/**
 * Export data as clean JSON string (PRD spec).
 */
function exportJSON(data) {
  const clean = {
    version: data.version,
    page: data.page,
    comments: data.comments.map(({ selector, tag, comment }) => ({
      selector,
      tag,
      comment
    }))
  };
  return JSON.stringify(clean, null, 2);
}
