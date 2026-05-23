const STORAGE_KEY = 'billy_dek_v1';

function bytesToB64(bytes) {
  let s = '';
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < view.length; i++) s += String.fromCharCode(view[i]);
  return btoa(s);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function setSessionDEK(cryptoKey) {
  const raw = await crypto.subtle.exportKey('raw', cryptoKey);
  sessionStorage.setItem(STORAGE_KEY, bytesToB64(new Uint8Array(raw)));
}

export async function getSessionDEK() {
  const stored = sessionStorage.getItem(STORAGE_KEY);
  if (!stored) return null;
  try {
    const bytes = b64ToBytes(stored);
    return await crypto.subtle.importKey(
      'raw',
      bytes,
      { name: 'AES-GCM' },
      true,
      ['encrypt', 'decrypt']
    );
  } catch {
    sessionStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

export function clearSessionDEK() {
  sessionStorage.removeItem(STORAGE_KEY);
}
