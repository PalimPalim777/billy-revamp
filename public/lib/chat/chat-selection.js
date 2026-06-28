// Branch #2 revamp/chat-selection — PURE login-selection math.
// No network, no DOM, no crypto, no callLLM. Consumed by the login loader
// (commit 2) and the deterministic fixture harness. Selection = centrality x novelty.

export const CENTRALITY_FN_VERSION = 'weighted-indegree-v1';

export const SELECTION_CONFIG = {
  CHAT_SLOT_CAP: 7,                              // 5-10, tuned at build (decision 7)
  CHAT_ELIGIBLE_BUCKETS: ['Projects', 'Areas'],  // decision 3: within each Area/Project
  RESERVED_TIMEBOUND_SLOT: 'melt',               // 'melt' | 'empty' (NL-only today -> melt)
};

// Weighted in-degree centrality by sweeping ALL connection blobs. Forward-only
// blobs mean in-degree is NOT derivable from a memo's own blob; every blob is
// required. Input: [{ memo_id, neighbors:[{memo_id,score}] }]. Output:
// Map<memo_id, weightedInDegree>. Memos with no incoming edges are absent (=> 0).
export function computeInDegreeCentrality(allBlobs) {
  const indegree = new Map();
  for (const blob of allBlobs) {
    const neighbors = (blob && blob.neighbors) || [];
    for (const n of neighbors) {
      if (!n || typeof n.memo_id !== 'string') continue;
      const w = Number.isFinite(n.score) ? n.score : 0;
      indegree.set(n.memo_id, (indegree.get(n.memo_id) || 0) + w);
    }
  }
  return indegree;
}

// Deterministic due-date extractor. time_reference is NL-only today and we do
// NOT parse it (deterministic-over-fuzzy). Returns null for every memo until a
// capture-prompt v2 adds a machine-comparable due_date. Seam only.
export function getDueDate(memo) {
  if (memo && typeof memo.due_date === 'string' && memo.due_date.length > 0) {
    const t = Date.parse(memo.due_date);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function isNovel(memo, cooldownByMemoId, now) {
  const until = cooldownByMemoId.get(memo.memo_id);
  if (!until) return true;
  const t = typeof until === 'number' ? until : Date.parse(until);
  if (Number.isNaN(t)) return true;
  return t <= now; // cooldown elapsed => novel again
}

function cmpId(a, b) {
  return a.memo_id < b.memo_id ? -1 : a.memo_id > b.memo_id ? 1 : 0;
}

// Pure selector. Returns an ordered, free-slot-capped candidate list. Writes no
// rows (commit/#4 persists 'proposed'); this is the in-memory feed only.
export function selectChats({
  memos,
  centralityByMemoId,
  cooldownByMemoId,
  activeChatCount,
  now,
  config = SELECTION_CONFIG,
}) {
  const eligibleBuckets = new Set(config.CHAT_ELIGIBLE_BUCKETS);
  const freeSlots = Math.max(0, config.CHAT_SLOT_CAP - activeChatCount);
  if (freeSlots === 0) return []; // backpressure — never over-propose

  // Reserved time-bound slot (decision 6): soonest-due among non-cooled real
  // memos, cross-bucket (Express residue). null today => melt vs empty.
  const dated = memos
    .filter((m) => m.kind === 'memo')
    .filter((m) => isNovel(m, cooldownByMemoId, now))
    .map((m) => ({ m, due: getDueDate(m) }))
    .filter((x) => x.due !== null)
    .sort((a, b) => a.due - b.due || cmpId(a.m, b.m));
  const reservedHub = dated.length > 0 ? dated[0].m.memo_id : null;

  const out = [];
  let generalSlots = freeSlots;
  if (reservedHub !== null) {
    out.push({ hubMemoId: reservedHub, reason: 'time-bound', state: 'proposed' });
    generalSlots = freeSlots - 1;
  } else if (config.RESERVED_TIMEBOUND_SLOT === 'empty') {
    generalSlots = freeSlots - 1; // hold one slot empty
  } // 'melt' + no dated memo => all free slots flow to the general pool

  if (generalSlots > 0) {
    const ranked = memos
      .filter((m) => m.kind === 'memo')
      .filter((m) => eligibleBuckets.has(m.para_bucket))
      .filter((m) => m.memo_id !== reservedHub)
      .filter((m) => isNovel(m, cooldownByMemoId, now)) // novelty = not cooled (binary)
      .map((m) => ({ m, c: centralityByMemoId.get(m.memo_id) || 0 }))
      .sort((a, b) => b.c - a.c || cmpId(a.m, b.m)); // centrality x novelty; novelty binary
    for (const r of ranked.slice(0, generalSlots)) {
      out.push({ hubMemoId: r.m.memo_id, reason: 'central', centrality: r.c, state: 'proposed' });
    }
  }
  return out;
}
