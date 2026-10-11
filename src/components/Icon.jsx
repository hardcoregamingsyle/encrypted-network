// Small inline icons. Decorative by default (hidden from screen readers).
// All icons are drawn on a 24 by 24 grid with a 2 unit stroke.
export const ICON_PATHS = {
  check: 'M5 12.5l4.5 4.5L19 7.5',
  'check-double': 'M2.5 13l4.5 4.5L15 9M11 15.5l2 2L21.5 9',
  x: 'M6 6l12 12M18 6L6 18',
  warn: 'M12 4l9 16H3L12 4zM12 10v4M12 17.5v.01',
  info: 'M12 11v6M12 7.5v.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  menu: 'M4 7h16M4 12h16M4 17h16',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z',
  key: 'M14 10a4 4 0 1 1-1.2-2.8L21 15v3h-3v-2h-2v-2h-2l-1.2-1.2',
  download: 'M12 4v11M7.5 11l4.5 4.5 4.5-4.5M5 20h14',
  upload: 'M12 16V5M7.5 9L12 4.5 16.5 9M5 20h14',
  plus: 'M12 5v14M5 12h14',
  chat: 'M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
  file: 'M7 3h7l5 5v13H7zM14 3v5h5',
  shield: 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z',
  'shield-check': 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3zM9 12l2 2 4-4',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 3.6-6 8-6s8 2 8 6',
  'arrow-left': 'M19 12H5M11 6l-6 6 6 6',
  'arrow-down': 'M12 5v14M6 13l6 6 6-6',
  'chevron-right': 'M9 6l6 6-6 6',
  send: 'M21 3L3 10.5l7 2.5 2.5 7L21 3zM10 13l11-10',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5',
  share: 'M12 15V4M8 8l4-4 4 4M5 13v6h14v-6',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  more: 'M12 5v.01M12 12v.01M12 19v.01',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  logout: 'M9 4H5v16h4M16 8l4 4-4 4M20 12H9',
  reply: 'M9 8L4 13l5 5M4 13h10a6 6 0 0 1 6 6',
  edit: 'M4 20h4L19 9l-4-4L4 16v4zM13 7l4 4',
  mail: 'M4 6h16v12H4zM4 7l8 6 8-6',
  device: 'M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2',
  bolt: 'M13 3L5 14h6l-1 7 8-11h-6l1-7z',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  refresh: 'M20 5v5h-5M4 19v-5h5M18.5 10A7 7 0 0 0 6 7.5L4 10M5.5 14A7 7 0 0 0 18 16.5l2-2.5',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M9 9.5v.01',
  table: 'M4 5h16v14H4zM4 10h16M4 15h16M10 5v14',
  archive: 'M4 5h16v4H4zM5 9v10h14V9M10 13h4',
  music: 'M9 18V6l10-2v12M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM19 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z',
  video: 'M4 6h11v12H4zM15 10l5-3v10l-5-3',
  text: 'M5 5h14M5 10h14M5 15h14M5 20h9'
};

export default function Icon({ name, size = 18, label }) {
  const d = ICON_PATHS[name] || ICON_PATHS.info;
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
