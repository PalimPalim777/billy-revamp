const SESSION_COOKIE = 'billy_session';

function appendSetCookie(res, value) {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) {
    res.setHeader('Set-Cookie', value);
  } else if (Array.isArray(prev)) {
    res.setHeader('Set-Cookie', prev.concat(value));
  } else {
    res.setHeader('Set-Cookie', [prev, value]);
  }
}

function setSessionCookie(res, token) {
  const cookie = `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`;
  appendSetCookie(res, cookie);
}

function clearSessionCookie(res) {
  const cookie = `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
  appendSetCookie(res, cookie);
}

function parseCookies(req) {
  const header = req.headers && req.headers.cookie;
  const out = {};
  if (!header) return out;
  const parts = header.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

module.exports = { setSessionCookie, clearSessionCookie, parseCookies, appendSetCookie };
