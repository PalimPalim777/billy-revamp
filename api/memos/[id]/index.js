const { parseCookies } = require('../../../lib/cookies');
const { verifySession } = require('../../../lib/session');
const { supabase } = require('../../../lib/supabase');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getMemoId(req) {
  if (req.query && req.query.id) return req.query.id;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = new URL(req.url, `https://${host}`);
  const m = url.pathname.match(/\/api\/memos\/([^/]+)\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

function badInput(res, detail) {
  res.statusCode = 400;
  res.end(JSON.stringify({ error: 'bad_input', detail }));
}

// GET /api/memos/<id> — returns the owner's single memo CONTENT ciphertext so the
// retrieve client can decrypt it locally with the session DEK. The server never
// sees plaintext: it returns ONLY memo_ciphertext + memo_iv (and the id), never any
// plaintext-derived field, and never the embedding or connection-blob columns.
// Read-only; writes nothing.
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

  const id = getMemoId(req);
  if (!UUID_RE.test(id || '')) { badInput(res, 'id'); return; }

  // Tight select: ONLY the content ciphertext columns. Ownership is enforced by
  // BOTH .eq('id') AND .eq('user_id') — a guessed id belonging to another user
  // returns the same 404 as a nonexistent id (no enumeration oracle).
  const { data, error } = await supabase
    .from('memos')
    .select('id, memo_ciphertext, memo_iv')
    .eq('id', id)
    .eq('user_id', payload.uid);

  if (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'server' }));
    return;
  }

  // Missing row, or a row owned by someone else: one indistinguishable 404.
  if (!data || data.length === 0) {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  const row = data[0];
  res.statusCode = 200;
  res.end(JSON.stringify({ id: row.id, memo_ciphertext: row.memo_ciphertext, memo_iv: row.memo_iv }));
};
