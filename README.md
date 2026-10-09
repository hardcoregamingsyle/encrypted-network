hrdlock

A site for signed documents and signed chat. You lock a file in your browser and publish it. Anyone with the link can check that the file is the latest version and that nobody changed it.

What it does

- Everyone makes a signing key in their browser. The ID of a person is the hash of their public key.
- A file is locked in your browser with AES-256-GCM, and then a second homemade cipher goes on top. The password never leaves your browser. The server only stores the locked file.
- Every version of a document is a signed record, and every record points to the one before it, so the versions form a chain. Revoking a document is also a signed record.
- The server signs where the chain is now (a checkpoint) and the newest version of each document. The page checks all of it in your browser, not on the server.
- Chat messages are signed too. Each message shows whether its signature checked out.
- The Verify page is for officials. They can pin the server key, check a document, check a saved bundle without any network, compare a file with its fingerprint, and audit the whole ledger.

What it does not do

- The server could hide a newer version. You only catch that if you pinned an older checkpoint or audited the whole ledger.
- The homemade cipher has not been reviewed by anyone. The AES-256-GCM layer is the standard one.
- Times come from the signers and the server clock. There is no trusted timestamp service.
- A key is only a key. Nobody checks who the person really is.
- The ledger is public. Unlisted only hides a document from the list. Labels, names and chat messages are public and cannot be removed.
- It is a prototype and nobody independent has reviewed it. Do not use it for real legal or government records until that happens.

Run it on your computer

You need Node 22 or newer.

    npm install
    npm run setup
    npm run build
    npm run preview

Then open http://127.0.0.1:8788

To work on the pages, run npm run dev:web in one terminal and npm run dev:api in another, then open http://127.0.0.1:8788

Tests

    npm test

To test against a running server: node scripts/e2e.mjs http://127.0.0.1:8788

Put it online

It is made for Cloudflare Pages with D1 and R2. The steps and the limits are in scripts/DEPLOY.md.

An AI coding assistant helped write this code.
