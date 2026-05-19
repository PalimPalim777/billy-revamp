const { clearSessionCookie } = require('../../lib/cookies');

module.exports = function handler(req, res) {
  clearSessionCookie(res);
  res.statusCode = 302;
  res.setHeader('Location', '/');
  res.end();
};
