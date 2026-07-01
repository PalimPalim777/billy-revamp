// public/lib/chat/chat-end.js
// Branch #5b (revamp/chat-writeback-orchestration) — the End action / CODE conveyor.
// DORMANT: nothing imports this yet; #5c mounts it behind the End control in chat-ui.js.
//
// On End of a RESPONDED chat, chatEnd():
//   (a) generates a Claude-chat-style HEADLINE via the ONE new callLLM (cost tier 3);
//   (b) attaches raw transcript + headline as a HUB-CHILD node (kind='chat-transcript',
//       parent_memo_id=hub) — HARD GATE; the hub's own ciphertext/vector are NEVER touched
//       (locked decision A: attachment = child node + cooldown column, not a hub rewrite);
//   (c) split-embeds the node client-side (bge-small) and writes its K<=20 connection blob,
//       replicating capture's embedAndConnectAndSave (app.html) via the shared primitives —
//       best-effort, mirroring capture's pending-tolerance;
//   (d) benches the HUB — ANCHOR-ONLY cooldown_until (neighbors stay eligible so the focus
//       walks the graph) — best-effort + one retry;
//   (e) frees the slot LAST (responded -> ended), so a failed write-back never loses the
//       transcript: the chat stays 'responded' and re-endable.

import { getSessionDEK } from '/crypto/session-dek.js';
import { decryptStringWithDEK } from '/crypto/dek.js';
import { callLLM } from '/lib/llm.js';
import { loadChatHeadlinePromptV1 } from '/lib/prompts-loader.js';
import { saveMemo, saveEmbedding, fetchOtherEmbeddings, saveConnectionBlob } from '/lib/memos.js';
import {
  embedText,
  base64ToFloat32Array,
  topKNeighbors,
  SCORING_FN_VERSION,
  EMBEDDING_MODEL_VERSION
} from '/lib/embeddings.js';

export const CHAT_COOLDOWN_DAYS = 90;
export const HEADLINE_MAX_TOKENS = 64;
export const CHAT_HEADLINE_PROMPT_VERSION = 'lifeos-chat-headline-v1';

const DAY_MS = 24 * 60 * 60 * 1000;

// Conversation flattened for the headline LLM turn — role-labelled for clarity.
function transcriptForPrompt(transcript) {
  const msgs = (transcript && Array.isArray(transcript.messages)) ? transcript.messages : [];
  return msgs
    .map(m => `${m && m.role === 'assistant' ? 'Billy' : 'Me'}: ${(m && m.content) || ''}`)
    .join('\n');
}

// Conversation flattened for embedding — content only (role labels would be vector noise).
function transcriptForEmbedding(transcript) {
  const msgs = (transcript && Array.isArray(transcript.messages)) ? transcript.messages : [];
  return msgs
    .map(m => (m && typeof m.content === 'string') ? m.content : '')
    .filter(Boolean)
    .join('\n\n');
}

async function setHubCooldown(hubMemoId, isoUntil) {
  const r = await fetch(`/api/memos/${hubMemoId}/cooldown`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ cooldown_until: isoUntil })
  });
  if (!r.ok) throw new Error(`COOLDOWN_HTTP_${r.status}`);
}

async function endChatRecord(chatId) {
  const r = await fetch(`/api/chats/${chatId}/end`, {
    method: 'PUT',
    credentials: 'same-origin'
  });
  if (!r.ok) throw new Error(`END_HTTP_${r.status}`);
}

// Split-embed the transcript NODE (never the hub). Byte-faithful mirror of capture's
// embedAndConnectAndSave: embed -> saveEmbedding(node) -> fetchOthers -> decrypt-skip loop
// -> topKNeighbors -> saveConnectionBlob(node). Operates ONLY on nodeId. Returns neighbor count.
async function embedAndConnectNode(nodeId, transcript) {
  const vec = await embedText(transcriptForEmbedding(transcript));
  await saveEmbedding(nodeId, vec, EMBEDDING_MODEL_VERSION);

  const others = await fetchOtherEmbeddings(nodeId);
  if (others.length === 0) {
    await saveConnectionBlob(nodeId, { neighbors: [], scoring_fn_version: SCORING_FN_VERSION }, SCORING_FN_VERSION);
    return 0;
  }

  const dek = await getSessionDEK();
  if (!dek) throw new Error('BLOB_NO_DEK');

  const neighbors = [];
  for (const m of others) {
    try {
      const plaintext_b64 = await decryptStringWithDEK(m.embedding_ciphertext, m.embedding_iv, dek);
      neighbors.push({ id: m.id, vec: base64ToFloat32Array(plaintext_b64) });
    } catch (decryptErr) {
      // Skip a corrupt/undecryptable row; the blob stays valid with fewer neighbors (mirrors capture).
    }
  }

  const top = topKNeighbors(vec, neighbors);
  await saveConnectionBlob(nodeId, { neighbors: top, scoring_fn_version: SCORING_FN_VERSION }, SCORING_FN_VERSION);
  return top.length;
}

export async function chatEnd({ chatId, hubMemoId, transcript }) {
  if (!chatId || !hubMemoId || !transcript) throw new Error('END_BAD_ARGS');

  // (a) headline — the ONE new LLM call, gated to End (tier 3). Compute only, no persistence.
  const { system } = await loadChatHeadlinePromptV1();
  const raw = await callLLM({
    system,
    messages: [{ role: 'user', content: transcriptForPrompt(transcript) }],
    maxTokens: HEADLINE_MAX_TOKENS
  });
  const headline = (raw || '').trim();

  // (b) attach — insert the transcript as a HUB-CHILD node. HARD GATE: on failure, abort;
  //     the chat stays 'responded', nothing is benched or freed, a clean retry is possible.
  //     The hub row is untouched here (decision A): no saveMemo/saveEmbedding on the hub.
  const node = {
    kind: 'chat-transcript',
    parent_memo_id: hubMemoId,
    headline,
    transcript,
    body: headline
  };
  const { id: nodeId } = await saveMemo(node, CHAT_HEADLINE_PROMPT_VERSION);

  // (c) split-embed the NODE — best-effort (node is parented regardless, so never orphaned).
  let neighborCount = null;
  try {
    neighborCount = await embedAndConnectNode(nodeId, transcript);
  } catch (embedErr) {
    console.warn('[chat-end] node embed/blob deferred:', embedErr);
  }

  // (d) bench the HUB — ANCHOR-ONLY cooldown. Only the hub's cooldown_until is written.
  //     Best-effort + one retry; a miss degrades to "hub not benched", never data loss.
  const cooldownUntil = new Date(Date.now() + CHAT_COOLDOWN_DAYS * DAY_MS).toISOString();
  try {
    await setHubCooldown(hubMemoId, cooldownUntil);
  } catch (cd1) {
    try { await setHubCooldown(hubMemoId, cooldownUntil); }
    catch (cd2) { console.warn('[chat-end] hub cooldown deferred:', cd2); }
  }

  // (e) free the slot LAST — responded -> ended.
  await endChatRecord(chatId);

  return { nodeId, headline, neighborCount, cooldownUntil };
}
