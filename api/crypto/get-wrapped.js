const { parseCookies } = require('../../lib/cookies');
const { verifySession } = require('../../lib/session');
const { supabase } = require('../../lib/supabase');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const cookies = parseCookies(req);
  const payload = cookies.billy_session ? verifySession(cookies.billy_session) : null;
  if (!payload || !payload.uid) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: 'unauthenticated' }));
    return;
  }

  const { data, error } = await supabase
    .from('users')
    .select('salt, kdf_version, dek_wrapped_by_password, dek_wrapped_by_password_iv, dek_wrapped_by_recovery, dek_wrapped_by_recovery_iv')
    .eq('id', payload.uid)
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

  res.statusCode = 200;
  res.end(JSON.stringify({
    setup_complete: true,
    salt: data.salt,
    kdf_version: data.kdf_version,
    dek_wrapped_by_password: data.dek_wrapped_by_password,
    dek_wrapped_by_password_iv: data.dek_wrapped_by_password_iv,
    dek_wrapped_by_recovery: data.dek_wrapped_by_recovery,
    dek_wrapped_by_recovery_iv: data.dek_wrapped_by_recovery_iv
  }));
};
