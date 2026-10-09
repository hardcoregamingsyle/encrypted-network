import { useEffect, useRef } from 'react';

// Focus helpers. When the control a person just pressed is removed from the page, the browser drops
// focus to the top of the document. These put it somewhere sensible instead.

// True when focus has fallen to the page itself (nothing useful has it).
export function focusIsLost() {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement;
  return !active || active === document.body || active === document.documentElement;
}

// Gives focus to el (made focusable if it is not) when focus was lost. Returns true when it moved.
// A person who has already moved on to something else keeps their place.
export function focusIfLost(el) {
  if (!el || typeof el.focus !== 'function' || !focusIsLost()) return false;
  if (!el.hasAttribute('tabindex') && !/^(a|button|input|select|textarea)$/i.test(el.tagName)) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
  return true;
}

// The heading of what is shown now: the first h1 (or h2) inside root, or main.
export function focusHeading(root) {
  if (typeof document === 'undefined') return false;
  const scope = root || document.getElementById('main') || document;
  const heading = scope.querySelector('h1') || scope.querySelector('h2');
  return focusIfLost(heading);
}

// For a control that swaps between a button and a form (open/close). When open turns true, focus
// goes to the element in openRef. When it turns false again, focus goes back to closedRef, the button
// that opened it. The first render does nothing.
export function useToggleFocus(open, openRef, closedRef) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const target = open ? openRef.current : closedRef.current;
    if (target && typeof target.focus === 'function') target.focus();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
}
