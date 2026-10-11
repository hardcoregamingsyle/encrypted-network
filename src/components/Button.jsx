import Spinner from './Spinner.jsx';

// Variants: primary, ghost, danger. Anything else is the plain secondary button.
// loading disables the button, shows a spinner and sets aria-busy.
// pending is for a press that is being handled right now (a download, a share): the same look, but the button
// stays focusable, so a keyboard user keeps their place. The caller ignores presses while it is pending.
export default function Button({
  variant = 'secondary',
  loading = false,
  pending = false,
  disabled = false,
  type = 'button',
  size = 'md',
  className = '',
  children,
  ...rest
}) {
  const classes = [
    'ui-btn',
    `ui-btn--${variant}`,
    size === 'sm' ? 'ui-btn--sm' : '',
    loading || pending ? 'is-loading' : '',
    pending ? 'is-pending' : '',
    className
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      {...rest}
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || pending ? 'true' : undefined}
      aria-disabled={pending && !loading ? 'true' : undefined}
    >
      {loading || pending ? <Spinner label={null} size="sm" /> : null}
      <span className="ui-btn__label">{children}</span>
    </button>
  );
}

export { Button };
