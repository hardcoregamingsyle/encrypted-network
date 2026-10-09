import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Button from '../Button.jsx';
import EmptyState from '../EmptyState.jsx';
import { MessageItem, PendingItem } from './MessageItem.jsx';

const NEAR_BOTTOM_PX = 48;

// The scrolling list of messages.
// Scroll rules: when the person is at the bottom the list follows new messages, otherwise the
// position stays and a "new messages" button appears. Older messages added at the top keep the
// view where it was.
export default function MessageList({
  entries,
  pending = [],
  identities = {},
  ownKeyId = '',
  ownName = '',
  canReply = false,
  onReply,
  onRetry,
  onDiscard,
  hasOlder = false,
  loadingOlder = false,
  olderError = '',
  onLoadOlder
}) {
  const scrollRef = useRef(null);
  const stick = useRef(true);
  const snap = useRef({ first: 0, last: 0, pending: 0, ready: false });
  const beforeOlder = useRef(0);
  const [unseen, setUnseen] = useState(0);

  const byHash = useMemo(() => {
    const map = new Map();
    for (const e of entries) if (e.hash) map.set(e.hash, e);
    return map;
  }, [entries]);

  const nameOf = useCallback(
    (keyId) => {
      const id = identities[keyId];
      return id && typeof id.displayName === 'string' ? id.displayName : '';
    },
    [identities]
  );

  const toBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    stick.current = true;
    setUnseen(0);
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    if (stick.current) setUnseen((n) => (n === 0 ? n : 0));
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const first = entries.length ? entries[0].seq : 0;
    const last = entries.length ? entries[entries.length - 1].seq : 0;
    const prev = snap.current;
    if (!prev.ready) {
      el.scrollTop = el.scrollHeight;
      stick.current = true;
    } else {
      if (first && prev.first && first < prev.first) {
        // older messages were added above: keep what the person was looking at
        const base = beforeOlder.current || 0;
        if (base) el.scrollTop += el.scrollHeight - base;
        beforeOlder.current = 0;
      }
      if (pending.length > prev.pending) {
        el.scrollTop = el.scrollHeight;
        stick.current = true;
        setUnseen(0);
      } else if (last > prev.last) {
        if (stick.current) {
          el.scrollTop = el.scrollHeight;
        } else {
          const added = entries.filter((e) => e.seq > prev.last).length;
          setUnseen((n) => n + added);
        }
      }
    }
    snap.current = { first, last, pending: pending.length, ready: entries.length > 0 || pending.length > 0 || prev.ready };
  }, [entries, pending.length]);

  const jump = useCallback((seq) => {
    const el = document.getElementById(`chat-msg-${seq}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.focus({ preventScroll: true });
  }, []);

  const loadOlder = useCallback(() => {
    const el = scrollRef.current;
    beforeOlder.current = el ? el.scrollHeight : 0;
    if (onLoadOlder) onLoadOlder();
  }, [onLoadOlder]);

  const empty = entries.length === 0 && pending.length === 0;

  return (
    <div className="chat-list">
      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-label="Messages"
        aria-relevant="additions"
        tabIndex={0}
      >
        {hasOlder ? (
          <div className="chat-older">
            <Button size="sm" onClick={loadOlder} loading={loadingOlder}>
              Load older messages
            </Button>
            <p className="ui-muted">Only the latest messages are shown. Older ones are not loaded.</p>
            {olderError ? (
              <p className="chat-error" role="alert">
                {olderError}
              </p>
            ) : null}
          </div>
        ) : null}
        {empty ? (
          <EmptyState title="No messages yet">Be the first to write in this channel.</EmptyState>
        ) : (
          <ol className="chat-msgs">
            {entries.map((entry) => {
              const rec = entry.record || {};
              const parent = rec.replyTo ? byHash.get(rec.replyTo) : undefined;
              return (
                <MessageItem
                  key={entry.seq}
                  entry={entry}
                  name={nameOf(rec.signer)}
                  parent={parent}
                  parentName={parent && parent.record ? nameOf(parent.record.signer) : ''}
                  own={Boolean(ownKeyId) && rec.signer === ownKeyId}
                  canReply={canReply}
                  onReply={onReply}
                  onJump={jump}
                />
              );
            })}
            {pending.map((item) => (
              <PendingItem key={item.id} item={item} name={ownName} keyId={ownKeyId} onRetry={onRetry} onDiscard={onDiscard} />
            ))}
          </ol>
        )}
      </div>
      {unseen > 0 ? (
        <button type="button" className="chat-newbtn" onClick={toBottom}>
          {unseen === 1 ? '1 new message' : `${unseen} new messages`}
        </button>
      ) : null}
    </div>
  );
}
