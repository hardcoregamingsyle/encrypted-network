// Small inline icons. Decorative by default (hidden from screen readers).
const PATHS = {
  check: 'M5 12.5l4.5 4.5L19 7.5',
  x: 'M6 6l12 12M18 6L6 18',
  warn: 'M12 4l9 16H3L12 4zM12 10v4M12 17.5v.01',
  info: 'M12 11v6M12 7.5v.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  menu: 'M4 7h16M4 12h16M4 17h16',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z',
  key: 'M14 10a4 4 0 1 1-1.2-2.8L21 15v3h-3v-2h-2v-2h-2l-1.2-1.2',
  download: 'M12 4v11M7.5 11l4.5 4.5 4.5-4.5M5 20h14'
};

export default function Icon({ name, size = 18, label }) {
  const d = PATHS[name] || PATHS.info;
  const labelled = typeof label === 'string' && label !== '';
  return (
    <svg
      className="ui-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={labelled ? 'img' : undefined}
      aria-label={labelled ? label : undefined}
      aria-hidden={labelled ? undefined : 'true'}
      focusable="false"
    >
      <path d={d} />
    </svg>
  );
}

export { Icon };
