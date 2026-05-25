const RESERVED = [
  'admin', 'administrator', 'billy', 'root', 'system', 'support', 'help',
  'mod', 'moderator', 'official', 'anthropic', 'api', 'www', 'mail',
  'security', 'abuse'
];

function normalize(input) {
  return String(input).trim().toLowerCase();
}

function validateFormat(name) {
  if (name.length < 3) return { ok: false, reason: 'too short' };
  if (name.length > 20) return { ok: false, reason: 'too long' };
  if (!/^[a-z0-9_-]+$/.test(name)) return { ok: false, reason: 'invalid format' };
  if (RESERVED.includes(name)) return { ok: false, reason: 'reserved name' };
  return { ok: true };
}

function randomSuffix() {
  const len = 2 + Math.floor(Math.random() * 3); // 2, 3, or 4 digits
  const min = Math.pow(10, len - 1);
  const max = Math.pow(10, len);
  return String(min + Math.floor(Math.random() * (max - min)));
}

function generateSuggestions(base) {
  const seen = new Set();
  while (seen.size < 3) {
    seen.add(`${base}${randomSuffix()}`);
  }
  return Array.from(seen);
}

module.exports = { RESERVED, normalize, validateFormat, generateSuggestions };
