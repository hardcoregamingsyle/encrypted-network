import { Link } from 'react-router-dom';
import Callout from '../components/Callout.jsx';
import PageHeader from '../components/PageHeader.jsx';
import '../styles/about.css';

export default function AboutPage() {
  return (
    <div className="ui-container ui-container--narrow about-page">
      <PageHeader
        title="How this works"
        lead="hrdlock keeps signed records of documents, so that someone holding a copy can check it is the latest one and has not been changed."
        documentTitle="About"
      />

      <Callout tone="warn" title="This is a prototype">
        It has not been audited or certified. Read the limits below before you rely on it for anything that matters.
      </Callout>

      <section className="about-section" aria-labelledby="about-what">
        <h2 id="about-what">What this is</h2>
        <p>
          Each person has a signing identity, which is a key pair made in their browser. Every document version and
          every chat message is signed with that key. The key is named by the hash of its public half, called the key
          id. The server keeps the records and a ledger that links them in order. A document can be fetched and
          its signatures and links checked in the browser. The checking program comes from this same site, see the limits
          below.
        </p>
      </section>

      <section className="about-section" aria-labelledby="about-protected">
        <h2 id="about-protected">How a document is protected</h2>
        <p>
          A file is locked in your browser before it leaves your computer. It is encrypted with AES-256-GCM, a
          standard cipher, and then wrapped in a second, homemade layer. The password is never sent to the server. It
          stays with you, and only appears in a share link after the # sign, which browsers do not send to servers.
        </p>
        <p>The server stores only the locked file. It cannot read the document.</p>
      </section>

      <section className="about-section" aria-labelledby="about-public">
        <h2 id="about-public">What is public</h2>
        <ul className="ui-list">
          <li>
            The label you give the document. Unlisted only means a document is left out of the public list. It is not
            secret: the signed ledger is public, so anyone who reads the whole ledger can see the id, label, file hash
            and times of every document, listed or not.
          </li>
          <li>The owner key id and the display name they chose.</li>
          <li>The version history and the times each version was signed.</li>
          <li>The hash of the locked file, and its size.</li>
        </ul>
        <p>Do not put anything secret in a label or a display name.</p>
      </section>

      <section className="about-section" aria-labelledby="about-verify">
        <h2 id="about-verify">How verification works</h2>
        <ul className="ui-list">
          <li>
            <strong>Signatures.</strong> Each version is signed by the owner key. A changed record no longer matches
            its signature.
          </li>
          <li>
            <strong>Hash chain.</strong> Each version names the hash of the one before it, so versions cannot be
            removed or reordered without the chain breaking.
          </li>
          <li>
            <strong>Server checkpoint and head attestation.</strong> The server signs where its ledger stands and what
            the latest version of a document is, at the moment it answers.
          </li>
          <li>
            <strong>File fingerprint commitment.</strong> Each version holds a commitment to the fingerprint of the
            unlocked file. With the password you can unlock the file and show that it matches what was signed.
          </li>
        </ul>
        <p>
          Try it on the <Link to="/verify">verify page</Link>. A verifier can pin the server key id, so a server
          with a different key cannot pose as this one, as long as the checking program itself is the real one.
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
          <li>
            Timestamps come from the signer and the server clock. They are not from a trusted timestamp authority.
          </li>
          <li>
            The program that does the checking is delivered by this same site. A changed or copied site could send
            different code that skips a check, reports a pass, or sends a password somewhere. Pinning a server key does
            not help against that. A separate verification program that does not come from this site is not provided yet,
            so for records that matter, have the checks repeated with code you got from a source you trust.
          </li>
          <li>The identity is only a key. Nobody has checked who the person really is.</li>
          <li>It is a prototype, not a certified system.</li>
        </ul>
      </section>

      <section className="about-section" aria-labelledby="about-start">
        <h2 id="about-start">Getting started</h2>
        <p>
          Make an identity on the <Link to="/keys">identity page</Link> and download the backup file. If you lose the
          key and have no backup, you lose the identity for good.
        </p>
      </section>
    </div>
  );
}
