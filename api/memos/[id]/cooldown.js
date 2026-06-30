const { parseCookies } = require('../../../lib/cookies');
const { verifySession } = require('../../../lib/session');
const { supabase } = require('../../../lib/supabase');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// ISO-8601 UTC instant, e.g. 2026-06-30T12:34:56.789Z — the shape new Date().toISOString() emits.
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

// Same defensive posture as api/memos/index.js / connection-blob.js: a plaintext-shaped
// field anywhere in the body is a bug or an attack and is rejected before the update.
const FORBIDDEN_FIELDS = [
  'title', 'body', 'tags', 'summary', 'time_reference',
  'para_bucket', 'content', 'plaintext', 'memo'
];

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
  const m = url.pathname.match(/\/api\/memos\/([^/]+)\/cooldown/);
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

  if (req.method !== 'PUT') {
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

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    // Do not echo the body.
    badInput(res, 'invalid_json');
    return;
  }

  const forbidden = findForbiddenKey(body);
  if (forbidden) { badInput(res, `plaintext_field:${forbidden}`); return; }

  // cooldown_until is a plaintext metadata timestamp (rides alongside ciphertext, like
  // kind / prompt_version). Validate it is an ISO-8601 UTC instant AND a real date.
  const cd = body.cooldown_until;
  if (typeof cd !== 'string' || !ISO_UTC_RE.test(cd) || Number.isNaN(Date.parse(cd))) {
    badInput(res, 'cooldown_until');
    return;
  }

  // The user_id predicate makes cross-user updates impossible even if the id is guessed.
  // ANCHOR-ONLY: this writes the cooldown of exactly ONE memo (the hub). Neighbors are
  // never touched here; selection's isNovel() keeps them eligible so the focus walks the graph.
  const { data, error } = await supabase
    .from('memos')
    .update({ cooldown_until: cd })
    .eq('id', id)
    .eq('user_id', payload.uid)
    .select('id');

  if (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'server' }));
    return;
  }

  // Zero rows updated: wrong id, or correct id but not this user's. One indistinguishable
  // 404 (no enumeration oracle), matching the sibling memos endpoints.
  if (!data || data.length === 0) {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true }));
};
