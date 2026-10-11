// Small flat illustrations for empty screens. Decorative, so hidden from screen readers.
// Colours come from the art classes in components.css.
function Art({ name }) {
  switch (name) {
    case 'chats':
      return (
        <svg className="ui-art" viewBox="0 0 120 90" width="120" height="90" aria-hidden="true" focusable="false">
          <rect className="ui-art__soft" x="8" y="10" width="68" height="40" rx="12" />
          <path className="ui-art__soft" d="M22 50l-2 14 16-14z" />
          <rect className="ui-art__main" x="44" y="34" width="68" height="38" rx="12" />
          <path className="ui-art__main" d="M96 72l4 12-18-12z" />
          <rect className="ui-art__line" x="56" y="46" width="44" height="5" rx="2.5" />
          <rect className="ui-art__line" x="56" y="57" width="28" height="5" rx="2.5" />
        </svg>
      );
    case 'files':
      return (
        <svg className="ui-art" viewBox="0 0 120 90" width="120" height="90" aria-hidden="true" focusable="false">
          <rect className="ui-art__soft" x="22" y="14" width="52" height="64" rx="8" />
          <rect className="ui-art__main" x="42" y="8" width="52" height="64" rx="8" />
          <path className="ui-art__fold" d="M78 8l16 16H78z" />
          <rect className="ui-art__line" x="52" y="34" width="32" height="5" rx="2.5" />
          <rect className="ui-art__line" x="52" y="45" width="32" height="5" rx="2.5" />
          <rect className="ui-art__line" x="52" y="56" width="20" height="5" rx="2.5" />
          <circle className="ui-art__badge" cx="90" cy="68" r="14" />
          <path className="ui-art__tick" d="M83 68l5 5 9-10" />
        </svg>
      );
    case 'search':
      return (
        <svg className="ui-art" viewBox="0 0 120 90" width="120" height="90" aria-hidden="true" focusable="false">
          <circle className="ui-art__soft" cx="52" cy="42" r="28" />
          <circle className="ui-art__ring" cx="52" cy="42" r="20" />
          <path className="ui-art__handle" d="M67 57l22 22" />
          <rect className="ui-art__line" x="42" y="38" width="20" height="5" rx="2.5" />
        </svg>
      );
    case 'verify':
      return (
        <svg className="ui-art" viewBox="0 0 120 90" width="120" height="90" aria-hidden="true" focusable="false">
          <path className="ui-art__soft" d="M60 8l34 12v22c0 20-14 34-34 42-20-8-34-22-34-42V20z" />
          <path className="ui-art__main" d="M60 18l24 9v15c0 14-10 24-24 30-14-6-24-16-24-30V27z" />
          <path className="ui-art__tick" d="M49 46l8 8 15-17" />
        </svg>
      );
    default:
      return (
        <svg className="ui-art" viewBox="0 0 120 90" width="120" height="90" aria-hidden="true" focusable="false">
          <rect className="ui-art__soft" x="20" y="18" width="80" height="54" rx="12" />
          <rect className="ui-art__main" x="34" y="32" width="52" height="26" rx="8" />
          <circle className="ui-art__badge" cx="60" cy="45" r="6" />
        </svg>
      );
  }
}

// A friendly note for a screen with nothing on it.
//   title     what is missing ("No chats yet")
//   children  one or two plain sentences
//   art       'chats' | 'files' | 'search' | 'verify' | nothing for a neutral picture
//   action    a button or link to put under the text
export default function EmptyState({ title, children, art, action, className = '' }) {
  return (
    <div className={`ui-empty ${className}`.trim()}>
      {art ? <Art name={art} /> : null}
      <p className="ui-empty__title">{title}</p>
      {children ? <div className="ui-empty__text">{children}</div> : null}
      {action ? <div className="ui-empty__action">{action}</div> : null}
    </div>
  );
}

export { EmptyState };
