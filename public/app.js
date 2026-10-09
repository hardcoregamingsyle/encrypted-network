const MAX_SIZE = 50 * 1024 * 1024;
const TOKEN_KEY = 'hrdlock-tokens';

const $ = (id) => document.getElementById(id);
const pick = $('pick');
const drop = $('drop');
const chosen = $('chosen');
const lockBtn = $('lockBtn');
const lockStatus = $('lockStatus');
const result = $('result');
const pwBox = $('pw');
const copyBtn = $('copyBtn');
const saveBtn = $('saveBtn');
const storedAs = $('storedAs');
const listStatus = $('listStatus');
const fileList = $('files');
const countPill = $('count');
const search = $('search');

let allFiles = [];

// ---------- small helpers ----------

function say(el, text, kind) {
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

function prettySize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return new Date(iso).toLocaleDateString();
}

function saveToDisk(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes]));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// the delete tokens stay in this browser only
function getTokens() {
  try { return JSON.parse(localStorage.getItem(TOKEN_KEY) || '{}'); } catch (e) { return {}; }
}
function setToken(name, token) {
  try {
    const t = getTokens();
    t[name] = token;
    localStorage.setItem(TOKEN_KEY, JSON.stringify(t));
  } catch (e) {}
}
function dropToken(name) {
  try {
    const t = getTokens();
    delete t[name];
    localStorage.setItem(TOKEN_KEY, JSON.stringify(t));
  } catch (e) {}
}

// ---------- the worker (locks and unlocks in the background) ----------

let worker = null;
const pending = new Map();
let nextId = 1;

try {
  worker = new Worker('worker.js');
  worker.onmessage = (e) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.ok) p.resolve(e.data);
    else p.reject(new Error(e.data.error));
  };
  worker.onerror = () => {
    pending.forEach((p) => p.reject(new Error('the background worker crashed')));
    pending.clear();
    worker = null;
  };
} catch (e) {
  worker = null;
}

async function runJob(job) {
  if (!worker) {
    // no worker available, do it on the page instead
    if (job.op === 'lock') return { data: await HRD.lock(job.data, job.name, job.password) };
    return HRD.unlock(job.data, job.password);
  }
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage(Object.assign({ id }, job), [job.data.buffer]);
  });
}

if (!window.isSecureContext || !window.crypto || !crypto.subtle) {
  $('warn').hidden = false;
  lockBtn.disabled = true;
}

// ---------- picking a file ----------

function showChosen() {
  const f = pick.files[0];
  chosen.textContent = f ? f.name + ' (' + prettySize(f.size) + ')' : '';
}

pick.addEventListener('change', showChosen);

['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
  e.preventDefault();
  drop.classList.add('over');
}));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
  e.preventDefault();
  drop.classList.remove('over');
}));
drop.addEventListener('drop', (e) => {
  if (e.dataTransfer.files.length) {
    pick.files = e.dataTransfer.files;
    showChosen();
  }
});

// ---------- locking ----------

lockBtn.addEventListener('click', async () => {
  const file = pick.files[0];
  result.hidden = true;
  if (!file) return say(lockStatus, 'Pick a file first.', 'bad');
  if (file.size > MAX_SIZE) return say(lockStatus, 'That file is over 50 MB.', 'bad');

  lockBtn.disabled = true;
  try {
    say(lockStatus, 'Locking...');
    const data = new Uint8Array(await file.arrayBuffer());
    const password = HRD.generatePassword();
    const locked = (await runJob({ op: 'lock', data, name: file.name, password })).data;

    say(lockStatus, 'Uploading...');
    const res = await fetch('/api/files', {
      method: 'POST',
      headers: { 'x-file-name': encodeURIComponent(file.name) },
      body: locked
    });
    const info = await res.json();
    if (!res.ok) throw new Error(info.error || 'upload failed');
    setToken(info.name, info.token);

    pwBox.textContent = password;
    storedAs.textContent = 'Saved as ' + info.name;
    result.dataset.file = info.name;
    result.hidden = false;
    say(lockStatus, 'Done.', 'good');
    pick.value = '';
    showChosen();
    loadList();
  } catch (e) {
    say(lockStatus, e.message, 'bad');
  }
  lockBtn.disabled = false;
});

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(pwBox.textContent);
    copyBtn.textContent = 'Copied';
  } catch (e) {
    copyBtn.textContent = 'Select it by hand';
  }
  setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
});

saveBtn.addEventListener('click', () => {
  const text = 'hrdlock password\r\nfile: ' + result.dataset.file + '\r\npassword: ' + pwBox.textContent + '\r\n';
  saveToDisk(new TextEncoder().encode(text), result.dataset.file + '.password.txt');
});

// ---------- the list ----------

async function loadList() {
  try {
    const res = await fetch('/api/files');
    allFiles = await res.json();
    drawList();
  } catch (e) {
    say(listStatus, 'Could not load the list.', 'bad');
  }
}

function drawList() {
  const q = search.value.trim().toLowerCase();
  const shown = allFiles.filter((f) => f.name.toLowerCase().includes(q));
  countPill.textContent = allFiles.length;
  fileList.textContent = '';
  if (!allFiles.length) say(listStatus, 'Nothing stored yet.');
  else if (!shown.length) say(listStatus, 'No file matches that.');
  else say(listStatus, '');
  shown.forEach((f) => fileList.appendChild(makeRow(f)));
}

search.addEventListener('input', drawList);

function hueFor(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 360;
  return h;
}

function makeRow(f) {
  const base = f.name.slice(0, -'.hrdlock'.length);
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1, dot + 5).toUpperCase() : 'FILE';

  const li = document.createElement('li');
  li.className = 'file';

  const badge = document.createElement('div');
  badge.className = 'badge';
  badge.textContent = ext;
  badge.style.setProperty('--h', hueFor(ext));

  const info = document.createElement('div');
  info.className = 'info';
  const fname = document.createElement('div');
  fname.className = 'fname';
  fname.append(base);
  const suffix = document.createElement('span');
  suffix.className = 'suffix';
  suffix.textContent = '.hrdlock';
  fname.append(suffix);
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = prettySize(f.size) + ', ' + ago(f.uploaded);
  info.append(fname, meta);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const openBtn = button('Unlock', 'btn tiny primary');
  const rawBtn = button('Locked copy', 'btn tiny ghost');
  actions.append(openBtn, rawBtn);
  const owned = !!getTokens()[f.name];
  let delBtn = null;
  if (owned) {
    delBtn = button('Delete', 'btn tiny danger');
    actions.append(delBtn);
  }

  // the unlock panel
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.hidden = true;
  const input = document.createElement('input');
  input.className = 'pwin';
  input.type = 'password';
  input.placeholder = 'password';
  input.autocomplete = 'off';
  input.spellcheck = false;
  const showBtn = button('Show', 'btn tiny ghost');
  const go = button('Download', 'btn tiny primary');
  const msg = document.createElement('p');
  msg.className = 'status';
  panel.append(input, showBtn, go, msg);

  openBtn.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) input.focus();
  });
  showBtn.addEventListener('click', () => {
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    showBtn.textContent = hidden ? 'Hide' : 'Show';
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });

  go.addEventListener('click', async () => {
    if (!input.value.trim()) return say(msg, 'Type the password.', 'bad');
    go.disabled = true;
    try {
      say(msg, 'Getting file...');
      const locked = await fetchLocked(f.name);
      say(msg, 'Unlocking...');
      const out = await runJob({ op: 'unlock', data: locked, password: input.value });
      saveToDisk(out.data, out.name);
      say(msg, 'Downloaded ' + out.name, 'good');
      input.value = '';
    } catch (e) {
      say(msg, e.message, 'bad');
    }
    go.disabled = false;
  });

  rawBtn.addEventListener('click', async () => {
    rawBtn.disabled = true;
    try {
      saveToDisk(await fetchLocked(f.name), f.name);
    } catch (e) {
      panel.hidden = false;
      say(msg, e.message, 'bad');
    }
    rawBtn.disabled = false;
  });

  if (delBtn) {
    let timer = null;
    delBtn.addEventListener('click', async () => {
      if (!delBtn.classList.contains('sure')) {
        delBtn.classList.add('sure');
        delBtn.textContent = 'Really delete?';
        timer = setTimeout(() => {
          delBtn.classList.remove('sure');
          delBtn.textContent = 'Delete';
        }, 4000);
        return;
      }
      clearTimeout(timer);
      delBtn.disabled = true;
      try {
        const res = await fetch('/api/files/' + encodeURIComponent(f.name), {
          method: 'DELETE',
          headers: { 'x-delete-token': getTokens()[f.name] }
        });
        if (res.status === 403 || res.status === 404) dropToken(f.name);
        if (!res.ok && res.status !== 404) throw new Error((await res.json()).error || 'could not delete');
        loadList();
      } catch (e) {
        delBtn.disabled = false;
        panel.hidden = false;
        say(msg, e.message, 'bad');
      }
    });
  }

  li.append(badge, info, actions, panel);
  return li;
}

function button(text, cls) {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = text;
  return b;
}

async function fetchLocked(name) {
  const res = await fetch('/api/files/' + encodeURIComponent(name));
  if (!res.ok) throw new Error('could not get the file');
  return new Uint8Array(await res.arrayBuffer());
}

loadList();
