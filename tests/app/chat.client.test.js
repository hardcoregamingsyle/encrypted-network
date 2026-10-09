import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BODY_MAX,
  POLL_MAX_MS,
  POLL_MS,
  backoffDelay,
  buildChannelRecord,
  buildMessageRecord,
  canResend,
  checkBody,
  checkChannelInput,
  countChars,
  createPoller,
  describeAnchor,
  describeApiError,
  dropDelivered,
  hashIndex,
  mergeEntries,
  normalizeBody,
  parseDocIdInput,
  slugifyTitle,
  sortChannels
} from '../../src/lib/chatClient.js';
import { ZERO_HASH, validateRecord } from '../../shared/records.js';

const KEY = 'a1'.repeat(32);
const HASH = (n) => String(n).padStart(2, '0').repeat(32);

describe('message input checks', () => {
  it('accepts normal text and returns the cleaned body', () => {
    const r = checkBody('  hello\r\nworld  ');
    expect(r.ok).toBe(true);
    expect(r.body).toBe('hello\nworld');
    expect(r.count).toBe(11);
    expect(r.error).toBe('');
  });

  it('rejects empty and blank text with plain words', () => {
    expect(checkBody('').ok).toBe(false);
    expect(checkBody('').error).toMatch(/cannot be empty/);
    expect(checkBody('   \n\t ').ok).toBe(false);
  });

  it('enforces the 2000 character limit and counts code points, not UTF-16 units', () => {
    expect(checkBody('a'.repeat(BODY_MAX)).ok).toBe(true);
    const over = checkBody('a'.repeat(BODY_MAX + 1));
    expect(over.ok).toBe(false);
    expect(over.error).toContain('2001');
    expect(over.error).toContain('2000');
    // 2000 emoji are 4000 UTF-16 units but 2000 characters
    const emoji = '\u{1F600}'.repeat(BODY_MAX);
    expect(countChars(emoji)).toBe(BODY_MAX);
    expect(checkBody(emoji).ok).toBe(true);
    expect(checkBody(emoji + '\u{1F600}').ok).toBe(false);
  });

  it('rejects control characters but allows new lines', () => {
    expect(checkBody('a\u0000b').ok).toBe(false);
    expect(checkBody('a\u0007b').error).toMatch(/not allowed/);
    expect(checkBody('line one\nline two').ok).toBe(true);
  });

  it('rejects text made only of invisible characters', () => {
    expect(checkBody('​​').ok).toBe(false);
  });

  it('normalises to NFC', () => {
    const decomposed = 'é';
    expect(normalizeBody(decomposed)).toBe('é');
    expect(checkBody(decomposed).body).toBe('é');
  });

  it('handles non string input without throwing', () => {
    expect(normalizeBody(null)).toBe('');
    expect(normalizeBody(undefined)).toBe('');
    expect(checkBody(undefined).ok).toBe(false);
    expect(countChars(5)).toBe(0);
  });
});

describe('record building', () => {
  it('builds a message record that the shared validator accepts', () => {
    const rec = buildMessageRecord({ channelId: 'town-hall', body: ' hi ', signer: KEY, now: 1700000000000 });
    expect(rec).toMatchObject({ v: 2, type: 'message', channelId: 'town-hall', body: 'hi', replyTo: '', signer: KEY, createdAt: 1700000000000 });
    expect(rec.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(validateRecord(rec)).toEqual({ ok: true });
    expect(Object.keys(rec).sort()).toEqual(['body', 'channelId', 'createdAt', 'nonce', 'replyTo', 'signer', 'type', 'v']);
  });

  it('uses a fresh nonce each time and keeps a given reply hash', () => {
    const a = buildMessageRecord({ channelId: 'town-hall', body: 'x', signer: KEY, replyTo: HASH(7) });
    const b = buildMessageRecord({ channelId: 'town-hall', body: 'x', signer: KEY, replyTo: HASH(7) });
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.replyTo).toBe(HASH(7));
  });

  it('throws with the reason for bad input', () => {
    expect(() => buildMessageRecord({ channelId: 'town-hall', body: '', signer: KEY })).toThrow(/body/);
    expect(() => buildMessageRecord({ channelId: 'X', body: 'hi', signer: KEY })).toThrow(/channelId/);
    expect(() => buildMessageRecord({ channelId: 'town-hall', body: 'hi', signer: 'nope' })).toThrow(/signer/);
    expect(() => buildMessageRecord({ channelId: 'town-hall', body: 'hi', signer: KEY, replyTo: 'zz' })).toThrow(/replyTo/);
    expect(() => buildMessageRecord()).toThrow();
  });

  it('builds channel records', () => {
    const doc = 'ab'.repeat(16);
    const rec = buildChannelRecord({ channelId: 'my-channel', title: 'My channel', docId: doc, signer: KEY, now: 5 });
    expect(rec).toEqual({ v: 2, type: 'channel.create', channelId: 'my-channel', title: 'My channel', docId: doc, signer: KEY, createdAt: 5 });
    expect(validateRecord(rec).ok).toBe(true);
    expect(buildChannelRecord({ channelId: 'my-channel', title: 'T', signer: KEY }).docId).toBe('');
    expect(() => buildChannelRecord({ channelId: 'ab', title: 'T', signer: KEY })).toThrow();
    expect(() => buildChannelRecord({ channelId: 'my-channel', title: '', signer: KEY })).toThrow();
  });
});

describe('channel form helpers', () => {
  it('makes ids from titles', () => {
    expect(slugifyTitle('My Town Hall!')).toBe('my-town-hall');
    expect(slugifyTitle('  Café meeting  ')).toBe('cafe-meeting');
    expect(slugifyTitle('ab')).toBe('');
    expect(slugifyTitle('!!!')).toBe('');
    expect(slugifyTitle(undefined)).toBe('');
    const long = slugifyTitle('word '.repeat(30));
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith('-')).toBe(false);
  });

  it('reads document ids and links', () => {
    const id = 'ab'.repeat(16);
    expect(parseDocIdInput('')).toBe('');
    expect(parseDocIdInput('   ')).toBe('');
    expect(parseDocIdInput(id)).toBe(id);
    expect(parseDocIdInput(id.toUpperCase())).toBe(id);
    expect(parseDocIdInput(`https://example.org/d/${id}#k=ABCD`)).toBe(id);
    expect(parseDocIdInput('/d/' + id)).toBe(id);
    expect(parseDocIdInput('not an id')).toBeNull();
    expect(parseDocIdInput('ab'.repeat(15))).toBeNull();
    expect(parseDocIdInput('ab'.repeat(17))).toBeNull();
    expect(parseDocIdInput(null)).toBeNull();
  });

  it('checks the create channel form per field', () => {
    const good = checkChannelInput({ title: ' Town hall ', channelId: 'town-hall', docId: '' });
    expect(good.ok).toBe(true);
    expect(good.values).toEqual({ title: 'Town hall', channelId: 'town-hall', docId: '' });

    const bad = checkChannelInput({ title: '', channelId: 'No', docId: 'xyz' });
    expect(bad.ok).toBe(false);
    expect(Object.keys(bad.errors).sort()).toEqual(['channelId', 'docId', 'title']);
    expect(bad.errors.title).toMatch(/title/i);

    expect(checkChannelInput({ title: 'x'.repeat(61), channelId: 'abc', docId: '' }).errors.title).toContain('61');
    expect(checkChannelInput({ title: 'ok', channelId: '-abc', docId: '' }).errors.channelId).toBeTruthy();
    expect(checkChannelInput({ title: 'ok', channelId: 'a'.repeat(41), docId: '' }).ok).toBe(false);
    expect(checkChannelInput({ title: 'ok', channelId: 'a'.repeat(40), docId: '' }).ok).toBe(true);
    expect(checkChannelInput().ok).toBe(false);
  });

  it('sorts channels by latest activity and drops bad rows', () => {
    const list = sortChannels([
      { channelId: 'old-one', title: 'a', createdAt: 100, lastMessageAt: null },
      { channelId: 'busy-one', title: 'b', createdAt: 50, lastMessageAt: 900 },
      { channelId: 'new-one', title: 'c', createdAt: 500, lastMessageAt: null },
      null,
      { channelId: 'BAD', title: 'x' }
    ]);
    expect(list.map((c) => c.channelId)).toEqual(['busy-one', 'new-one', 'old-one']);
    expect(sortChannels(undefined)).toEqual([]);
  });
});

describe('error wording', () => {
  it('explains rate limits in plain words', () => {
    const r = describeApiError({ status: 429, code: 'rate_limited', message: 'x' }, 'send');
    expect(r.message).toMatch(/too fast/);
    expect(r.message).toMatch(/20 per minute/);
  });

  it('points to the keys page when the signer is unknown', () => {
    expect(describeApiError({ status: 400, code: 'unknown_signer', message: 'x' }).hint).toBe('keys');
    expect(describeApiError({ status: 400, code: 'bad_signature', message: 'x' }).hint).toBe('keys');
  });

  it('covers network, expired, exists and server errors', () => {
    expect(describeApiError({ status: 0, code: 'network' }).message).toMatch(/reach the server/);
    expect(describeApiError({ status: 400, code: 'expired' }).message).toMatch(/clock/);
    expect(describeApiError({ status: 409, code: 'exists', message: 'channel exists' }).message).toBe('channel exists');
    expect(describeApiError({ status: 500, code: 'server_error' }).message).toMatch(/problem/);
  });

  it('uses the server text for validation errors and a fallback otherwise', () => {
    expect(describeApiError({ status: 400, code: 'bad_request', message: 'body is wrong' }).message).toBe('body is wrong');
    expect(describeApiError(null, 'send it').message).toBe('Could not send it.');
    expect(describeApiError(new Error('boom')).message).toBe('boom');
  });
});

describe('merging', () => {
  const e = (seq, hash = HASH(seq), extra = {}) => ({ seq, hash, ...extra });

  it('sorts by seq and removes duplicates', () => {
    const r = mergeEntries([e(3), e(1)], [e(2), e(3), e(4)]);
    expect(r.entries.map((x) => x.seq)).toEqual([1, 2, 3, 4]);
    expect(r.conflicts).toEqual([]);
    expect(r.dropped).toBe(0);
  });

  it('keeps the first copy when the same message arrives again', () => {
    const first = e(2, HASH(2), { verdict: 'first' });
    const r = mergeEntries([first], [e(2, HASH(2), { verdict: 'second' })]);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].verdict).toBe('first');
  });

  it('reports two different messages for one position and keeps the first', () => {
    const r = mergeEntries([e(2, HASH(2))], [e(2, HASH(9))]);
    expect(r.entries[0].hash).toBe(HASH(2));
    expect(r.conflicts).toEqual([2]);
  });

  it('drops entries without a valid seq and tolerates bad input', () => {
    const r = mergeEntries([], [null, { seq: 0 }, { seq: -1 }, { seq: 1.5 }, { seq: 'x' }, e(1)]);
    expect(r.entries.map((x) => x.seq)).toEqual([1]);
    expect(r.dropped).toBe(5);
    expect(mergeEntries(undefined, undefined).entries).toEqual([]);
  });

  it('does not change its inputs', () => {
    const a = [e(2), e(1)];
    const b = [e(3)];
    mergeEntries(a, b);
    expect(a.map((x) => x.seq)).toEqual([2, 1]);
    expect(b).toHaveLength(1);
  });

  it('indexes hashes and drops delivered pending messages', () => {
    const idx = hashIndex([e(1), e(2)]);
    expect(idx.get(HASH(2))).toBe(2);
    const pending = [{ hash: HASH(2) }, { hash: HASH(9) }];
    expect(dropDelivered(pending, [e(1), e(2)])).toEqual([{ hash: HASH(9) }]);
    expect(dropDelivered(undefined, [])).toEqual([]);
  });

  it('allows a resend only while the signed record is fresh', () => {
    const now = 1_000_000_000_000;
    expect(canResend({ record: { createdAt: now - 1000 } }, now)).toBe(true);
    expect(canResend({ record: { createdAt: now - 9 * 60 * 1000 } }, now)).toBe(false);
    expect(canResend({ record: { createdAt: now + 10 * 60 * 1000 } }, now)).toBe(false);
    expect(canResend(null, now)).toBe(false);
  });
});

describe('backoff delay', () => {
  it('is the normal interval with no failures', () => {
    expect(backoffDelay(0)).toBe(POLL_MS);
    expect(backoffDelay(undefined)).toBe(POLL_MS);
    expect(backoffDelay(-3)).toBe(POLL_MS);
  });

  it('doubles after each failure and is capped', () => {
    const mid = () => 0.5; // no jitter
    expect(backoffDelay(1, { random: mid })).toBe(6000);
    expect(backoffDelay(2, { random: mid })).toBe(12000);
    expect(backoffDelay(3, { random: mid })).toBe(24000);
    expect(backoffDelay(4, { random: mid })).toBe(48000);
    expect(backoffDelay(5, { random: mid })).toBe(POLL_MAX_MS);
    expect(backoffDelay(500, { random: mid })).toBe(POLL_MAX_MS);
  });

  it('keeps jitter inside the bounds', () => {
    for (let n = 1; n < 12; n++) {
      for (const r of [0, 0.25, 0.5, 0.99, 1]) {
        const d = backoffDelay(n, { random: () => r });
        expect(d).toBeGreaterThanOrEqual(POLL_MS);
        expect(d).toBeLessThanOrEqual(POLL_MAX_MS);
      }
    }
    // a broken random source cannot push it out of range
    expect(backoffDelay(2, { random: () => 99 })).toBeLessThanOrEqual(POLL_MAX_MS);
    expect(backoffDelay(2, { random: () => -5 })).toBeGreaterThanOrEqual(POLL_MS);
  });
});

describe('poller', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const mid = () => 0.5;

  it('runs at once, then every 3 seconds, and stops on request', async () => {
    const run = vi.fn(async () => ({}));
    const p = createPoller({ run, random: mid });
    await p.start();
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_MS - 1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(run).toHaveBeenCalledTimes(5);
    p.stop();
    await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    expect(run).toHaveBeenCalledTimes(5);
    expect(p.isStopped()).toBe(true);
  });

  it('never runs two at the same time', async () => {
    let active = 0;
    let maxActive = 0;
    let release;
    const run = vi.fn(
      () =>
        new Promise((resolve) => {
          active++;
          maxActive = Math.max(maxActive, active);
          release = () => {
            active--;
            resolve({});
          };
        })
    );
    const p = createPoller({ run, random: mid });
    const first = p.start();
    p.kick();
    p.kick();
    await vi.advanceTimersByTimeAsync(POLL_MS * 4);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(maxActive).toBe(1);
    p.stop();
  });

  it('waits longer after failures and goes back to normal after a success', async () => {
    const statuses = [];
    let fail = true;
    const run = vi.fn(async () => {
      if (fail) throw new Error('down');
      return {};
    });
    const p = createPoller({ run, random: mid, onStatus: (s, d) => statuses.push([s, d]) });
    await p.start();
    expect(statuses.at(-1)).toEqual(['retrying', 6000]);
    await vi.advanceTimersByTimeAsync(6000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(statuses.at(-1)).toEqual(['retrying', 12000]);
    await vi.advanceTimersByTimeAsync(11999);
    expect(run).toHaveBeenCalledTimes(2);
    fail = false;
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(3);
    expect(statuses.at(-1)).toEqual(['waiting', POLL_MS]);
    expect(p.failures()).toBe(0);
    p.stop();
  });

  it('pauses while the tab is hidden and continues on resume', async () => {
    let hidden = false;
    const run = vi.fn(async () => ({}));
    const statuses = [];
    const p = createPoller({ run, isHidden: () => hidden, random: mid, onStatus: (s) => statuses.push(s) });
    await p.start();
    expect(run).toHaveBeenCalledTimes(1);
    hidden = true;
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(run).toHaveBeenCalledTimes(1);
    expect(statuses).toContain('paused');
    await vi.advanceTimersByTimeAsync(POLL_MS * 10);
    expect(run).toHaveBeenCalledTimes(1);
    hidden = false;
    await p.resume();
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(run).toHaveBeenCalledTimes(3);
    p.stop();
  });

  it('resume does nothing when polling was not paused or was stopped', async () => {
    const run = vi.fn(async () => ({}));
    const p = createPoller({ run, random: mid });
    await p.resume();
    expect(run).not.toHaveBeenCalled();
    await p.start();
    await p.resume();
    expect(run).toHaveBeenCalledTimes(1);
    p.stop();
    await p.kick();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('stops by itself when run asks for it', async () => {
    const run = vi.fn(async () => ({ stop: true }));
    const p = createPoller({ run, random: mid });
    await p.start();
    await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    expect(run).toHaveBeenCalledTimes(1);
    expect(p.isStopped()).toBe(true);
  });

  it('a run that ends after stop() does not schedule another', async () => {
    let release;
    const run = vi.fn(() => new Promise((resolve) => (release = () => resolve({}))));
    const p = createPoller({ run, random: mid });
    const first = p.start();
    p.stop();
    release();
    await first;
    await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('survives a throwing status listener', async () => {
    const run = vi.fn(async () => ({}));
    const p = createPoller({
      run,
      random: mid,
      onStatus: () => {
        throw new Error('listener');
      }
    });
    await p.start();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(run).toHaveBeenCalledTimes(2);
    p.stop();
  });

  it('kick runs now even while the tab is hidden', async () => {
    const run = vi.fn(async () => ({}));
    const p = createPoller({ run, isHidden: () => true, random: mid });
    await p.start();
    expect(run).toHaveBeenCalledTimes(1);
    await p.kick();
    expect(run).toHaveBeenCalledTimes(2);
    p.stop();
  });
});

describe('head status wording', () => {
  it('says the latest messages are tied to the head', () => {
    const d = describeAnchor({ anchored: true, hasCheckpoint: true, checkpointSeq: 9, headSeq: 9, pinned: true, warnings: [] });
    expect(d.tone).toBe('good');
    expect(d.title).toBe('Latest messages tied to the server head');
    expect(d.lines.join(' ')).toMatch(/pinned/);
  });

  it('says when the key is not pinned', () => {
    const d = describeAnchor({ anchored: true, hasCheckpoint: true, checkpointSeq: 9, headSeq: 9, pinned: false, warnings: [] });
    expect(d.lines.join(' ')).toMatch(/not pinned/);
  });

  it('says it is an older page when the head is ahead', () => {
    const d = describeAnchor({ anchored: false, hasCheckpoint: true, checkpointSeq: 12, headSeq: 6, pinned: false, warnings: ['extra'] });
    expect(d.tone).toBe('warn');
    expect(d.title).toBe('Not tied to the server head, older page');
    expect(d.lines).toContain('extra');
  });

  it('says when the server sent no checkpoint', () => {
    const d = describeAnchor({ anchored: false, hasCheckpoint: false, checkpointSeq: null, headSeq: 3, pinned: false, warnings: [] });
    expect(d.tone).toBe('warn');
    expect(d.title).toBe('Not tied to the server head');
    expect(d.lines[0]).toMatch(/did not send a signed checkpoint/);
  });

  it('handles no result yet', () => {
    expect(describeAnchor(null).tone).toBe('info');
    expect(describeAnchor(null, { checking: true }).title).toMatch(/Checking/);
  });

  it('never claims tied for an anchor that is not anchored', () => {
    for (const hasCheckpoint of [true, false]) {
      const d = describeAnchor({ anchored: false, hasCheckpoint, checkpointSeq: hasCheckpoint ? 5 : null, headSeq: 5, pinned: true, warnings: [] });
      expect(d.tone).not.toBe('good');
      expect(d.title).not.toBe('Latest messages tied to the server head');
    }
  });
});

describe('constants', () => {
  it('uses the zero hash for the genesis link', () => {
    expect(ZERO_HASH).toBe('0'.repeat(64));
    expect(POLL_MS).toBe(3000);
  });
});
