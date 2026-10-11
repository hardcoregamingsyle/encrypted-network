import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Button from '../Button.jsx';
import Callout from '../Callout.jsx';
import EmptyState from '../EmptyState.jsx';
import { ItemList } from '../ListItem.jsx';
import ListItem from '../ListItem.jsx';
import Sheet from '../Sheet.jsx';
import Skeleton from '../Skeleton.jsx';
import { useToast } from '../Toast.jsx';
import { actionErrorText } from '../actionText.js';
import { saveFile } from '../doc/saveFile.js';
import { saveDocPassword, snapshotVaultContext } from '../../lib/vault.js';
import { ApiError, deletePrivateFile, getIdentity, getPrivateFile, listPrivateFiles, putPrivateFile } from '../../lib/api.js';
import { formatBytes, timeAgo } from '../../lib/format.js';
import { FileIcon } from './FileRow.jsx';
import FilesPasswordSheet from './FilesPasswordSheet.jsx';
import { runAddFile } from './addFlow.js';
import { addPrivateFile } from './addPrivate.js';
import { NEEDS_KEY_COPY, needsKeyKind } from '../../lib/authText.js';
import { fetchChecked, openLocked } from './openPrivate.js';

const errorText = (err) => (err instanceof ApiError ? actionErrorText(err) : err.message);

// The Private tab: files only this account can open. They are locked in the browser with the files password and
// stored away from every public list. files is optional (a list the caller already has, skips the loading).
export default function PrivateFiles({ session, files: given, now = Date.now() }) {
  const toast = useToast();
  const navigate = useNavigate();
  const input = useRef(null);
  const [list, setList] = useState(given ? { status: 'ready', files: given, error: '' } : { status: 'loading', files: [], error: '' });
  const [reload, setReload] = useState(0);
  const [picked, setPicked] = useState(null); // a file chosen to add
  const [opening, setOpening] = useState(null); // { bytes, file, publish } a file that passed the check, waiting for the password
  const [removing, setRemoving] = useState(null); // the row being deleted
  const [busy, setBusy] = useState(''); // id of the row being worked on
  const [error, setError] = useState('');
  const ready = session.status === 'ready' && session.mode === 'account' && Boolean(session.identity);

  useEffect(() => {
    if (!ready || given) return undefined;
    let live = true;
    listPrivateFiles().then(
      (answer) => live && setList({ status: 'ready', files: answer.files, error: '' }),
      (err) => live && setList({ status: 'error', files: [], error: actionErrorText(err) })
    );
    return () => {
      live = false;
    };
  }, [ready, reload, given]);

  async function onPassword(lockPassword) {
    setError('');
    try {
      await addPrivateFile({ file: picked, lockPassword, identity: session.identity }, { putPrivateFile });
      toast.push({ tone: 'good', text: 'Saved. Only you can open it.' });
      setReload((n) => n + 1);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPicked(null);
    }
  }

  // Brings the locked copy here and checks it before the password is asked for.
  async function download(file, publish = false) {
    if (busy) return;
    setBusy(file.id);
    setError('');
    try {
      const publicKeyOf = async (keyId) => (keyId === session.identity.keyId ? session.identity.publicKey : (await getIdentity(keyId)).publicKey);
      setOpening({ bytes: await fetchChecked(file.id, { ownKeyIds: session.keys.map((k) => k.keyId), publicKeyOf }, { getPrivateFile }), file, publish });
    } catch (err) {
      setError(errorText(err));
    }
    setBusy('');
  }

  // Throws a plain sentence when the password is wrong, so the password box stays open.
  async function unlock(lockPassword) {
    const opened = await openLocked(opening.bytes, lockPassword);
    if (opening.publish) return makePublic(opened, opening.file);
    saveFile(opened.name, opened.data);
    toast.push({ tone: 'good', text: 'Downloaded.' });
    setOpening(null);
  }

  // Publishes the opened file like any public file (new password, kept for you), then removes the private copy.
  async function makePublic(opened, file) {
    const context = snapshotVaultContext();
    const out = await runAddFile({ file: new File([opened.data], opened.name), listed: true, identity: session.identity, save: (docId, pw) => saveDocPassword(docId, pw, context) });
    if (!out.ok) throw new Error(out.message);
    // Without a kept password nobody could open the public copy, so the private one stays.
    const kept = out.stored !== 'none';
    const removed = kept && (await deletePrivateFile(file.id).then(() => true, () => false));
    const text = removed ? 'Now public.' : kept ? 'Now public, but the private copy could not be removed. Delete it yourself.' : 'Now public, but its password could not be kept, so the private copy stays. Withdraw the public file and try again.';
    toast.push({ tone: removed ? 'good' : 'warn', text });
    setOpening(null);
    navigate(`/d/${encodeURIComponent(out.result.docId)}`);
  }

  async function remove() {
    setBusy(removing.id);
    setError('');
    try {
      await deletePrivateFile(removing.id);
      toast.push({ tone: 'good', text: 'Deleted.' });
    } catch (err) {
      setError(errorText(err));
    }
    setReload((n) => n + 1); // also after a failure, the file may be gone already
    setRemoving(null);
    setBusy('');
  }

  if (session.status === 'loading') return <Skeleton variant="row" count={3} label="Loading your private files" />;
  if (session.status === 'needsKey') {
    const copy = NEEDS_KEY_COPY[needsKeyKind(session)];
    return (
      <EmptyState art="files" title="One more step" action={<Link className="ui-btn ui-btn--primary" to="/signin"><span className="ui-btn__label">{copy.action}</span></Link>}>
        {copy.files}
      </EmptyState>
    );
  }
  if (!ready) {
    return (
      <EmptyState art="files" title="Private files need an email account" action={<Link className="ui-btn ui-btn--primary" to="/signin"><span className="ui-btn__label">Sign in with email</span></Link>}>
        Sign in with your email to keep files that only you can open. Quick start cannot keep them.
      </EmptyState>
    );
  }
  return (
    <>
      <input ref={input} className="ui-sr-only" tabIndex={-1} type="file" aria-label="Choose a file to keep private" onChange={(e) => { setPicked(e.target.files[0] || null); e.target.value = ''; }} />
      <Button variant="primary" onClick={() => input.current.click()}>
        Add a private file
      </Button>
      {error ? <Callout tone="bad" title="That did not work">{error}</Callout> : null}
      {list.status === 'loading' ? <Skeleton variant="row" count={3} label="Loading your private files" /> : null}
      {list.status === 'error' ? <Callout tone="bad" title="Could not load your private files">{list.error}</Callout> : null}
      {list.status === 'ready' && list.files.length === 0 ? <p className="ui-muted">No private files yet. A file is locked in your browser before it is sent.</p> : null}
      {list.status === 'ready' && list.files.length > 0 ? (
        <ItemList>
          {list.files.map((f) => (
            <ListItem key={f.id} leading={<FileIcon label={f.label} />} title={f.label} subtitle={`${formatBytes(f.size)}, ${timeAgo(f.createdAt, now)}`} className="files-row files-private"
              trailing={
                <>
                  <Button size="sm" pending={busy === f.id} aria-label={`Download ${f.label}`} onClick={() => download(f)}>
                    Download
                  </Button>
                  <Button size="sm" aria-label={`Make ${f.label} public`} onClick={() => download(f, true)}>
                    Make public
                  </Button>
                  <Button size="sm" variant="ghost" aria-label={`Delete ${f.label}`} onClick={() => !busy && setRemoving(f)}>
                    Delete
                  </Button>
                </>
              }
            />
          ))}
        </ItemList>
      ) : null}
      {opening ? <FilesPasswordSheet purpose={opening.publish ? 'public' : 'open'} accountId={session.account.id} onDone={unlock} onClose={() => setOpening(null)} /> : null}
      {removing ? (
        <Sheet
          open
          onClose={() => setRemoving(null)}
          dismissible={!busy}
          title="Delete this file?"
          description="It is removed for good. We cannot get it back."
          footer={
            <>
              <Button variant="ghost" onClick={() => setRemoving(null)} disabled={Boolean(busy)}>
                Cancel
              </Button>
              <Button variant="danger" loading={Boolean(busy)} onClick={remove}>
                Delete
              </Button>
            </>
          }
        >
          <p className="ui-muted">{removing.label}</p>
        </Sheet>
      ) : null}
      {picked ? <FilesPasswordSheet purpose="add" accountId={session.account.id} onDone={onPassword} onClose={() => setPicked(null)} /> : null}
    </>
  );
}
