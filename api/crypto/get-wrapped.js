const { parseCookies } = require('../../lib/cookies');
const { verifySession } = require('../../lib/session');
const { supabase } = require('../../lib/supabase');
const { normalize } = require('../../lib/usernames');

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

  const cookies = parseCookies(req);
  const payload = cookies.billy_session ? verifySession(cookies.billy_session) : null;

  let userId;
  let isAuthed = false;
  if (payload && payload.uid) {
    userId = payload.uid;
    isAuthed = true;
  } else {
    // ?u=<username> fallback for the unauthenticated recovery flow (/recover page).
    // The wrapped DEK is encrypted with AES-GCM; exposing it without a session is safe
    // because it is useless without the recovery phrase.
    const query = getQuery(req);
    const uParam = query.u;
    if (!uParam) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'unauthenticated' }));
      return;
    }
    const username = normalize(uParam);
    const { data: userRow, error: userErr } = await supabase
      .from('users')
      .select('id')
      .eq('username', username)
      .maybeSingle();
    if (userErr || !userRow) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'user_not_found' }));
      return;
    }
    userId = userRow.id;
  }

  const { data, error } = await supabase
    .from('users')
    .select('salt, kdf_version, dek_wrapped_by_password, dek_wrapped_by_password_iv, dek_wrapped_by_recovery, dek_wrapped_by_recovery_iv, anthropic_key_wrapped, anthropic_key_iv, onboarding_complete')
    .eq('id', userId)
    .single();

  if (error || !data) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'user_lookup_failed' }));
    return;
  }

  if (data.salt === null || data.salt === undefined) {
    res.statusCode = 200;
    res.end(JSON.stringify({ setup_complete: false }));
    return;
  }

  const responseBody = {
    setup_complete: true,
    salt: data.salt,
    kdf_version: data.kdf_version,
    dek_wrapped_by_password: data.dek_wrapped_by_password,
    dek_wrapped_by_password_iv: data.dek_wrapped_by_password_iv,
    dek_wrapped_by_recovery: data.dek_wrapped_by_recovery,
    dek_wrapped_by_recovery_iv: data.dek_wrapped_by_recovery_iv
  };

  // Anthropic-key material and onboarding state are returned ONLY on the
  // authenticated path. The unauthenticated ?u= recovery branch must return
  // exactly the fields /recover consumes — nothing more.
  if (isAuthed) {
    responseBody.anthropic_key_wrapped = data.anthropic_key_wrapped;
    responseBody.anthropic_key_iv = data.anthropic_key_iv;
    responseBody.onboarding_complete = data.onboarding_complete === true;
  }

  res.statusCode = 200;
  res.end(JSON.stringify(responseBody));
};
