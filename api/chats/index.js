const { parseCookies } = require('../../lib/cookies');
const { verifySession } = require('../../lib/session');
const { supabase } = require('../../lib/supabase');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isB64 = (s) => typeof s === 'string' && s.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(s);
const ALLOWED_POST_KEYS = ['id', 'hub_memo_id', 'transcript_ciphertext', 'transcript_iv', 'prompt_version'];

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

module.exports = async function handler(req, res) {
  const cookies = parseCookies(req);
  const payload = cookies.billy_session ? verifySession(cookies.billy_session) : null;
  if (!payload || !payload.uid) {
    res.statusCode = 401; res.end(JSON.stringify({ error: 'unauthenticated' })); return;
  }
  const uid = payload.uid;

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('chats')
      .select('id, hub_memo_id, state, transcript_ciphertext, transcript_iv, prompt_version, created_at, responded_at')
      .eq('user_id', uid)
      .neq('state', 'ended')
      .order('created_at', { ascending: true });
    if (error) { res.statusCode = 500; res.end(JSON.stringify({ error: 'server' })); return; }
    res.statusCode = 200; res.end(JSON.stringify({ chats: data || [] })); return;
  }

  if (req.method === 'POST') {
    let body;
    try { body = await readJsonBody(req); }
    catch { res.statusCode = 400; res.end(JSON.stringify({ error: 'bad_input', detail: 'json' })); return; }

    for (const k of Object.keys(body)) {
      if (!ALLOWED_POST_KEYS.includes(k)) {
        res.statusCode = 400; res.end(JSON.stringify({ error: 'bad_input', detail: 'unexpected_field:' + k })); return;
      }
    }
    const { id, hub_memo_id, transcript_ciphertext, transcript_iv, prompt_version } = body;
    if (!UUID_RE.test(id || '')) { res.statusCode = 400; res.end(JSON.stringify({ error: 'bad_input', detail: 'id' })); return; }
    if (!UUID_RE.test(hub_memo_id || '')) { res.statusCode = 400; res.end(JSON.stringify({ error: 'bad_input', detail: 'hub_memo_id' })); return; }
    if (!isB64(transcript_ciphertext)) { res.statusCode = 400; res.end(JSON.stringify({ error: 'bad_input', detail: 'transcript_ciphertext' })); return; }
    if (!isB64(transcript_iv)) { res.statusCode = 400; res.end(JSON.stringify({ error: 'bad_input', detail: 'transcript_iv' })); return; }
    if (typeof prompt_version !== 'string' || prompt_version.length === 0) { res.statusCode = 400; res.end(JSON.stringify({ error: 'bad_input', detail: 'prompt_version' })); return; }

    const { data, error } = await supabase
      .from('chats')
      .insert({
        id,
        user_id: uid,
        hub_memo_id,
        state: 'responded',
        transcript_ciphertext,
        transcript_iv,
        prompt_version,
        responded_at: new Date().toISOString(),
      })
      .select('id, created_at')
      .single();
    if (error) {
      if (error.code === '23505') { res.statusCode = 409; res.end(JSON.stringify({ error: 'id_conflict' })); return; }
      res.statusCode = 500; res.end(JSON.stringify({ error: 'server' })); return;
    }
    res.statusCode = 200; res.end(JSON.stringify({ ok: true, id: data.id, created_at: data.created_at })); return;
  }

  res.statusCode = 405; res.end(JSON.stringify({ error: 'method_not_allowed' }));
};
