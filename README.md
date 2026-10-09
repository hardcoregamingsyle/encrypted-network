hrdlock

A small site where you lock a file, store it, and unlock it later with a password.

How it works

1. You pick a file and press lock.
2. The page makes a random password and locks the whole file in your browser, every byte of it. The file name is locked too.
3. Only the locked file is sent to the server. It is saved as yourfile.ext.hrdlock
4. To get it back you press unlock, type the password, the locked file comes down to your computer and is opened there. The server never sees the password or the real file.

If you lose the password the file cannot be opened. There is no reset.

The cipher

The cipher is homemade, it is in public/hrdcipher.js. The password is turned into keys with PBKDF2 (that part is a normal tool). After that my own code takes over. It makes a keystream by mixing numbers with add, rotate, xor and multiply, and every byte also goes through a shuffled lookup table together with the byte before it. A check code (HMAC) on the end tells you if the password is wrong or the file was changed.

I made this to learn. Nobody has checked it. Do not use it for anything that really matters.

Run it

You need node 18 or newer. There is nothing to install.

    node server.js

Then open http://127.0.0.1:3000 in a browser.

Tests

    npm test

Limits

Files can be up to 50 MB. There are no accounts, so anyone who can open the site can see the list of locked file names and download the locked files. They still need the password to open them.

An AI coding assistant helped write this code.
