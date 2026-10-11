// Pure chat logic: the timeline, the status line, server key handling, list helpers.
import { describe, expect, it, vi } from 'vitest';
import {
  GROUP_GAP_MS,
  buildTimeline,
  checkServerTrust,
  composerStatus,
  counterState,
  firstUnreadSeq,
  isTrustMismatch,
  pendingLabel,
  pinGetter,
  quoteLine,
  roomStatus
} from '../../src/components/chat/roomLogic.js';
import { channelPreview, checkNewChatInput, filterChannels, newChannelId } from '../../src/lib/chatClient.js';
import { isChannelId } from '../../shared/records.js';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const HOUR = 60 * 60 * 1000;
// A fixed local noon, so day boundaries do not depend on when the test runs.
const NOON = new Date(2026, 9, 9, 12, 0, 0).getTime();

const msg = (seq, signer, createdAt, status = 'verified') => ({
  seq,
  hash: String(seq).padStart(64, '0'),
  record: { signer, createdAt, body: 'm' + seq },
  verdict: { status, detail: '' }
});

describe('buildTimeline', () => {
  it('puts a date separator before the first message and again when the day changes', () => {
    const rows = buildTimeline([msg(1, KEY_A, NOON), msg(2, KEY_B, NOON + HOUR), msg(3, KEY_A, NOON + 24 * HOUR)], { now: NOON + 24 * HOUR });
    expect(rows.map((r) => r.kind)).toEqual(['day', 'msg', 'msg', 'day', 'msg']);
    expect(rows[0].label).toBe('Yesterday');
    expect(rows[3].label).toBe('Today');
  });

  it('groups verified messages of one sender that are close in time on one day', () => {
    const rows = buildTimeline([msg(1, KEY_A, NOON), msg(2, KEY_A, NOON + 60 * 1000), msg(3, KEY_A, NOON + 60 * 1000 + GROUP_GAP_MS)], { now: NOON });
    const m = rows.filter((r) => r.kind === 'msg');
    expect(m.map((r) => r.grouped)).toEqual([false, true, false]);
    expect(m.map((r) => r.endOfGroup)).toEqual([false, true, true]);
  });

  it('never groups across senders, and never groups a message that failed its check', () => {
    const rows = buildTimeline([msg(1, KEY_A, NOON), msg(2, KEY_B, NOON + 1000), msg(3, KEY_B, NOON + 2000, 'invalid'), msg(4, KEY_B, NOON + 3000)], { now: NOON });
    expect(rows.filter((r) => r.kind === 'msg').map((r) => r.grouped)).toEqual([false, false, false, false]);
  });

  it('keeps the order of the server numbers even when a written time goes backwards', () => {
    const rows = buildTimeline([msg(1, KEY_A, NOON), msg(2, KEY_A, NOON - 5000)], { now: NOON });
    expect(rows.filter((r) => r.kind === 'msg').map((r) => r.entry.seq)).toEqual([1, 2]);
    expect(rows.filter((r) => r.kind === 'msg')[1].grouped).toBe(false);
  });

  it('puts the unread marker before the first unread message and ends a group there', () => {
    const rows = buildTimeline([msg(1, KEY_A, NOON), msg(2, KEY_A, NOON + 1000), msg(3, KEY_A, NOON + 2000)], { now: NOON, firstUnread: 2 });
    expect(rows.map((r) => r.kind)).toEqual(['day', 'msg', 'unread', 'msg', 'msg']);
    const m = rows.filter((r) => r.kind === 'msg');
    expect(m[1].grouped).toBe(false);
    expect(m[2].grouped).toBe(true);
  });

  it('copes with odd input and bad times', () => {
    expect(buildTimeline(null)).toEqual([]);
    expect(buildTimeline([null, { seq: 'x' }, 5])).toEqual([]);
    const rows = buildTimeline([{ seq: 1, record: null, verdict: { status: 'invalid' } }, { seq: 2, record: { signer: KEY_A, createdAt: 'soon' } }]);
    expect(rows.every((r) => r.kind === 'msg')).toBe(true);
  });
});

describe('firstUnreadSeq', () => {
  const list = [msg(1, KEY_A, 1), msg(2, KEY_B, 2), msg(3, KEY_A, 3), msg(4, KEY_B, 4)];
  it('finds the first message after the last seen one', () => {
    expect(firstUnreadSeq(list, 1)).toBe(2);
    expect(firstUnreadSeq(list, 3)).toBe(4);
    expect(firstUnreadSeq(list, 4)).toBe(0);
  });
  it('skips messages written by the reader and gives 0 when never opened', () => {
    expect(firstUnreadSeq(list, 1, KEY_B)).toBe(3);
    expect(firstUnreadSeq(list, 0)).toBe(0);
    expect(firstUnreadSeq(null, 2)).toBe(0);
  });
});

describe('roomStatus', () => {
  const ok = [msg(1, KEY_A, 1), msg(2, KEY_B, 2)];
  it('says all messages were checked and tied to the server record', () => {
    const s = roomStatus({ entries: ok, problems: [], anchor: { anchored: true, pinned: true } });
    expect(s.tone).toBe('good');
    expect(s.text).toMatch(/^All messages were checked here./);
    expect(s.text).toMatch(/matches the server's record/);
  });
  it('is not green when the view is not tied to the server record', () => {
    const s = roomStatus({ entries: ok, problems: [], anchor: { anchored: false } });
    expect(s.tone).toBe('info');
    expect(s.text).toMatch(/not tied/);
    expect(roomStatus({ entries: ok, problems: [], anchor: null }).tone).toBe('info');
  });
  it('is red when a message failed, a problem was found or the server key changed', () => {
    expect(roomStatus({ entries: [...ok, msg(3, KEY_A, 3, 'invalid')], problems: [], anchor: { anchored: true } }).tone).toBe('bad');
    expect(roomStatus({ entries: ok, problems: ['x'], anchor: null }).tone).toBe('bad');
    const s = roomStatus({ entries: ok, problems: [], anchor: { pinMismatch: true } });
    expect(s.tone).toBe('bad');
    expect(s.text).toMatch(/identity changed/);
    expect(roomStatus({ entries: ok, problems: [], anchor: { badSignature: true } }).tone).toBe('bad');
  });
  it('counts only verified messages and says so', () => {
    const s = roomStatus({ entries: [...ok, msg(3, KEY_A, 3, 'unverified')], problems: [], anchor: null });
    expect(s.text).toMatch(/^2 of 3 messages were checked here/);
  });
  it('reports a connection problem first, and handles an empty chat', () => {
    const s = roomStatus({ entries: ok, problems: [], anchor: { anchored: true } }, { status: 'retrying', delay: 6000 });
    expect(s.tone).toBe('warn');
    expect(s.text).toMatch(/Trying again in 6 seconds/);
    expect(roomStatus({ entries: [], problems: [], anchor: null }).text).toMatch(/signed and checked/);
    expect(roomStatus(null).tone).toBe('info');
  });
});

describe('composerStatus', () => {
  it('maps the session to what the writing box shows', () => {
    expect(composerStatus(null)).toBe('loading');
    expect(composerStatus({ status: 'loading' })).toBe('loading');
    expect(composerStatus({ status: 'signedOut' })).toBe('none');
    expect(composerStatus({ status: 'needsKey', identity: null })).toBe('needsKey');
    expect(composerStatus({ status: 'ready', identity: { keyId: KEY_A } })).toBe('ready');
    // ready without a usable key cannot write
    expect(composerStatus({ status: 'ready', identity: null })).toBe('none');
  });
});

describe('server key handling', () => {
  it('uses the pinned key first, then the remembered one, else none', () => {
    expect(pinGetter({ getPinnedServerKeyId: () => KEY_A, getRememberedServerKeyId: () => KEY_B })()).toBe(KEY_A);
    expect(pinGetter({ getPinnedServerKeyId: () => '', getRememberedServerKeyId: () => KEY_B })()).toBe(KEY_B);
    expect(pinGetter({ getPinnedServerKeyId: () => '' })()).toBe('');
    expect(pinGetter({})()).toBe('');
    expect(pinGetter(null)()).toBe('');
  });
  it('ignores a remembered value that is not a key id and survives errors', () => {
    expect(pinGetter({ getPinnedServerKeyId: () => '', getRememberedServerKeyId: () => 'nope' })()).toBe('');
    expect(
      pinGetter({
        getPinnedServerKeyId: () => {
          throw new Error('storage blocked');
        }
      })()
    ).toBe('');
  });
  it('asks serverKeyTrust only for a real key id and only when it exists', () => {
    const seen = [];
    const lib = { serverKeyTrust: (id) => (seen.push(id), 'first-visit'), rememberServerKey: vi.fn() };
    expect(checkServerTrust(lib, KEY_A)).toBe('first-visit');
    expect(checkServerTrust(lib, 'short')).toBe('');
    expect(checkServerTrust(lib, 12)).toBe('');
    expect(seen).toEqual([KEY_A]);
    // the first visit remembers the key
    expect(lib.rememberServerKey).toHaveBeenCalledTimes(1);
    expect(lib.rememberServerKey).toHaveBeenCalledWith(KEY_A);
    expect(checkServerTrust({}, KEY_A)).toBe('');
    expect(
      checkServerTrust(
        {
          serverKeyTrust() {
            throw new Error('x');
          }
        },
        KEY_A
      )
    ).toBe('');
  });
  it('remembers nothing when the key is known, pinned or changed', () => {
    for (const word of ['pinned-match', 'pinned-mismatch', 'remembered-match', 'remembered-mismatch']) {
      const lib = { serverKeyTrust: () => word, rememberServerKey: vi.fn() };
      expect(checkServerTrust(lib, KEY_A)).toBe(word);
      expect(lib.rememberServerKey).not.toHaveBeenCalled();
    }
  });
  it('knows which answers are a changed key', () => {
    expect(isTrustMismatch('pinned-mismatch')).toBe(true);
    expect(isTrustMismatch('remembered-mismatch')).toBe(true);
    for (const t of ['pinned-match', 'remembered-match', 'first-visit', '', undefined]) expect(isTrustMismatch(t)).toBe(false);
  });
});

describe('small text helpers', () => {
  it('quoteLine flattens white space and cuts', () => {
    expect(quoteLine('a \n\n b')).toBe('a b');
    expect(quoteLine('x'.repeat(200), 10)).toBe('x'.repeat(10) + '...');
    expect(quoteLine(null)).toBe('');
  });
  it('counterState shows the counter only near the limit', () => {
    expect(counterState(10, 2000).show).toBe(false);
    expect(counterState(1799, 2000).show).toBe(false);
    expect(counterState(1800, 2000)).toMatchObject({ show: true, tone: 'near', text: '1800 / 2000' });
    expect(counterState(2000, 2000).tone).toBe('near');
    expect(counterState(2005, 2000)).toMatchObject({ show: true, tone: 'over' });
    expect(counterState(2005, 2000).text).toMatch(/5 over the limit/);
    expect(counterState(NaN, 2000).show).toBe(false);
  });
  it('pendingLabel names the three states', () => {
    expect(pendingLabel({ status: 'failed' })).toEqual({ tone: 'bad', label: 'Not sent' });
    expect(pendingLabel({ status: 'sent' }).label).toBe('Sent');
    expect(pendingLabel({ status: 'sending' }).label).toBe('Sending');
    expect(pendingLabel(null).label).toBe('Sending');
  });
});

describe('chat list helpers', () => {
  const rows = [
    { channelId: 'town-hall', title: 'Town hall', lastText: 'Lunch at noon?', lastSignerName: 'Priya' },
    { channelId: 'cafe-9f2a', title: 'Café club', lastText: '', lastSignerName: '' },
    { channelId: 'files-1c3d', title: 'Budget file', lastText: 'Signed', lastSignerName: 'Omar' }
  ];

  it('builds the preview as "Name: text" in one line, cut at 80 characters', () => {
    expect(channelPreview(rows[0])).toBe('Priya: Lunch at noon?');
    expect(channelPreview({ lastText: 'a\n\nb', lastSignerName: '' })).toBe('a b');
    expect(channelPreview({ lastText: 'x'.repeat(200), lastSignerName: 'N' })).toBe('N: ' + 'x'.repeat(80) + '...');
    expect(channelPreview(rows[1])).toBe('');
    expect(channelPreview({ lastText: 5, lastSignerName: {} })).toBe('');
    expect(channelPreview(null)).toBe('');
  });

  it('searches title, id and preview, ignoring case and accents, every word must match', () => {
    expect(filterChannels(rows, '').length).toBe(3);
    expect(filterChannels(rows, 'TOWN').map((r) => r.channelId)).toEqual(['town-hall']);
    expect(filterChannels(rows, 'cafe').map((r) => r.channelId)).toEqual(['cafe-9f2a']);
    expect(filterChannels(rows, 'priya lunch').map((r) => r.channelId)).toEqual(['town-hall']);
    expect(filterChannels(rows, 'priya omar')).toEqual([]);
    expect(filterChannels(rows, '1c3d').length).toBe(1);
    expect(filterChannels(null, 'x')).toEqual([]);
    expect(filterChannels([null, 5, rows[0]], 'town').length).toBe(1);
  });

  it('checks the new chat form: a name is needed, a file link or id is optional', () => {
    const ok = checkNewChatInput({ title: '  Team lunch ', docId: '' });
    expect(ok.ok).toBe(true);
    expect(ok.values).toEqual({ title: 'Team lunch', docId: '' });
    const withDoc = checkNewChatInput({ title: 'About the budget', docId: 'https://x.example/d/' + 'ab'.repeat(16) + '#k=zz' });
    expect(withDoc.ok).toBe(true);
    expect(withDoc.values.docId).toBe('ab'.repeat(16));
    expect(checkNewChatInput({ title: '', docId: '' }).errors.title).toMatch(/cannot be empty/);
    expect(checkNewChatInput({ title: 'x'.repeat(61), docId: '' }).errors.title).toMatch(/61 characters/);
    expect(checkNewChatInput({ title: 'ok', docId: 'not a file' }).errors.docId).toMatch(/file/);
    expect(checkNewChatInput({ title: 'ok', docId: 'not a file' }).errors).not.toHaveProperty('channelId');
    expect(checkNewChatInput().ok).toBe(false);
  });

  it('makes chat ids that are always valid and different for the same title', () => {
    expect(newChannelId('Team lunch', () => '4f2a')).toBe('team-lunch-4f2a');
    for (const title of ['Team lunch', '', 'a', '!!!', '午餐', 'x'.repeat(200), 'Café * club', null, 5]) {
      const id = newChannelId(title);
      expect(isChannelId(id), String(title)).toBe(true);
    }
    expect(newChannelId('Team lunch')).not.toBe(newChannelId('Team lunch'));
    expect(newChannelId('x'.repeat(200)).length).toBeLessThanOrEqual(40);
    expect(newChannelId('!!!', () => 'abcd')).toBe('chat-abcd');
  });
});
