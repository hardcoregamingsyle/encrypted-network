// The Add file flow without any screen: publish, then keep the password for the owner, then try to put
// the link on the clipboard. The browser pieces are passed in, so it runs in Node tests.
import { runPublish } from '../vault/publishFlow.js';
import { progressLine } from './addLogic.js';

async function safe(fn, fallback) {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

// Returns { ok: false, error, message, hint, failedStep } or
//         { ok: true, result, stored: 'account' | 'device' | 'none', link, copied }.
// The password stays inside result and the link. It is never part of any text made here.
//   publish(args)      defaults to publishNewDocument (through runPublish)
//   save(docId, pw)    keeps the password for the owner and says where it went (src/lib/vault.js)
//   copy(text)         puts text on the clipboard and says whether it worked
//   onLine(text)       one short progress line at a time
export async function runAddFile({ file, label, listed, identity, publish, save, copy, onLine }) {
  const tell = (text) => {
    if (typeof onLine !== 'function') return;
    try {
      onLine(text);
    } catch {
      // a broken screen update must not stop the publish
    }
  };
  tell('Starting');
  const out = await runPublish({
    file,
    label,
    listed,
    identity,
    publish,
    onUpdate: (steps) => tell(progressLine(steps))
  });
  if (!out.ok) return out;
  // The file exists now: keep its password before anything else.
  tell('Saving your password');
  const stored = await safe(() => save(out.result.docId, out.result.password), 'none');
  const link = out.result.links.full;
  const copied = (await safe(() => copy(link), false)) === true;
  return { ok: true, result: out.result, stored: stored === 'account' || stored === 'device' ? stored : 'none', link, copied };
}
