// public/lib/chat/chat-login-loader.js
// Branch #2 revamp/chat-selection — login-time I/O layer for the pure selector.
// Sweeps the bulk endpoints, decrypts client-side with the session DEK, builds the
// three inputs selectChats needs, returns the ordered candidate feed.
// Browser-only (fetch + Web Crypto + absolute /crypto import). NOT wired into the
// bootstrap here — #4 attaches it at the post-unlock seam. node --check = syntax only;
// real verification is the preview console. No LLM, no urgency, no date parsing.

import {
  selectChats,
  computeInDegreeCentrality,
  SELECTION_CONFIG,
} from './chat-selection.js';
import { decryptStringWithDEK } from '/crypto/dek.js';

export const SWEEP_PAGE_SIZE = 200; // mirrors retrieve; <= endpoint MAX_PAGE_SIZE (200)

// Keyset cursor-walk to exhaustion over a paginated GET. Mirrors retrieve-ui's loop
// (credentials same-origin; encodeURIComponent on cursor; next_cursor falsy ends).
// Returns raw stitched rows (no decrypt). Throws coded errors on auth/HTTP.
export async function sweepAll(path, key, { pageSize = SWEEP_PAGE_SIZE } = {}) {
  const rows = [];
  let cursor = null;
  do {
    const url = `${path}?limit=${pageSize}`
      + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const r = await fetch(url, { method: 'GET', credentials: 'same-origin' });
    if (r.status === 401) throw new Error('CHAT_SELECT_AUTH');
    if (r.status === 400) {
      const j = await r.json().catch(() => ({}));
      throw new Error(`CHAT_SELECT_BAD_INPUT_${j.detail || 'unknown'}`);
    }
    if (!r.ok) throw new Error(`CHAT_SELECT_HTTP_${r.status}`);
    const page = await r.json();
    for (const row of (page[key] || [])) rows.push(row);
    cursor = page.next_cursor || null;
  } while (cursor);
  return rows;
}

async function fetchActiveChatCount() {
  const r = await fetch('/api/chats/active-count', { method: 'GET', credentials: 'same-origin' });
  if (r.status === 401) throw new Error('CHAT_SELECT_AUTH');
  if (!r.ok) throw new Error(`CHAT_SELECT_HTTP_${r.status}`);
  const j = await r.json();
  return Number.isFinite(j.active_count) ? j.active_count : 0;
}

// Login-time selection. `dek` is the already-validated session CryptoKey (the bootstrap
// has redirected to /unlock if it was null). Returns the ordered (hub, proposed) feed.
export async function loadAndSelectChats({
  dek,
  now = Date.now(),
  config = SELECTION_CONFIG,
  pageSize = SWEEP_PAGE_SIZE,
} = {}) {
  if (!dek) throw new Error('CHAT_SELECT_NO_DEK'); // bootstrap guarantees non-null; defensive

  // 1. Blobs -> decrypt -> in-degree centrality. Per-row tolerant (skip corrupt, never fatal).
  const blobRows = await sweepAll('/api/memos/blobs', 'blobs', { pageSize });
  const parsedBlobs = [];
  for (const row of blobRows) {
    try {
      const pt = await decryptStringWithDEK(
        row.connection_blob_ciphertext, row.connection_blob_iv, dek);
      const blob = JSON.parse(pt); // { neighbors:[{memo_id,score}], scoring_fn_version }
      if (blob && Array.isArray(blob.neighbors)) parsedBlobs.push(blob);
    } catch (e) {
      console.warn('chat-selection: skipping undecryptable blob', row && row.id, e);
    }
  }
  const centralityByMemoId = computeInDegreeCentrality(parsedBlobs);

  // 2. Content -> decrypt for para_bucket/time_reference. kind/cooldown_until are plaintext
  //    columns. Endpoints return `id`; the selector keys on `memo_id` -> rename here.
  const contentRows = await sweepAll('/api/memos/content', 'memos', { pageSize });
  const memos = [];
  const cooldownByMemoId = new Map();
  for (const row of contentRows) {
    try {
      const pt = await decryptStringWithDEK(row.memo_ciphertext, row.memo_iv, dek);
      const parsed = JSON.parse(pt); // { title, body, para_bucket, tags, summary, time_reference, links? }
      memos.push({
        memo_id: row.id,                       // id -> memo_id (selector contract)
        kind: row.kind,                        // plaintext column
        para_bucket: parsed.para_bucket,       // decrypted -> bucket filter reads this
        time_reference: parsed.time_reference, // NL-only today; selector does NOT parse it
        due_date: parsed.due_date,             // absent until capture-prompt v2; getDueDate -> null
      });
      if (row.cooldown_until) cooldownByMemoId.set(row.id, row.cooldown_until); // id -> memo_id
    } catch (e) {
      console.warn('chat-selection: skipping undecryptable memo', row && row.id, e);
    }
  }

  // 3. Active chat count -> free-slot backpressure (proposed+responded; only ended frees).
  const activeChatCount = await fetchActiveChatCount();

  // 4. Pure, deterministic selection.
  return selectChats({ memos, centralityByMemoId, cooldownByMemoId, activeChatCount, now, config });
}
