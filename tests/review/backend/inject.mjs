// D1 safety: injection, LIKE escaping, odd numbers, and listing correctness.
// node tests/review/backend/inject.mjs <baseUrl>
import {
  assert, brief, call, channelRecord, check, createRecord, eq, expectStatus, finish, makeBlob, newDocId, newPerson,
  postChannel, postDoc, publish, putBlob, RUN
} from './_lib.mjs';

const alice = await newPerson('Inj');
const marker = 'zq' + RUN;
const docs = {};
for (const [k, label] of Object.entries({
  pct: `${marker} 100% sure`,
  und: `${marker} a_b`,
  bs: `${marker} back\\slash`,
  plain: `${marker} aXb`,
  quote: `${marker} it's "quoted"`
})) {
  docs[k] = await publish(alice, { label });
}

const ids = (res) => res.json.documents.map((d) => d.docId);

await check('q with a percent sign matches only labels with a literal percent', async () => {
  const res = await call('GET', '/api/documents?q=' + encodeURIComponent(marker + ' 100%'));
  expectStatus(res, 200);
  eq(ids(res).join(), docs.pct.docId);
  const all = await call('GET', '/api/documents?limit=100&q=' + encodeURIComponent('%'));
  expectStatus(all, 200);
  assert(all.json.documents.every((d) => d.label.includes('%')), 'q=% matched labels without a percent sign');
});

await check('q with an underscore matches only a literal underscore', async () => {
  const res = await call('GET', '/api/documents?q=' + encodeURIComponent(marker + ' a_b'));
  eq(ids(res).join(), docs.und.docId);
});

await check('q with a backslash is treated literally', async () => {
  const res = await call('GET', '/api/documents?q=' + encodeURIComponent(marker + ' back\\slash'));
  eq(ids(res).join(), docs.bs.docId);
  const res2 = await call('GET', '/api/documents?q=' + encodeURIComponent('\\'));
  expectStatus(res2, 200);
});

await check('q with quotes and SQL fragments never errors or widens the result', async () => {
  const evil = [
    "' OR 1=1 --", "'; DROP TABLE documents; --", '" OR ""="', "%' OR '1'='1", "\\' OR 1=1 --",
    "' UNION SELECT 1 --", marker + ' it\'s "quoted"'
  ];
  for (const q of evil) {
    const res = await call('GET', '/api/documents?q=' + encodeURIComponent(q));
    expectStatus(res, 200);
    if (q.startsWith(marker)) eq(ids(res).join(), docs.quote.docId, 'quoted label found');
    else assert(res.json.documents.every((d) => d.label.toLowerCase().includes(q.toLowerCase())), 'q=' + q + ' returned non matching rows');
  }
  expectStatus(await call('GET', '/api/documents?limit=1'), 200); // table still there
});

await check('q with NUL, lone surrogate bytes and long unicode does not crash (4xx or 200, never 5xx)', async () => {
  for (const q of ['%00', '%00abc', '%ED%A0%80', '%F0%9F%98%80'.repeat(5), '\u{e9}'.repeat(10), '%C0%80']) {
    const res = await call('GET', '/api/documents?q=' + q);
    assert(res.status < 500, `q=${q.slice(0, 20)}: ${brief(res)}`);
  }
});

await check('every q the API accepts (up to 120 characters) is a valid search, not a server error', async () => {
  // D1 refuses a LIKE pattern longer than 50 bytes. The pattern is '%' + q + '%', so q of 49 or more characters fails.
  const bad = [];
  for (const q of ['a'.repeat(48), 'a'.repeat(49), 'a'.repeat(60), 'a'.repeat(120), '\u{1f600}'.repeat(13), '\u{e9}'.repeat(25), '%'.repeat(25)]) {
    const res = await call('GET', '/api/documents?q=' + encodeURIComponent(q));
    if (res.status !== 200) bad.push(`${[...q].length} chars / ${new TextEncoder().encode(q).length} bytes -> HTTP ${res.status}`);
  }
  assert(bad.length === 0, 'search answered with an error: ' + bad.join('; '));
});

await check('owner, before, limit, after, tail, ids never reach SQL unescaped', async () => {
  const bad = ["' OR 1=1 --", '1 OR 1=1', '1;DROP TABLE documents', '-1', '1.5', '1e3', '0x10', '+5', ' 5', '5 ', 'NaN', 'Infinity', '99999999999999999999', '', '\u{663}', '\u{ff11}\u{ff12}'];
  for (const v of bad) {
    for (const p of ['limit', 'before']) {
      const res = await call('GET', `/api/documents?${p}=${encodeURIComponent(v)}`);
      assert(res.status < 500, `${p}=${v}: ${brief(res)}`);
      if (v !== '' && p === 'limit' && res.status === 200) {
        assert(res.json.documents.length <= 100, 'limit not capped for ' + v);
      }
    }
    for (const p of ['after', 'limit']) {
      const res = await call('GET', `/api/ledger?${p}=${encodeURIComponent(v)}`);
      assert(res.status < 500, `ledger ${p}=${v}: ${brief(res)}`);
    }
    const o = await call('GET', `/api/documents?owner=${encodeURIComponent(v)}`);
    assert(o.status < 500, `owner=${v}: ${brief(o)}`);
    const id = await call('GET', `/api/documents/${encodeURIComponent(v || 'x')}`);
    assert(id.status < 500, `docId=${v}: ${brief(id)}`);
    const idn = await call('GET', `/api/identities/${encodeURIComponent(v || 'x')}`);
    assert(idn.status < 500, `keyId=${v}: ${brief(idn)}`);
  }
  expectStatus(await call('GET', '/api/documents?limit=1'), 200);
});

await check('limit and tail beyond bounds are rejected, not silently huge', async () => {
  expectStatus(await call('GET', '/api/documents?limit=0'), 400);
  expectStatus(await call('GET', '/api/documents?limit=101'), 400);
  expectStatus(await call('GET', '/api/ledger?limit=201'), 400);
  expectStatus(await call('GET', '/api/ledger?limit=501'), 400);
  expectStatus(await call('GET', '/api/ledger?limit=200'), 200);
  expectStatus(await call('GET', '/api/channels?limit=201'), 400);
  const ch = channelRecord(alice);
  expectStatus(await postChannel(alice, ch), 201);
  expectStatus(await call('GET', `/api/channels/${ch.channelId}/messages?limit=101`), 400);
  expectStatus(await call('GET', `/api/channels/${ch.channelId}/messages?tail=101`), 400);
  expectStatus(await call('GET', `/api/channels/${ch.channelId}/messages?tail=0`), 400);
  expectStatus(await call('GET', `/api/channels/${ch.channelId}/messages?after=-1`), 400);
});

await check('channel id in the path with SQL, slashes or unicode is rejected', async () => {
  for (const id of ["x'--", 'a%2Fb', '..%2F..%2Fetc', 'ABC', 'a', '%00abc', '\u{e9}'.repeat(5), 'a'.repeat(41)]) {
    const res = await call('GET', `/api/channels/${id}/messages`);
    assert(res.status >= 400 && res.status < 500, `${id}: ${brief(res)}`);
  }
});

await check('document list pagination reaches every listed document (ties on updatedAt must not hide documents)', async () => {
  // The cursor is "updatedAt < before". updatedAt is the client signed createdAt, so anyone can make many
  // documents share one value. Documents tied with the page boundary are then skipped by the next page.
  const victim = await newPerson('VictimTie');
  const attacker = await newPerson('AttackTie');
  const T = Date.now() - 60000;
  const blobV = await makeBlob(210);
  assert((await putBlob(victim, blobV)).status < 300, 'upload');
  const blobA = await makeBlob(211);
  assert((await putBlob(attacker, blobA)).status < 300, 'upload');
  const mk = (id) => id;
  const victimId = '00' + newDocId().slice(2); // sorts last among ties (doc_id DESC)
  expectStatus(await postDoc(victim, createRecord(victim, blobV, { docId: victimId, createdAt: T, label: 'victim tie ' + RUN })), 201);
  const spamIds = ['ff', 'fe', 'fd'].map((p) => mk(p + newDocId().slice(2)));
  for (const id of spamIds) expectStatus(await postDoc(attacker, createRecord(attacker, blobA, { docId: id, createdAt: T, label: 'spam tie' })), 201);

  // page through everything with limit 2 using the documented cursor (before = updatedAt, beforeId = docId of the last item)
  const seen = new Set();
  let before = null;
  let beforeId = null;
  for (let page = 0; page < 400; page++) {
    const res = await call('GET', `/api/documents?limit=2${before !== null ? '&before=' + before + '&beforeId=' + beforeId : ''}`);
    expectStatus(res, 200);
    if (res.json.documents.length === 0) break;
    for (const d of res.json.documents) seen.add(d.docId);
    const lastRow = res.json.documents[res.json.documents.length - 1];
    before = lastRow.updatedAt;
    beforeId = lastRow.docId;
  }
  const missing = [victimId, ...spamIds].filter((id) => !seen.has(id));
  assert(missing.length === 0, `${missing.length} of 4 documents with the same updatedAt are unreachable by paging: ${missing.map((m) => m.slice(0, 8)).join(',')}`);
});

await check('the paging cursor is validated: beforeId needs before and must be a document id', async () => {
  expectStatus(await call('GET', '/api/documents?beforeId=' + newDocId()), 400);
  expectStatus(await call('GET', '/api/documents?before=5&beforeId=zz'), 400);
  expectStatus(await call('GET', '/api/documents?before=5&beforeId=' + 'A'.repeat(32)), 400);
  expectStatus(await call('GET', '/api/documents?before=5&beforeId=' + newDocId()), 200);
  // the old form (before alone) still works and means strictly earlier
  expectStatus(await call('GET', '/api/documents?before=5'), 200);
});

await check('search is case blind for ASCII and finds text anywhere in the label, at the longest allowed length', async () => {
  const long = (marker + ' LongLabelSearch ' + 'x'.repeat(100)).slice(0, 120);
  const doc = await publish(alice, { label: long });
  for (const q of [long, long.toLowerCase(), long.toUpperCase(), long.slice(5, 110)]) {
    const res = await call('GET', '/api/documents?limit=100&q=' + encodeURIComponent(q));
    expectStatus(res, 200);
    assert(ids(res).includes(doc.docId), 'not found with a query of ' + q.length + ' characters');
  }
  expectStatus(await call('GET', '/api/documents?q=' + encodeURIComponent('a'.repeat(121))), 400);
});

finish();
