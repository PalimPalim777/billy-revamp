// api/chats/active-count.js — GET /api/chats/active-count
// Active = state != 'ended' (proposed + responded both hold a slot; only ended
// frees one). Feeds selectChats's free-slot cap. Uses chats_user_state_idx.
const { parseCookies } = require('../../lib/cookies');
const { verifySession } = require('../../lib/session');
const { supabase } = require('../../lib/supabase');

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

  const { count, error } = await supabase
    .from('chats')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', payload.uid)
    .neq('state', 'ended');
  if (error) { res.statusCode = 500; res.end(JSON.stringify({ error: 'server' })); return; }

  res.statusCode = 200;
  res.end(JSON.stringify({ active_count: count || 0 }));
};
