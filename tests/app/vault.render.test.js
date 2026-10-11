import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { DocListBody, DocRow, SkeletonRows, StatusBadge } from '../../src/components/vault/DocList.jsx';
import DropZone from '../../src/components/vault/DropZone.jsx';
import ProgressList from '../../src/components/vault/ProgressList.jsx';
import PublishResult from '../../src/components/vault/PublishResult.jsx';
import { advanceSteps, createSteps } from '../../src/components/vault/vaultLogic.js';

const render = (node) => renderToString(h(MemoryRouter, { initialEntries: ['/'] }, node));

const ID = 'c'.repeat(32);
const OWNER = 'ab'.repeat(32);

const baseList = {
  status: 'ready',
  items: [],
  error: '',
  hasMore: false,
  moreBusy: false,
  moreError: '',
  announce: '',
  reload() {},
  loadMore() {}
};

const row = {
  docId: ID,
  label: 'Land record',
  status: 'active',
  version: 3,
  updatedAt: Date.now() - 3600 * 1000,
  approxTime: false,
  ownerKeyId: OWNER,
  ownerName: 'Office',
  listed: true,
  local: false
};

function noBadText(html) {
  expect(html).not.toMatch(new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']'));
  expect(html).not.toMatch(/\b(AI|Claude|Anthropic|GPT|OpenAI)\b/);
}

describe('DropZone', () => {
  it('has a labelled file input and the size limit text', () => {
    const html = render(h(DropZone, { file: null, onFile() {}, onClear() {}, limitText: 'Up to 20 MiB.' }));
    expect(html).toContain('type="file"');
    expect(html).toContain('<label');
    expect(html).toContain('Drop a file here, or choose one');
    expect(html).toContain('Up to 20 MiB.');
    expect(html).not.toContain('Remove file');
  });

  it('shows the chosen file with its size and a remove button', () => {
    const html = render(h(DropZone, { file: { name: 'deed.pdf', size: 1536 }, onFile() {}, onClear() {} }));
    expect(html).toContain('deed.pdf');
    expect(html).toContain('1.5 KiB');
    expect(html).toContain('Remove file');
  });

  it('shows an error and marks the input invalid', () => {
    const html = render(h(DropZone, { file: { name: 'a', size: 0 }, onFile() {}, onClear() {}, error: 'The file is empty.' }));
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('The file is empty.');
    expect(html).toContain('role="alert"');
  });
});

describe('ProgressList', () => {
  it('lists the six steps with states for screen readers', () => {
    let steps = createSteps();
    steps = advanceSteps(steps, 'read');
    steps = advanceSteps(steps, 'derive');
    const html = render(h(ProgressList, { steps, detail: 'Deriving the key, this takes a moment' }));
    expect(html).toContain('Read the file');
    expect(html).toContain('Publish the record');
    expect(html).toContain(': done');
    expect(html).toContain(': in progress');
    expect(html).toContain(': waiting');
    expect(html).toContain('aria-current="step"');
    expect(html).toContain('This takes a moment on purpose.');
    expect(html).toContain('role="status"');
    expect(html).toContain('Deriving the key, this takes a moment');
  });

  it('shows a failed step', () => {
    const steps = createSteps().map((s, i) => (i === 3 ? { ...s, status: 'error' } : s));
    expect(render(h(ProgressList, { steps }))).toContain(': failed');
  });
});

describe('PublishResult', () => {
  const result = {
    docId: ID,
    password: 'ABCD-EFGH-JKLM-NPQR-STUV',
    fingerprint: 'f'.repeat(64),
    version: 1,
    links: {
      verify: `https://x.test/d/${ID}`,
      full: `https://x.test/d/${ID}#k=ABCDEFGHJKLMNPQRSTUV`
    }
  };

  it('shows the id, password once, fingerprint, both links and the warning', () => {
    const html = render(h(PublishResult, { result, meta: { label: 'Deed', createdAt: 1 }, onDismiss() {} }));
    expect(html).toContain(ID);
    expect(html).toContain('ABCD-EFGH-JKLM-NPQR-STUV');
    expect(html).toContain('f'.repeat(64));
    expect(html).toContain(result.links.verify);
    expect(html).toContain(result.links.full);
    expect(html).toContain('cannot be recovered');
    expect(html).toContain('shown only once');
    expect(html).toContain('Save as text file');
    expect(html).toContain('Open the document page');
    expect(html).toContain(`href="/d/${ID}#k=ABCDEFGHJKLMNPQRSTUV"`);
    expect(html).toContain('Copy');
    expect(html).toContain('I have saved the password');
    noBadText(html);
  });
});

describe('document lists', () => {
  it('renders skeleton rows with an announcement', () => {
    const html = render(h(SkeletonRows, { count: 2, label: 'Loading your documents' }));
    expect(html).toContain('Loading your documents');
    expect(html.match(/vault-doc--skeleton/g).length).toBe(2);
  });

  it('renders a row with label, version, status, time and a link', () => {
    const html = render(h('ul', null, h(DocRow, { doc: row, showOwner: true })));
    expect(html).toContain(`href="/d/${ID}"`);
    expect(html).toContain('Land record');
    expect(html).toContain('Version 3');
    expect(html).toContain('Active');
    expect(html).toContain('updated 1 hour ago');
    expect(html).toContain('Office');
    expect(html).toContain('abababab');
  });

  it('shows revoked and missing documents differently', () => {
    const revoked = render(h('ul', null, h(DocRow, { doc: { ...row, status: 'revoked' } })));
    expect(revoked).toContain('Revoked');
    expect(revoked).toContain('ui-badge--bad');
    const missing = render(h('ul', null, h(DocRow, { doc: { ...row, status: 'missing', local: true }, onForget() {} })));
    expect(missing).toContain('Not on the server');
    expect(missing).not.toContain(`href="/d/${ID}"`);
    expect(missing).toContain('Remove from list');
  });

  it('handles an empty label and an unknown time', () => {
    const html = render(h('ul', null, h(DocRow, { doc: { ...row, label: '', updatedAt: null, version: null } })));
    expect(html).toContain('Untitled document');
    expect(html).toContain('time unknown');
    expect(html).not.toContain('Version');
  });

  it('shows the status badge tones', () => {
    expect(render(h(StatusBadge, { status: 'active' }))).toContain('ui-badge--good');
    expect(render(h(StatusBadge, { status: 'checking' }))).toContain('Checking');
  });

  const empty = { title: 'Nothing here', text: 'Add something.' };

  it('shows skeletons for the first load, then empty, error and rows', () => {
    const loading = render(h(DocListBody, { list: { ...baseList, status: 'loading' }, rows: [], empty }));
    expect(loading).toContain('vault-doc--skeleton');

    const emptyHtml = render(h(DocListBody, { list: baseList, rows: [], empty }));
    expect(emptyHtml).toContain('Nothing here');

    const err = render(h(DocListBody, { list: { ...baseList, status: 'error', error: 'Could not reach the server.' }, rows: [], empty }));
    expect(err).toContain('Could not reach the server.');
    expect(err).toContain('Try again');

    const rows = render(h(DocListBody, { list: baseList, rows: [row], empty, showOwner: true }));
    expect(rows).toContain('Land record');
    expect(rows).not.toContain('Load more');
  });

  it('keeps old rows visible while a new search loads', () => {
    const html = render(h(DocListBody, { list: { ...baseList, status: 'loading' }, rows: [row], empty }));
    expect(html).toContain('is-stale');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Land record');
  });

  it('shows Load more and its error', () => {
    const more = render(h(DocListBody, { list: { ...baseList, hasMore: true }, rows: [row], empty }));
    expect(more).toContain('Load more');
    const busy = render(h(DocListBody, { list: { ...baseList, hasMore: true, moreBusy: true }, rows: [row], empty }));
    expect(busy).toContain('aria-busy="true"');
    const failed = render(h(DocListBody, { list: { ...baseList, moreError: 'Server down' }, rows: [row], empty }));
    expect(failed).toContain('Could not load more');
    expect(failed).toContain('Server down');
  });
});
