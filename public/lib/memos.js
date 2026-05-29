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

export async function saveEmbedding(memoId, embeddingFloat32, modelVersion) {
  const dek = await getSessionDEK();
  if (!dek) throw new Error('EMBED_NO_DEK');

  const { float32ArrayToBase64 } = await import('./embeddings.js');
  const plaintext_b64 = float32ArrayToBase64(embeddingFloat32);
  // encryptStringWithDEK takes a UTF-8 string; a base64 string is valid UTF-8.
  const { ciphertext_b64, iv_b64 } = await encryptStringWithDEK(plaintext_b64, dek);

  const r = await fetch(`/api/memos/${memoId}/embedding`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      embedding_ciphertext: ciphertext_b64,
      embedding_iv: iv_b64,
      embedding_model_version: modelVersion
    })
  });

  if (r.status === 401) throw new Error('EMBED_AUTH');
  if (r.status === 404) throw new Error('EMBED_NOT_FOUND');
  if (r.status === 400) {
    const j = await r.json().catch(() => ({}));
    throw new Error(`EMBED_BAD_INPUT_${j.detail || 'unknown'}`);
  }
  if (!r.ok) throw new Error(`EMBED_HTTP_${r.status}`);
}

export async function fetchOtherEmbeddings(excludeMemoId) {
  const r = await fetch(`/api/memos/embeddings?exclude=${encodeURIComponent(excludeMemoId)}`, {
    method: 'GET',
    credentials: 'same-origin'
  });
  if (r.status === 401) throw new Error('EMBED_FETCH_AUTH');
  if (!r.ok) throw new Error(`EMBED_FETCH_HTTP_${r.status}`);
  const out = await r.json();
  return out.memos || [];
}

export async function saveConnectionBlob(memoId, blob, scoringFnVersion) {
  const dek = await getSessionDEK();
  if (!dek) throw new Error('BLOB_NO_DEK');

  const plaintext = JSON.stringify(blob);
  const { ciphertext_b64, iv_b64 } = await encryptStringWithDEK(plaintext, dek);

  const r = await fetch(`/api/memos/${memoId}/connection-blob`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      connection_blob_ciphertext: ciphertext_b64,
      connection_blob_iv: iv_b64,
      scoring_fn_version: scoringFnVersion
    })
  });

  if (r.status === 401) throw new Error('BLOB_AUTH');
  if (r.status === 404) throw new Error('BLOB_NOT_FOUND');
  if (r.status === 400) {
    const j = await r.json().catch(() => ({}));
    throw new Error(`BLOB_BAD_INPUT_${j.detail || 'unknown'}`);
  }
  if (!r.ok) throw new Error(`BLOB_HTTP_${r.status}`);
}
