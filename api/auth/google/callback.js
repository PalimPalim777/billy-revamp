const { parseCookies, setSessionCookie, appendSetCookie } = require('../../../lib/cookies');
const { signSession } = require('../../../lib/session');
const { supabase } = require('../../../lib/supabase');

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? 0 : 4 - (str.length % 4);
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function getQuery(req) {
  if (req.query) return req.query;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = new URL(req.url, `https://${host}`);
  const out = {};
  url.searchParams.forEach((v, k) => { out[k] = v; });
  return out;
}

module.exports = async function handler(req, res) {
  try {
    const query = getQuery(req);
    const code = query.code;
    const state = query.state;
    const cookies = parseCookies(req);
    const cookieState = cookies.billy_oauth_state;

    if (!state || !cookieState || state !== cookieState) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'text/plain');
      res.end('Invalid OAuth state');
      return;
    }

    if (!code) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'text/plain');
      res.end('Missing authorization code');
      return;
    }

    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const redirectUri = `https://${host}/api/auth/google/callback`;

    const tokenBody = new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    });

    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody.toString()
    });

    if (!tokenResp.ok) {
      const text = await tokenResp.text();
      res.statusCode = 502;
      res.setHeader('Content-Type', 'text/plain');
      res.end(`Token exchange failed: ${text}`);
      return;
    }

    const tokens = await tokenResp.json();
    const idToken = tokens.id_token;
    if (!idToken) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'text/plain');
      res.end('Missing id_token from Google');
      return;
    }

    const segments = idToken.split('.');
    if (segments.length !== 3) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'text/plain');
      res.end('Malformed id_token');
      return;
    }

    const claims = JSON.parse(b64urlDecode(segments[1]));
    const sub = claims.sub;
    const email = claims.email;

    if (!sub || !email) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'text/plain');
      res.end('id_token missing required claims');
      return;
    }

    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from('users')
      .upsert(
        { google_sub: sub, email, updated_at: now },
        { onConflict: 'google_sub' }
      )
      .select('id')
      .single();

    if (error || !data) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/plain');
      res.end(`User upsert failed: ${error ? error.message : 'no row'}`);
      return;
    }

    const token = signSession({ uid: data.id, email });
    setSessionCookie(res, token);
    appendSetCookie(
      res,
      'billy_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'
    );

    res.statusCode = 302;
    res.setHeader('Location', '/app');
    res.end();
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain');
    res.end(`Callback error: ${err.message}`);
  }
};
