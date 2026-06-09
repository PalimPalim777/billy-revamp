// 4.1b canary verifier — reproduces public/crypto/{kdf,dek}.js via node:crypto webcrypto.subtle.
// Proves the wrapped-DEK envelope survived dump -> age -> B2 -> pg_restore byte-intact.
// Reads canary row fields from argv (fed by psql in the workflow). Exits non-zero on any failure.
import { webcrypto as wc } from 'node:crypto';

const [, , saltB64, dekWrapB64, dekWrapIvB64, memoCtB64, memoIvB64] = process.argv;
const PW = process.env.CANARY_PASSWORD;
const MARKER = process.env.CANARY_MARKER;

function b64ToBytes(b64) { return new Uint8Array(Buffer.from(b64, 'base64')); }

async function deriveKEK(passwordOrPhrase, saltB64) {
  const ikm = await wc.subtle.importKey('raw', new TextEncoder().encode(passwordOrPhrase),
    { name: 'PBKDF2' }, false, ['deriveKey']);
  return wc.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt: b64ToBytes(saltB64) },
    ikm, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}

async function unwrapDEK(wrapB64, ivB64, kek) {
  const raw = await wc.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(ivB64) }, kek, b64ToBytes(wrapB64));
  return wc.subtle.importKey('raw', new Uint8Array(raw), { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}

async function decryptStringWithDEK(ctB64, ivB64, dek) {
  const pt = await wc.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(ivB64) }, dek, b64ToBytes(ctB64));
  return new TextDecoder().decode(pt);
}

function fail(msg) { console.error('CANARY VERIFY FAILED: ' + msg); process.exit(1); }

(async () => {
  if (!PW) fail('CANARY_PASSWORD env not set');
  if (!MARKER) fail('CANARY_MARKER env not set');
  if (!saltB64 || !dekWrapB64 || !dekWrapIvB64 || !memoCtB64 || !memoIvB64)
    fail('missing canary row field(s) from psql — restored row not found or columns empty');

  let kek, dek, plaintext;
  try { kek = await deriveKEK(PW, saltB64); } catch (e) { fail('deriveKEK: ' + e.message); }
  try { dek = await unwrapDEK(dekWrapB64, dekWrapIvB64, kek); }
  catch (e) { fail('unwrapDEK (wrong password OR wrapped-DEK corrupted in backup): ' + e.message); }
  try { plaintext = await decryptStringWithDEK(memoCtB64, memoIvB64, dek); }
  catch (e) { fail('memo decrypt (GCM auth tag failed -> ciphertext corrupted in backup): ' + e.message); }

  let obj;
  try { obj = JSON.parse(plaintext); } catch (e) { fail('decrypted memo is not valid JSON: ' + e.message); }
  if (!JSON.stringify(obj).includes(MARKER)) fail('decrypted memo JSON does not contain canary marker');

  console.log('CANARY VERIFY OK: memo decrypted, valid JSON, marker present — full chain survived the round-trip.');
})();
