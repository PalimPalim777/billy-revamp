const { supabase } = require('../../lib/supabase');
const { normalize, validateFormat, generateSuggestions } = require('../../lib/usernames');

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

function getQuery(req) {
  if (req.query) return req.query;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = new URL(req.url, `https://${host}`);
  const out = {};
  url.searchParams.forEach((v, k) => { out[k] = v; });
  return out;
}

async function getAvailableSuggestions(base) {
  const confirmed = [];
  let attempts = 0;
  while (confirmed.length < 3 && attempts < 50) {
    const candidates = generateSuggestions(base).filter(c => !confirmed.includes(c));
    attempts += candidates.length;
    const { data } = await supabase
      .from('users')
      .select('username')
      .in('username', candidates);
    const taken = new Set((data || []).map(r => r.username));
    for (const c of candidates) {
      if (!taken.has(c) && !confirmed.includes(c)) {
        confirmed.push(c);
        if (confirmed.length === 3) break;
      }
    }
  }
  return confirmed;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (!checkRateLimit(getIP(req))) {
    res.statusCode = 429;
    res.end(JSON.stringify({ error: 'rate_limited' }));
    return;
  }

  const query = getQuery(req);
  const name = normalize(query.u || '');
  const validation = validateFormat(name);

  if (!validation.ok) {
    res.statusCode = 200;
    const body = { available: false, reason: validation.reason };
    res.end(JSON.stringify(body));
    return;
  }

  const { data, error } = await supabase
    .from('users')
    .select('id')
    .eq('username', name)
    .maybeSingle();

  if (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'lookup_failed' }));
    return;
  }

  if (data) {
    const suggestions = await getAvailableSuggestions(name);
    res.statusCode = 200;
    res.end(JSON.stringify({ available: false, reason: 'taken', suggestions }));
    return;
  }

  res.statusCode = 200;
  res.end(JSON.stringify({ available: true }));
};
