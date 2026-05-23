import { BIP39_WORDLIST } from './bip39-wordlist.js';

function bytesToBits(bytes) {
  let bits = '';
  for (let i = 0; i < bytes.length; i++) {
    bits += bytes[i].toString(2).padStart(8, '0');
  }
  return bits;
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return new Uint8Array(digest);
}

export async function generateRecoveryPhrase() {
  const entropy = new Uint8Array(32);
  crypto.getRandomValues(entropy);
  const hash = await sha256(entropy);
  const entropyBits = bytesToBits(entropy);
  const checksumBits = bytesToBits(hash).slice(0, 8);
  const allBits = entropyBits + checksumBits;
  const words = [];
  for (let i = 0; i < 24; i++) {
    const chunk = allBits.slice(i * 11, (i + 1) * 11);
    const idx = parseInt(chunk, 2);
    words.push(BIP39_WORDLIST[idx]);
  }
  return words.join(' ');
}

export async function validateRecoveryPhrase(phrase) {
  if (typeof phrase !== 'string') return false;
  if (!/^[a-z]+(?: [a-z]+){23}$/.test(phrase)) return false;
  const words = phrase.split(' ');
  if (words.length !== 24) return false;
  let allBits = '';
  for (const w of words) {
    const idx = BIP39_WORDLIST.indexOf(w);
    if (idx === -1) return false;
    allBits += idx.toString(2).padStart(11, '0');
  }
  const entropyBits = allBits.slice(0, 256);
  const checksumBits = allBits.slice(256, 264);
  const entropy = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    entropy[i] = parseInt(entropyBits.slice(i * 8, (i + 1) * 8), 2);
  }
  const hash = await sha256(entropy);
  const expectedChecksum = bytesToBits(hash).slice(0, 8);
  return checksumBits === expectedChecksum;
}
