// Sending a message, without React, so every branch can be tested in Node.
//
//   prepareItem   body + identity -> a signed pending item { id, hash, record, signature, status, error }
//   refreshItem   the same text signed again with a fresh time (an old record is no longer accepted)
//   deliverItem   posts the item and reports each state through patch(id, { status, error })
//
// The server only accepts a signed message for a few minutes (canResend in chatClient.js), and a
// repeat of a record it already has answers 409, which counts as delivered, so a lost answer never
// causes a second message.
import { recordHash } from '../../../shared/records.js';
import { buildMessageRecord, describeApiError } from '../../lib/chatClient.js';

export async function prepareItem({ channelId, body, parent, identity }) {
  const record = buildMessageRecord({
    channelId,
    body,
    replyTo: parent && parent.hash ? parent.hash : '',
    signer: identity.keyId
  });
  const signature = await identity.sign(record);
  const hash = await recordHash(record);
  return { id: hash, hash, record, signature, status: 'sending', error: '' };
}

export async function refreshItem({ channelId, item, identity }) {
  const record = buildMessageRecord({
    channelId,
    body: item.record.body,
    replyTo: item.record.replyTo,
    signer: identity.keyId
  });
  const signature = await identity.sign(record);
  const hash = await recordHash(record);
  return { id: hash, hash, record, signature, status: 'sending', error: '' };
}

// post(channelId, record, signature) is the api call. registerAgain() registers the key with the
// server once more (used when the server answers unknown_signer, tried once). kick() asks the
// poller to look for the new message now. Returns the final status: 'sent' or 'failed'.
export async function deliverItem(item, { channelId, post, patch, kick = () => {}, registerAgain, retry = false }) {
  patch(item.id, { status: 'sending', error: '' });
  for (let attempt = 0; ; attempt++) {
    try {
      await post(channelId, item.record, item.signature);
      patch(item.id, { status: 'sent', error: '' });
      kick();
      return 'sent';
    } catch (err) {
      if (retry && err && err.status === 409) {
        patch(item.id, { status: 'sent', error: '' });
        kick();
        return 'sent';
      }
      if (err && err.code === 'unknown_signer' && attempt === 0 && typeof registerAgain === 'function') {
        try {
          await registerAgain();
          continue;
        } catch {
          // the plain message below explains it
        }
      }
      patch(item.id, { status: 'failed', error: describeApiError(err, 'send the message').message });
      return 'failed';
    }
  }
}
