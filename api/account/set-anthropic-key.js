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

  // Accept ONLY wrapped (ciphertext) material. Reject any field that looks like a
  // plaintext Anthropic key so it can never be persisted server-side by mistake.
  const plaintextish = ['key', 'api_key', 'anthropic_key', 'plaintext'];
  for (const f of plaintextish) {
    if (f in body) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'plaintext_key_rejected', field: f }));
      return;
    }
  }

  const fields = ['anthropic_key_wrapped', 'anthropic_key_iv'];
  for (const f of fields) {
    if (!isB64(body[f])) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'invalid_field', field: f }));
      return;
    }
  }

  const now = new Date().toISOString();
  const { error: updateErr } = await supabase
    .from('users')
    .update({
      anthropic_key_wrapped: body.anthropic_key_wrapped,
      anthropic_key_iv: body.anthropic_key_iv,
      onboarding_complete: true,
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
