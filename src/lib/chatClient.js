// Chat logic with no React and no DOM, so it can be tested in Node.
//
// Parts:
//   - record building and input checks (messages, channels)
//   - merging polled messages by seq
//   - verification orchestration (every message is checked in the browser with verifyMessages)
//   - a session that loads the last page, polls for new messages and loads older ones
//   - a poller with a back off schedule
//   - plain wording for errors and for the "tied to the server head" line
//
// fetch and verify are injected, so tests can run everything without a server.
import { verifyMessages } from '../../shared/verify.js';
import { LIMITS, ZERO_HASH, isChannelId, isDocId, isHash, newNonce, validateRecord } from '../../shared/records.js';

export const POLL_MS = 3000;
export const POLL_MAX_MS = 60000;
export const TAIL_SIZE = 50;
export const PAGE_SIZE = 50;
export const BODY_MAX = LIMITS.BODY_MAX;
// A signed record is only accepted by the server for 10 minutes, so a retry of the same record
// is only sensible for a little less than that.
export const RESEND_WINDOW_MS = 8 * 60 * 1000;

// ---------------------------------------------------------------------------
// Input checks and record building

function codePoints(text) {
  let n = 0;
  for (const _ of text) n++; // eslint-disable-line no-unused-vars
  return n;
}

export function countChars(text) {
  return typeof text === 'string' ? codePoints(text) : 0;
}

// Line endings to \n, unicode NFC, outer blank space removed.
export function normalizeBody(text) {
  if (typeof text !== 'string') return '';
  let t = text.replace(/\r\n?/g, '\n');
  try {
    t = t.normalize('NFC');
  } catch {
    // keep as it is, the validator reports bad text
  }
  return t.trim();
}

function friendlyTextError(label, raw, count, max) {
  if (/must be \d+ to \d+ characters/.test(raw)) {
    if (count === 0) return `${label} cannot be empty.`;
    if (count > max) return `${label} is ${count} characters, the limit is ${max}.`;
  }
  if (/blank/.test(raw)) return `${label} needs at least one visible character.`;
  if (/control characters/.test(raw)) return `${label} has characters that are not allowed.`;
  if (/invisible/.test(raw)) return `${label} has invisible characters, remove them.`;
  if (/direction override|line separator/.test(raw)) return `${label} has direction or line separator characters, remove them.`;
  if (/unicode/.test(raw)) return `${label} has characters that cannot be stored.`;
  return `${label}: ${raw}.`;
}

// Checks message text with the shared validator.
// Returns { ok, body, count, error }. error is plain words for the person writing.
export function checkBody(text) {
  const body = normalizeBody(text);
  const count = countChars(body);
  const probe = {
    v: 2,
    type: 'message',
    channelId: 'general',
    body,
    replyTo: '',
    signer: ZERO_HASH,
    createdAt: 0,
    nonce: '0'.repeat(32)
  };
  const res = validateRecord(probe);
  if (res.ok) return { ok: true, body, count, error: '' };
  const raw = String(res.error || '').replace(/^body\s*/, 'body ');
  return { ok: false, body, count, error: friendlyTextError('The message', raw, count, BODY_MAX) };
}

// Builds the message record that gets signed. Throws Error with the reason when it is not valid.
export function buildMessageRecord({ channelId, body, replyTo = '', signer, now = Date.now(), nonce } = {}) {
  const record = {
    v: 2,
    type: 'message',
    channelId,
    body: normalizeBody(body),
    replyTo: replyTo || '',
    signer,
    createdAt: now,
    nonce: nonce || newNonce()
  };
  const res = validateRecord(record);
  if (!res.ok) throw new Error(res.error);
  return record;
}

// "My Town Hall!" -> "my-town-hall". Gives '' when nothing usable is left.
export function slugifyTitle(title) {
  if (typeof title !== 'string') return '';
  let s = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  if (s.length < 3) s = '';
  return s;
}

// Accepts a bare document id or a link that contains /d/<id>. Returns the id, '' for empty input,
// or null when the text is not a document id.
export function parseDocIdInput(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (t === '') return '';
  const lower = t.toLowerCase();
  if (isDocId(lower)) return lower;
  const m = /\/d\/([0-9a-fA-F]{32})(?![0-9a-fA-F])/.exec(t);
  return m ? m[1].toLowerCase() : null;
}

// Checks the create channel form. errors has one text per field that is wrong.
export function checkChannelInput({ title, channelId, docId } = {}) {
  const errors = {};
  const cleanTitle = normalizeBody(typeof title === 'string' ? title.replace(/\n/g, ' ') : '');
  const id = typeof channelId === 'string' ? channelId.trim() : '';
  const doc = parseDocIdInput(typeof docId === 'string' ? docId : '');

  if (!isChannelId(id)) {
    errors.channelId = 'Use 3 to 40 lowercase letters, digits or hyphens, starting with a letter or digit.';
  }
  if (doc === null) errors.docId = 'This is not a document id. Paste the 32 character id or the document link.';

  const probe = {
    v: 2,
    type: 'channel.create',
    channelId: isChannelId(id) ? id : 'general',
    title: cleanTitle,
    docId: doc === null ? '' : doc,
    signer: ZERO_HASH,
    createdAt: 0
  };
  const res = validateRecord(probe);
  if (!res.ok && /^title/.test(res.error)) {
    errors.title = friendlyTextError('The title', res.error, countChars(cleanTitle), LIMITS.TITLE_MAX);
  }
  return {
    ok: Object.keys(errors).length === 0,
    values: { title: cleanTitle, channelId: id, docId: doc === null ? '' : doc },
    errors
  };
}

export function buildChannelRecord({ channelId, title, docId = '', signer, now = Date.now() } = {}) {
  const record = {
    v: 2,
    type: 'channel.create',
    channelId,
    title: normalizeBody(title),
    docId: docId || '',
    signer,
    createdAt: now
  };
  const res = validateRecord(record);
  if (!res.ok) throw new Error(res.error);
  return record;
}

// ---------------------------------------------------------------------------
// Channel list helpers

// Newest activity first. Channels nobody wrote in sort by creation time.
export function sortChannels(channels) {
  if (!Array.isArray(channels)) return [];
  const stamp = (c) => (c && Number.isFinite(c.lastMessageAt) ? c.lastMessageAt : c && Number.isFinite(c.createdAt) ? c.createdAt : 0);
  return channels
    .filter((c) => c && typeof c === 'object' && isChannelId(c.channelId))
    .slice()
    .sort((a, b) => stamp(b) - stamp(a) || (a.channelId < b.channelId ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Wording for errors

// Turns an error from the api module (or any error) into { message, hint }.
// hint is 'keys' when the person should open the identity page, or ''.
export function describeApiError(err, what = 'do that') {
  const status = err && Number.isFinite(err.status) ? err.status : -1;
  const code = err && typeof err.code === 'string' ? err.code : '';
  const text = err && typeof err.message === 'string' ? err.message : '';
  if (status === 429 || code === 'rate_limited') {
    return {
      message: 'You are sending too fast and the server asked you to slow down (messages are limited to 20 per minute). Wait a little and try again.',
      hint: ''
    };
  }
  if (code === 'unknown_signer') {
    return { message: 'The server does not know your identity yet. Open the Keys page to register it, then try again.', hint: 'keys' };
  }
  if (code === 'bad_signature') {
    return { message: 'The server could not verify your signature. Check the Keys page, your stored key may not match.', hint: 'keys' };
  }
  if (code === 'expired') {
    return { message: 'The server says the time on this device is more than 10 minutes away from its own time. Fix the clock and try again.', hint: '' };
  }
  if (code === 'network' || status === 0) {
    return { message: 'Could not reach the server. Check your connection.', hint: '' };
  }
  if (code === 'exists' || (status === 409 && code !== 'conflict')) {
    return { message: text || 'That already exists.', hint: '' };
  }
  if (code === 'not_found' || status === 404) {
    return { message: text || 'The server could not find that.', hint: '' };
  }
  if (code === 'too_large' || status === 413) {
    return { message: 'That is too large for the server.', hint: '' };
  }
  if (status >= 500) {
    return { message: 'The server had a problem. Try again in a moment.', hint: '' };
  }
  return { message: text ? text : `Could not ${what}.`, hint: '' };
}

// ---------------------------------------------------------------------------
// Merging

function validSeq(n) {
  return Number.isSafeInteger(n) && n >= 1;
}

// existing and incoming are entries with seq and hash. Existing entries win, so a message that is
// already shown (and already checked) is never swapped by a later answer. Two different messages
// for one seq are reported in conflicts. Result is sorted by seq with no duplicates.
export function mergeEntries(existing, incoming) {
  const bySeq = new Map();
  const conflicts = [];
  let dropped = 0;
  for (const e of Array.isArray(existing) ? existing : []) {
    if (e && validSeq(e.seq) && !bySeq.has(e.seq)) bySeq.set(e.seq, e);
  }
  for (const e of Array.isArray(incoming) ? incoming : []) {
    if (!e || !validSeq(e.seq)) {
      dropped++;
      continue;
    }
    const have = bySeq.get(e.seq);
    if (!have) {
      bySeq.set(e.seq, e);
    } else if (have.hash !== e.hash) {
      if (!conflicts.includes(e.seq)) conflicts.push(e.seq);
    }
  }
  const entries = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return { entries, conflicts, dropped };
}

// Hash -> seq of the entries, used to spot a signed message that shows up twice.
export function hashIndex(entries) {
  const map = new Map();
  for (const e of entries) if (e && typeof e.hash === 'string' && !map.has(e.hash)) map.set(e.hash, e.seq);
  return map;
}

// Pending (just sent) messages that the server list now contains are removed.
export function dropDelivered(pending, entries) {
  const have = hashIndex(entries);
  return (Array.isArray(pending) ? pending : []).filter((p) => !have.has(p.hash));
}

export function canResend(pending, now = Date.now()) {
  return Boolean(pending && pending.record && now - pending.record.createdAt < RESEND_WINDOW_MS && now >= pending.record.createdAt - 60000);
}

// ---------------------------------------------------------------------------
// Verification orchestration

function reasonOf(err) {
  return err && err.message ? err.message : 'unknown problem';
}

function stripVerdict(entry) {
  const { verdict, ...rest } = entry; // eslint-disable-line no-unused-vars
  return rest;
}

// Verifies one page of messages and returns entries with a verdict each.
//   verdict.status  'verified' (signature, key id, message hash and chain link checked)
//                   'invalid' (something failed, detail says what)
//                   'unverified' (the check itself could not run)
// ctx: channelId (from the route), pin (pinned server key id or ''), startPrev (chain hash before the
// first message, when known), known (Map hash -> seq of messages already shown), verify (injected).
export async function verifyPageEntries(page, ctx = {}) {
  const { channelId, pin = '', startPrev, known = new Map(), verify = verifyMessages } = ctx;
  const raw = page && Array.isArray(page.messages) ? page.messages : [];
  const messages = raw.filter((m) => m && typeof m === 'object');
  const warnings = [];
  if (messages.length !== raw.length) warnings.push('The server sent entries that are not messages. They were ignored.');
  const view = { ...(page || {}), messages: messages.map(stripVerdict) };
  let res;
  try {
    const opts = { pinnedServerKeyId: pin || undefined, expectedChannelId: channelId, allowUnanchored: true };
    if (isHash(startPrev)) opts.startPrev = startPrev;
    res = await verify(view, opts);
  } catch (err) {
    res = null;
    warnings.push('The check could not run: ' + reasonOf(err));
  }
  const results = res && Array.isArray(res.results) ? res.results : [];
  const entries = messages.map((m, i) => {
    const r = results[i];
    let verdict;
    if (!r) verdict = { status: 'unverified', detail: 'This message could not be checked.' };
    else if (r.ok) verdict = { status: 'verified', detail: String(r.detail || 'signature, signer key id and message hash verify') };
    else verdict = { status: 'invalid', detail: String(r.detail || 'the check failed') };
    const prior = typeof m.hash === 'string' ? known.get(m.hash) : undefined;
    if (prior !== undefined && prior !== m.seq) {
      verdict = {
        status: 'invalid',
        detail: `replayed: this exact signed message is already shown at position ${prior}`
      };
    }
    return { ...m, verdict };
  });
  if (res && Array.isArray(res.warnings)) warnings.push(...res.warnings);
  return { entries, chainOk: Boolean(res && res.chainOk), warnings, ran: Boolean(res) };
}

// Checks the channel head: is the newest loaded message exactly where the signed server
// checkpoint says the channel ends? Uses only the newest message and the checkpoint of the page.
// Returns { anchored, hasCheckpoint, checkpointSeq, signedAt, serverKeyId, pinned, headSeq, warnings }.
export async function checkAnchor({ headEntry, identities, page, channelId, pin = '', verify = verifyMessages }) {
  const cp = page && page.checkpoint && typeof page.checkpoint === 'object' ? page.checkpoint : null;
  const payload = cp && cp.payload && typeof cp.payload === 'object' ? cp.payload : null;
  const out = {
    anchored: false,
    hasCheckpoint: Boolean(payload),
    checkpointSeq: payload && Number.isFinite(payload.seq) ? payload.seq : null,
    signedAt: payload && Number.isFinite(payload.signedAt) ? payload.signedAt : null,
    serverKeyId: payload && typeof payload.serverKeyId === 'string' ? payload.serverKeyId : '',
    pinned: isHash(pin),
    headSeq: headEntry ? headEntry.seq : 0,
    warnings: []
  };
  if (!payload) return out;
  const view = {
    channel: page.channel,
    messages: headEntry ? [stripVerdict(headEntry)] : [],
    identities: identities || {},
    checkpoint: page.checkpoint,
    server: page.server
  };
  try {
    const opts = { pinnedServerKeyId: pin || undefined, expectedChannelId: channelId, allowUnanchored: true };
    if (headEntry && isHash(headEntry.prevChainHash)) opts.startPrev = headEntry.prevChainHash;
    const res = await verify(view, opts);
    out.anchored = Boolean(res && res.anchored);
    out.warnings = res && Array.isArray(res.warnings) ? res.warnings : [];
  } catch (err) {
    out.warnings = ['The head check could not run: ' + reasonOf(err)];
  }
  return out;
}

// Plain words for the footer line under the messages.
// Returns { tone: 'good' | 'warn' | 'info', title, lines: [string] }
export function describeAnchor(anchor, { checking = false } = {}) {
  if (!anchor) {
    return { tone: 'info', title: checking ? 'Checking the server head' : 'Server head not checked yet', lines: [] };
  }
  const lines = [];
  if (anchor.anchored) {
    lines.push(
      `The server signed a checkpoint at message ${anchor.checkpointSeq}, and the newest message shown is exactly that one.`
    );
    lines.push(
      anchor.pinned
        ? 'The checkpoint key is the server key you pinned.'
        : 'You have not pinned a server key, so this only proves the key the server presented. You can pin it on the Verify page.'
    );
    return { tone: 'good', title: 'Latest messages tied to the server head', lines };
  }
  if (!anchor.hasCheckpoint) {
    lines.push('The server did not send a signed checkpoint, so nobody vouches that no later messages are being held back.');
    return { tone: 'warn', title: 'Not tied to the server head', lines };
  }
  const older = anchor.checkpointSeq !== null && anchor.headSeq < anchor.checkpointSeq;
  if (older) {
    lines.push(
      `The newest message shown is number ${anchor.headSeq}, but the server head is at ${anchor.checkpointSeq}. Messages and links were checked, but not tied to the head.`
    );
  } else {
    lines.push('The checkpoint could not be matched to the newest message shown.');
  }
  for (const w of anchor.warnings) if (!lines.includes(w)) lines.push(w);
  return { tone: 'warn', title: older ? 'Not tied to the server head, older page' : 'Not tied to the server head', lines };
}

// ---------------------------------------------------------------------------
// Session

function isPage(page) {
  return page && typeof page === 'object' && Array.isArray(page.messages);
}

function mergeIdentities(have, add) {
  const out = { ...have };
  if (add && typeof add === 'object') {
    for (const [k, v] of Object.entries(add)) if (!out[k]) out[k] = v;
  }
  return out;
}

function addProblem(list, text) {
  return list.includes(text) ? list : [...list, text];
}

// One open channel. It holds the entries, verdicts and head status.
//   getMessages(channelId, { after, limit, tail })   injected (the api module)
//   verify(page, options)                            injected (verifyMessages)
//   getPin()                                         returns the pinned server key id or ''
export function createChatSession({
  channelId,
  getMessages,
  verify = verifyMessages,
  getPin = () => '',
  tail = TAIL_SIZE,
  pageSize = PAGE_SIZE
}) {
  let state = {
    phase: 'loading', // loading, ready, error, missing
    channel: null,
    entries: [],
    identities: {},
    problems: [],
    anchor: null,
    hasOlder: false,
    lastSeq: 0,
    error: null,
    failures: 0,
    updatedAt: 0
  };
  let loaded = false;
  let disposed = false;
  let inflight = null;
  const listeners = new Set();

  function set(patch) {
    state = { ...state, ...patch };
    for (const fn of listeners) {
      try {
        fn(state);
      } catch {
        // a broken listener must not stop the session
      }
    }
  }

  function pin() {
    try {
      return getPin() || '';
    } catch {
      return '';
    }
  }

  // Adds a verified page to the state. Returns the number of new entries.
  async function absorb(page, { startPrev, older = false } = {}) {
    const p = pin();
    const known = hashIndex(state.entries);
    const checked = await verifyPageEntries(page, { channelId, pin: p, startPrev, known, verify });
    let problems = state.problems;
    if (page.channel && typeof page.channel.channelId === 'string' && page.channel.channelId !== channelId) {
      problems = addProblem(problems, 'The server answered with a different channel than the one you opened.');
    }
    if (!checked.chainOk && checked.entries.length > 0) {
      problems = addProblem(problems, 'The links between some messages do not add up. Look for messages marked as failed.');
    }
    let incoming = checked.entries;
    if (older && incoming.length > 0 && state.entries.length > 0) {
      const last = incoming[incoming.length - 1];
      const first = state.entries[0];
      if (last.seq + 1 !== first.seq || last.chainHash !== first.prevChainHash) {
        problems = addProblem(problems, 'The older page does not connect to the newer messages, so it was marked as failed.');
        incoming = incoming.map((e) => ({
          ...e,
          verdict: { status: 'invalid', detail: 'this page does not connect to the messages that follow it' }
        }));
      }
    }
    const merged = mergeEntries(state.entries, incoming);
    if (merged.conflicts.length > 0) {
      problems = addProblem(
        problems,
        `The server sent two different messages for position ${merged.conflicts.join(', ')}. The first one received is shown.`
      );
    }
    if (merged.dropped > 0) problems = addProblem(problems, 'The server sent entries without a valid position. They were ignored.');
    const before = state.entries.length;
    const identities = mergeIdentities(state.identities, page.identities);
    const entries = merged.entries;
    const head = entries.length > 0 ? entries[entries.length - 1] : null;
    let anchor = state.anchor;
    if (!older) {
      anchor = await checkAnchor({ headEntry: head, identities, page, channelId, pin: p, verify });
    }
    if (disposed) return 0;
    const patch = {
      entries,
      identities,
      problems,
      anchor,
      lastSeq: head ? head.seq : 0,
      hasOlder: entries.length > 0 ? entries[0].seq > 1 : false,
      updatedAt: Date.now()
    };
    if (page.channel && typeof page.channel === 'object') patch.channel = page.channel;
    set(patch);
    return entries.length - before;
  }

  async function loadInitialNow() {
    const page = await getMessages(channelId, { tail });
    if (disposed) return;
    if (!isPage(page)) throw new Error('The server sent an answer that could not be read.');
    await absorb(page, {});
    if (disposed) return;
    loaded = true;
    set({ phase: 'ready', error: null, failures: 0 });
  }

  async function pollNow() {
    let guard = 0;
    for (;;) {
      const after = state.lastSeq;
      const page = await getMessages(channelId, { after, limit: pageSize });
      if (disposed) return;
      if (!isPage(page)) throw new Error('The server sent an answer that could not be read.');
      const last = state.entries[state.entries.length - 1];
      const first = page.messages.find((m) => m && typeof m === 'object');
      let startPrev;
      if (last && first) {
        if (first.seq === last.seq + 1) startPrev = last.chainHash;
        else if (Number.isSafeInteger(first.seq) && first.seq > last.seq + 1) {
          set({
            problems: addProblem(
              state.problems,
              `Messages ${last.seq + 1} to ${first.seq - 1} were not sent by the server. Something may be held back.`
            )
          });
        }
      }
      await absorb(page, { startPrev });
      if (disposed) return;
      set({ phase: 'ready', error: null, failures: 0 });
      guard++;
      if (!page.hasMore || page.messages.length === 0 || guard >= 5) return;
    }
  }

  // One round of work: first load, or a poll. Errors are stored in the state and thrown so a
  // poller can back off. A missing channel is final and asks the poller to stop.
  function tick() {
    if (disposed) return Promise.resolve({ stop: true });
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        if (!loaded) await loadInitialNow();
        else await pollNow();
        return { stop: false };
      } catch (err) {
        if (disposed) return { stop: true };
        const info = describeApiError(err, 'load messages');
        if (err && (err.status === 404 || err.code === 'not_found')) {
          set({ phase: 'missing', error: info.message });
          return { stop: true };
        }
        set({
          phase: loaded ? 'ready' : 'error',
          error: info.message,
          failures: state.failures + 1
        });
        throw err;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  async function loadOlder() {
    if (disposed || !loaded || state.entries.length === 0) return 0;
    const firstSeq = state.entries[0].seq;
    if (firstSeq <= 1) return 0;
    const after = Math.max(0, firstSeq - 1 - pageSize);
    const limit = firstSeq - 1 - after;
    const page = await getMessages(channelId, { after, limit });
    if (disposed) return 0;
    if (!isPage(page)) throw new Error('The server sent an answer that could not be read.');
    return absorb(page, { older: true });
  }

  return {
    tick,
    loadOlder,
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispose() {
      disposed = true;
      listeners.clear();
    }
  };
}

// ---------------------------------------------------------------------------
// Poller and back off

// Wait before the next try. No failures: the normal interval. After n failures: doubling, capped.
// random() lets tests fix the jitter (a value from 0 to 1, spread is plus or minus 20 percent).
export function backoffDelay(failures, { base = POLL_MS, max = POLL_MAX_MS, random = Math.random } = {}) {
  const n = Number.isFinite(failures) ? Math.max(0, Math.floor(failures)) : 0;
  if (n === 0) return base;
  const raw = Math.min(max, base * 2 ** Math.min(n, 20));
  const spread = 0.8 + 0.4 * Math.min(1, Math.max(0, Number(random())));
  return Math.min(max, Math.max(base, Math.round(raw * spread)));
}

// Runs run() now and then again after each wait.
//   - never two runs at the same time
//   - waits longer after failures (backoffDelay)
//   - does not run while isHidden() is true, call resume() when the tab is visible again
//   - kick() runs right away (after sending a message, or a retry button)
//   - run may return { stop: true } to end polling
// onStatus(status, delayMs) with status: 'running', 'waiting', 'retrying', 'paused', 'stopped'
export function createPoller({
  run,
  baseMs = POLL_MS,
  maxMs = POLL_MAX_MS,
  isHidden = () => false,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  random = Math.random,
  onStatus = () => {}
}) {
  let timer = null;
  let stopped = true;
  let paused = false;
  let failures = 0;
  let current = null;

  function say(status, delay) {
    try {
      onStatus(status, delay);
    } catch {
      // ignore listener errors
    }
  }

  function clear() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function schedule(delay) {
    clear();
    timer = setTimer(() => {
      timer = null;
      tick(false);
    }, delay);
  }

  function tick(force) {
    if (stopped) return Promise.resolve();
    if (current) return current;
    clear();
    if (!force && isHidden()) {
      paused = true;
      say('paused', 0);
      return Promise.resolve();
    }
    paused = false;
    say('running', 0);
    current = (async () => {
      let failed = false;
      try {
        const r = await run();
        failures = 0;
        if (r && r.stop) {
          stopped = true;
          say('stopped', 0);
        }
      } catch {
        failed = true;
        failures++;
      } finally {
        current = null;
      }
      if (stopped) return;
      const delay = backoffDelay(failures, { base: baseMs, max: maxMs, random });
      say(failed ? 'retrying' : 'waiting', delay);
      schedule(delay);
    })();
    return current;
  }

  return {
    start() {
      stopped = false;
      failures = 0;
      return tick(true);
    },
    stop() {
      stopped = true;
      clear();
      say('stopped', 0);
    },
    // Run now unless a run is already going on.
    kick() {
      return tick(true);
    },
    // The tab became visible again: continue if polling was paused.
    resume() {
      if (!stopped && paused) return tick(true);
      return Promise.resolve();
    },
    isStopped: () => stopped,
    failures: () => failures
  };
}
