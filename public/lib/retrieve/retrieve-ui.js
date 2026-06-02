// Retrieve tab (milestone 3.3) — typed-query sweep + single-center selection (3.2c) PLUS
// a streaming, CENTER-ONLY written summary rendered ABOVE the center card.
// Reuses capture/connection primitives by import; NO crypto/embedding/scoring logic is
// reimplemented here. Still NO graph, NO neighbors, NO connection-blob read (those arrive
// at 3.4): the summary is grounded in the CENTER memo alone.
// The query is embedded LOCALLY and is never sent to our server. The streaming summary
// calls api.anthropic.com directly with the user's own key, exactly as capture synthesis
// does — the only plaintext leaving the browser is the prompt + center body, to Anthropic.
import { startLoadingEmbeddingModel, embedText, base64ToFloat32Array, topKNeighbors } from '/lib/embeddings.js';
import { getSessionDEK } from '/crypto/session-dek.js';
import { decryptStringWithDEK } from '/crypto/dek.js';
import { callLLMStream } from '/lib/llm.js';
import { loadRetrievePromptV1 } from '/lib/prompts-loader.js';

// Matches the server's EMBEDDINGS_PAGE_SIZE cap; pages the full corpus via ?limit=&cursor=.
const SWEEP_PAGE_SIZE = 200;

export function mountRetrieve(container) {
  // app.html guards against a second mount, but clear defensively so a stray
  // re-call can never stack a duplicate UI inside the container.
  container.innerHTML = '';

  // Query row: a single-line input (Enter submits) plus a Search button.
  const row = document.createElement('div');
  row.className = 'row';

  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'retrieveQuery';
  input.autocomplete = 'off';
  input.setAttribute('autocapitalize', 'none');
  input.spellcheck = false;
  input.placeholder = 'Ask a question…';

  const searchBtn = document.createElement('button');
  searchBtn.type = 'button';
  searchBtn.id = 'retrieveSearchBtn';
  searchBtn.textContent = 'Search';

  row.appendChild(input);
  row.appendChild(searchBtn);

  // Inline hint for empty submits. Separate from the result region so an empty
  // submit never disturbs the idle empty-state or a prior result.
  const hint = document.createElement('p');
  hint.id = 'retrieveHint';
  hint.className = 'small';
  hint.style.display = 'none';
  hint.textContent = 'Type a question to search.';

  // Result region: idle empty-state now; working state / result card / messages later.
  const result = document.createElement('div');
  result.id = 'retrieveResult';
  const empty = document.createElement('p');
  empty.id = 'retrieveEmpty';
  empty.textContent = 'Ask a question to search your memos.';
  result.appendChild(empty);

  container.appendChild(row);
  container.appendChild(hint);
  container.appendChild(result);

  // Warm the embedding model when the tab opens so the first query is fast.
  // Idempotent and shared with capture (same module instance) — never double-fetches.
  startLoadingEmbeddingModel().catch(err => console.warn('[retrieve] model warm failed:', err));

  let inFlight = false;

  function setBusy(b) {
    inFlight = b;
    searchBtn.disabled = b;
    input.disabled = b;
  }

  // Replace the result region with a single line (plain or error). Never blank.
  function showMessage(text, isError) {
    result.innerHTML = '';
    const p = document.createElement('p');
    if (isError) p.className = 'err';
    p.textContent = text;
    result.appendChild(p);
  }

  // Build the 3.2c center card as a detached element; the caller places it BELOW the
  // streaming summary region. (Renders without the LLM, so it survives a summary failure.)
  function buildCenterCard(memo, score) {
    const card = document.createElement('div');
    card.className = 'memo-card';

    const h = document.createElement('h3');
    h.textContent = memo.title || '(untitled)';
    card.appendChild(h);

    if (memo.para_bucket) {
      const bucket = document.createElement('span');
      bucket.className = 'bucket';
      bucket.textContent = memo.para_bucket;
      card.appendChild(bucket);
    }

    if (memo.summary) {
      const summary = document.createElement('div');
      summary.className = 'memo-summary';
      summary.textContent = memo.summary;
      card.appendChild(summary);
    }

    const body = document.createElement('div');
    body.className = 'memo-body';
    body.textContent = memo.body || ''; // textContent: never interpret memo text as HTML
    card.appendChild(body);

    if (Array.isArray(memo.tags) && memo.tags.length) {
      const tags = document.createElement('div');
      tags.className = 'memo-tags';
      tags.textContent = memo.tags.join(' · '); // visible, NOT clickable in 3.2c
      card.appendChild(tags);
    }

    // Surfaced for this milestone's verifiability — the cosine score the center won with.
    const scoreLine = document.createElement('p');
    scoreLine.className = 'small';
    scoreLine.textContent = `Best match · cosine ${score.toFixed(3)}`;
    card.appendChild(scoreLine);

    return card;
  }

  async function submit() {
    if (inFlight) return;
    const q = input.value.trim();
    if (!q) {
      // Empty / whitespace-only: keep the 3.1 hint behaviour, no sweep.
      hint.style.display = 'block';
      input.focus();
      return;
    }
    hint.style.display = 'none';
    setBusy(true);
    showMessage('Searching your memos…', false);

    try {
      // The DEK decrypts both corpus embeddings and the center's content.
      const dek = await getSessionDEK();
      if (!dek) { showMessage('Your session is locked — re-unlock to search.', true); return; }

      // Embed the BARE query with capture's exact model / pooling / normalization
      // (same imported embedText; no tags fabricated for the query).
      const queryVec = await embedText(q);

      // Full sweep: page GET /api/memos/embeddings until next_cursor is null,
      // decrypting each row's embedding via the SAME path as the 2.6 connection code.
      // Decrypted corpus vectors to score against the query — candidates for the
      // single CENTER. NOT graph neighbors: no connection blob is read here.
      const candidates = [];
      let cursor = null;
      do {
        const url = `/api/memos/embeddings?limit=${SWEEP_PAGE_SIZE}`
          + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
        const r = await fetch(url, { method: 'GET', credentials: 'same-origin' });
        if (r.status === 401) { showMessage('Your session expired — please re-unlock.', true); return; }
        if (!r.ok) { showMessage(`Couldn't load your memos (HTTP ${r.status}). Try again.`, true); return; }
        const page = await r.json();
        for (const m of (page.memos || [])) {
          try {
            const plaintext_b64 = await decryptStringWithDEK(m.embedding_ciphertext, m.embedding_iv, dek);
            const vec = base64ToFloat32Array(plaintext_b64);
            candidates.push({ id: m.id, vec });
          } catch (decryptErr) {
            // Corrupted/unreadable row: skip, not fatal (matches 2.6 tolerance).
            console.warn('[retrieve] embedding decrypt failed for memo', m.id, decryptErr);
          }
        }
        cursor = page.next_cursor || null;
      } while (cursor);

      // Sparse honesty: nothing usable to match against.
      if (candidates.length === 0) {
        showMessage('Nothing to search yet — capture a few memos first.', false);
        return;
      }

      // Cosine-score the whole corpus with the reused scorer; pick the single best = CENTER.
      const center = topKNeighbors(queryVec, candidates, 1)[0];

      // Fetch + decrypt the center's content (3.2b endpoint).
      const cr = await fetch(`/api/memos/${encodeURIComponent(center.memo_id)}`, {
        method: 'GET', credentials: 'same-origin'
      });
      if (cr.status === 401) { showMessage('Your session expired — please re-unlock.', true); return; }
      if (cr.status === 404) { showMessage('The best match could not be loaded (it may have just been deleted).', true); return; }
      if (!cr.ok) { showMessage(`Couldn't load the best match (HTTP ${cr.status}). Try again.`, true); return; }
      const content = await cr.json();

      let memo;
      try {
        const plaintext = await decryptStringWithDEK(content.memo_ciphertext, content.memo_iv, dek);
        memo = JSON.parse(plaintext);
      } catch {
        showMessage('Found the best match but could not decrypt it.', true);
        return;
      }

      // 3.2c center card + 3.3 streaming summary ABOVE it. The card renders immediately
      // (it does not depend on the LLM); then the written summary streams into the region
      // above it. streamSummary handles its own errors and never throws, so a summary
      // failure leaves the correct center card in place.
      result.innerHTML = '';
      const { region: summaryRegion, textEl: summaryText } = buildSummaryRegion();
      result.appendChild(summaryRegion);
      result.appendChild(buildCenterCard(memo, center.score));

      await streamSummary(q, memo, summaryText);
    } catch (err) {
      // Most likely the embedding model failed to load (CDN/network); never leave a blank panel.
      console.warn('[retrieve] sweep failed:', err);
      showMessage("Search failed — the model couldn't load or a network error occurred. Try again.", true);
    } finally {
      setBusy(false);
    }
  }

  searchBtn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });
  input.addEventListener('input', () => { hint.style.display = 'none'; });
}

// ---- 3.3 streaming summary helpers (CENTER-ONLY; no neighbor context) ----

// A region for the streamed summary, placed ABOVE the center card. Returns the wrapper
// plus the inner text element that the stream progressively writes into.
function buildSummaryRegion() {
  const region = document.createElement('div');
  region.className = 'retrieve-summary';
  region.style.margin = '0 0 16px';

  const label = document.createElement('p');
  label.className = 'small';
  label.textContent = 'Summary';
  label.style.margin = '0 0 4px';
  region.appendChild(label);

  const textEl = document.createElement('div');
  textEl.className = 'retrieve-summary-text';
  const waiting = document.createElement('span');
  waiting.className = 'small';
  waiting.textContent = 'Summarizing…';
  textEl.appendChild(waiting);
  region.appendChild(textEl);

  return { region, textEl };
}

// Build the user turn: the query plus the CENTER memo's title/summary/body. No neighbors,
// no surrounding memos — the summary is grounded in this one memo only.
function buildRetrieveUserMessage(query, memo) {
  const lines = [];
  lines.push('User question:');
  lines.push(query);
  lines.push('');
  lines.push("CENTER memo (the single best match from the user's own notes):");
  if (memo.title) lines.push(`Title: ${memo.title}`);
  if (memo.summary) lines.push(`Summary: ${memo.summary}`);
  lines.push('Body:');
  lines.push(memo.body || '');
  return lines.join('\n');
}

// Stream a CENTER-ONLY written summary into textEl. Fully self-contained error handling:
// any failure shows an inline message and NEVER throws, so the center card stays intact.
async function streamSummary(query, memo, textEl) {
  let acc = '';
  let started = false;
  try {
    const { system } = await loadRetrievePromptV1();
    const full = await callLLMStream({
      system,
      messages: [{ role: 'user', content: buildRetrieveUserMessage(query, memo) }],
      onToken: (chunk) => {
        if (!started) { textEl.textContent = ''; started = true; } // clear "Summarizing…"
        acc += chunk;
        textEl.textContent = acc;
      }
    });
    const finalText = (full || acc || '').trim();
    textEl.textContent = finalText || '(No summary was returned.)';
  } catch (err) {
    console.warn('[retrieve] summary stream failed:', err);
    textEl.innerHTML = '';
    const e = document.createElement('span');
    e.className = 'err';
    e.textContent = summaryErrorMessage(err);
    textEl.appendChild(e);
  }
}

function summaryErrorMessage(err) {
  const code = (err && err.message) || '';
  if (code === 'LLM_NO_KEY') return 'No Anthropic key in this session — re-unlock to generate a summary.';
  if (code === 'LLM_AUTH') return 'Anthropic rejected the API key — the summary could not be generated.';
  if (code === 'LLM_RATELIMIT') return 'Anthropic is rate-limiting right now — try again in a moment.';
  return 'Could not generate a summary just now. Your best-match memo is shown below.';
}
