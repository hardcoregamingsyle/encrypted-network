export default function EmptyState({ title, children }) {
  return (
    <div className="ui-empty">
      <p className="ui-empty__title">{title}</p>
      {children ? <div className="ui-empty__text">{children}</div> : null}
    </div>
  );
}

export { EmptyState };
