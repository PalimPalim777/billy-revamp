function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  let s = '';
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < view.length; i++) s += String.fromCharCode(view[i]);
  return btoa(s);
}

export async function generateDEK() {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

export async function wrapDEK(dek, kek) {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const rawDek = await crypto.subtle.exportKey('raw', dek);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    kek,
    rawDek
  );
  return {
    ciphertext_b64: bytesToB64(new Uint8Array(ciphertext)),
    iv_b64: bytesToB64(iv)
  };
}

export async function unwrapDEK(ciphertext_b64, iv_b64, kek) {
  const ciphertext = b64ToBytes(ciphertext_b64);
  const iv = b64ToBytes(iv_b64);
  const rawDek = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    kek,
    ciphertext
  );
  return crypto.subtle.importKey(
    'raw',
    rawDek,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

// Same AES-256-GCM convention as wrapDEK/unwrapDEK, but for arbitrary UTF-8 text
// (e.g. the user's Anthropic API key) encrypted under the DEK.
export async function encryptStringWithDEK(plaintext, dek) {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    dek,
    new TextEncoder().encode(plaintext)
  );
  return {
    ciphertext_b64: bytesToB64(new Uint8Array(ciphertext)),
    iv_b64: bytesToB64(iv)
  };
}

export async function decryptStringWithDEK(ciphertext_b64, iv_b64, dek) {
  const ciphertext = b64ToBytes(ciphertext_b64);
  const iv = b64ToBytes(iv_b64);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    dek,
    ciphertext
  );
  return new TextDecoder().decode(plaintext);
}
