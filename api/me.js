const { parseCookies } = require('../lib/cookies');
const { verifySession } = require('../lib/session');

module.exports = function handler(req, res) {
  const cookies = parseCookies(req);
  const token = cookies.billy_session;
  const payload = token ? verifySession(token) : null;

  res.setHeader('Content-Type', 'application/json');
  res.statusCode = 200;

  if (payload && payload.uid && payload.username) {
    res.end(JSON.stringify({ authenticated: true, username: payload.username, uid: payload.uid }));
  } else {
    res.end(JSON.stringify({ authenticated: false }));
  }
};
