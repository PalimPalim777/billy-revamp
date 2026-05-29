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
