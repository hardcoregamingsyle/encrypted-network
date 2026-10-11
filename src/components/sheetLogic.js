// Pure helpers for the Sheet: the focus trap and the page scroll lock.

export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

// The index to focus after Tab (or Shift+Tab) when count controls are inside the sheet and index is
// the one that has focus now (-1 when focus is somewhere else). Tab wraps around at both ends.
export function nextTabIndex(count, index, backwards) {
  if (!Number.isInteger(count) || count <= 0) return -1;
  if (index < 0 || index >= count) return backwards ? count - 1 : 0;
  if (backwards) return index === 0 ? count - 1 : index - 1;
  return index === count - 1 ? 0 : index + 1;
}

// What a key press inside the sheet should do:
//   { action: 'close' }               Escape, when the sheet may be dismissed
//   { action: 'focus', index }        Tab that would leave the sheet, or focus is outside the list
//   { action: 'none' }                everything else (the browser handles it)
export function sheetKeyAction({ key, shiftKey = false }, { count, index, dismissible = true }) {
  if (key === 'Escape') return dismissible ? { action: 'close' } : { action: 'none' };
  if (key !== 'Tab') return { action: 'none' };
  if (count <= 0) return { action: 'focus', index: -1 };
  const outside = index < 0 || index >= count;
  const atEdge = shiftKey ? index === 0 : index === count - 1;
  if (outside || atEdge) return { action: 'focus', index: nextTabIndex(count, index, shiftKey) };
  return { action: 'none' };
}

// Locks the scroll of the page while sheets are open. Several sheets can be open at once, the page
// scrolls again when the last one closes. doc is the document (or a stand in for tests).
export function createScrollLock(doc) {
  let holders = 0;
  return {
    lock() {
      if (!doc || !doc.body) return;
      if (holders === 0) doc.body.classList.add('ui-scroll-locked');
      holders += 1;
    },
    unlock() {
      if (!doc || !doc.body || holders === 0) return;
      holders -= 1;
      if (holders === 0) doc.body.classList.remove('ui-scroll-locked');
    },
    count: () => holders
  };
}

// Where focus goes when the sheet closes: the control that opened it, if it is still on the page.
export function pickReturnTarget(opener, doc) {
  if (opener && typeof opener.focus === 'function' && (!doc || !doc.contains || doc.contains(opener))) return opener;
  return null;
}
