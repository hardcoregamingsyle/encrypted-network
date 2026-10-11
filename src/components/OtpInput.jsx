import { useEffect, useId, useRef } from 'react';
import { OTP_LENGTH, digitsOnly, otpBackspace, otpComplete, otpDelete, otpInsert, otpMove, otpPaste, otpTyped } from './otpLogic.js';

// Six boxes for the code from the email.
//   value       the digits typed so far (a string)
//   onChange    called with the new digits
//   onComplete  called once when all digits are in, and again when Enter is pressed with all digits in
//   error       a plain sentence, announced to screen readers as soon as it appears
// The first box has autocomplete="one-time-code", so a phone can offer the code from the email or
// message. A whole code that arrives in one box (autofill or paste) is spread over the boxes.
export default function OtpInput({ value = '', onChange, onComplete, length = OTP_LENGTH, disabled = false, error = '', label = 'Code', autoFocus = false, describedBy }) {
  const baseId = useId();
  const refs = useRef([]);
  const digits = digitsOnly(value, length);
  const lastCompleted = useRef('');

  useEffect(() => {
    if (autoFocus && refs.current[0]) refs.current[0].focus();
  }, [autoFocus]);

  // When the code is no longer complete (the page emptied the boxes after a wrong code, or a digit was
  // removed) the same code may be reported again, for example when it is pasted once more after a lost connection.
  useEffect(() => {
    if (digits.length < length) lastCompleted.current = '';
  }, [digits, length]);

  // After a wrong code the boxes are empty again: put the cursor back in the first one.
  useEffect(() => {
    if (error && refs.current[0] && !disabled) refs.current[0].focus();
  }, [error, disabled]);

  function focusBox(index) {
    const el = refs.current[Math.max(0, Math.min(length - 1, index))];
    if (el) {
      el.focus();
      if (typeof el.select === 'function') el.select();
    }
  }

  function apply(result) {
    if (result.value !== digits && onChange) onChange(result.value);
    if (otpComplete(result.value, length)) {
      if (onComplete && lastCompleted.current !== result.value) {
        lastCompleted.current = result.value;
        onComplete(result.value);
      }
    } else {
      lastCompleted.current = '';
    }
    focusBox(result.focus);
  }

  function onInput(index, event) {
    const raw = event.target.value;
    // A box emptied with no Backspace key event (many phone keyboards) removes that digit.
    if (raw === '') {
      apply(otpInsert(digits, index, '', length));
      return;
    }
    const typed = otpTyped(raw, digits[index] || '');
    if (typed) apply(otpInsert(digits, index, typed, length));
  }

  function onKeyDown(index, event) {
    const key = event.key;
    if (key === 'Enter') {
      // A full code that is already in (filled in for the person, or pasted) is sent with Enter.
      if (otpComplete(digits, length) && onComplete && !disabled) {
        event.preventDefault();
        lastCompleted.current = digits;
        onComplete(digits);
      }
    } else if (key === 'Backspace') {
      event.preventDefault();
      apply(otpBackspace(digits, index, length));
    } else if (key === 'Delete') {
      event.preventDefault();
      apply(otpDelete(digits, index, length));
    } else if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Home' || key === 'End') {
      event.preventDefault();
      focusBox(otpMove(key, index, length));
    }
  }

  function onPaste(index, event) {
    const text = event.clipboardData ? event.clipboardData.getData('text') : '';
    event.preventDefault();
    if (text) apply(otpPaste(digits, index, text, length));
  }

  const errorId = `${baseId}-error`;
  const labelId = `${baseId}-label`;
  return (
    <div className={`ui-otp ${error ? 'has-error' : ''}`.trim()}>
      <p className="ui-otp__label" id={labelId}>
        {label}
      </p>
      <div className="ui-otp__boxes" role="group" aria-labelledby={labelId} aria-describedby={[describedBy, error ? errorId : ''].filter(Boolean).join(' ') || undefined}>
        {Array.from({ length }, (_, i) => (
          <input
            key={i}
            ref={(el) => {
              refs.current[i] = el;
            }}
            className="ui-otp__box"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete={i === 0 ? 'one-time-code' : 'off'}
            autoCorrect="off"
            spellCheck="false"
            aria-label={`Digit ${i + 1} of ${length}`}
            aria-invalid={error ? 'true' : undefined}
            value={digits[i] || ''}
            disabled={disabled}
            onChange={(e) => onInput(i, e)}
            onKeyDown={(e) => onKeyDown(i, e)}
            onPaste={(e) => onPaste(i, e)}
            onFocus={(e) => e.target.select()}
          />
        ))}
      </div>
      <p className="ui-otp__error" id={errorId} role="alert">
        {error}
      </p>
    </div>
  );
}

export { OtpInput };
