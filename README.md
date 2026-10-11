hrdlock

A site for signed documents and signed chat. You lock a file and publish it with one tap. Anyone with the link can check that it is the latest version and that nobody changed it.

How you use it

- Sign in with your email. We send a 6 digit code, you type it, you pick a name. That is all. Or use Quick start, which needs no email but keeps everything on one device.
- Add a file with the + button. It is locked in your browser, published, and you get a link to share. File passwords are handled for you and live inside the link.
- Anyone who opens the link sees a plain answer: verified and up to date, or a warning. The technical checks are under Details.
- Chats are signed. Every message shows whether its signature checked out. Public chats can be read by anyone. Private chats are for the people you add by email.
- The Verify page is for officials. They can check a link, pin the server key, check a saved bundle without any network, compare a file with its fingerprint, and audit the whole ledger.

What is stored where

- Your account is only a hash of your email and a masked copy for display. The email itself is not kept.
- Easy mode (the default): so that any device works, the server keeps an encrypted copy of your signing key and your file passwords. The people who run the service could technically use them. Verifiers still get the same signatures, chain and server checkpoints as before. Strict mode (in Me) deletes those copies and keeps everything on your own devices.
- Files are locked in your browser with AES-256-GCM, and then a second homemade cipher goes on top. The server stores only the locked file.

What it does not do

- The server could hide a newer version or a withdrawal. A single answer cannot show that. You only catch it if you pinned an older checkpoint or audited the whole ledger.
- The homemade cipher has not been reviewed by anyone. The AES-256-GCM layer is the standard one.
- Times come from the signers and the server clock. There is no trusted timestamp service.
- A name is only a name. Nobody checks who the person really is.
- The ledger is public. Unlisted only hides a document from the list. Labels, names and chat messages are public and cannot be removed.
- Private chats lock their messages with a group password that nobody picks. The server keeps it sealed and gives it to the members, so the people who run the service could technically open it, like Easy mode keys. It is not end to end.
- It is a prototype and nobody independent has reviewed it. Do not use it for real legal or government records until that happens.

Run it on your computer

You need Node 22 or newer.

    npm install
    npm run setup
    npm run build
    npm run preview

Then open http://127.0.0.1:8788. In local test mode no email is sent: the sign in code is filled in for you. That mode only works on your own computer.

To work on the pages, run npm run dev:web in one terminal and npm run dev:api in another, then open http://127.0.0.1:8788

Tests

    npm test

To test against a running local server: node scripts/e2e.mjs http://127.0.0.1:8788 --require-accounts

Put it online

It is made for Cloudflare Pages with D1 (the database) and KV (the locked files). Files can be up to 20 MiB. Sign in codes are sent through an email service (Resend, Brevo or Cloudflare). The steps, the secrets and the limits are in scripts/DEPLOY.md.

An AI coding assistant helped write this code.
