const { parseCookies } = require('../../../lib/cookies');
const { verifySession } = require('../../../lib/session');
const { supabase } = require('../../../lib/supabase');

const BASE64_RE = /^[A-Za-z0-9+/]+=*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same defensive posture as api/memos/index.js: a plaintext-shaped field anywhere in
// the body is a bug or an attack and is rejected before the update.
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

function getMemoId(req) {
  if (req.query && req.query.id) return req.query.id;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = new URL(req.url, `https://${host}`);
  const m = url.pathname.match(/\/api\/memos\/([^/]+)\/connection-blob/);
  return m ? decodeURIComponent(m[1]) : null;
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

  if (req.method !== 'GET' && req.method !== 'PUT') {
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

  const id = getMemoId(req);
  if (!UUID_RE.test(id || '')) { badInput(res, 'id'); return; }

  // GET /api/memos/<id>/connection-blob — read path (added for the retrieve neighbor
  // layer, milestone 3.4a). Returns ONLY this owner's connection-blob ciphertext columns
  // (plus the plaintext scoring_fn_version) so the client can decrypt the neighbor set
  // locally with the session DEK. Never returns memo/embedding content or any
  // plaintext-derived field. The content endpoint GET /api/memos/<id> is deliberately
  // left untouched (it still returns only memo_ciphertext/_iv); this is its sibling.
  if (req.method === 'GET') {
    // Ownership enforced by BOTH .eq('id') AND .eq('user_id'); a guessed id belonging to
    // another user returns the same 404 as a nonexistent id (no enumeration oracle).
    const { data, error } = await supabase
      .from('memos')
      .select('connection_blob_ciphertext, connection_blob_iv, scoring_fn_version')
      .eq('id', id)
      .eq('user_id', payload.uid);

    if (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'server' }));
      return;
    }

    // Missing row, or a row owned by someone else: one indistinguishable 404 (matches
    // GET /api/memos/<id>). A row that exists but has no blob yet returns 200 with null
    // columns — an honest "memo exists, no neighbors" signal, distinct from not_found.
    if (!data || data.length === 0) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    const row = data[0];
    res.statusCode = 200;
    res.end(JSON.stringify({
      connection_blob_ciphertext: row.connection_blob_ciphertext,
      connection_blob_iv: row.connection_blob_iv,
      scoring_fn_version: row.scoring_fn_version
    }));
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

  const forbidden = findForbiddenKey(body);
  if (forbidden) { badInput(res, `plaintext_field:${forbidden}`); return; }

  if (!isB64(body.connection_blob_ciphertext)) { badInput(res, 'connection_blob_ciphertext'); return; }
  if (!isB64(body.connection_blob_iv)) { badInput(res, 'connection_blob_iv'); return; }
  if (typeof body.scoring_fn_version !== 'string' || body.scoring_fn_version.length === 0) {
    badInput(res, 'scoring_fn_version');
    return;
  }

  // The user_id predicate makes cross-user updates impossible even if the id is guessed.
  const { data, error } = await supabase
    .from('memos')
    .update({
      connection_blob_ciphertext: body.connection_blob_ciphertext,
      connection_blob_iv: body.connection_blob_iv,
      scoring_fn_version: body.scoring_fn_version
    })
    .eq('id', id)
    .eq('user_id', payload.uid)
    .select('id');

  if (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'server' }));
    return;
  }

  // Zero rows updated: wrong id, or correct id but not this user's. Do not distinguish
  // (avoids a small enumeration oracle).
  if (!data || data.length === 0) {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true }));
};
