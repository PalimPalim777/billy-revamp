const { parseCookies } = require('../../lib/cookies');
const { verifySession } = require('../../lib/session');
const { supabase } = require('../../lib/supabase');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Keyset page size for the full-corpus sweep (3.2b). An optional ?limit= may ask
// for fewer; never more. A named constant, never a literal.
const EMBEDDINGS_PAGE_SIZE = 200;

// created_at as PostgREST serializes timestamptz: ISO-8601 with optional
// fractional seconds and a Z / ±HH:MM zone. Validating a client-supplied cursor
// against this both rejects junk AND guarantees the value carries no PostgREST
// filter metacharacters (no comma / paren / space), so interpolating it into the
// keyset .or(...) below is injection-safe.
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function getQuery(req) {
  if (req.query) return req.query;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = new URL(req.url, `https://${host}`);
  const out = {};
  url.searchParams.forEach((v, k) => { out[k] = v; });
  return out;
}

function badInput(res, detail) {
  res.statusCode = 400;
  res.end(JSON.stringify({ error: 'bad_input', detail }));
}

// Opaque cursor over the (created_at, id) keyset. base64url keeps it URL-safe and
// not obviously structured to the client.
function encodeCursor(createdAt, id) {
  return Buffer.from(JSON.stringify({ c: createdAt, i: id }), 'utf8').toString('base64url');
}

// Returns { c, i } on success or null for any malformed cursor.
function decodeCursor(cursor) {
  try {
    const obj = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!obj || typeof obj.c !== 'string' || typeof obj.i !== 'string') return null;
    if (!ISO_TS_RE.test(obj.c) || !UUID_RE.test(obj.i)) return null;
    return { c: obj.c, i: obj.i };
  } catch {
    return null;
  }
}

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

  const q = getQuery(req);
  const exclude = q.exclude;
  const hasLimit = q.limit !== undefined;
  const hasCursor = q.cursor !== undefined;

  // exclude is now OPTIONAL. Validate only when present; when absent, exclude nothing.
  if (exclude !== undefined && !UUID_RE.test(exclude)) {
    badInput(res, 'exclude');
    return;
  }

  // ---- No-pagination path: byte-identical to the pre-3.2a endpoint ----------
  // With NEITHER limit NOR cursor present, this reproduces the original request
  // exactly — same 4-column SELECT (incl. embedding_model_version), same NOT NULL
  // filter, same created_at DESC order, same { memos } body. This is precisely the
  // 2.6 connection-scoring caller's request (?exclude=<uuid>, no pagination), so it
  // must not change. Pagination is layered separately below; this block is left as-is.
  if (!hasLimit && !hasCursor) {
    let query = supabase
      .from('memos')
      .select('id, embedding_ciphertext, embedding_iv, embedding_model_version')
      .eq('user_id', payload.uid);
    if (exclude !== undefined) query = query.neq('id', exclude);
    const { data, error } = await query
      .not('embedding_ciphertext', 'is', null)
      .order('created_at', { ascending: false });

    if (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'server' }));
      return;
    }

    res.statusCode = 200;
    res.end(JSON.stringify({ memos: data || [] }));
    return;
  }

  // ---- Paginated sweep path (new in 3.2a) -----------------------------------
  // Keyset over a stable total order (created_at DESC, id DESC) on the existing
  // (user_id, created_at DESC) index; id breaks created_at ties so paging is
  // lossless against the UUID primary key. Rows carry ONLY id + embedding_ciphertext
  // + embedding_iv — created_at is selected solely to build the cursor and is
  // stripped before responding. Ownership (user_id) and the NOT NULL filter hold.
  let limit = EMBEDDINGS_PAGE_SIZE;
  if (hasLimit) {
    const n = Number(q.limit);
    if (!Number.isInteger(n) || n < 1 || n > EMBEDDINGS_PAGE_SIZE) {
      badInput(res, 'limit');
      return;
    }
    limit = n;
  }

  let after = null;
  if (hasCursor) {
    after = decodeCursor(q.cursor);
    if (!after) { badInput(res, 'cursor'); return; }
  }

  let query = supabase
    .from('memos')
    .select('id, embedding_ciphertext, embedding_iv, created_at')
    .eq('user_id', payload.uid)
    .not('embedding_ciphertext', 'is', null);
  if (exclude !== undefined) query = query.neq('id', exclude);
  if (after) {
    // Rows strictly after the cursor in (created_at DESC, id DESC) order.
    query = query.or(`created_at.lt.${after.c},and(created_at.eq.${after.c},id.lt.${after.i})`);
  }

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);

  if (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'server' }));
    return;
  }

  const rows = data || [];
  // A full page implies there may be more; a short page means the sweep is exhausted.
  let next_cursor = null;
  if (rows.length === limit) {
    const last = rows[rows.length - 1];
    next_cursor = encodeCursor(last.created_at, last.id);
  }
  // Strip created_at — present only to build the cursor, never returned.
  const memos = rows.map(({ created_at, ...rest }) => rest);

  res.statusCode = 200;
  res.end(JSON.stringify({ memos, next_cursor }));
};
