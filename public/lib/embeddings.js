// Load transformers.js from CDN as an ES module. Pinned version for reproducibility.
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';
const MODEL_ID = 'Xenova/bge-small-en-v1.5';
export const EMBEDDING_MODEL_VERSION = 'Xenova/bge-small-en-v1.5@2.17.2';
export const EMBEDDING_DIM = 384;

let _loadPromise = null;
let _pipeline = null;

// Idempotent: returns the same in-flight promise on subsequent calls.
export function startLoadingEmbeddingModel() {
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    const { pipeline, env } = await import(TRANSFORMERS_URL);
    // transformers.js caches model files in CacheStorage by default; do not disable.
    env.allowLocalModels = false;
    _pipeline = await pipeline('feature-extraction', MODEL_ID, { quantized: true });
    return _pipeline;
  })();
  return _loadPromise;
}

export function isEmbeddingModelReady() {
  return _pipeline !== null;
}

export async function embedMemo(memo) {
  const pipe = await startLoadingEmbeddingModel();
  // Per graph spec §4.1: embed body with tags appended for tag-aware similarity.
  // Tags appended as a trailing line, space-separated, # prefix preserved for the model.
  const tagsLine = (memo.tags && memo.tags.length)
    ? '\n\n' + memo.tags.map(t => `#${t}`).join(' ')
    : '';
  const input = (memo.body || '') + tagsLine;
  // bge models: mean pooling + normalization (cosine-ready).
  const out = await pipe(input, { pooling: 'mean', normalize: true });
  const vec = Array.from(out.data);
  if (vec.length !== EMBEDDING_DIM) {
    throw new Error(`EMBED_DIM_MISMATCH_${vec.length}`);
  }
  return new Float32Array(vec);
}

// Serialize Float32Array → base64 for encryption-as-string.
export function float32ArrayToBase64(f32) {
  const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// Inverse of float32ArrayToBase64.
export function base64ToFloat32Array(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // Copy into a fresh buffer to satisfy Float32Array alignment requirements.
  const buf = new ArrayBuffer(bytes.length);
  new Uint8Array(buf).set(bytes);
  return new Float32Array(buf);
}

// Scoring function — versioned with the embedding model and LifeOS prompt per graph spec §7.3.
// Both vectors are already L2-normalized at embed time (pipe(..., {normalize: true}) in embedMemo).
// For L2-normalized vectors, cosine similarity = dot product.
export const SCORING_FN_VERSION = 'cosine-on-normalized-bge-small-v1';
export const K_NEIGHBORS = 20;

export function cosineScore(a, b) {
  if (a.length !== b.length) throw new Error(`SCORE_DIM_MISMATCH_${a.length}_vs_${b.length}`);
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

// Compute top-K neighbors. neighbors is [{ id, vec: Float32Array }, ...].
// Returns sorted desc by score, capped at K.
export function topKNeighbors(queryVec, neighbors, k = K_NEIGHBORS) {
  const scored = neighbors.map(n => ({ memo_id: n.id, score: cosineScore(queryVec, n.vec) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}
