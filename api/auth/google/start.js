const crypto = require('node:crypto');
const { appendSetCookie } = require('../../../lib/cookies');

module.exports = function handler(req, res) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const redirectUri = `https://${host}/api/auth/google/callback`;
  const state = crypto.randomBytes(16).toString('hex');

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account',
    state
  });

  appendSetCookie(
    res,
    `billy_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`
  );

  res.statusCode = 302;
  res.setHeader('Location', `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  res.end();
};
