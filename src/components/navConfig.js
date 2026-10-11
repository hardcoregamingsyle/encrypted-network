// The main places of the app, used by the side navigation and the bottom tabs.

export const NAV_ITEMS = Object.freeze([
  { id: 'chats', to: '/chats', label: 'Chats', icon: 'chat' },
  { id: 'files', to: '/files', label: 'Files', icon: 'file' },
  { id: 'verify', to: '/verify', label: 'Verify', icon: 'shield-check' },
  { id: 'me', to: '/me', label: 'Me', icon: 'user' }
]);

// Which tab a path belongs to, or '' for pages outside the tabs (welcome, sign in, not found).
export function activeTab(pathname) {
  const p = typeof pathname === 'string' ? pathname : '';
  if (p === '/chats' || p.startsWith('/chats/') || p === '/chat' || p.startsWith('/chat/')) return 'chats';
  if (p === '/files' || p.startsWith('/files/') || p.startsWith('/d/')) return 'files';
  if (p === '/verify' || p.startsWith('/verify/')) return 'verify';
  if (p === '/me' || p.startsWith('/me/') || p === '/about') return 'me';
  return '';
}

// How much chrome a path gets:
//   'bare'  welcome and sign in: no navigation at all
//   'room'  one chat: the bottom tabs go away on a phone, the side navigation stays on a wide screen
//   'full'  everything else
export function chromeFor(pathname) {
  const p = typeof pathname === 'string' ? pathname : '';
  if (p === '/welcome' || p === '/signin') return 'bare';
  if (/^\/chats\/[^/]+/.test(p)) return 'room';
  return 'full';
}
