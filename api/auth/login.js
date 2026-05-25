const { supabase } = require('../../lib/supabase');
const { normalize } = require('../../lib/usernames');
const { signSession } = require('../../lib/session');
const { setSessionCookie } = require('../../lib/cookies');

const rateLimitMap = new Map();
const RATE_LIMIT = 30;
const WINDOW_MS = 60 * 1000;

function getIP(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
}

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
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

  if (!checkRateLimit(getIP(req))) {
    res.statusCode = 429;
    res.end(JSON.stringify({ error: 'rate_limited' }));
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

  const username = normalize(body.username || '');

  const { data, error } = await supabase
    .from('users')
    .select('id, salt, kdf_version, dek_wrapped_by_password, dek_wrapped_by_password_iv, password_check_ciphertext, password_check_iv, password_check_auth_tag')
    .eq('username', username)
    .maybeSingle();

  if (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'lookup_failed' }));
    return;
  }

  if (!data) {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'no such user' }));
    return;
  }

  if (data.salt === null || data.salt === undefined) {
    res.statusCode = 409;
    res.end(JSON.stringify({ error: 'setup incomplete' }));
    return;
  }

  // Server does not verify the password. Security comes from the client failing
  // to unwrap the DEK with AES-GCM if the password is wrong (Bitwarden model).
  const token = signSession({ uid: data.id, username });
  setSessionCookie(res, token);

  res.statusCode = 200;
  res.end(JSON.stringify({
    salt: data.salt,
    kdf_version: data.kdf_version,
    dek_wrapped_by_password: data.dek_wrapped_by_password,
    dek_wrapped_by_password_iv: data.dek_wrapped_by_password_iv,
    password_check_ciphertext: data.password_check_ciphertext,
    password_check_iv: data.password_check_iv,
    password_check_auth_tag: data.password_check_auth_tag
  }));
};
