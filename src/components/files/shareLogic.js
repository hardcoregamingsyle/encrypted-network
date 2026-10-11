// Sharing a link: the phone share sheet when there is one, the clipboard otherwise.
// Pure functions with the browser pieces passed in, so they are tested in Node.

export function canNativeShare(nav = globalThis.navigator) {
  return Boolean(nav) && typeof nav.share === 'function';
}

// Returns 'shared', 'cancelled' (the person closed the share sheet), 'copied' or 'failed'.
// copy(text) must resolve to true when the text reached the clipboard.
export async function shareLink({ link, title }, { nav = globalThis.navigator, copy } = {}) {
  if (typeof link !== 'string' || link === '') return 'failed';
  if (canNativeShare(nav)) {
    try {
      await nav.share(title ? { title, url: link } : { url: link });
      return 'shared';
    } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled';
      // any other failure falls back to copying
    }
  }
  try {
    return typeof copy === 'function' && (await copy(link)) ? 'copied' : 'failed';
  } catch {
    return 'failed';
  }
}

// The toast for the outcome of shareLink, or null when nothing needs saying.
// withPassword is true when the link also opens the file.
export function shareToast(outcome, { withPassword = true } = {}) {
  if (outcome === 'copied') {
    return {
      tone: 'good',
      text: withPassword ? 'Link copied. Anyone who has it can open the file.' : 'Link copied. It lets people check the file, but not open it.'
    };
  }
  if (outcome === 'failed') return { tone: 'bad', text: 'Could not copy the link. Try again.' };
  return null;
}
