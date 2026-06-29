import { getSessionDEK } from '/crypto/session-dek.js';
import { encryptStringWithDEK, decryptStringWithDEK } from '/crypto/dek.js';

const CHAT_PROMPT_VERSION = 'lifeos-chat-v1';

export async function createRespondedChat({ hubMemoId, transcript }) {
  const dek = await getSessionDEK();
  if (!dek) throw new Error('CHAT_NO_DEK');
  const id = crypto.randomUUID();
  const { ciphertext_b64, iv_b64 } = await encryptStringWithDEK(JSON.stringify(transcript), dek);
  const r = await fetch('/api/chats', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      id,
      hub_memo_id: hubMemoId,
      transcript_ciphertext: ciphertext_b64,
      transcript_iv: iv_b64,
      prompt_version: CHAT_PROMPT_VERSION,
    }),
  });
  if (r.status === 401) throw new Error('CHAT_AUTH');
  if (r.status === 409) throw new Error('CHAT_ID_CONFLICT');
  if (r.status === 400) { let d = ''; try { d = (await r.json()).detail || ''; } catch {} throw new Error('CHAT_BAD_INPUT_' + d); }
  if (!r.ok) throw new Error('CHAT_SERVER_' + r.status);
  const out = await r.json();
  return { id, hubMemoId, transcript, createdAt: out.created_at };
}

export async function listChats() {
  const dek = await getSessionDEK();
  if (!dek) throw new Error('CHAT_NO_DEK');
  const r = await fetch('/api/chats', { method: 'GET', credentials: 'same-origin' });
  if (r.status === 401) throw new Error('CHAT_AUTH');
  if (!r.ok) throw new Error('CHAT_SERVER_' + r.status);
  const { chats = [] } = await r.json();
  const out = [];
  for (const c of chats) {
    let transcript = null;
    try {
      if (c.transcript_ciphertext && c.transcript_iv) {
        const pt = await decryptStringWithDEK(c.transcript_ciphertext, c.transcript_iv, dek);
        transcript = JSON.parse(pt);
      }
    } catch (e) {
      transcript = null; // skip undecryptable/corrupt row; never blank the whole list
    }
    out.push({ id: c.id, hubMemoId: c.hub_memo_id, state: c.state, transcript, createdAt: c.created_at, respondedAt: c.responded_at });
  }
  return out;
}
