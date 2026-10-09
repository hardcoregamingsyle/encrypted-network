// worker.js
// Does the locking and unlocking in the background so the page does not freeze
// on big files.

importScripts('hrdcipher.js');

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.op === 'lock') {
      const fingerprint = await HRD.fingerprint(m.data);
      const out = await HRD.lock(m.data, m.name, m.password);
      self.postMessage({ id: m.id, ok: true, data: out, fingerprint }, [out.buffer]);
    } else if (m.op === 'unlock') {
      const r = await HRD.unlock(m.data, m.password);
      const copy = r.data.slice();
      self.postMessage({ id: m.id, ok: true, name: r.name, data: copy, fingerprint: r.fingerprint }, [copy.buffer]);
    } else {
      throw new Error('unknown job');
    }
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: err.message });
  }
};
