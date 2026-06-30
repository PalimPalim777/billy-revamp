const { parseCookies } = require('../../../lib/cookies');
const { verifySession } = require('../../../lib/session');
const { supabase } = require('../../../lib/supabase');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getChatId(req) {
  if (req.query && req.query.id) return req.query.id;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = new URL(req.url, `https://${host}`);
  const m = url.pathname.match(/\/api\/chats\/([^/]+)\/end/);
  return m ? decodeURIComponent(m[1]) : null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'PUT') {
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

  const id = getChatId(req);
  if (!UUID_RE.test(id || '')) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'bad_input', detail: 'id' }));
    return;
  }

  // Transition responded -> ended. The .eq('state','responded') guard means:
  //   - an already-ended chat updates zero rows -> 404 (a double-end is a harmless no-op)
  //   - a (never-persisted) proposed chat cannot be ended
  // ended_at is server-set, mirroring responded_at in the POST path. slot is left NULL
  // (no reader); active-count frees the slot purely via state != 'ended'.
  const { data, error } = await supabase
    .from('chats')
    .update({ state: 'ended', ended_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', payload.uid)
    .eq('state', 'responded')
    .select('id');

  if (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'server' }));
    return;
  }

  // Zero rows: wrong id, not this user's, or not in 'responded' state. One indistinguishable
  // 404 (no enumeration oracle), matching the memos endpoints.
  if (!data || data.length === 0) {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true }));
};
