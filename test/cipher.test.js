const assert = require('assert');
const HRD = require('../public/hrdcipher.js');

function randomBytes(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) {
    crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  }
  return out;
}

function onesFraction(bytes) {
  let ones = 0;
  for (const b of bytes) {
    let x = b;
    while (x) { ones += x & 1; x >>= 1; }
  }
  return ones / (bytes.length * 8);
}

async function main() {
  const password = HRD.generatePassword();
  assert.match(password, /^([A-Z2-9]{4}-){4}[A-Z2-9]{4}$/);

  // round trip on a few sizes, including the edges around one block (64)
  for (const size of [0, 1, 2, 63, 64, 65, 1000, 100000]) {
    const data = randomBytes(size);
    const locked = await HRD.lock(data, 'test file ' + size + '.bin', password);
    const back = await HRD.unlock(locked, password);
    assert.strictEqual(back.name, 'test file ' + size + '.bin');
    assert.deepStrictEqual(Buffer.from(back.data), Buffer.from(data));
  }
  console.log('round trip ok');

  // password typed in lower case without dashes still works
  const small = await HRD.lock(new Uint8Array([1, 2, 3]), 'a.txt', password);
  const typed = password.replace(/-/g, '').toLowerCase();
  assert.deepStrictEqual(Array.from((await HRD.unlock(small, typed)).data), [1, 2, 3]);
  console.log('typed password ok');

  // wrong password
  await assert.rejects(HRD.unlock(small, HRD.generatePassword()), /wrong password/);
  console.log('wrong password rejected');

  // one flipped bit anywhere should be caught
  for (const pos of [0, 9, 20, 35, 45, small.length - 40, small.length - 1]) {
    const copy = new Uint8Array(small);
    copy[pos] ^= 1;
    await assert.rejects(HRD.unlock(copy, password));
  }
  console.log('tampering rejected');

  // same file twice should look different (new salt and nonce each time)
  const a = await HRD.lock(new Uint8Array(500), 'z.bin', password);
  const b = await HRD.lock(new Uint8Array(500), 'z.bin', password);
  assert.notDeepStrictEqual(Buffer.from(a), Buffer.from(b));
  console.log('fresh salt ok');

  // a file of only zeros should come out looking random
  const zeros = new Uint8Array(200000);
  const lockedZeros = await HRD.lock(zeros, 'zeros.bin', password);
  const body = lockedZeros.subarray(40, lockedZeros.length - 32);
  const frac = onesFraction(body);
  console.log('ones in locked zeros:', frac.toFixed(4));
  assert.ok(frac > 0.49 && frac < 0.51);

  // byte counts should be roughly even too
  const counts = new Array(256).fill(0);
  for (const x of body) counts[x]++;
  const expected = body.length / 256;
  let chi = 0;
  for (const c of counts) chi += ((c - expected) ** 2) / expected;
  console.log('chi square (255 degrees, expect near 255):', chi.toFixed(1));
  assert.ok(chi > 180 && chi < 340);

  // two passwords on the same file give unrelated output
  const other = await HRD.lock(zeros, 'zeros.bin', HRD.generatePassword());
  const otherBody = other.subarray(40, other.length - 32);
  let same = 0;
  for (let i = 0; i < body.length; i++) if (body[i] === otherBody[i]) same++;
  console.log('matching bytes between two passwords:', (same / body.length).toFixed(4), '(expect about 0.0039)');
  assert.ok(same / body.length < 0.01);

  console.log('all tests passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
