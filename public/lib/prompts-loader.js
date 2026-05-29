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
