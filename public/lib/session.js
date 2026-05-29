let _anthropicKey = null;

export function setAnthropicKey(key) { _anthropicKey = key || null; }
export function getAnthropicKey() { return _anthropicKey; }
export function clearAnthropicKey() { _anthropicKey = null; }
