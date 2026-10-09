// Spinning ring. Pass label={null} when it sits inside something that already says what is happening.
export default function Spinner({ label = 'Loading', size = 'md' }) {
  return (
    <span className={`ui-spinner ui-spinner--${size}`} role={label ? 'status' : undefined}>
      <span className="ui-spinner__ring" aria-hidden="true" />
      {label ? <span className="ui-sr-only">{label}</span> : null}
    </span>
  );
}

export { Spinner };
