// Pure logic of the Files screen, the Add file flow, sharing and the file page.
import { afterEach, describe, expect, it } from 'vitest';
import { verifyDocumentBundle } from '../../shared/verify.js';
import { runAddFile } from '../../src/components/files/addFlow.js';
import { PROGRESS_LINES, addProblem, canPublish, failureText, labelFor, progressLine, storedNote } from '../../src/components/files/addLogic.js';
import {
  TABS,
  accountRow,
  emptyCopy,
  listSummary,
  publicRow,
  publicSubtitle,
  rowIcon,
  rowSubtitle,
  rowTitle,
  statusChip,
  tabFromSearch,
  usableRows
} from '../../src/components/files/filesLogic.js';
import { canNativeShare, shareLink, shareToast } from '../../src/components/files/shareLogic.js';
import { createSteps, advanceSteps, failSteps } from '../../src/components/vault/vaultLogic.js';
import {
  fileState,
  fileTitle,
  initialPassword,
  openLabel,
  openPlan,
  ownerNote,
  passwordFromInput,
  promptProblem,
  rollbackNote,
  sharePassword,
  sharePlan,
  updateProblem,
  validHead,
  versionRows,
  versionStamp,
  withdrawProblem
} from '../../src/components/doc/pageLogic.js';
import { ownerAccess } from '../../src/components/doc/docLogic.js';
import { buildBundleParts, createIdentity, createServerKey } from '../helpers/bundle.js';

const ID = 'c'.repeat(32);
const PW = 'ABCD-EFGH-JKLM-NPQR-STUV';
const NOW = new Date(2026, 9, 11, 12, 0, 0).getTime();
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const noText = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  expect(text).not.toMatch(new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']'));
  expect(text).not.toMatch(/\b(AI|Claude|Anthropic|GPT|OpenAI)\b/);
};

describe('tabs', () => {
  it('has Mine, Public and Private, and Mine is the default', () => {
    expect(TABS.map((t) => t.label)).toEqual(['Mine', 'Public', 'Private']);
    expect(tabFromSearch('public')).toBe('public');
    expect(tabFromSearch('private')).toBe('private');
    expect(tabFromSearch('mine')).toBe('mine');
    expect(tabFromSearch(null)).toBe('mine');
    expect(tabFromSearch('<script>')).toBe('mine');
    expect(tabFromSearch(undefined)).toBe('mine');
  });
});

describe('row text', () => {
  it('names a row by its label and falls back for an empty or odd label', () => {
    expect(rowTitle({ label: '  Land record.pdf ' })).toBe('Land record.pdf');
    expect(rowTitle({ label: '' })).toBe('Untitled file');
    expect(rowTitle({ label: 42 })).toBe('Untitled file');
    expect(rowTitle(null)).toBe('Untitled file');
  });

  it('picks the icon from the extension at the end of the label', () => {
    expect(rowIcon({ label: 'deed.pdf' })).toBe('file');
    expect(rowIcon({ label: 'photo.JPG' })).toBe('image');
    expect(rowIcon({ label: 'budget.xlsx' })).toBe('table');
    expect(rowIcon({ label: 'backup.zip' })).toBe('archive');
    expect(rowIcon({ label: 'talk.mp3' })).toBe('music');
    expect(rowIcon({ label: 'clip.mp4' })).toBe('video');
    expect(rowIcon({ label: 'notes.txt' })).toBe('text');
    expect(rowIcon({ label: 'Land record' })).toBe('file');
    expect(rowIcon({})).toBe('file');
  });

  it('writes "Version N, edited <relative time>"', () => {
    expect(rowSubtitle({ status: 'active', version: 3, updatedAt: NOW - HOUR }, NOW)).toBe('Version 3, edited today');
    expect(rowSubtitle({ status: 'active', version: 1, updatedAt: NOW - DAY }, NOW)).toBe('Version 1, edited yesterday');
    expect(rowSubtitle({ status: 'active', version: 2, updatedAt: NOW - 3 * DAY }, NOW)).toBe('Version 2, edited 3 days ago');
    expect(rowSubtitle({ status: 'active', version: 2, updatedAt: NOW - 30 * DAY }, NOW)).toMatch(/^Version 2, edited on \d+ \w+/);
  });

  it('does not invent a version or a time', () => {
    expect(rowSubtitle({ status: 'active', version: null, updatedAt: NOW }, NOW)).toBe('Version not known');
    expect(rowSubtitle({ status: 'active', version: 4, updatedAt: null }, NOW)).toBe('Version 4');
    expect(rowSubtitle({ status: 'checking' }, NOW)).toBe('Checking');
    expect(rowSubtitle({ status: 'missing' }, NOW)).toBe('Not found on this server');
    expect(rowSubtitle({ status: 'unknown' }, NOW)).toBe('Could not check right now');
    expect(rowSubtitle({ status: 'active', version: 2, updatedAt: NOW, approxTime: true }, NOW)).toBe('Version 2, published today');
    expect(rowSubtitle(null)).toBe('');
  });

  it('puts the publisher first on the public list', () => {
    const row = { status: 'active', version: 2, updatedAt: NOW - HOUR, ownerName: 'Priya' };
    expect(publicSubtitle(row, NOW)).toBe('Priya, Version 2, edited today');
    expect(publicSubtitle({ ...row, ownerName: '' }, NOW)).toBe('Version 2, edited today');
  });

  it('writes no em dashes and no vendor words', () => {
    noText([rowSubtitle({ status: 'missing' }), emptyCopy('mine'), emptyCopy('public'), emptyCopy('public', { searching: true }), listSummary(0)]);
  });
});

describe('status chip', () => {
  it('shows Withdrawn for a withdrawn file', () => {
    expect(statusChip({ status: 'revoked' })).toMatchObject({ text: 'Withdrawn', tone: 'warn' });
  });

  it('is never green for a row this browser did not check', () => {
    const chip = statusChip({ status: 'active', version: 3 }, null);
    expect(chip.tone).not.toBe('good');
    expect(chip.text).toBe('Not checked yet');
    expect(chip.hint).toMatch(/Open the file to check/);
  });

  it('is Verified only when this browser checked this exact version', () => {
    expect(statusChip({ status: 'active', version: 3 }, { version: 3 })).toMatchObject({ tone: 'good', text: 'Verified', icon: 'shield-check' });
    expect(statusChip({ status: 'active', version: 4 }, { version: 3 }).tone).not.toBe('good');
    expect(statusChip({ status: 'active', version: null }, { version: 3 }).tone).not.toBe('good');
  });

  it('a withdrawn row is not Verified even when it was seen', () => {
    expect(statusChip({ status: 'revoked', version: 3 }, { version: 3 }).text).toBe('Withdrawn');
  });

  it('names the other states', () => {
    expect(statusChip({ status: 'missing' }).text).toBe('Not found');
    expect(statusChip({ status: 'unknown' }).text).toBe('Unknown');
    expect(statusChip({ status: 'checking' }).text).toBe('Checking');
  });
});

describe('server rows', () => {
  const server = {
    docId: ID,
    label: 'Land record.pdf',
    status: 'active',
    headVersion: 2,
    updatedAt: 1760000000000,
    ownerKeyId: 'ab'.repeat(32),
    ownerName: 'Priya',
    listed: true
  };

  it('turns a public list entry into a row', () => {
    expect(publicRow(server)).toMatchObject({ docId: ID, label: 'Land record.pdf', status: 'active', version: 2, ownerName: 'Priya', local: false });
  });

  it('keeps whether an account file is listed', () => {
    expect(accountRow({ ...server, listed: false }).listed).toBe(false);
    expect(accountRow({ ...server, listed: true }).listed).toBe(true);
    expect(accountRow({ ...server, listed: undefined }).listed).toBe(false);
  });

  it('turns odd server fields into safe text', () => {
    const row = publicRow({ docId: ID, label: { x: 1 }, status: 'weird', headVersion: 'x', updatedAt: 'y', ownerName: 7 });
    expect(row.label).toBe('');
    expect(row.status).toBe('active');
    expect(row.version).toBeNull();
    expect(row.updatedAt).toBeNull();
    expect(row.ownerName).toBe('');
    expect(publicRow(null).docId).toBe('');
  });

  it('drops rows without a usable id', () => {
    const rows = usableRows([publicRow(server), publicRow({ ...server, docId: '../../x' }), null, publicRow({ ...server, docId: '' })]);
    expect(rows.map((r) => r.docId)).toEqual([ID]);
    expect(usableRows('nope')).toEqual([]);
  });

  it('counts for screen readers', () => {
    expect(listSummary(0)).toBe('No files');
    expect(listSummary(0, { searching: true })).toBe('No files found');
    expect(listSummary(1)).toBe('1 file shown');
    expect(listSummary(5)).toBe('5 files shown');
  });
});

describe('progress while a file is published', () => {
  it('shows one short line at a time, following the steps', () => {
    let steps = createSteps();
    expect(progressLine(steps)).toBe('Starting');
    steps = advanceSteps(steps, 'read');
    expect(progressLine(steps)).toBe('Reading your file');
    steps = advanceSteps(steps, 'derive');
    expect(progressLine(steps)).toBe('Locking your file');
    steps = advanceSteps(steps, 'lock');
    // nothing is active between two steps: the line names the one that comes next
    expect(progressLine(steps)).toBe('Uploading');
    steps = advanceSteps(steps, 'upload');
    expect(progressLine(steps)).toBe('Uploading');
    steps = advanceSteps(steps, 'sign');
    expect(progressLine(steps)).toBe('Signing');
    steps = advanceSteps(steps, 'publish');
    expect(progressLine(steps)).toBe('Publishing');
    steps = advanceSteps(steps, 'done');
    expect(progressLine(steps)).toBe('Published');
  });

  it('has no line for a failed or missing list', () => {
    expect(progressLine(failSteps(advanceSteps(createSteps(), 'derive')))).toBe('');
    expect(progressLine([])).toBe('');
    expect(progressLine(null)).toBe('');
  });

  it('every line is short and plain', () => {
    for (const line of Object.values(PROGRESS_LINES)) {
      expect(line.length).toBeLessThan(30);
      noText(line);
    }
  });
});

describe('the label and the Publish button', () => {
  it('starts as the file name and follows what the person typed', () => {
    expect(labelFor({ labelText: '', touched: false, fileName: 'deed.pdf' })).toBe('deed.pdf');
    expect(labelFor({ labelText: 'Land record', touched: true, fileName: 'deed.pdf' })).toBe('Land record');
    expect(labelFor({ labelText: '  ', touched: true, fileName: 'deed.pdf' })).toBe('');
    expect(labelFor({ labelText: '', touched: false, fileName: '' })).toBe('');
  });

  it('is off without a file, while running, or with a bad file or label', () => {
    const file = { name: 'a.txt', size: 10 };
    expect(canPublish({ file: null, label: '', running: false })).toBe(false);
    expect(canPublish({ file, label: 'a.txt', running: true })).toBe(false);
    expect(canPublish({ file, label: 'a.txt', running: false })).toBe(true);
    expect(canPublish({ file: { name: 'a.txt', size: 0 }, label: 'a.txt', running: false })).toBe(false);
    expect(canPublish({ file: { name: 'a.txt', size: 21 * 1024 * 1024 }, label: 'a.txt', running: false })).toBe(false);
    expect(canPublish({ file, label: 'bad\u0000label', running: false })).toBe(false);
  });

  it('explains what is wrong with the file or the label', () => {
    expect(addProblem({ file: null, label: '' })).toBe('');
    expect(addProblem({ file: { name: 'a', size: 0 }, label: 'a' })).toMatch(/empty/);
    expect(addProblem({ file: { name: 'a', size: 5 }, label: 'bad\u0000' })).toMatch(/label/);
    expect(addProblem({ file: { name: 'a', size: 5 }, label: 'fine' })).toBe('');
  });

  it('allows an empty label', () => {
    expect(canPublish({ file: { name: 'a.txt', size: 3 }, label: '', running: false })).toBe(true);
  });
});

describe('where the password went', () => {
  it('is honest about each place and never contains a password', () => {
    expect(storedNote('account')).toMatchObject({ tone: 'good' });
    expect(storedNote('account').text).toMatch(/account/);
    expect(storedNote('device')).toMatchObject({ tone: 'info' });
    expect(storedNote('device').text).toMatch(/this device only/);
    const none = storedNote('none');
    expect(none.tone).toBe('warn');
    expect(none.text).toMatch(/only copy/);
    expect(storedNote('anything else').tone).toBe('warn');
    for (const s of ['account', 'device', 'none']) noText(storedNote(s).text);
  });

  it('joins a failure message and its hint once', () => {
    expect(failureText({ message: 'Could not reach the server.', hint: 'Publish again.' })).toBe('Could not reach the server. Publish again.');
    expect(failureText({ message: 'Same', hint: 'Same' })).toBe('Same');
    expect(failureText(null)).toBe('');
  });
});

describe('runAddFile', () => {
  const identity = { keyId: 'ab'.repeat(32), sign: async () => 'sig' };
  const file = { name: 'deed.pdf', size: 10 };
  const published = () => ({
    docId: ID,
    password: PW,
    version: 1,
    fingerprint: 'f'.repeat(64),
    links: { verify: `https://x.test/d/${ID}`, full: `https://x.test/d/${ID}#k=ABCDEFGHJKLMNPQRSTUV` }
  });

  it('publishes, keeps the password, copies the link and reports short lines', async () => {
    const lines = [];
    const saved = [];
    const copied = [];
    const out = await runAddFile({
      file,
      label: 'Deed',
      listed: false,
      identity,
      publish: async (args) => {
        expect(args.label).toBe('Deed');
        expect(args.listed).toBe(false);
        for (const id of ['read', 'derive', 'lock', 'upload', 'sign', 'publish']) args.onStep(id, 'x');
        return published();
      },
      save: async (docId, password) => {
        saved.push([docId, password]);
        return 'account';
      },
      copy: async (text) => {
        copied.push(text);
        return true;
      },
      onLine: (t) => lines.push(t)
    });
    expect(out.ok).toBe(true);
    expect(out.stored).toBe('account');
    expect(out.copied).toBe(true);
    expect(out.link).toBe(`https://x.test/d/${ID}#k=ABCDEFGHJKLMNPQRSTUV`);
    expect(saved).toEqual([[ID, PW]]);
    expect(copied).toEqual([out.link]);
    expect(lines[0]).toBe('Starting');
    expect(lines).toContain('Locking your file');
    expect(lines).toContain('Publishing');
    expect(lines[lines.length - 1]).toBe('Saving your password');
    // no line ever shows the password
    for (const line of lines) expect(line).not.toContain(PW);
  });

  it('says none when the password could not be stored, and still returns the link', async () => {
    const out = await runAddFile({
      file,
      label: '',
      listed: true,
      identity,
      publish: async () => published(),
      save: async () => {
        throw new Error('storage blocked');
      },
      copy: async () => false
    });
    expect(out.ok).toBe(true);
    expect(out.stored).toBe('none');
    expect(out.copied).toBe(false);
    expect(out.link).toContain('#k=');
  });

  it('a throwing clipboard does not fail the publish', async () => {
    const out = await runAddFile({
      file,
      label: '',
      listed: false,
      identity,
      publish: async () => published(),
      save: async () => 'device',
      copy: async () => {
        throw new Error('no clipboard');
      }
    });
    expect(out.ok).toBe(true);
    expect(out.copied).toBe(false);
    expect(out.stored).toBe('device');
  });

  it('does not save or copy anything when publishing fails, and explains what happened', async () => {
    let saved = 0;
    let copied = 0;
    const out = await runAddFile({
      file,
      label: '',
      listed: false,
      identity,
      publish: async (args) => {
        args.onStep('read', 'x');
        args.onStep('derive', 'x');
        throw Object.assign(new Error('boom'), { code: 'network' });
      },
      save: async () => {
        saved += 1;
        return 'device';
      },
      copy: async () => {
        copied += 1;
        return true;
      }
    });
    expect(out.ok).toBe(false);
    expect(saved).toBe(0);
    expect(copied).toBe(0);
    expect(out.message).toMatch(/Could not reach the server/);
    expect(out.hint).toMatch(/not sent anywhere/);
    expect(failureText(out)).toContain(out.message);
  });

  it('survives a broken progress callback', async () => {
    const out = await runAddFile({
      file,
      label: '',
      listed: false,
      identity,
      publish: async () => published(),
      save: async () => 'device',
      copy: async () => true,
      onLine: () => {
        throw new Error('screen gone');
      }
    });
    expect(out.ok).toBe(true);
  });
});

describe('sharing', () => {
  const link = `https://x.test/d/${ID}#k=ABCDEFGHJKLMNPQRSTUV`;

  it('uses the share sheet when there is one', async () => {
    const calls = [];
    const nav = { share: async (data) => calls.push(data) };
    expect(canNativeShare(nav)).toBe(true);
    const out = await shareLink({ link, title: 'Deed' }, { nav, copy: async () => true });
    expect(out).toBe('shared');
    expect(calls).toEqual([{ title: 'Deed', url: link }]);
  });

  it('a closed share sheet is not an error and nothing is copied', async () => {
    let copied = 0;
    const nav = {
      share: async () => {
        throw Object.assign(new Error('closed'), { name: 'AbortError' });
      }
    };
    const out = await shareLink({ link }, { nav, copy: async () => (copied += 1) });
    expect(out).toBe('cancelled');
    expect(copied).toBe(0);
  });

  it('falls back to the clipboard when sharing fails or does not exist', async () => {
    const failing = {
      share: async () => {
        throw new Error('not allowed');
      }
    };
    expect(await shareLink({ link }, { nav: failing, copy: async () => true })).toBe('copied');
    expect(await shareLink({ link }, { nav: {}, copy: async () => true })).toBe('copied');
    expect(await shareLink({ link }, { nav: undefined, copy: async () => true })).toBe('copied');
    expect(canNativeShare({})).toBe(false);
    expect(canNativeShare(null)).toBe(false);
  });

  it('reports failure when nothing worked', async () => {
    expect(await shareLink({ link }, { nav: {}, copy: async () => false })).toBe('failed');
    expect(await shareLink({ link }, { nav: {}, copy: async () => { throw new Error('x'); } })).toBe('failed');
    expect(await shareLink({ link }, { nav: {} })).toBe('failed');
    expect(await shareLink({ link: '' }, { nav: {}, copy: async () => true })).toBe('failed');
  });

  it('says the right thing in the toast', () => {
    expect(shareToast('copied', { withPassword: true }).text).toMatch(/open the file/);
    expect(shareToast('copied', { withPassword: false }).text).toMatch(/check the file, but not open it/);
    expect(shareToast('failed').tone).toBe('bad');
    expect(shareToast('shared')).toBeNull();
    expect(shareToast('cancelled')).toBeNull();
    noText([shareToast('copied', { withPassword: true }), shareToast('copied', { withPassword: false }), shareToast('failed')]);
  });
});

describe('the file page', () => {
  async function fixture(versions = [{ label: 'Act of 2026' }, { label: 'Act of 2026, corrected' }]) {
    const owner = await createIdentity('Priya');
    const serverKey = await createServerKey();
    const parts = await buildBundleParts({ owner, serverKey, versions });
    const verification = await verifyDocumentBundle(parts.bundle, { pinnedServerKeyId: serverKey.keyId, expectedDocId: parts.docId });
    return { ...parts, owner, serverKey, verification };
  }

  it('uses the newest label as the title and keeps it after a withdrawal', async () => {
    const f = await fixture();
    expect(fileTitle(f.bundle, f.verification)).toBe('Act of 2026, corrected');
    const w = await fixture([{ label: 'Act of 2026' }, { revoke: true, reason: 'Issued by mistake' }]);
    expect(fileTitle(w.bundle, w.verification)).toBe('Act of 2026');
    expect(fileTitle(null, null)).toBe('File');
  });

  it('decides the state from the checks only', async () => {
    const f = await fixture();
    expect(f.verification.ok).toBe(true);
    expect(fileState(f.verification)).toBe('verified');
    expect(fileState({ ...f.verification, ok: false })).toBe('unverified');
    expect(fileState({ ...f.verification, status: 'revoked' })).toBe('withdrawn');
    expect(fileState({ ok: 'yes', status: 'active' })).toBe('unverified');
    expect(fileState(null)).toBe('unverified');
  });

  it('warns loudly about an answer older than one this browser saw', () => {
    expect(rollbackNote({ rollback: true })).toMatch(/older than one this browser saw/);
    expect(rollbackNote({ rollback: false })).toBe('');
    expect(rollbackNote({ rollback: 'true' })).toBe('');
    expect(rollbackNote(null)).toBe('');
  });

  it('lists versions newest first like "Version 2, Priya, today 10:02"', async () => {
    const f = await fixture([{ label: 'one' }, { label: 'two' }, { label: 'three' }]);
    const rows = versionRows(f.bundle, Date.now() + 1000);
    expect(rows.map((r) => r.version)).toEqual([3, 2, 1]);
    expect(rows[0].isHead).toBe(true);
    expect(rows[1].isHead).toBe(false);
    expect(rows[0].line).toMatch(/^Version 3, Priya, (today \d\d:\d\d|\d+ \w+, \d\d:\d\d)$/);
    expect(rows[2].label).toBe('one');
  });

  it('names a withdrawal and keeps the reason', async () => {
    const f = await fixture([{ label: 'one' }, { revoke: true, reason: 'Superseded' }]);
    const rows = versionRows(f.bundle);
    expect(rows[0]).toMatchObject({ withdrawn: true, title: 'Withdrawn', reason: 'Superseded' });
    expect(rows[0].line).toMatch(/^Withdrawn, Priya, /);
  });

  it('handles a bundle with no names or no records', () => {
    expect(versionRows(null)).toEqual([]);
    expect(versionRows({ records: [] })).toEqual([]);
  });

  it('formats the time of a version', () => {
    expect(versionStamp(NOW - HOUR, NOW)).toMatch(/^today \d\d:\d\d$/);
    expect(versionStamp(NOW - DAY, NOW)).toMatch(/^yesterday \d\d:\d\d$/);
    expect(versionStamp(NOW - 40 * DAY, NOW)).toMatch(/^\d+ \w+, \d\d:\d\d$/);
    expect(versionStamp(NaN, NOW)).toBe('time unknown');
    expect(versionStamp(undefined, NOW)).toBe('time unknown');
  });
});

describe('the Open file button', () => {
  const good = { blobCheck: { ok: true }, plaintextCheck: null, file: null, fingerprint: null };

  it('opens an unlocked file', () => {
    expect(openPlan({ result: { ...good, file: { name: 'a', data: new Uint8Array(1) } } }).kind).toBe('ready');
  });

  it('asks for the password when the file was not tried', () => {
    expect(openPlan({ result: good }).kind).toBe('ask');
  });

  it('says a wrong password did not work', () => {
    const plan = openPlan({ result: { ...good, plaintextCheck: { ok: false, detail: 'x' }, fingerprint: null } });
    expect(plan.kind).toBe('wrong');
    expect(plan.text).toMatch(/did not work/);
  });

  it('never offers a file that does not match what the owner signed', () => {
    expect(openPlan({ result: { blobCheck: { ok: false }, plaintextCheck: null, file: null } }).kind).toBe('broken');
    const changed = openPlan({ result: { ...good, plaintextCheck: { ok: false }, fingerprint: 'ab'.repeat(32) } });
    expect(changed.kind).toBe('broken');
  });

  it('has nothing to open for a withdrawn file or a missing locked file', () => {
    expect(openPlan({ result: good, revoked: true }).kind).toBe('none');
    expect(openPlan({ result: { blobCheck: null, file: null }, revoked: false }).kind).toBe('none');
    expect(openPlan({ result: null }).kind).toBe('none');
  });

  it('does not offer a plain Open for a file that did not verify', () => {
    expect(openLabel({ verified: true, kind: 'ready' })).toBe('Open file');
    expect(openLabel({ verified: false, kind: 'ready' })).toMatch(/not verified/);
    expect(openLabel({ verified: false, kind: 'ask' })).toBe('Open file');
  });
});

describe('passwords on the file page', () => {
  it('reads a password or a pasted full link', () => {
    expect(passwordFromInput('abcd-efgh-jklm-npqr-stuv')).toBe(PW);
    expect(passwordFromInput(`https://x.test/d/${ID}#k=ABCDEFGHJKLMNPQRSTUV`)).toBe(PW);
    expect(passwordFromInput('   ')).toBe('');
    expect(passwordFromInput(`https://x.test/d/${ID}`.replace('x', 'y') + '#nothing')).not.toContain('http');
    expect(passwordFromInput(null)).toBe('');
    expect(promptProblem('')).toMatch(/Enter the file password/);
    expect(promptProblem(PW)).toBe('');
  });

  it('uses the password in the link first, then the owner\'s saved copy', async () => {
    const asked = [];
    const getStored = async (id) => {
      asked.push(id);
      return 'wxyz-wxyz-wxyz-wxyz-wxyz';
    };
    const link = await initialPassword({ docId: ID, fragment: '#k=ABCDEFGHJKLMNPQRSTUV', signedIn: true, getStored });
    expect(link).toEqual({ password: PW, fromLink: true });
    expect(asked).toEqual([]);
    const vault = await initialPassword({ docId: ID, fragment: '', signedIn: true, getStored });
    expect(vault.password).toBe('WXYZ-WXYZ-WXYZ-WXYZ-WXYZ');
    expect(vault.fromLink).toBe(false);
    expect(asked).toEqual([ID]);
  });

  it('does not look in the vault for someone who is not signed in', async () => {
    let asked = 0;
    const out = await initialPassword({ docId: ID, fragment: '', signedIn: false, getStored: async () => (asked += 1) });
    expect(out.password).toBe('');
    expect(asked).toBe(0);
  });

  it('a failing or empty vault gives no password and no error', async () => {
    expect((await initialPassword({ docId: ID, fragment: '', signedIn: true, getStored: async () => { throw new Error('down'); } })).password).toBe('');
    expect((await initialPassword({ docId: ID, fragment: '', signedIn: true, getStored: async () => null })).password).toBe('');
    expect((await initialPassword({ docId: ID, fragment: '#k=', signedIn: true, getStored: async () => null })).password).toBe('');
    expect((await initialPassword({ docId: ID, fragment: '', signedIn: true })).password).toBe('');
  });

  it('shares the password that opened the file, or the owner\'s own copy', async () => {
    const getStored = async () => PW;
    expect(await sharePassword({ docId: ID, unlockedWith: 'AAAA', isOwner: false, getStored })).toBe('AAAA');
    expect(await sharePassword({ docId: ID, unlockedWith: '', isOwner: true, getStored })).toBe(PW);
    // a visitor never gets a password from the vault
    expect(await sharePassword({ docId: ID, unlockedWith: '', isOwner: false, getStored })).toBe('');
    expect(await sharePassword({ docId: ID, unlockedWith: '', isOwner: true, getStored: async () => { throw new Error('x'); } })).toBe('');
  });

  it('builds the link to share', () => {
    const withPw = sharePlan({ docId: ID, password: PW });
    expect(withPw.withPassword).toBe(true);
    expect(withPw.link).toBe(`/d/${ID}#k=ABCDEFGHJKLMNPQRSTUV`);
    const without = sharePlan({ docId: ID, password: '' });
    expect(without.withPassword).toBe(false);
    expect(without.link).toBe(`/d/${ID}`);
    expect(without.link).not.toContain('#');
  });
});

describe('owner tools', () => {
  async function fixture() {
    const owner = await createIdentity('Priya');
    const other = await createIdentity('Other');
    const serverKey = await createServerKey();
    const parts = await buildBundleParts({ owner, serverKey, versions: [{ label: 'one' }, { label: 'two' }] });
    const verification = await verifyDocumentBundle(parts.bundle, { pinnedServerKeyId: serverKey.keyId, expectedDocId: parts.docId });
    return { ...parts, owner, other, verification };
  }

  it('owner tools need the verified owner key to equal the signed in key', async () => {
    const f = await fixture();
    expect(ownerAccess({ identity: { keyId: f.owner.keyId }, bundle: f.bundle, verification: f.verification }).allowed).toBe(true);
    expect(ownerAccess({ identity: { keyId: f.other.keyId }, bundle: f.bundle, verification: f.verification }).isOwner).toBe(false);
    expect(ownerAccess({ identity: null, bundle: f.bundle, verification: f.verification }).allowed).toBe(false);
    expect(ownerAccess({ identity: { keyId: f.owner.keyId }, bundle: f.bundle, verification: { ...f.verification, ok: false } }).allowed).toBe(false);
  });

  it('explains when the account owns the file through another key', async () => {
    const f = await fixture();
    const access = ownerAccess({ identity: { keyId: f.other.keyId }, bundle: f.bundle, verification: f.verification });
    const note = ownerNote({ identity: { keyId: f.other.keyId }, keys: [{ keyId: f.owner.keyId }, { keyId: f.other.keyId }], bundle: f.bundle, access });
    expect(note).toMatch(/another key of your account/);
    expect(ownerNote({ identity: { keyId: f.other.keyId }, keys: [{ keyId: f.other.keyId }], bundle: f.bundle, access })).toBe('');
    const mine = ownerAccess({ identity: { keyId: f.owner.keyId }, bundle: f.bundle, verification: f.verification });
    expect(ownerNote({ identity: { keyId: f.owner.keyId }, keys: [{ keyId: f.owner.keyId }], bundle: f.bundle, access: mine })).toBe('');
    expect(ownerNote({ identity: null, keys: undefined, bundle: null, access: null })).toBe('');
  });

  it('the update form needs a file and a password', () => {
    expect(updateProblem({ file: null, password: PW })).toBe('Choose the new file.');
    expect(updateProblem({ file: { size: 0 }, password: PW })).toMatch(/empty/);
    expect(updateProblem({ file: { size: 5 }, password: '' })).toMatch(/password/);
    expect(updateProblem({ file: { size: 5 }, password: PW })).toBe('');
  });

  it('the withdraw form needs a short reason and a tick', () => {
    expect(withdrawProblem({ reason: '', confirmed: true })).toMatch(/short reason/);
    expect(withdrawProblem({ reason: '   ', confirmed: true })).toMatch(/short reason/);
    expect(withdrawProblem({ reason: 'Issued by mistake', confirmed: false })).toMatch(/Tick the box/);
    expect(withdrawProblem({ reason: 'Issued by mistake', confirmed: 'yes' })).toMatch(/Tick the box/);
    expect(withdrawProblem({ reason: 'x'.repeat(501), confirmed: true })).toMatch(/too long/);
    expect(withdrawProblem({ reason: 'Issued by mistake', confirmed: true })).toBe('');
  });

  it('accepts only a usable head', () => {
    expect(validHead({ version: 2, recordHash: 'ab'.repeat(32) })).toBe(true);
    expect(validHead({ version: 0, recordHash: 'ab'.repeat(32) })).toBe(false);
    expect(validHead({ version: 2, recordHash: 'zz' })).toBe(false);
    expect(validHead(null)).toBe(false);
  });
});

afterEach(() => {
  // nothing global is changed by these tests
});
