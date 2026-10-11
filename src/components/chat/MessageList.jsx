import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Button from '../Button.jsx';
import EmptyState from '../EmptyState.jsx';
import Icon from '../Icon.jsx';
import { MessageItem, PendingItem } from './MessageItem.jsx';
import { buildTimeline } from './roomLogic.js';

const NEAR_BOTTOM_PX = 48;

// The scrolling list of messages.
// Scroll rules: when the person is at the bottom the list follows new messages, otherwise the
// position stays and a round "scroll to bottom" button shows how many new messages arrived. Older
// messages added at the top keep the view where it was.
//   onBottomChange(atBottom)   told when the person reaches or leaves the bottom
//   firstUnread                position of the first message to mark as unread, 0 for none
//   onMenu(entry)              opens the message menu (the touch way to reply)
export default function MessageList({
  entries,
  pending = [],
  identities = {},
  ownKeyId = '',
  ownName = '',
  canReply = false,
  onReply,
  onMenu,
  onRetry,
  onDiscard,
  hasOlder = false,
  loadingOlder = false,
  olderError = '',
  onLoadOlder,
  onBottomChange,
  firstUnread = 0,
  now
}) {
  const scrollRef = useRef(null);
  const stick = useRef(true);
  const snap = useRef({ first: 0, last: 0, pending: 0, ready: false });
  const beforeOlder = useRef(0);
  const [unseen, setUnseen] = useState(0);
  const [away, setAway] = useState(false);
  const bottomCb = useRef(onBottomChange);
  bottomCb.current = onBottomChange;

  const byHash = useMemo(() => {
    const map = new Map();
    for (const e of entries) if (e.hash) map.set(e.hash, e);
    return map;
  }, [entries]);

  const rows = useMemo(() => buildTimeline(entries, { firstUnread, now: now || Date.now() }), [entries, firstUnread, now]);

  const nameOf = useCallback(
    (keyId) => {
      const id = identities[keyId];
      return id && typeof id.displayName === 'string' ? id.displayName : '';
    },
    [identities]
  );

  // Tell the room whether the newest message is on screen (it marks messages as seen then).
  useEffect(() => {
    if (bottomCb.current) bottomCb.current(!away);
  }, [away]);

  const toBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    stick.current = true;
    setUnseen(0);
    setAway(false);
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    setAway((was) => (was === !stick.current ? was : !stick.current));
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
        setAway(false);
      } else if (last > prev.last) {
        if (stick.current) {
          el.scrollTop = el.scrollHeight;
        } else {
          const added = entries.filter((e) => e.seq > prev.last && !(ownKeyId && e.record && e.record.signer === ownKeyId)).length;
          setUnseen((n) => n + added);
        }
      }
    }
    snap.current = { first, last, pending: pending.length, ready: entries.length > 0 || pending.length > 0 || prev.ready };
  }, [entries, pending.length, ownKeyId]);

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
  const newLabel = unseen > 0 ? `Scroll to the newest message, ${unseen} new` : 'Scroll to the newest message';

  return (
    <div className="chat-list">
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll} role="log" aria-label="Messages" aria-live={loadingOlder ? 'off' : 'polite'} aria-relevant="additions" tabIndex={0}>
        {hasOlder ? (
          <div className="chat-older">
            <Button size="sm" onClick={loadOlder} loading={loadingOlder}>
              Load older messages
            </Button>
            {olderError ? (
              <p className="chat-error" role="alert">
                {olderError}
              </p>
            ) : null}
          </div>
        ) : null}
        {empty ? (
          <EmptyState art="chats" title="No messages yet" className="chat-empty">
            Say hello. Everyone can read this chat, and your message is signed with your key.
          </EmptyState>
        ) : (
          <ol className="chat-msgs">
            {rows.map((row) => {
              if (row.kind === 'day') {
                return (
                  <li key={row.key} className="chat-day">
                    <span className="chat-day__label">{row.label}</span>
                  </li>
                );
              }
              if (row.kind === 'unread') {
                return (
                  <li key={row.key} className="chat-day chat-day--unread">
                    <span className="chat-day__label">{row.label}</span>
                  </li>
                );
              }
              const entry = row.entry;
              const rec = entry.record || {};
              const parent = rec.replyTo ? byHash.get(rec.replyTo) : undefined;
              return (
                <MessageItem
                  key={row.key}
                  entry={entry}
                  name={nameOf(rec.signer)}
                  parent={parent}
                  parentName={parent && parent.record ? nameOf(parent.record.signer) : ''}
                  own={Boolean(ownKeyId) && rec.signer === ownKeyId}
                  grouped={row.grouped}
                  endOfGroup={row.endOfGroup}
                  canReply={canReply}
                  onReply={onReply}
                  onMenu={onMenu}
                  onJump={jump}
                />
              );
            })}
            {pending
              .filter((item) => item.status !== 'failed')
              .map((item) => (
                <PendingItem key={item.id} item={item} name={ownName} keyId={ownKeyId} onRetry={onRetry} onDiscard={onDiscard} />
              ))}
            {/* Messages that could not be sent are kept together under their own label, not mixed in with newer
                messages that did go out, so none of them looks like it was sent in order. */}
            {pending.some((item) => item.status === 'failed') ? (
              <li className="chat-day chat-day--unsent">
                <span className="chat-day__label">Not sent. Try again or discard.</span>
              </li>
            ) : null}
            {pending
              .filter((item) => item.status === 'failed')
              .map((item) => (
                <PendingItem key={item.id} item={item} name={ownName} keyId={ownKeyId} onRetry={onRetry} onDiscard={onDiscard} />
              ))}
          </ol>
        )}
      </div>
      {away ? (
        <button type="button" className="chat-newbtn" onClick={toBottom} aria-label={newLabel}>
          <Icon name="arrow-down" size={20} />
          {unseen > 0 ? (
            <span className="chat-newbtn__count" aria-hidden="true">
              {unseen > 99 ? '99+' : unseen}
            </span>
          ) : null}
        </button>
      ) : null}
    </div>
  );
}
