// Locks a file with the files password and stores it as a private file.
import { LIMITS } from '../../../shared/records.js';
import { lockInWorker } from '../../lib/cipherClient.js';

// The name in the list: plain characters only (control, invisible and direction changing ones become _), 120 at most.
const BAD = [[0, 31], [127, 159], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff]];
const isBad = (ch) => BAD.some(([a, b]) => ch.codePointAt(0) >= a && ch.codePointAt(0) <= b);
export const labelFor = (name) => Array.from(String(name || '')).map((ch) => (isBad(ch) ? '_' : ch)).slice(0, 120).join('').trim() || 'Private file';

// lockPassword comes from the files password prompt. identity signs for the account. api.putPrivateFile sends it.
// Gives back the answer of the server, { id, size }.
export async function addPrivateFile({ file, lockPassword, identity }, { putPrivateFile }) {
  if (!file || !(file.size > 0)) throw new Error('That file is empty.');
  if (file.size > LIMITS.MAX_FILE_BYTES) throw new Error('That file is too large. The limit is 20 MiB.');
  const locked = await lockInWorker({ data: new Uint8Array(await file.arrayBuffer()), name: file.name, password: lockPassword });
  const createdAt = Date.now();
  const record = { v: 2, type: 'blob.put', hash: locked.blobHash, size: locked.size, signer: identity.keyId, createdAt };
  const signature = await identity.sign(record);
  return putPrivateFile({ bytes: locked.bytes, label: labelFor(file.name), hash: locked.blobHash, signer: identity.keyId, createdAt, signature });
}
