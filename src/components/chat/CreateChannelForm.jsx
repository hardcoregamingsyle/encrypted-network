import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Button from '../Button.jsx';
import Callout from '../Callout.jsx';
import Field from '../Field.jsx';
import { createChannel } from '../../lib/api.js';
import { buildChannelRecord, checkChannelInput, describeApiError, slugifyTitle } from '../../lib/chatClient.js';
import { useIdentity } from '../../lib/identity.jsx';

// Start a channel: title, id and an optional document. The record is signed in the browser.
export default function CreateChannelForm({ onCreated }) {
  const { status, identity } = useIdentity();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [channelId, setChannelId] = useState('');
  const [idTouched, setIdTouched] = useState(false);
  const [docId, setDocId] = useState('');
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [hint, setHint] = useState('');
  const [busy, setBusy] = useState(false);

  if (status === 'loading') {
    return (
      <section className="chat-section">
        <h2 className="chat-section__title">Start a channel</h2>
        <p className="ui-muted">Checking for your identity...</p>
      </section>
    );
  }
  if (status !== 'ready') {
    return (
      <section className="chat-section" aria-labelledby="chat-create-title">
        <h2 id="chat-create-title" className="chat-section__title">
          Start a channel
        </h2>
        <Callout tone="info" title="You need an identity to start a channel">
          The channel is signed with your key. You can read every channel without one. <Link to="/keys">Create or restore an identity</Link>.
        </Callout>
      </section>
    );
  }

  function changeTitle(value) {
    setTitle(value);
    if (!idTouched) setChannelId(slugifyTitle(value));
  }

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    const check = checkChannelInput({ title, channelId, docId });
    setErrors(check.errors);
    setFormError('');
    setHint('');
    if (!check.ok) return;
    setBusy(true);
    try {
      const record = buildChannelRecord({ ...check.values, signer: identity.keyId });
      const signature = await identity.sign(record);
      await createChannel(record, signature);
      if (onCreated) onCreated(record.channelId);
      navigate(`/chat/${record.channelId}`);
    } catch (err) {
      const info = describeApiError(err, 'create the channel');
      if (err && (err.code === 'exists' || err.status === 409)) {
        setErrors({ channelId: 'That channel id is already taken. Pick another one.' });
      } else {
        setFormError(info.message);
        setHint(info.hint);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="chat-section" aria-labelledby="chat-create-title">
      <h2 id="chat-create-title" className="chat-section__title">
        Start a channel
      </h2>
      <form className="ui-stack" onSubmit={submit} noValidate>
        <Field label="Title" error={errors.title} hint="What people see in the list, up to 60 characters.">
          <input type="text" value={title} onChange={(e) => changeTitle(e.target.value)} maxLength={200} autoComplete="off" />
        </Field>
        <Field
          label="Channel id"
          error={errors.channelId}
          hint="Part of the web address, for example town-hall. Lowercase letters, digits and hyphens, 3 to 40 characters. It cannot be changed later."
        >
          <input
            type="text"
            value={channelId}
            onChange={(e) => {
              setIdTouched(true);
              setChannelId(e.target.value.toLowerCase());
            }}
            maxLength={60}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
        </Field>
        <Field
          label="Linked document (optional)"
          error={errors.docId}
          hint="Paste a document id or its link to attach this channel to a document."
        >
          <input type="text" value={docId} onChange={(e) => setDocId(e.target.value)} maxLength={300} autoComplete="off" spellCheck={false} />
        </Field>
        {formError ? (
          <Callout tone="bad" title="The channel was not created">
            <p>{formError}</p>
            {hint === 'keys' ? (
              <p>
                <Link to="/keys">Open the Keys page</Link>
              </p>
            ) : null}
          </Callout>
        ) : null}
        <div>
          <Button type="submit" variant="primary" loading={busy}>
            Sign and create channel
          </Button>
        </div>
      </form>
    </section>
  );
}
