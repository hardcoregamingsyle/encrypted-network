import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { focusHeading } from '../lib/focus.js';
import Icon from './Icon.jsx';
import { FOCUSABLE_SELECTOR, createScrollLock, pickReturnTarget, sheetKeyAction } from './sheetLogic.js';

// The sheets that are open, the last one is on top. Only the top one reacts to the keyboard.
const openStack = [];

let lock = null;
function scrollLock() {
  if (!lock && typeof document !== 'undefined') lock = createScrollLock(document);
  return lock;
}

// A control inside a closed <details> cannot be reached with Tab (only its summary can), so it is not a stop.
function reachable(el) {
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return false;
  const closed = el.closest('details:not([open])');
  return !(closed && !(el.tagName === 'SUMMARY' && el.parentElement === closed));
}

function focusables(root) {
  if (!root) return [];
  return Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR)).filter(reachable);
}

// The page behind an open sheet is made inert, so a screen reader or a swipe cannot reach it either
// (aria-modal alone is not honoured everywhere). The toast area sits outside the app frame and stays live.
let inertHolders = 0;
function setBehindInert(on) {
  if (typeof document === 'undefined') return;
  const app = document.querySelector('.ui-shell');
  if (!app) return;
  if (on) {
    inertHolders += 1;
    app.setAttribute('inert', '');
  } else {
    inertHolders = Math.max(0, inertHolders - 1);
    if (inertHolders === 0) app.removeAttribute('inert');
  }
}

let historyCounter = 0;

// A dialog that slides up from the bottom on a phone and sits in the middle on a wide screen.
//   open        whether it is shown
//   onClose     called for Escape, the close button and a tap on the dim area
//   title       the heading (also the dialog's name)
//   footer      buttons pinned at the bottom
//   dismissible false for a step that must be finished (no Escape, no tap outside, no close button)
//   initialFocus  a ref of the control that should get focus first. Otherwise the control marked
//                 data-autofocus, otherwise the first control (the close button comes last).
// Keyboard: Tab stays inside, Escape closes, focus returns to the control that opened it, and the page
// behind does not scroll.
export default function Sheet({ open, onClose, title, children, footer, dismissible = true, initialFocus, className = '', description }) {
  const titleId = useId();
  const descId = useId();
  const panelRef = useRef(null);
  const openerRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dismissibleRef = useRef(dismissible);
  dismissibleRef.current = dismissible;

  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    const token = { panel: panelRef };
    openStack.push(token);
    openerRef.current = document.activeElement;
    // Nothing has focus when a sheet opens over another one because the control that was pressed is disabled while it
    // waits (a button that is "loading"). Focus then goes back to the sheet below when this one closes.
    const below = openStack[openStack.length - 2];
    const idle = !openerRef.current || openerRef.current === document.body || openerRef.current === document.documentElement;
    if (idle && below && below.panel.current) openerRef.current = below.panel.current;
    const locker = scrollLock();
    locker.lock();
    setBehindInert(true);

    // The phone Back button closes the sheet instead of leaving the page. A sheet that must be finished
    // (not dismissible) adds no entry. The entry copies the router's own state, so the router sees no move.
    const mark = 'sheet' + ++historyCounter;
    let pushed = false;
    if (dismissibleRef.current) {
      try {
        window.history.pushState({ ...(window.history.state || {}), hrdSheet: mark }, '');
        pushed = true;
      } catch {
        pushed = false;
      }
    }
    function onPopState() {
      if (!pushed) return;
      if (!dismissibleRef.current) {
        // Back during a step that must be finished (a publish that is running): the sheet stays, and the entry is put back.
        try {
          window.history.pushState({ ...(window.history.state || {}), hrdSheet: mark }, '');
        } catch {
          pushed = false;
        }
        return;
      }
      pushed = false;
      if (openStack[openStack.length - 1] === token && onCloseRef.current) onCloseRef.current();
    }
    window.addEventListener('popstate', onPopState);
    const panel = panelRef.current;
    const start = initialFocus && initialFocus.current ? initialFocus.current : null;
    const marked = panel ? panel.querySelector('[data-autofocus]') : null;
    const first = start || marked || focusables(panel).find((el) => !el.hasAttribute('data-sheet-close')) || focusables(panel)[0] || panel;
    if (first && typeof first.focus === 'function') first.focus({ preventScroll: true });

    // Keys are read on the whole page, so Escape and Tab still work after a tap on the dim area
    // took focus out of the panel.
    function onKeyDown(event) {
      if (openStack[openStack.length - 1] !== token) return;
      const list = focusables(panelRef.current);
      const index = list.indexOf(document.activeElement);
      const step = sheetKeyAction(event, { count: list.length, index, dismissible: dismissibleRef.current });
      if (step.action === 'close') {
        event.preventDefault();
        event.stopPropagation();
        if (onCloseRef.current) onCloseRef.current();
      } else if (step.action === 'focus') {
        event.preventDefault();
        const target = step.index >= 0 ? list[step.index] : panelRef.current;
        if (target) target.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('popstate', onPopState);
      const at = openStack.indexOf(token);
      if (at >= 0) openStack.splice(at, 1);
      locker.unlock();
      setBehindInert(false);
      // Closed with Escape, the close button or a tap outside: take our history entry away again. If the
      // page has moved on to another entry since (a link was followed), leave the history alone.
      // It waits a tick, so a sheet that closes and opens again at once (a development re-run) is left alone.
      if (pushed) {
        setTimeout(() => {
          try {
            if (openStack.length === 0 && window.history.state && window.history.state.hrdSheet === mark) window.history.back();
          } catch {
            // nothing to undo
          }
        }, 0);
      }
      const target = pickReturnTarget(openerRef.current, document);
      if (target) target.focus({ preventScroll: true });
      else focusHeading();
      // The control that opened this sheet can be disabled right now (it is waiting for the answer that opened
      // this sheet), and then it takes no focus. Focus goes to the dialog it sits in, or to the page heading.
      if (target && document.activeElement !== target) {
        const outer = typeof target.closest === 'function' ? target.closest('[role="dialog"]') : null;
        if (outer && typeof outer.focus === 'function') outer.focus({ preventScroll: true });
        else focusHeading();
      }
    };
    // initialFocus is read once, when the sheet opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const node = (
    <div className="ui-sheet-root">
      <div
        className="ui-sheet-scrim"
        onClick={dismissible ? () => onCloseRef.current && onCloseRef.current() : undefined}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        className={`ui-sheet ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
      >
        <div className="ui-sheet__grip" aria-hidden="true" />
        <div className="ui-sheet__head">
          <h2 className="ui-sheet__title" id={titleId}>
            {title}
          </h2>
          {dismissible ? (
            <button type="button" className="ui-sheet__close" data-sheet-close="true" onClick={() => onCloseRef.current && onCloseRef.current()}>
              <Icon name="x" size={20} />
              <span className="ui-sr-only">Close</span>
            </button>
          ) : null}
        </div>
        {description ? (
          <p className="ui-sheet__desc" id={descId}>
            {description}
          </p>
        ) : null}
        <div className="ui-sheet__body">{children}</div>
        {footer ? <div className="ui-sheet__foot">{footer}</div> : null}
      </div>
    </div>
  );

  // The server renderer (tests) has no document and cannot render a portal: show it in place.
  if (typeof document === 'undefined') return node;
  return createPortal(node, document.body);
}

export { Sheet };
