import { encryptStringWithDEK } from '../crypto/dek.js';
import { getSessionDEK } from '../crypto/session-dek.js';

export async function saveMemo(memo, promptVersion) {
  const dek = await getSessionDEK();
  if (!dek) throw new Error('MEMO_NO_DEK');

  const id = crypto.randomUUID();
  const plaintext = JSON.stringify(memo);
  const { ciphertext_b64, iv_b64 } = await encryptStringWithDEK(plaintext, dek);

  const r = await fetch('/api/memos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      id,
      memo_ciphertext: ciphertext_b64,
      memo_iv: iv_b64,
      prompt_version: promptVersion
    })
  });

  if (r.status === 401) throw new Error('MEMO_AUTH');
  if (r.status === 400) {
    const j = await r.json().catch(() => ({}));
    throw new Error(`MEMO_BAD_INPUT_${j.detail || 'unknown'}`);
  }
  if (r.status === 409) throw new Error('MEMO_ID_CONFLICT');
  if (!r.ok) throw new Error(`MEMO_HTTP_${r.status}`);

  const out = await r.json();
  return { id: out.id, created_at: out.created_at };
}
