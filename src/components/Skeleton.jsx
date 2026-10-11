// Grey placeholders that show where content will appear, so the page does not jump when it loads.
//   variant  'row' (avatar and two lines, for a list), 'text' (a line of text), 'block' (a box)
//   count    how many
//   label    what screen readers hear ("Loading chats"). One announcement for the whole group.
export default function Skeleton({ variant = 'row', count = 1, label = 'Loading', className = '' }) {
  const n = Math.max(1, Math.min(20, Math.floor(count) || 1));
  return (
    <div className={`ui-skeleton-group ${className}`.trim()} role="status" aria-busy="true">
      <span className="ui-sr-only">{label}</span>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className={`ui-skeleton ui-skeleton--${variant}`} aria-hidden="true">
          {variant === 'row' ? (
            <>
              <span className="ui-skeleton__dot" />
              <span className="ui-skeleton__lines">
                <span className="ui-skeleton__line ui-skeleton__line--wide" />
                <span className="ui-skeleton__line" />
              </span>
            </>
          ) : variant === 'text' ? (
            <span className="ui-skeleton__line ui-skeleton__line--wide" />
          ) : null}
        </div>
      ))}
    </div>
  );
}

export { Skeleton };
