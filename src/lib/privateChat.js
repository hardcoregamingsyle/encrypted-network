// Private chats: a message is locked in the browser with the group password of its chat (AES-GCM) before it is
// signed and sent, so what the server stores and what the signature covers is the locked text. The group
// password is made on the server when the chat is created, nobody picks or sees it, and members get it to lock
// and unlock with. The chat id is bound into every message, so a message cannot be moved to another chat.
import { base64UrlToBytes, bytesToBase64Url, concatBytes, utf8Decode, utf8Encode } from '../../shared/encoding.js';
import { getChannelKey } from './api.js';

// The longest text of a message in a private chat, in bytes. Locked and written as text it must fit the 2000
// character limit of a message (12 bytes of start value and 16 of check data are added, then 4 characters per 3 bytes).
export const PRIVATE_TEXT_MAX_BYTES = 1400;

const subtle = () => globalThis.crypto.subtle;

export async function loadGroupKey(channelId, opts) {
  const { key } = await getChannelKey(channelId, opts);
  return subtle().importKey('raw', base64UrlToBytes(key), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function sealText(key, channelId, text) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const locked = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: utf8Encode(channelId) }, key, utf8Encode(text)));
  return bytesToBase64Url(concatBytes(iv, locked));
}

// The text, or null when the message does not unlock with this chat's password.
export async function openText(key, channelId, body) {
  try {
    const raw = base64UrlToBytes(body);
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: utf8Encode(channelId) }, key, raw.slice(12));
    return utf8Decode(new Uint8Array(plain));
  } catch {
    return null;
  }
}
