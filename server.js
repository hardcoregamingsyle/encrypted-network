// server.js
// Tiny storage server. It only ever sees locked files, the password
// and the real file never leave the browser.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const CLOUD = process.env.CLOUD_DIR || path.join(__dirname, 'cloud');
const PUBLIC = path.join(__dirname, 'public');
const MAX_UPLOAD = 50 * 1024 * 1024;
const MAGIC = Buffer.from('HRDLOCK1');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon'
};

fs.mkdirSync(CLOUD, { recursive: true });

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'"
  }, headers));
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json' });
}

// turn whatever name the browser sent into something safe to save
function safeName(name) {
  let n = String(name).replace(/\\/g, '/');
  n = n.substring(n.lastIndexOf('/') + 1);
  n = n.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (n.length > 150) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 && n.length - dot <= 12 ? n.substring(dot) : '';
    n = n.substring(0, 150 - ext.length) + ext;
  }
  if (!n || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) n = '_' + n;
  return n;
}

// userfile.txt becomes userfile.txt.hrdlock, add a number if it is taken
function saveLocked(name, body) {
  const base = safeName(name);
  for (let i = 0; i < 1000; i++) {
    const stored = (i === 0 ? base : base + ' (' + i + ')') + '.hrdlock';
    try {
      fs.writeFileSync(path.join(CLOUD, stored), body, { flag: 'wx' });
      return stored;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error('too many files with that name');
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { tooBig = true; return; }
      chunks.push(c);
    });
    req.on('end', () => (tooBig ? reject(new Error('too big')) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

function listFiles() {
  return fs.readdirSync(CLOUD)
    .filter((f) => f.endsWith('.hrdlock'))
    .map((f) => {
      const st = fs.statSync(path.join(CLOUD, f));
      return { name: f, size: st.size, uploaded: st.mtime.toISOString() };
    })
    .sort((a, b) => (a.uploaded < b.uploaded ? 1 : -1));
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/files' && req.method === 'GET') {
    return sendJson(res, 200, listFiles());
  }

  if (url.pathname === '/api/files' && req.method === 'POST') {
    if (Number(req.headers['content-length']) > MAX_UPLOAD) {
      res.setHeader('Connection', 'close');
      return sendJson(res, 413, { error: 'file is too big, the limit is 50 MB' });
    }
    let body;
    try {
      body = await readBody(req, MAX_UPLOAD);
    } catch (e) {
      return sendJson(res, 413, { error: 'file is too big, the limit is 50 MB' });
    }
    if (body.length < MAGIC.length || !body.subarray(0, MAGIC.length).equals(MAGIC)) {
      return sendJson(res, 400, { error: 'that is not a locked file' });
    }
    let original = 'file';
    try { original = decodeURIComponent(req.headers['x-file-name'] || 'file'); } catch (e) {}
    return sendJson(res, 201, { name: saveLocked(original, body) });
  }

  if (url.pathname.startsWith('/api/files/') && req.method === 'GET') {
    let name;
    try { name = decodeURIComponent(url.pathname.substring('/api/files/'.length)); }
    catch (e) { return sendJson(res, 400, { error: 'bad name' }); }
    if (name !== path.basename(name) || !name.endsWith('.hrdlock')) {
      return sendJson(res, 400, { error: 'bad name' });
    }
    const full = path.join(CLOUD, name);
    if (!fs.existsSync(full)) return sendJson(res, 404, { error: 'file not found' });
    return send(res, 200, fs.readFileSync(full), { 'Content-Type': 'application/octet-stream' });
  }

  return sendJson(res, 404, { error: 'not found' });
}

function handleStatic(req, res, url) {
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  let full;
  try { full = path.join(PUBLIC, decodeURIComponent(p)); }
  catch (e) { return send(res, 400, 'bad request'); }
  if (!full.startsWith(PUBLIC + path.sep) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    return send(res, 404, 'not found');
  }
  send(res, 200, fs.readFileSync(full), {
    'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream'
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else if (req.method === 'GET') handleStatic(req, res, url);
    else send(res, 405, 'method not allowed');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: 'server error' });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => console.log('hrdlock running at http://' + HOST + ':' + PORT));
}

module.exports = server;
