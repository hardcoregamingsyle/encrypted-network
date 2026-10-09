import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Button from '../Button.jsx';
import Callout from '../Callout.jsx';
import { getDocumentHead } from '../../lib/api.js';
import { forgetDoc, listLocalDocs } from '../../lib/localDocs.js';
import { DocListBody, SkeletonRows } from './DocList.jsx';
import useDocumentList from './useDocumentList.js';
import { PAGE_SIZE, idsToLookUp, mergeDocuments } from './vaultLogic.js';

const BATCH = 5;

async function lookUp(docId) {
  try {
    const head = await getDocumentHead(docId);
    return { state: 'ok', head };
  } catch (err) {
    if (err && err.status === 404) return { state: 'missing' };
    return { state: 'error' };
  }
}

// Documents owned by this identity (from the server list) plus the ones published from this
// browser (so unlisted documents show up too).
export default function MyDocuments({ status, identity, reloadKey = 0 }) {
  const keyId = identity ? identity.keyId : '';
  const [tick, setTick] = useState(0);
  const [heads, setHeads] = useState({});
  const headsRef = useRef({});
  const local = useMemo(() => listLocalDocs(), [reloadKey, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = useDocumentList({ owner: keyId, enabled: status === 'ready' && !!keyId, limit: PAGE_SIZE, reloadKey });

  // Look up local documents that the server list does not show.
  const waiting = status === 'loading' || (status === 'ready' && keyId && list.status === 'loading');
  useEffect(() => {
    if (waiting) return undefined;
    const ids = idsToLookUp(list.items, local, headsRef.current);
    if (ids.length === 0) return undefined;
    let cancelled = false;
    (async () => {
      for (let i = 0; i < ids.length; i += BATCH) {
        const part = ids.slice(i, i + BATCH);
        const found = await Promise.all(part.map(lookUp));
        if (cancelled) return;
        const next = { ...headsRef.current };
        part.forEach((id, n) => {
          next[id] = found[n];
        });
        headsRef.current = next;
        setHeads(next);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [waiting, list.items, local]);

  function forget(docId) {
    forgetDoc(docId);
    setTick((n) => n + 1);
  }

  function refresh() {
    headsRef.current = {};
    setHeads({});
    list.reload();
  }

  const rows = useMemo(() => mergeDocuments(list.items, local, heads), [list.items, local, heads]);
  const failedButHasRows = list.status === 'error' && rows.length > 0;
  const view = failedButHasRows ? { ...list, status: 'ready' } : list;

  return (
    <section className="ui-card vault-section" aria-labelledby="vault-mine-title">
      <div className="vault-section__head">
        <h2 className="ui-card__title" id="vault-mine-title">
          Your documents
        </h2>
        <Button size="sm" variant="ghost" onClick={refresh} disabled={waiting}>
          Refresh
        </Button>
      </div>
      <p className="ui-muted">
        Documents signed by your key, plus documents published from this browser, including unlisted ones. This browser
        remembers only ids and labels, never passwords.
      </p>

      {status === 'none' && local.length === 0 ? (
        <Callout tone="info" title="No identity on this device">
          <p>
            Your documents are found through your key. <Link to="/keys">Create or restore your identity</Link> to see
            them here.
          </p>
        </Callout>
      ) : null}

      {failedButHasRows ? (
        <Callout tone="warn" title="The server list could not be loaded">
          <p>{list.error} Showing the documents this browser remembers.</p>
        </Callout>
      ) : null}

      {status === 'loading' ? (
        <SkeletonRows label="Loading your documents" />
      ) : status === 'none' && local.length === 0 ? null : (
        <DocListBody
          list={view}
          rows={rows}
          onForget={forget}
          busyLabel="Loading your documents"
          errorTitle="Could not load your documents"
          empty={{
            title: 'No documents yet',
            text: 'Lock and publish a file above and it will appear here.'
          }}
        />
      )}
    </section>
  );
}
