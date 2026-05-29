const { parseCookies } = require('../../lib/cookies');
const { verifySession } = require('../../lib/session');
const { supabase } = require('../../lib/supabase');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getQuery(req) {
  if (req.query) return req.query;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = new URL(req.url, `https://${host}`);
  const out = {};
  url.searchParams.forEach((v, k) => { out[k] = v; });
  return out;
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

  const exclude = getQuery(req).exclude;
  if (!UUID_RE.test(exclude || '')) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'bad_input', detail: 'exclude' }));
    return;
  }

  // Ciphertext only. This SELECT must NEVER include memo_ciphertext or any other
  // content column — only id + the embedding columns needed for client-side scoring.
  const { data, error } = await supabase
    .from('memos')
    .select('id, embedding_ciphertext, embedding_iv, embedding_model_version')
    .eq('user_id', payload.uid)
    .neq('id', exclude)
    .not('embedding_ciphertext', 'is', null)
    .order('created_at', { ascending: false });

  if (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'server' }));
    return;
  }

  res.statusCode = 200;
  res.end(JSON.stringify({ memos: data || [] }));
};
