// lib/keyset.js
// Keyset (seek) pagination over (created_at DESC, id DESC), mirroring the
// pattern in api/memos/embeddings.js. Independently authored: each endpoint's
// cursor only round-trips to that same endpoint, so byte-compatibility with
// embeddings.js cursors is NOT required — only internal correctness.
// The ISO/UUID validation in decodeCursor is what makes interpolating the
// cursor into a PostgREST .or(...) filter injection-safe. DO NOT relax it.

const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 200;

function getQuery(req) {
  if (req.query && typeof req.query === 'object') return req.query;
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  let url;
  try { url = new URL(req.url, `https://${host}`); } catch { return {}; }
  return Object.fromEntries(url.searchParams.entries());
}

// Integer in [1, MAX_PAGE_SIZE]; '__bad__' when present-but-invalid (-> badInput).
function parseLimit(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_PAGE_SIZE;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE_SIZE) return '__bad__';
  return n;
}

function encodeCursor(createdAt, id) {
  return Buffer.from(JSON.stringify({ c: createdAt, i: id })).toString('base64url');
}

// {c,i} on success; null on any malformation (-> badInput).
function decodeCursor(cursor) {
  let obj;
  try { obj = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); }
  catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  if (typeof obj.c !== 'string' || !ISO_TS_RE.test(obj.c)) return null;
  if (typeof obj.i !== 'string' || !UUID_RE.test(obj.i)) return null;
  return { c: obj.c, i: obj.i };
}

// PostgREST .or() seek predicate. Safe ONLY because after.c/after.i passed
// decodeCursor's ISO/UUID validation (no metacharacters can survive).
function seekPredicate(after) {
  return `created_at.lt.${after.c},and(created_at.eq.${after.c},id.lt.${after.i})`;
}

module.exports = {
  ISO_TS_RE, UUID_RE, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE,
  getQuery, parseLimit, encodeCursor, decodeCursor, seekPredicate,
};
