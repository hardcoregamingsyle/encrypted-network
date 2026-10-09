// Loads a page of documents from the server and more pages on demand.
// status: 'loading' | 'ready' | 'error'. A newer request always wins over an older one.
import { useCallback, useEffect, useRef, useState } from 'react';
import { listDocuments } from '../../lib/api.js';
import { PAGE_SIZE, appendPage, hasMorePage, listParams, nextCursor } from './vaultLogic.js';

function messageOf(err) {
  return err && err.message ? err.message : 'Could not load the documents.';
}

export default function useDocumentList({ owner = '', q = '', enabled = true, limit = PAGE_SIZE, reloadKey = 0 } = {}) {
  const [state, setState] = useState({
    status: enabled ? 'loading' : 'ready',
    items: [],
    hasMore: false,
    error: '',
    moreBusy: false,
    moreError: '',
    announce: ''
  });
  const ticket = useRef(0);
  const itemsRef = useRef([]);
  const abortRef = useRef(null);

  const begin = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    abortRef.current = controller;
    ticket.current += 1;
    return { mine: ticket.current, signal: controller ? controller.signal : undefined };
  }, []);

  const load = useCallback(async () => {
    if (!enabled) return;
    const { mine, signal } = begin();
    setState((s) => ({ ...s, status: 'loading', error: '', moreError: '', announce: '' }));
    try {
      const res = await listDocuments({ ...listParams({ owner, q, limit }), signal });
      if (mine !== ticket.current) return;
      const page = Array.isArray(res && res.documents) ? res.documents : [];
      itemsRef.current = appendPage([], page);
      setState({
        status: 'ready',
        items: itemsRef.current,
        hasMore: hasMorePage(page, limit),
        error: '',
        moreBusy: false,
        moreError: '',
        announce: ''
      });
    } catch (err) {
      if (mine !== ticket.current || (err && err.name === 'AbortError')) return;
      itemsRef.current = [];
      setState({ status: 'error', items: [], hasMore: false, error: messageOf(err), moreBusy: false, moreError: '', announce: '' });
    }
  }, [begin, enabled, owner, q, limit]);

  const loadMore = useCallback(async () => {
    if (!enabled) return;
    const { mine, signal } = begin();
    setState((s) => ({ ...s, moreBusy: true, moreError: '', announce: '' }));
    try {
      const before = nextCursor(itemsRef.current);
      const res = await listDocuments({ ...listParams({ owner, q, before, limit }), signal });
      if (mine !== ticket.current) return;
      const page = Array.isArray(res && res.documents) ? res.documents : [];
      const countBefore = itemsRef.current.length;
      itemsRef.current = appendPage(itemsRef.current, page);
      const added = itemsRef.current.length - countBefore;
      setState((s) => ({
        ...s,
        items: itemsRef.current,
        hasMore: hasMorePage(page, limit) && added > 0,
        moreBusy: false,
        announce: added > 0 ? `${added} more ${added === 1 ? 'document' : 'documents'} loaded` : 'No more documents'
      }));
    } catch (err) {
      if (mine !== ticket.current || (err && err.name === 'AbortError')) return;
      setState((s) => ({ ...s, moreBusy: false, moreError: messageOf(err) }));
    }
  }, [begin, enabled, owner, q, limit]);

  useEffect(() => {
    load();
    return () => {
      ticket.current += 1;
      if (abortRef.current) abortRef.current.abort();
    };
  }, [load, reloadKey]);

  return { ...state, reload: load, loadMore };
}

// Returns value after it stopped changing for delay ms.
export function useDebounced(value, delay) {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setShown(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return shown;
}
