// Stops a build early, with a clear message, on a Node version the tools need more than.
// Vite 8 needs Node 20.19 or newer 20.x, or 22.12 and up. Wrangler 4 needs 22 or newer.
// On Cloudflare Pages the Node version comes from the .node-version file (or NODE_VERSION).
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function nodeVersionOk(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version));
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  if (major === 20) return minor >= 19;
  if (major === 21) return false;
  return major === 22 ? minor >= 12 : major > 22;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!nodeVersionOk(process.versions.node)) {
    console.error(
      `This build needs Node 20.19 or newer 20.x, or 22.12 and up. This is Node ${process.versions.node}.\n` +
        'On Cloudflare Pages set NODE_VERSION=22 in the project settings, or keep the .node-version file.'
    );
    process.exit(1);
  }
}
