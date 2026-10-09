const MAX_SIZE = 50 * 1024 * 1024;

const pick = document.getElementById('pick');
const lockBtn = document.getElementById('lockBtn');
const lockStatus = document.getElementById('lockStatus');
const result = document.getElementById('result');
const pwBox = document.getElementById('pw');
const copyBtn = document.getElementById('copyBtn');
const storedAs = document.getElementById('storedAs');
const listStatus = document.getElementById('listStatus');
const fileList = document.getElementById('files');

function say(el, text, kind) {
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

function prettySize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

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
    const locked = await HRD.lock(data, file.name, password);

    say(lockStatus, 'Uploading...');
    const res = await fetch('/api/files', {
      method: 'POST',
      headers: { 'x-file-name': encodeURIComponent(file.name) },
      body: locked
    });
    const info = await res.json();
    if (!res.ok) throw new Error(info.error || 'upload failed');

    pwBox.textContent = password;
    storedAs.textContent = 'Saved as ' + info.name;
    result.hidden = false;
    say(lockStatus, 'Done.', 'good');
    pick.value = '';
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

async function loadList() {
  try {
    const res = await fetch('/api/files');
    const files = await res.json();
    fileList.textContent = '';
    say(listStatus, files.length ? '' : 'Nothing stored yet.');
    files.forEach((f) => fileList.appendChild(makeRow(f)));
  } catch (e) {
    say(listStatus, 'Could not load the list.', 'bad');
  }
}

function makeRow(f) {
  const li = document.createElement('li');

  const row = document.createElement('div');
  row.className = 'row';
  const left = document.createElement('div');
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = f.name;
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = prettySize(f.size) + ', ' + new Date(f.uploaded).toLocaleString();
  left.append(name, meta);
  const open = document.createElement('button');
  open.className = 'plain';
  open.textContent = 'Unlock';
  row.append(left, open);

  const form = document.createElement('div');
  form.className = 'unlock';
  form.hidden = true;
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'password';
  input.autocomplete = 'off';
  input.spellcheck = false;
  const go = document.createElement('button');
  go.textContent = 'Download';
  const msg = document.createElement('span');
  msg.className = 'status';
  form.append(input, go, msg);

  open.addEventListener('click', () => {
    form.hidden = !form.hidden;
    if (!form.hidden) input.focus();
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });

  go.addEventListener('click', async () => {
    if (!input.value.trim()) return say(msg, 'Type the password.', 'bad');
    go.disabled = true;
    try {
      say(msg, 'Getting file...');
      const res = await fetch('/api/files/' + encodeURIComponent(f.name));
      if (!res.ok) throw new Error('could not get the file');
      const locked = new Uint8Array(await res.arrayBuffer());
      say(msg, 'Unlocking...');
      const out = await HRD.unlock(locked, input.value);
      saveToDisk(out.data, out.name);
      say(msg, 'Downloaded ' + out.name, 'good');
      input.value = '';
    } catch (e) {
      say(msg, e.message, 'bad');
    }
    go.disabled = false;
  });

  li.append(row, form);
  return li;
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

loadList();
