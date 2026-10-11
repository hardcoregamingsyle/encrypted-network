// Runs every blob storage test again with the files in KV instead of R2.
globalThis.__STORE_KIND = "kv";
await import("./blobs.test.js");
