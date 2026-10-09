import Spinner from './Spinner.jsx';

// Variants: primary, ghost, danger. Anything else is the plain secondary button.
// loading disables the button, shows a spinner and sets aria-busy.
export default function Button({
  variant = 'secondary',
  loading = false,
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
    loading ? 'is-loading' : '',
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
      aria-busy={loading ? 'true' : undefined}
    >
      {loading ? <Spinner label={null} size="sm" /> : null}
      <span className="ui-btn__label">{children}</span>
    </button>
  );
}

export { Button };
