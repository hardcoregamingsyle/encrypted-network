import { Link } from 'react-router-dom';
import Callout from '../components/Callout.jsx';
import ScreenHeader from '../components/ScreenHeader.jsx';
import '../styles/about.css';

export default function AboutPage() {
  return (
    <div className="ui-screen">
      <ScreenHeader title="How this works" documentTitle="About" back="/me" backLabel="Back to Me" />
      <div className="ui-container ui-container--narrow about-page">
        <p className="about-lead">
          hrdlock keeps signed records of files and chats, so that anyone holding a copy can see who signed it and check
          whether anyone has changed it.
        </p>

        <Callout tone="warn" title="This is a prototype">
          It has not been audited or certified. Read the limits below before you rely on it for anything that matters.
        </Callout>

        <section className="about-section" aria-labelledby="about-what">
          <h2 id="about-what">What this is</h2>
          <p>
            Every file version and every chat message is signed with a key that belongs to the person who wrote it. The
            server keeps the records and a ledger that links them in order. When you open a file or check a link, your
            browser looks at the signatures and the links itself and tells you in plain words what it found. The checking
            program comes from this same site, see the limits below.
          </p>
          <p>
            Chats are public. Anyone can read them, and you need to be signed in to write. Private encrypted chats do not
            exist yet.
          </p>
        </section>

        <section className="about-section" aria-labelledby="about-signin">
          <h2 id="about-signin">Signing in</h2>
          <p>
            You sign in with your email and a 6 digit code. There are no passwords. Other people see the name you choose
            and your public key, never your email. The service stores your email only in a scrambled form plus a masked
            version such as pr***@example.com. To deliver the code, your address is sent to an email service.
          </p>
          <p>
            <strong>Easy mode</strong> is the default. Your signing key is made in your browser, then sent once over an
            encrypted connection and kept encrypted on the server, so every device you sign in on can use it. The same goes
            for the passwords of the files you publish. The trade-off is plain: whoever runs the service holds the means to
            use your key and open those passwords. It does not change what other people see when they check your files.
          </p>
          <p>
            <strong>Strict mode</strong> (in <Link to="/me">Me</Link>) deletes the server copies. Each device then makes its own
            key. Files stay owned by the key that published them, so updating or withdrawing a file works only on a device
            that holds that key.
          </p>
          <p>
            <strong>Quick start</strong> needs no email. A key is made in this browser and everything stays on this device.
            If you clear your browser data you lose access, and nobody can bring it back.
          </p>
          <p>
            <strong>On a shared computer:</strong> when you sign out of an Easy account, your key and file passwords are
            removed from that computer. A Strict account and Quick start keep them on the computer, so use Leave Quick start
            when you are done, and do not use Strict mode on a computer other people use.
          </p>
        </section>

        <section className="about-section" aria-labelledby="about-protected">
          <h2 id="about-protected">How a file is protected</h2>
          <p>
            A file is locked in your browser before it leaves your device. It is encrypted with AES-256-GCM, a standard
            cipher, and then wrapped in a second, homemade layer. The server stores only the locked file. It cannot read
            the file, unless you use Easy mode: then the service also keeps a locked copy of the file passwords, and whoever runs
            the service could use them. The password is made for you. It lives in the share link after the # sign, which browsers do not send
            to servers, and in your own saved copy so you can open your files again.
          </p>
        </section>

        <section className="about-section" aria-labelledby="about-public">
          <h2 id="about-public">What is public</h2>
          <ul className="ui-list">
            <li>
              The label you give a file. Leaving a file out of the public list only hides it from the list. It is not
              secret: the signed ledger is public, so anyone who reads the whole ledger can see the id, label, file hash and
              times of every file, listed or not.
            </li>
            <li>The name you chose and your public key.</li>
            <li>The version history and the times each version was signed.</li>
            <li>The hash of the locked file, and its size.</li>
            <li>Every chat message and who signed it.</li>
          </ul>
          <p>Do not put anything secret in a label, a name or a message.</p>
        </section>

        <section className="about-section" aria-labelledby="about-verify">
          <h2 id="about-verify">What Verified means</h2>
          <p>A green Verified on a file means all of these were checked in your browser:</p>
          <ul className="ui-list">
            <li>
              <strong>Signatures.</strong> Each version is signed by its owner. A changed record no longer matches its
              signature.
            </li>
            <li>
              <strong>Hash chain.</strong> Each version names the one before it, so versions cannot be removed or reordered
              without the chain breaking.
            </li>
            <li>
              <strong>Server checkpoint and head attestation.</strong> The server signs where its ledger stands and what the
              latest version of a file is, at the moment it answers.
            </li>
            <li>
              <strong>File fingerprint commitment.</strong> Each version holds a commitment to the fingerprint of the
              unlocked file. With the password you can unlock the file and show that it matches what was signed.
            </li>
          </ul>
          <p>
            Try it on the <Link to="/verify">verify page</Link>. A check that was only partly done is shown as a warning, not as green. On your first visit this browser has nothing
            earlier to compare the server's key with, so the answer says so.
          </p>
        </section>

        <section className="about-section" aria-labelledby="about-not">
          <h2 id="about-not">What this does not prove</h2>
          <ul className="ui-list">
            <li>
              The server can only attest to what it has seen. It could hide a newer version, unless you pin an earlier
              checkpoint or audit the whole ledger.
            </li>
            <li>The homemade cipher layer has not been independently reviewed. The standard AES layer still protects the file.</li>
            <li>Timestamps come from the signer and the server clock. They are not from a trusted timestamp authority.</li>
            <li>
              The program that does the checking is delivered by this same site. A changed or copied site could send
              different code that skips a check, reports a pass, or sends a password somewhere. Pinning a server key does
              not help against that. A separate verification program that does not come from this site is not provided yet,
              so for records that matter, have the checks repeated with code you got from a source you trust.
            </li>
            <li>In Easy mode the service can use your key and your file passwords, as explained above.</li>
            <li>Nobody has checked who the person behind a name really is. A name is only a name.</li>
            <li>It is a prototype, not a certified system.</li>
          </ul>
        </section>

        <section className="about-section" aria-labelledby="about-start">
          <h2 id="about-start">Getting started</h2>
          <p>
            Open <Link to="/welcome">the welcome screen</Link>, sign in with your email, choose a name, and you can write in
            chats and publish files. Deleting your account removes your saved key copy and file passwords from the server.
            What you already signed stays in the public history.
          </p>
        </section>
      </div>
    </div>
  );
}
