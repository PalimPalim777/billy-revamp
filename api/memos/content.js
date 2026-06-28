// api/memos/content.js — GET /api/memos/content?limit=&cursor=
// Bulk memo-content sweep. Body stays ciphertext (memo_ciphertext/_iv); the
// branch-#1 plaintext columns (kind, parent_memo_id, cooldown_until) ride along.
// para_bucket / time_reference live INSIDE memo_ciphertext — server cannot
// filter on them; the login loader decrypts client-side, then selectChats filters.
// No kind filter here: selection policy lives in the pure selector, not the endpoint.
const { parseCookies } = require('../../lib/cookies');
const { verifySession } = require('../../lib/session');
const { supabase } = require('../../lib/supabase');
const { getQuery, parseLimit, encodeCursor, decodeCursor, seekPredicate } = require('../../lib/keyset');

function badInput(res, detail) {
  res.statusCode = 400;
  res.end(JSON.stringify({ error: 'bad_input', detail }));
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'method_not_allowed' }));
    return;
  }
  const cookies = parseCookies(req);
  const payload = cookies.billy_session ? verifySession(cookies.billy_session) : null;
  if (!payload || !payload.uid) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: 'unauthenticated' }));
    return;
  }

  const q = getQuery(req);
  const limit = parseLimit(q.limit);
  if (limit === '__bad__') return badInput(res, 'limit');
  let after = null;
  if (q.cursor) { after = decodeCursor(q.cursor); if (!after) return badInput(res, 'cursor'); }

  let query = supabase
    .from('memos')
    .select('id, created_at, memo_ciphertext, memo_iv, kind, parent_memo_id, cooldown_until')
    .eq('user_id', payload.uid);
  if (after) query = query.or(seekPredicate(after));
  query = query.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit);

  const { data, error } = await query;
  if (error) { res.statusCode = 500; res.end(JSON.stringify({ error: 'server' })); return; }

  const rows = data || [];
  const next_cursor = rows.length < limit
    ? null
    : encodeCursor(rows[rows.length - 1].created_at, rows[rows.length - 1].id);
  const memos = rows.map((r) => ({
    id: r.id,
    memo_ciphertext: r.memo_ciphertext,
    memo_iv: r.memo_iv,
    kind: r.kind,
    parent_memo_id: r.parent_memo_id,
    cooldown_until: r.cooldown_until,
  }));

  res.statusCode = 200;
  res.end(JSON.stringify({ memos, next_cursor }));
};
