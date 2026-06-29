let _cached = null;

export async function loadCapturePromptV1() {
  if (_cached) return _cached;
  const r = await fetch('/prompts/lifeos-capture-v1.md');
  if (!r.ok) throw new Error(`PROMPT_FETCH_${r.status}`);
  const text = await r.text();
  // File structure: [preamble] --- [Section A] --- [Section B] --- [Versioning]
  const parts = text.split(/^---\s*$/m).map(s => s.trim());
  if (parts.length < 3) throw new Error('PROMPT_PARSE');
  _cached = { companion: parts[1], synthesis: parts[2] };
  return _cached;
}

let _retrieveCached = null;

export async function loadRetrievePromptV1() {
  if (_retrieveCached) return _retrieveCached;
  const r = await fetch('/prompts/lifeos-retrieve-v1.md');
  if (!r.ok) throw new Error(`PROMPT_FETCH_${r.status}`);
  const text = await r.text();
  // File structure: [preamble] --- [Section A: summary system prompt] --- [Versioning]
  const parts = text.split(/^---\s*$/m).map(s => s.trim());
  if (parts.length < 2) throw new Error('PROMPT_PARSE');
  _retrieveCached = { system: parts[1] };
  return _retrieveCached;
}

let _chatCached = null;

export async function loadChatPromptV1() {
  if (_chatCached) return _chatCached;
  const r = await fetch('/prompts/lifeos-chat-v1.md');
  if (!r.ok) throw new Error(`PROMPT_FETCH_${r.status}`);
  const text = await r.text();
  // File structure: [preamble] --- [Section A: opener system prompt] --- [Versioning]
  const parts = text.split(/^---\s*$/m).map(s => s.trim());
  if (parts.length < 2) throw new Error('PROMPT_PARSE');
  _chatCached = { system: parts[1] };
  return _chatCached;
}
