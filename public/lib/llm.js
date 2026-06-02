import { getAnthropicKey } from './session.js';

export const BILLY_MODEL = 'claude-sonnet-4-6';

export async function callLLM({ messages, system, maxTokens = 1024, signal }) {
  const key = getAnthropicKey();
  if (!key) throw new Error('LLM_NO_KEY');

  const body = { model: BILLY_MODEL, max_tokens: maxTokens, messages };
  if (system) body.system = system;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(body),
    signal
  });

  if (r.status === 401 || r.status === 403) throw new Error('LLM_AUTH');
  if (r.status === 429) throw new Error('LLM_RATELIMIT');
  if (!r.ok) throw new Error(`LLM_HTTP_${r.status}`);

  const data = await r.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return text;
}

// Streaming sibling of callLLM (milestone 3.3). The Anthropic request is IDENTICAL to
// callLLM — same endpoint, same headers (incl. anthropic-dangerous-direct-browser-access),
// same BILLY_MODEL, same getAnthropicKey() accessor, same { model, max_tokens, system,
// messages } body — with ONE addition: stream: true. It parses the Server-Sent Events
// response incrementally, invoking onToken(textChunk) per text delta, and returns the full
// concatenated text when the stream completes. The non-streaming callLLM above is untouched.
export async function callLLMStream({ messages, system, maxTokens = 1024, signal, onToken }) {
  const key = getAnthropicKey();
  if (!key) throw new Error('LLM_NO_KEY');

  const body = { model: BILLY_MODEL, max_tokens: maxTokens, messages, stream: true };
  if (system) body.system = system;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(body),
    signal
  });

  if (r.status === 401 || r.status === 403) throw new Error('LLM_AUTH');
  if (r.status === 429) throw new Error('LLM_RATELIMIT');
  if (!r.ok) throw new Error(`LLM_HTTP_${r.status}`);

  // Anthropic streams Server-Sent Events: records separated by a blank line, each carrying
  // a "data: <json>" payload. Text arrives as content_block_delta events (delta.text).
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  while (true) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch {
      throw new Error('LLM_STREAM');
    }
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });

    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const evt = parseSSEData(rawEvent);
      if (!evt) continue;
      if (evt.type === 'error') throw new Error('LLM_STREAM');
      if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') {
        const t = evt.delta.text || '';
        if (t) {
          full += t;
          if (onToken) onToken(t);
        }
      }
    }
  }

  return full;
}

// Extract the JSON payload from one SSE record's "data:" line(s). Returns the parsed
// object, or null for keep-alives, the [DONE] sentinel, or unparseable records.
function parseSSEData(rawEvent) {
  let dataStr = '';
  for (const line of rawEvent.split('\n')) {
    const clean = line.replace(/\r$/, '');
    if (clean.startsWith('data:')) dataStr += clean.slice(5).replace(/^ /, '');
  }
  if (!dataStr || dataStr === '[DONE]') return null;
  try {
    return JSON.parse(dataStr);
  } catch {
    return null;
  }
}
