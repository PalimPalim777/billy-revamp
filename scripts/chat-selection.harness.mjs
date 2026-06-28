import {
  computeInDegreeCentrality,
  selectChats,
  getDueDate,
  SELECTION_CONFIG,
  CENTRALITY_FN_VERSION,
} from '../public/lib/chat/chat-selection.js';

let failures = 0;
const ok = (cond, msg) => {
  if (cond) { console.log('PASS  ' + msg); }
  else { console.error('FAIL  ' + msg); failures++; }
};
const approx = (a, b) => Math.abs(a - b) < 1e-9;
const ids = (list) => list.map((x) => x.hubMemoId);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const now = Date.parse('2026-06-28T00:00:00Z');
const future = '2026-12-31T00:00:00Z';

const memos = [
  { memo_id: 'm1', kind: 'memo', para_bucket: 'Projects',  time_reference: null },
  { memo_id: 'm2', kind: 'memo', para_bucket: 'Areas',     time_reference: 'next week' },
  { memo_id: 'm3', kind: 'memo', para_bucket: 'Projects',  time_reference: 'tomorrow 15:45' },
  { memo_id: 'm4', kind: 'memo', para_bucket: 'Areas',     time_reference: null },
  { memo_id: 'm5', kind: 'memo', para_bucket: 'Resources', time_reference: null },
  { memo_id: 'm6', kind: 'chat-transcript', para_bucket: 'Projects', time_reference: null },
];

const blobs = [
  { memo_id: 'm1', neighbors: [] },
  { memo_id: 'm2', neighbors: [{ memo_id: 'm1', score: 0.9 }] },
  { memo_id: 'm3', neighbors: [{ memo_id: 'm1', score: 0.8 }, { memo_id: 'm2', score: 0.5 }] },
  { memo_id: 'm4', neighbors: [{ memo_id: 'm1', score: 0.7 }, { memo_id: 'm3', score: 0.4 }] },
  { memo_id: 'm5', neighbors: [{ memo_id: 'm2', score: 0.6 }] },
  { memo_id: 'm6', neighbors: [{ memo_id: 'm1', score: 0.3 }] },
];

const c = computeInDegreeCentrality(blobs);
ok(approx(c.get('m1'), 2.7), 'centrality m1 = 2.7 (weighted in-degree, all-blob sweep)');
ok(approx(c.get('m2'), 1.1), 'centrality m2 = 1.1');
ok(approx(c.get('m3'), 0.4), 'centrality m3 = 0.4');
ok(!c.has('m4'), 'centrality m4 absent (no incoming) -> treated as 0');
ok(c.get('m1') > c.get('m2') && c.get('m2') > c.get('m3'), 'centrality rank m1 > m2 > m3');

const cooldownByMemoId = new Map([['m2', future]]); // m2 benched
const base = { memos, centralityByMemoId: c, cooldownByMemoId, now };

// A: free = 3, no machine-dated memo -> melt -> 3 central hubs by rank
const a = selectChats({ ...base, activeChatCount: 4 });
ok(eq(ids(a), ['m1', 'm3', 'm4']), 'A: ranked central feed = [m1,m3,m4]');
ok(!ids(a).includes('m2'), 'A: cooled m2 excluded by novelty');
ok(!ids(a).includes('m5'), 'A: non-eligible bucket (Resources) m5 excluded');
ok(!ids(a).includes('m6'), 'A: chat-transcript m6 excluded by kind');
ok(a.every((x) => x.reason !== 'time-bound'), 'A: reserved slot melted (no machine date today)');

// B: free = 0 -> backpressure, never over-propose
const b = selectChats({ ...base, activeChatCount: SELECTION_CONFIG.CHAT_SLOT_CAP });
ok(b.length === 0, 'B: zero free slots -> [] (backpressure)');

// C: free = 1 -> cap respected
const cc = selectChats({ ...base, activeChatCount: SELECTION_CONFIG.CHAT_SLOT_CAP - 1 });
ok(eq(ids(cc), ['m1']), 'C: free=1 -> single top hub');

// D0: NL-only today -> getDueDate null everywhere
ok(memos.every((m) => getDueDate(m) === null), 'D0: getDueDate null for NL-only time_reference');

// D: v2 seam -> a structured ISO due_date lights the reserved slot
const memosV2 = memos.map((m) => (m.memo_id === 'm3' ? { ...m, due_date: future } : m));
const d = selectChats({ ...base, memos: memosV2, activeChatCount: 4 });
ok(eq(ids(d), ['m3', 'm1', 'm4']), 'D: dated m3 takes reserved slot, then central [m1,m4]');
ok(d[0].reason === 'time-bound', 'D: first slot is the time-bound reservation');

console.log('\ncentrality_fn_version=' + CENTRALITY_FN_VERSION);
if (failures > 0) { console.error('\n' + failures + ' FAILURE(S)'); process.exit(1); }
console.log('\nALL CHECKS PASSED');
