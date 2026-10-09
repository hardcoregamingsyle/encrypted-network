import { useId, useState } from 'react';
import Button from '../Button.jsx';
import { DocListBody } from './DocList.jsx';
import useDocumentList, { useDebounced } from './useDocumentList.js';
import { textOf } from '../../lib/format.js';
import { PAGE_SIZE, SEARCH_DELAY_MS, SEARCH_MAX, normalizeQuery } from './vaultLogic.js';

function rowOf(d) {
  return {
    docId: d.docId,
    label: typeof d.label === 'string' ? d.label : '',
    status: d.status === 'revoked' ? 'revoked' : 'active',
    version: Number.isFinite(d.headVersion) ? d.headVersion : null,
    updatedAt: Number.isFinite(d.updatedAt) ? d.updatedAt : null,
    approxTime: false,
    // every field comes from the server, so odd types are turned into text before they are shown
    ownerKeyId: textOf(d.ownerKeyId),
    ownerName: textOf(d.ownerName),
    listed: false,
    local: false
  };
}

// The public list with a search box. The search waits until typing stops, then asks the server.
export default function PublicDocuments({ reloadKey = 0 }) {
  const inputId = useId();
  const [text, setText] = useState('');
  const q = useDebounced(normalizeQuery(text), SEARCH_DELAY_MS);
  const list = useDocumentList({ q, limit: PAGE_SIZE, reloadKey });
  const rows = list.items.map(rowOf);
  const searching = q !== '';
  const waitingForTyping = normalizeQuery(text) !== q;

  let summary = '';
  if (list.status === 'ready' && !waitingForTyping) {
    summary = rows.length === 0 ? 'No documents found' : `${rows.length} ${rows.length === 1 ? 'document' : 'documents'} shown`;
  } else if (list.status === 'loading') {
    summary = 'Searching';
  }

  return (
    <section className="ui-card vault-section" aria-labelledby="vault-public-title">
      <div className="vault-section__head">
        <h2 className="ui-card__title" id="vault-public-title">
          Public documents
        </h2>
        <Button size="sm" variant="ghost" onClick={list.reload} disabled={list.status === 'loading'}>
          Refresh
        </Button>
      </div>
      <p className="ui-muted">
        Documents whose owners chose to show them in the public list, newest change first. Unlisted documents never
        appear here. A listing is not a check: open a document to verify it.
      </p>

      <form className="vault-search" role="search" onSubmit={(e) => e.preventDefault()}>
        <label className="ui-field__label" htmlFor={inputId}>
          Search labels
        </label>
        <div className="vault-search__row">
          <input
            id={inputId}
            type="search"
            value={text}
            maxLength={SEARCH_MAX}
            placeholder="Part of a label"
            autoComplete="off"
            onChange={(e) => setText(e.target.value)}
          />
          {text ? (
            <Button size="sm" variant="ghost" onClick={() => setText('')}>
              Clear
            </Button>
          ) : null}
        </div>
      </form>
      <p className="ui-sr-only" role="status" aria-live="polite">
        {summary}
      </p>

      <DocListBody
        list={list}
        rows={rows}
        showOwner
        busyLabel="Loading public documents"
        errorTitle="Could not load the public list"
        empty={
          searching
            ? {
                title: 'Nothing matches that search',
                text: 'Try fewer or different words. Only labels are searched, and only listed documents.'
              }
            : {
                title: 'No public documents yet',
                text: 'Nobody has listed a document yet. Publish one with "Show in the public list" ticked to see it here.'
              }
        }
      />
    </section>
  );
}
