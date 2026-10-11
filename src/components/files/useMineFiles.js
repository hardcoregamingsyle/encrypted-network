// "Mine" on the Files screen.
//   Account      GET /api/me/documents: every file owned by any key of the account, listed or not.
//   Quick start  the files this browser published (src/lib/localDocs.js) plus the listed files the server
//                names this key as the owner of. A remembered file the list does not show is looked up by id,
//                so unlisted files still appear.
import { useEffect, useMemo, useRef, useState } from 'react';
import { getDocumentHead, listDocuments, listMyDocuments } from '../../lib/api.js';
import { docsOwnedBy, forgetDoc, listLocalDocs } from '../../lib/localDocs.js';
import { idsToLookUp, mergeDocuments, ownedBy } from '../vault/vaultLogic.js';
import { accountRow, usableRows } from './filesLogic.js';
import useFileList from './useFileList.js';

const BATCH = 5;

async function lookUp(docId) {
  try {
    return { state: 'ok', head: await getDocumentHead(docId) };
  } catch (err) {
    if (err && err.status === 404) return { state: 'missing' };
    return { state: 'error' };
  }
}

// ready: a signed in person with a key. mode: 'account' | 'guest'.
export default function useMineFiles({ ready, mode, keyId, reloadKey = 0 }) {
  const account = mode === 'account';
  const accountList = useFileList({ fetcher: listMyDocuments, enabled: ready && account, reloadKey });
  const guestList = useFileList({ fetcher: listDocuments, owner: keyId, enabled: ready && !account && !!keyId, reloadKey });
  const [tick, setTick] = useState(0);
  const [heads, setHeads] = useState({});
  const headsRef = useRef({});
  // Only the files this key published. An entry that names another key belongs to somebody else who used this
  // browser; an old entry with no owner (from before owners were kept) is still shown.
  const local = useMemo(
    () => (account ? [] : docsOwnedBy(listLocalDocs(), keyId)),
    [account, keyId, reloadKey, tick] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // The server filters by owner, but a server can say anything, so the owner is checked again here.
  const mine = useMemo(() => ownedBy(guestList.items, keyId), [guestList.items, keyId]);

  const waiting = !ready || account || guestList.status === 'loading';
  useEffect(() => {
    if (waiting) return undefined;
    const ids = idsToLookUp(mine, local, headsRef.current);
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
  }, [waiting, mine, local]);

  const guestRows = useMemo(() => mergeDocuments(mine, local, heads), [mine, local, heads]);
  const accountRows = useMemo(() => usableRows(accountList.items.map(accountRow)), [accountList.items]);

  const rows = account ? accountRows : usableRows(guestRows);
  const base = account ? accountList : guestList;
  // The server list failed but the browser still remembers files: show those, with a note.
  const failedButHasRows = !account && base.status === 'error' && rows.length > 0;

  function reload() {
    headsRef.current = {};
    setHeads({});
    base.reload();
  }

  function forget(docId) {
    forgetDoc(docId);
    setTick((n) => n + 1);
  }

  return { list: { ...base, reload }, rows, forget, failedButHasRows };
}
