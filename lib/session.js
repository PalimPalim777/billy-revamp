const crypto = require('node:crypto');

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? 0 : 4 - (str.length % 4);
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  return Buffer.from(padded, 'base64');
}

function hmac(payloadB64) {
  const secret = process.env.SESSION_SECRET;
  return crypto.createHmac('sha256', secret).update(payloadB64).digest();
}

function signSession(payload) {
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const sigB64 = b64urlEncode(hmac(payloadB64));
  return `${payloadB64}.${sigB64}`;
}

function verifySession(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return null;
  let providedSig;
  try {
    providedSig = b64urlDecode(sigB64);
  } catch {
    return null;
  }
  const expectedSig = hmac(payloadB64);
  if (providedSig.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(providedSig, expectedSig)) return null;
  try {
    return JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
  } catch {
    return null;
  }
}

module.exports = { signSession, verifySession };
