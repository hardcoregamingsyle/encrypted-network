import { useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSignInPrompt } from '../AuthPrompt.jsx';
import Button from '../Button.jsx';
import Callout from '../Callout.jsx';
import Field from '../Field.jsx';
import Sheet from '../Sheet.jsx';
import { useToast } from '../Toast.jsx';
import { createChannel } from '../../lib/api.js';
import { buildChannelRecord, checkNewChatInput, describeApiError, newChannelId } from '../../lib/chatClient.js';
import { useSession } from '../../lib/session.jsx';

const ATTEMPTS = 3;

// The "New chat" sheet: a title and, if wanted, a linked file. The chat id is made for the person.
// The record is signed in the browser. Signed out visitors get the sign in sheet instead.
export default function NewChatSheet({ open, onClose, onCreated }) {
  const session = useSession();
  const { identity } = session;
  const prompt = useSignInPrompt();
  const toast = useToast();
  const navigate = useNavigate();
  const formId = useId();
  const [title, setTitle] = useState('');
  const [docId, setDocId] = useState('');
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) return;
    setTitle('');
    setDocId('');
    setErrors({});
    setFormError('');
    setBusy(false);
  }, [open]);

  // Signed out: ask for a sign in instead of showing a form that cannot work.
  useEffect(() => {
    if (open && !identity && session.status !== 'loading') {
      if (onClose) onClose();
      prompt.open('to start a chat');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, identity, session.status]);

  async function submit(e) {
    e.preventDefault();
    if (busy || !identity) return;
    const check = checkNewChatInput({ title, docId });
    setErrors(check.errors);
    setFormError('');
    if (!check.ok) return;
    setBusy(true);
    let registered = false;
    try {
      for (let attempt = 0; ; attempt++) {
        const channelId = newChannelId(check.values.title);
        const record = buildChannelRecord({ channelId, title: check.values.title, docId: check.values.docId, signer: identity.keyId });
        const signature = await identity.sign(record);
        try {
          await createChannel(record, signature);
          if (onCreated) onCreated(channelId);
          toast.push({ tone: 'good', text: 'Chat created.' });
          if (onClose) onClose();
          navigate(`/chats/${encodeURIComponent(channelId)}`);
          return;
        } catch (err) {
          const taken = err && (err.code === 'exists' || err.status === 409);
          if (taken && attempt < ATTEMPTS - 1) continue;
          if (err && err.code === 'unknown_signer' && !registered && typeof session.registerAgain === 'function') {
            registered = true;
            try {
              await session.registerAgain();
              continue;
            } catch {
              // the message below explains it
            }
          }
          throw err;
        }
      }
    } catch (err) {
      setFormError(describeApiError(err, 'create the chat').message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="New chat"
      description="Anyone can read a chat. You need to be signed in to write."
      footer={
        <div className="chat-sheetfoot">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form={formId} variant="primary" loading={busy}>
            Create chat
          </Button>
        </div>
      }
    >
      <form id={formId} className="ui-stack" onSubmit={submit} noValidate>
        <Field label="Chat name" error={errors.title} hint="What people see in the list, up to 60 characters.">
          <input type="text" data-autofocus value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoComplete="off" />
        </Field>
        <Field label="Linked file (optional)" error={errors.docId} hint="Paste the link of a file page to show that file at the top of the chat.">
          <input type="text" value={docId} onChange={(e) => setDocId(e.target.value)} maxLength={400} autoComplete="off" autoCapitalize="none" spellCheck={false} />
        </Field>
        {formError ? (
          <Callout tone="bad" title="The chat was not created">
            <p>{formError}</p>
          </Callout>
        ) : null}
      </form>
    </Sheet>
  );
}
