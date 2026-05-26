const { supabase } = require('../../lib/supabase');
const { normalize, validateFormat } = require('../../lib/usernames');
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
  const validation = validateFormat(username);
  if (!validation.ok) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: validation.reason }));
    return;
  }

  const { data, error } = await supabase
    .from('users')
    .insert({ username })
    .select('id')
    .single();

  if (error) {
    if (error.code === '23505') {
      res.statusCode = 409;
      res.end(JSON.stringify({ error: 'taken' }));
      return;
    }
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'insert_failed', message: error.message }));
    return;
  }

  const token = signSession({ uid: data.id, username });
  setSessionCookie(res, token);
  res.statusCode = 200;
  res.end(JSON.stringify({ user_id: data.id, username }));
};
