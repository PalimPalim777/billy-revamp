const { parseCookies } = require('../../lib/cookies');
const { verifySession } = require('../../lib/session');
const { supabase } = require('../../lib/supabase');

const BASE64_RE = /^[A-Za-z0-9+/]+=*$/;

function isB64(s) {
  return typeof s === 'string' && s.length > 0 && BASE64_RE.test(s);
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
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

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'invalid_json' }));
    return;
  }

  const fields = [
    'salt',
    'dek_wrapped_by_password',
    'dek_wrapped_by_password_iv',
    'dek_wrapped_by_recovery',
    'dek_wrapped_by_recovery_iv'
  ];
  for (const f of fields) {
    if (!isB64(body[f])) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'invalid_field', field: f }));
      return;
    }
  }

  const { data: existing, error: readErr } = await supabase
    .from('users')
    .select('salt')
    .eq('id', payload.uid)
    .single();

  if (readErr || !existing) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'user_lookup_failed' }));
    return;
  }

  if (existing.salt !== null && existing.salt !== undefined) {
    res.statusCode = 409;
    res.end(JSON.stringify({ error: 'setup_already_complete' }));
    return;
  }

  const now = new Date().toISOString();
  const { error: updateErr } = await supabase
    .from('users')
    .update({
      salt: body.salt,
      kdf_version: 1,
      dek_wrapped_by_password: body.dek_wrapped_by_password,
      dek_wrapped_by_password_iv: body.dek_wrapped_by_password_iv,
      dek_wrapped_by_recovery: body.dek_wrapped_by_recovery,
      dek_wrapped_by_recovery_iv: body.dek_wrapped_by_recovery_iv,
      updated_at: now
    })
    .eq('id', payload.uid);

  if (updateErr) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'update_failed', message: updateErr.message }));
    return;
  }

  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true }));
};
