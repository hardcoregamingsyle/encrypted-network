import { Children, cloneElement, isValidElement, useId } from 'react';

// Label, hint and error around one form control.
// children can be one element (it gets id, aria-describedby and aria-invalid)
// or a function that receives those props.
export default function Field({ label, hint, error, children, className = '' }) {
  const autoId = useId();
  const only = Children.count(children) === 1 ? Children.toArray(children)[0] : null;
  const id = (isValidElement(only) && only.props.id) || `field-${autoId}`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  const props = { id, 'aria-describedby': describedBy, 'aria-invalid': error ? 'true' : undefined };

  let control = children;
  if (typeof children === 'function') {
    control = children(props);
  } else if (isValidElement(only)) {
    const existing = only.props['aria-describedby'];
    control = cloneElement(only, {
      ...props,
      'aria-describedby': [existing, describedBy].filter(Boolean).join(' ') || undefined
    });
  }

  return (
    <div className={`ui-field ${error ? 'has-error' : ''} ${className}`.trim()}>
      <label className="ui-field__label" htmlFor={id}>
        {label}
      </label>
      {hint ? (
        <p className="ui-field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {control}
      {error ? (
        <p className="ui-field__error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export { Field };
