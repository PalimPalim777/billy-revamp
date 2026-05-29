const { parseCookies } = require('../../lib/cookies');
const { verifySession } = require('../../lib/session');
const { supabase } = require('../../lib/supabase');

const BASE64_RE = /^[A-Za-z0-9+/]+=*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Field names that would indicate plaintext memo content leaking into the request.
// The server stores only ciphertext; presence of any of these at any depth is a bug
// (or an attack) and is rejected outright. Mirrors set-anthropic-key.js's posture.
const FORBIDDEN_FIELDS = [
  'title', 'body', 'tags', 'summary', 'time_reference',
  'para_bucket', 'content', 'plaintext', 'memo'
];

function isB64(s) {
  return typeof s === 'string' && s.length > 0 && BASE64_RE.test(s);
}

function findForbiddenKey(obj) {
  if (obj === null || typeof obj !== 'object') return null;
  for (const k of Object.keys(obj)) {
    if (FORBIDDEN_FIELDS.includes(k)) return k;
    const child = obj[k];
    if (child && typeof child === 'object') {
      const nested = findForbiddenKey(child);
      if (nested) return nested;
    }
  }
  return null;
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

function badInput(res, detail) {
  res.statusCode = 400;
  res.end(JSON.stringify({ error: 'bad_input', detail }));
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
    // Do not echo the body — it carries user ciphertext.
    badInput(res, 'invalid_json');
    return;
  }

  // Reject any plaintext-shaped field anywhere in the payload before anything else.
  const forbidden = findForbiddenKey(body);
  if (forbidden) {
    badInput(res, `plaintext_field:${forbidden}`);
    return;
  }

  if (!UUID_RE.test(body.id || '')) { badInput(res, 'id'); return; }
  if (!isB64(body.memo_ciphertext)) { badInput(res, 'memo_ciphertext'); return; }
  if (!isB64(body.memo_iv)) { badInput(res, 'memo_iv'); return; }
  if (typeof body.prompt_version !== 'string' || body.prompt_version.length === 0) {
    badInput(res, 'prompt_version');
    return;
  }

  const { data, error } = await supabase
    .from('memos')
    .insert({
      id: body.id,
      user_id: payload.uid,
      memo_ciphertext: body.memo_ciphertext,
      memo_iv: body.memo_iv,
      prompt_version: body.prompt_version
    })
    .select('id, created_at')
    .single();

  if (error) {
    if (error.code === '23505') {
      res.statusCode = 409;
      res.end(JSON.stringify({ error: 'id_conflict' }));
      return;
    }
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'server' }));
    return;
  }

  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, id: data.id, created_at: data.created_at }));
};
