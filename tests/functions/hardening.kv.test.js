// Runs every hardening test again with the files in KV instead of R2.
globalThis.__STORE_KIND = "kv";
await import("./hardening.test.js");
