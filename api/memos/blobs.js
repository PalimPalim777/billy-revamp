// api/memos/blobs.js — GET /api/memos/blobs?limit=&cursor=
// Bulk connection-blob sweep (ciphertext only) for login-time centrality.
// Mirrors embeddings.js auth + keyset pagination. Returns ONLY rows that have a
// blob (connection_blob_ciphertext NOT NULL) — an absent-data filter, not a
// selection-policy filter (selection rules live in the pure selector).
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
    .select('id, created_at, connection_blob_ciphertext, connection_blob_iv')
    .eq('user_id', payload.uid)
    .not('connection_blob_ciphertext', 'is', null);
  if (after) query = query.or(seekPredicate(after));
  query = query.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit);

  const { data, error } = await query;
  if (error) { res.statusCode = 500; res.end(JSON.stringify({ error: 'server' })); return; }

  const rows = data || [];
  const next_cursor = rows.length < limit
    ? null
    : encodeCursor(rows[rows.length - 1].created_at, rows[rows.length - 1].id);
  const blobs = rows.map((r) => ({
    id: r.id,
    connection_blob_ciphertext: r.connection_blob_ciphertext,
    connection_blob_iv: r.connection_blob_iv,
  }));

  res.statusCode = 200;
  res.end(JSON.stringify({ blobs, next_cursor }));
};
