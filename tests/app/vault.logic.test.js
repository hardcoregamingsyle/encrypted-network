import { describe, expect, it } from 'vitest';
import {
  MAX_FILE_BYTES,
  advanceSteps,
  appendPage,
  buildSaveText,
  createSteps,
  displayLabel,
  documentRoute,
  doneCount,
  effectiveLabel,
  failSteps,
  failedStepId,
  fileProblem,
  friendlyError,
  hasMorePage,
  idsToLookUp,
  labelProblem,
  listParams,
  mergeDocuments,
  needsRegistration,
  nextCursor,
  normalizeLabel,
  normalizeQuery,
  recoveryHint,
  saveFileName,
  statusView,
  suggestedLabel
} from '../../src/components/vault/vaultLogic.js';

const ID1 = '1'.repeat(32);
const ID2 = '2'.repeat(32);
const ID3 = '3'.repeat(32);
const OWNER = 'ab'.repeat(32);

describe('fileProblem', () => {
  it('accepts a normal file and the exact limit', () => {
    expect(fileProblem({ name: 'a.pdf', size: 10 })).toBe('');
    expect(fileProblem({ name: 'a.pdf', size: MAX_FILE_BYTES })).toBe('');
  });

  it('rejects missing, empty, nameless and oversized files', () => {
    expect(fileProblem(null)).toMatch(/Choose a file/);
    expect(fileProblem({ name: 'a', size: 0 })).toMatch(/empty/);
    expect(fileProblem({ name: '   ', size: 5 })).toMatch(/no name/);
    expect(fileProblem({ name: 'a', size: NaN })).toMatch(/not known/);
    const big = fileProblem({ name: 'a', size: MAX_FILE_BYTES + 1 });
    expect(big).toMatch(/limit is 50 MiB/);
  });
});

describe('labels', () => {
  it('normalises, trims and cuts to 120 characters', () => {
    expect(normalizeLabel('  é  ')).toBe('é');
    expect(normalizeLabel(undefined)).toBe('');
    expect(Array.from(normalizeLabel('x'.repeat(300))).length).toBe(120);
    expect(Array.from(normalizeLabel('\u{1F600}'.repeat(200))).length).toBe(120);
  });

  it('starts from the file name unless the name is hidden', () => {
    expect(suggestedLabel({ fileName: 'report.pdf', hideName: false })).toBe('report.pdf');
    expect(suggestedLabel({ fileName: 'report.pdf', hideName: true })).toBe('');
  });

  it('never publishes the file name as the label when it is hidden', () => {
    expect(effectiveLabel({ labelText: 'report.pdf', fileName: 'report.pdf', hideName: true })).toBe('');
    expect(effectiveLabel({ labelText: 'Land record', fileName: 'report.pdf', hideName: true })).toBe('Land record');
    expect(effectiveLabel({ labelText: 'report.pdf', fileName: 'report.pdf', hideName: false })).toBe('report.pdf');
    expect(effectiveLabel({ labelText: '', fileName: 'report.pdf', hideName: false })).toBe('');
  });

  it('uses the shared record rules to spot a bad label', () => {
    expect(labelProblem('')).toBe('');
    expect(labelProblem('Land record 2026')).toBe('');
    expect(labelProblem('zero​width')).toMatch(/not allowed/);
    expect(labelProblem('bell\u0007')).toMatch(/not allowed/);
  });

  it('shows a placeholder for a missing label', () => {
    expect(displayLabel('')).toBe('Untitled document');
    expect(displayLabel('   ')).toBe('Untitled document');
    expect(displayLabel(null)).toBe('Untitled document');
    expect(displayLabel('Deed')).toBe('Deed');
  });
});

describe('progress steps', () => {
  it('starts with six waiting steps in publish order', () => {
    const steps = createSteps();
    expect(steps.map((s) => s.id)).toEqual(['read', 'derive', 'lock', 'upload', 'sign', 'publish']);
    expect(steps.every((s) => s.status === 'pending')).toBe(true);
  });

  it('marks earlier steps done and the current one active', () => {
    let steps = advanceSteps(createSteps(), 'read');
    expect(steps[0].status).toBe('active');
    steps = advanceSteps(steps, 'derive');
    expect(steps.map((s) => s.status).slice(0, 3)).toEqual(['done', 'active', 'pending']);
    expect(steps[1].hint).toMatch(/takes a moment/);
  });

  it('treats the lock event as finished and done as everything finished', () => {
    let steps = createSteps();
    for (const id of ['read', 'derive', 'lock']) steps = advanceSteps(steps, id);
    expect(steps.slice(0, 3).map((s) => s.status)).toEqual(['done', 'done', 'done']);
    steps = advanceSteps(steps, 'upload');
    expect(steps[3].status).toBe('active');
    steps = advanceSteps(steps, 'done');
    expect(doneCount(steps)).toBe(6);
  });

  it('ignores unknown events and does not change the input', () => {
    const steps = createSteps();
    expect(advanceSteps(steps, 'nope')).toBe(steps);
    advanceSteps(steps, 'sign');
    expect(steps.every((s) => s.status === 'pending')).toBe(true);
  });

  it('marks the running step as failed', () => {
    let steps = createSteps();
    for (const id of ['read', 'derive', 'lock', 'upload']) steps = advanceSteps(steps, id);
    const failed = failSteps(steps);
    expect(failedStepId(failed)).toBe('upload');
    expect(failed.filter((s) => s.status === 'error').length).toBe(1);
  });

  it('fails the first open step when nothing was running', () => {
    expect(failedStepId(failSteps(createSteps()))).toBe('read');
    let steps = createSteps();
    for (const id of ['read', 'derive', 'lock']) steps = advanceSteps(steps, id);
    expect(failedStepId(failSteps(steps))).toBe('upload');
  });

  it('leaves a finished list as it is', () => {
    const done = advanceSteps(createSteps(), 'done');
    expect(failedStepId(failSteps(done))).toBe('');
  });
});

describe('errors', () => {
  it('turns codes into plain advice', () => {
    expect(friendlyError({ code: 'network', message: 'x' })).toMatch(/Could not reach the server/);
    expect(friendlyError({ code: 'rate_limited' })).toMatch(/too often/);
    expect(friendlyError({ code: 'expired' })).toMatch(/clock/);
    expect(friendlyError({ code: 'unknown_signer' })).toMatch(/Register your key/);
    expect(friendlyError({ code: 'too_large' })).toMatch(/too large/);
    expect(friendlyError({ code: 'server_error' })).toMatch(/Nothing was published/);
  });

  it('keeps the message of other errors and survives odd input', () => {
    expect(friendlyError(new Error('the file is empty'))).toBe('the file is empty');
    expect(friendlyError(null)).toMatch(/Nothing was published/);
    expect(friendlyError('text')).toMatch(/Nothing was published/);
    expect(friendlyError({ code: 5, message: '' })).toMatch(/went wrong/);
  });

  it('is honest about what happened at each step', () => {
    expect(recoveryHint('derive')).toMatch(/not sent anywhere/);
    expect(recoveryHint('upload')).toMatch(/no record was published/);
    expect(recoveryHint('publish')).toMatch(/may already be on the server/);
    expect(recoveryHint('')).toMatch(/new password/);
  });

  it('knows when registering the key would help', () => {
    expect(needsRegistration({ code: 'unknown_signer' })).toBe(true);
    expect(needsRegistration({ code: 'network' })).toBe(false);
    expect(needsRegistration(null)).toBe(false);
  });
});

describe('search and paging', () => {
  it('cleans up the search text', () => {
    expect(normalizeQuery('  land   record  ')).toBe('land record');
    expect(normalizeQuery('a\n\tb')).toBe('a b');
    expect(normalizeQuery(undefined)).toBe('');
    expect(Array.from(normalizeQuery('x'.repeat(500))).length).toBe(100);
  });

  it('builds list parameters and leaves out empty ones', () => {
    expect(listParams({})).toEqual({ limit: 25 });
    expect(listParams({ owner: OWNER, q: ' deed ', before: 99, limit: 10 })).toEqual({
      limit: 10,
      owner: OWNER,
      q: 'deed',
      before: 99
    });
    expect(listParams({ q: '   ', before: NaN })).toEqual({ limit: 25 });
  });

  it('appends pages without duplicates and finds the next cursor', () => {
    const a = [{ docId: ID1, updatedAt: 30 }, { docId: ID2, updatedAt: 20 }];
    const b = [{ docId: ID2, updatedAt: 20 }, { docId: ID3, updatedAt: 10 }, null, { updatedAt: 5 }];
    const all = appendPage(a, b);
    expect(all.map((d) => d.docId)).toEqual([ID1, ID2, ID3]);
    expect(nextCursor(all)).toBe(10);
    expect(nextCursor([])).toBeUndefined();
    expect(nextCursor([{ docId: ID1 }])).toBeUndefined();
    expect(appendPage(a, undefined)).toEqual(a);
  });

  it('shows Load more only after a full page', () => {
    expect(hasMorePage(new Array(25).fill({}), 25)).toBe(true);
    expect(hasMorePage(new Array(24).fill({}), 25)).toBe(false);
    expect(hasMorePage(undefined)).toBe(false);
  });
});

describe('mergeDocuments', () => {
  const server = [
    { docId: ID1, label: 'Deed', ownerKeyId: OWNER, status: 'active', headVersion: 3, createdAt: 1, updatedAt: 3000 },
    { docId: ID2, label: 'Old', ownerKeyId: OWNER, status: 'revoked', headVersion: 2, createdAt: 1, updatedAt: 1000 }
  ];

  it('keeps server rows and adds local ones the server list does not show', () => {
    const local = [
      { docId: ID1, label: 'Deed local', createdAt: 5 },
      { docId: ID3, label: 'Secret', createdAt: 2000 }
    ];
    const heads = { [ID3]: { state: 'ok', head: { status: 'active', headVersion: 4 } } };
    const rows = mergeDocuments(server, local, heads);
    expect(rows.map((r) => r.docId)).toEqual([ID1, ID3, ID2]);
    expect(rows[0].label).toBe('Deed');
    expect(rows[0].listed).toBe(true);
    expect(rows[1]).toMatchObject({ label: 'Secret', status: 'active', version: 4, local: true, listed: false, approxTime: true });
    expect(rows[2].status).toBe('revoked');
  });

  it('marks missing, unreachable and not yet checked local documents', () => {
    const local = [
      { docId: ID1, label: 'a', createdAt: 4 },
      { docId: ID2, label: 'b', createdAt: 3 },
      { docId: ID3, label: 'c', createdAt: 2 }
    ];
    const rows = mergeDocuments([], local, { [ID1]: { state: 'missing' }, [ID2]: { state: 'error' } });
    expect(rows.map((r) => r.status)).toEqual(['missing', 'unknown', 'checking']);
  });

  it('handles empty, odd and revoked input', () => {
    expect(mergeDocuments(undefined, undefined)).toEqual([]);
    expect(mergeDocuments([null, {}], [null, { label: 'x' }])).toEqual([]);
    const rows = mergeDocuments([], [{ docId: ID1, label: '', createdAt: 0 }], {
      [ID1]: { state: 'ok', head: { status: 'revoked', headVersion: 'x' } }
    });
    expect(rows[0]).toMatchObject({ status: 'revoked', version: null, updatedAt: null });
  });

  it('picks the local ids that need a head lookup', () => {
    const local = [
      { docId: ID1, label: '', createdAt: 3 },
      { docId: ID2, label: '', createdAt: 2 },
      { docId: ID3, label: '', createdAt: 1 }
    ];
    expect(idsToLookUp(server, local, {})).toEqual([ID3]);
    expect(idsToLookUp([], local, { [ID1]: { state: 'missing' } })).toEqual([ID2, ID3]);
    expect(idsToLookUp([], local, {}, 2)).toEqual([ID1, ID2]);
    expect(idsToLookUp(undefined, undefined)).toEqual([]);
  });

  it('describes statuses', () => {
    expect(statusView('active')).toEqual({ tone: 'good', text: 'Active' });
    expect(statusView('revoked').tone).toBe('bad');
    expect(statusView('missing').tone).toBe('warn');
    expect(statusView('weird').text).toBe('weird');
  });
});

describe('result helpers', () => {
  const result = {
    docId: ID1,
    password: 'ABCD-EFGH-JKLM-NPQR-STUV',
    fingerprint: 'f'.repeat(64),
    links: { verify: `https://x.test/d/${ID1}`, full: `https://x.test/d/${ID1}#k=ABCDEFGHJKLMNPQRSTUV` }
  };

  it('puts everything the owner needs into the text file', () => {
    const text = buildSaveText({ ...result, label: 'Deed', createdAt: Date.UTC(2026, 9, 9) });
    expect(text).toContain(`Document id: ${ID1}`);
    expect(text).toContain('Password: ABCD-EFGH-JKLM-NPQR-STUV');
    expect(text).toContain('f'.repeat(64));
    expect(text).toContain(result.links.verify);
    expect(text).toContain(result.links.full);
    expect(text).toContain('Label: Deed');
    expect(text).toContain('2026-10-09');
    expect(text).toMatch(/cannot be recovered/);
    expect(text).not.toContain(String.fromCharCode(0x2014));
  });

  it('copes with an empty label and a missing time', () => {
    const text = buildSaveText({ ...result, label: '' });
    expect(text).toContain('Label: (none)');
    expect(text).not.toContain('Saved:');
  });

  it('names the file after the document id and builds the route with the hash only', () => {
    expect(saveFileName(ID1)).toBe('hrdlock-11111111.txt');
    expect(documentRoute(ID1, result.links.full)).toEqual({ pathname: `/d/${ID1}`, hash: '#k=ABCDEFGHJKLMNPQRSTUV' });
    expect(documentRoute(ID1, result.links.verify)).toEqual({ pathname: `/d/${ID1}`, hash: '' });
    expect(documentRoute(ID1, undefined)).toEqual({ pathname: `/d/${ID1}`, hash: '' });
  });
});
