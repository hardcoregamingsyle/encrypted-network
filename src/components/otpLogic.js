// Pure rules of the code boxes. The code is a string of digits that fills from the left,
// so the boxes never have a gap. Every function returns the new value and where focus goes.

export const OTP_LENGTH = 6;

// Only the digits of a text (full width digits and other scripts are left out), at most max of them.
export function digitsOnly(text, max = OTP_LENGTH) {
  return String(text == null ? '' : text)
    .replace(/[^0-9]/g, '')
    .slice(0, max);
}

// Text typed or pasted into box index. One digit replaces the digit in that box and keeps the ones after it,
// so a typo in the middle is fixed without typing the rest again. Several digits (a paste, or an autofill into
// one box) fill that box and the following ones. Anything that is not a digit is ignored. An empty text means
// the box was emptied by an input event alone (some phone keyboards send no Backspace key): that digit goes.
export function otpInsert(value, index, text, length = OTP_LENGTH) {
  const current = digitsOnly(value, length);
  if (text === '') {
    if (index < current.length) return { value: current.slice(0, index) + current.slice(index + 1), focus: index };
    return { value: current, focus: Math.min(index, Math.min(current.length, length - 1)) };
  }
  const digits = digitsOnly(text, length);
  if (!digits) return { value: current, focus: Math.min(index, Math.min(current.length, length - 1)) };
  const at = Math.min(Math.max(0, index), current.length);
  const next = (current.slice(0, at) + digits + current.slice(at + digits.length)).slice(0, length);
  return { value: next, focus: Math.min(at + digits.length, length - 1) };
}

// A box changed to newText while it held oldDigit. The typed characters are what is new.
export function otpTyped(newText, oldDigit) {
  const text = digitsOnly(newText, 64);
  if (oldDigit && text.length > 1) {
    // typing over a filled box gives two characters: keep the one that was not there before
    if (text[0] === oldDigit) return text.slice(1);
    if (text.endsWith(oldDigit)) return text.slice(0, -1);
  }
  return text;
}

// Backspace in box index. A filled box loses its digit, an empty box takes the digit before it.
export function otpBackspace(value, index, length = OTP_LENGTH) {
  const current = digitsOnly(value, length);
  if (index < current.length) {
    return { value: current.slice(0, index) + current.slice(index + 1), focus: index };
  }
  if (current.length === 0) return { value: '', focus: 0 };
  const target = Math.min(index, current.length) - 1;
  return { value: current.slice(0, target) + current.slice(target + 1), focus: Math.max(0, target) };
}

// Delete key in box index: removes that digit and keeps focus there.
export function otpDelete(value, index, length = OTP_LENGTH) {
  const current = digitsOnly(value, length);
  if (index >= current.length) return { value: current, focus: index };
  return { value: current.slice(0, index) + current.slice(index + 1), focus: index };
}

// Which box gets focus after an arrow, Home or End key. Anything else returns the same index.
export function otpMove(key, index, length = OTP_LENGTH) {
  if (key === 'ArrowLeft') return Math.max(0, index - 1);
  if (key === 'ArrowRight') return Math.min(length - 1, index + 1);
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  return index;
}

export function otpComplete(value, length = OTP_LENGTH) {
  return digitsOnly(value, length).length === length;
}

// Text pasted into any box. A pasted code always fills the boxes from the first one, whichever box had focus,
// so a code pasted into box 3 is not split over the boxes (which would send a wrong code). One pasted digit
// is treated like typing it, so it goes into the box that has focus.
export function otpPaste(value, index, text, length = OTP_LENGTH) {
  const digits = digitsOnly(text, length);
  if (digits.length < 2) return otpInsert(value, index, text, length);
  return { value: digits, focus: Math.min(digits.length, length - 1) };
}
