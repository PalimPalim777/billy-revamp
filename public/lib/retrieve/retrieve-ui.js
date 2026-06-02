// Retrieve tab (milestone 3.3 + 3.4a neighbor data layer) — typed-query sweep +
// single-center selection (3.2c), a CENTER-ONLY streaming written summary ABOVE the card
// (3.3), and the 3.4a neighbor data layer BELOW the card: read+decrypt the center's
// connection blob, N-fetch each shown neighbor's content, render a TEMPORARY plain-text
// readout. The readout is throwaway — it is REMOVED at 3.4b when the SVG ego-graph
// replaces it. Still NO graph/SVG/nodes/spokes/layout — that is 3.4b.
// Reuses capture/connection primitives by import; NO crypto/embedding/scoring logic is
// reimplemented here. The query is embedded LOCALLY and is never sent to our server. The
// streaming summary calls api.anthropic.com directly with the user's own key (capture
// parity). The 3.4a neighbor layer talks ONLY to GET /api/memos/<id>/connection-blob
// (ciphertext-only, merged in #10) and the existing GET /api/memos/<id> (ciphertext-only)
// — no plaintext crosses the server, no batch endpoint, no /api or schema change.
import { startLoadingEmbeddingModel, embedText, base64ToFloat32Array, topKNeighbors } from '/lib/embeddings.js';
import { getSessionDEK } from '/crypto/session-dek.js';
import { decryptStringWithDEK } from '/crypto/dek.js';
import { callLLMStream } from '/lib/llm.js';
import { loadRetrievePromptV1 } from '/lib/prompts-loader.js';

// Matches the server's EMBEDDINGS_PAGE_SIZE cap; pages the full corpus via ?limit=&cursor=.
const SWEEP_PAGE_SIZE = 200;

// Blob can hold up to 20 (K_NEIGHBORS in embeddings.js). Show only the top 8 in the debug
// readout — keeps the temporary verification block legible. Same number will inform the
// 3.4b SVG render budget, but this is debug-only for now.
const NEIGHBOR_DISPLAY_COUNT = 8;

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

      // 3.2c center card + 3.3 streaming summary ABOVE it + 3.4a neighbor debug readout
      // BELOW it. The card renders immediately (it does not depend on the LLM or the
      // blob); then the written summary streams into the region above it and the neighbor
      // layer fills the region below it. streamSummary AND loadAndRenderNeighbors each
      // handle their own errors and NEVER throw, so a summary failure OR a neighbor-layer
      // failure leaves the correct center card in place and the other region intact.
      result.innerHTML = '';
      const { region: summaryRegion, textEl: summaryText } = buildSummaryRegion();
      result.appendChild(summaryRegion);
      result.appendChild(buildCenterCard(memo, center.score));
      const { region: neighborsRegion, bodyEl: neighborsBody } = buildNeighborsDebugRegion();
      result.appendChild(neighborsRegion);

      // Run the summary stream and the neighbor data layer in parallel. Both are
      // self-contained: each catches internally and resolves (never rejects), so
      // Promise.all reliably awaits both. setBusy(false) flips only once both finish.
      await Promise.all([
        streamSummary(q, memo, summaryText),
        loadAndRenderNeighbors(center.memo_id, dek, neighborsBody)
      ]);
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

// ---- 3.4a neighbor data layer (TEMPORARY debug readout — removed at 3.4b) ----
//
// Reads the center's connection blob, decrypts it with the session DEK, picks the top
// neighbors by score, N-fetches each neighbor's content via the EXISTING /api/memos/<id>
// endpoint, decrypts, and renders a plain-text block BELOW the center card so I can
// eyeball-verify the round-trip before the SVG render lands at 3.4b.
//
// Fully self-contained error handling: every failure mode lands in the debug region; the
// 3.2c center card and the 3.3 streaming summary do NOT depend on this and must keep
// rendering even if everything below fails.

// Empty debug region with a placeholder line — appended to the result column immediately
// so the DOM order (summary, card, neighbors) is fixed before either async path resolves.
function buildNeighborsDebugRegion() {
  const region = document.createElement('div');
  region.className = 'retrieve-neighbors-debug';
  // Inline styles, deliberately: this block is throwaway (removed at 3.4b) and doesn't
  // earn a CSS rule. The dashed border + bold header visually scream "debug".
  region.style.margin = '16px 0 0';
  region.style.padding = '8px';
  region.style.border = '1px dashed #888';
  region.style.background = '#f7f7f7';

  const label = document.createElement('p');
  label.className = 'small';
  label.style.margin = '0 0 6px';
  label.style.fontWeight = 'bold';
  label.textContent = 'NEIGHBORS (debug — removed at 3.4b)';
  region.appendChild(label);

  const bodyEl = document.createElement('div');
  const waiting = document.createElement('span');
  waiting.className = 'small';
  waiting.textContent = 'Loading neighbors…';
  bodyEl.appendChild(waiting);
  region.appendChild(bodyEl);

  return { region, bodyEl };
}

// Read the center's connection blob, fetch+decrypt the top-N neighbors, render the
// readout. Never throws: any uncaught path lands in the catch and shows an inline error.
async function loadAndRenderNeighbors(centerId, dek, bodyEl) {
  try {
    // 1) GET the center's blob (ciphertext-only sibling of the content endpoint).
    const r = await fetch(`/api/memos/${encodeURIComponent(centerId)}/connection-blob`, {
      method: 'GET',
      credentials: 'same-origin'
    });
    if (r.status === 401) { showNeighborsError(bodyEl, 'Session expired — re-unlock to load neighbors.'); return; }
    if (r.status === 404) { showNeighborsError(bodyEl, 'Could not load the center memo blob (it may have just been deleted).'); return; }
    if (!r.ok) { showNeighborsError(bodyEl, `Could not load neighbors (HTTP ${r.status}).`); return; }
    const blobResponse = await r.json();

    // 2) Null blob fields = the memo exists but was never connected (e.g. the very first
    // memo, or one whose connect pass never finished). Treat as "no neighbors" honestly,
    // distinct from a fetch error — no crash, no fabrication.
    if (blobResponse.connection_blob_ciphertext == null || blobResponse.connection_blob_iv == null) {
      showNoNeighbors(bodyEl);
      return;
    }

    // 3) Decrypt + JSON.parse via the SAME path as 3.2c center-content decrypt. The
    // blob plaintext shape (set by the connect pass in app.html) is:
    //   { neighbors: [{ memo_id, score }, ...], scoring_fn_version: <string> }
    // Field names are memo_id and score — NOT id and NOT cosine.
    let blob;
    try {
      const plaintext = await decryptStringWithDEK(
        blobResponse.connection_blob_ciphertext,
        blobResponse.connection_blob_iv,
        dek
      );
      blob = JSON.parse(plaintext);
    } catch (err) {
      console.warn('[retrieve] neighbor blob decrypt/parse failed:', err);
      showNeighborsError(bodyEl, 'Found the neighbor set but could not decrypt it.');
      return;
    }

    const allNeighbors = Array.isArray(blob && blob.neighbors) ? blob.neighbors : [];
    if (allNeighbors.length === 0) {
      // The connect pass ran but produced an empty set (e.g. first memo). Honest signal.
      showNoNeighbors(bodyEl);
      return;
    }

    // 4) Top-N by score, descending. The blob holds up to K_NEIGHBORS (20) from the
    // connect pass; we only display NEIGHBOR_DISPLAY_COUNT here.
    const top = allNeighbors
      .slice()
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, NEIGHBOR_DISPLAY_COUNT);

    // 5) N-fetch each neighbor's content via the EXISTING ciphertext-only endpoint.
    // Documented forward-only / asymmetric-staleness tolerance: a neighbor that has since
    // been deleted (404) or whose decrypt/parse fails is SKIPPED with a console.warn and
    // counted, NEVER fatal. The readout still renders the resolved ones.
    const resolved = [];
    let skipped = 0;
    for (const n of top) {
      if (!n || typeof n.memo_id !== 'string') { skipped++; continue; }
      try {
        const cr = await fetch(`/api/memos/${encodeURIComponent(n.memo_id)}`, {
          method: 'GET',
          credentials: 'same-origin'
        });
        if (cr.status === 404) {
          // Asymmetric staleness: this center's blob still points at a memo that no
          // longer exists. Expected; skip and continue.
          console.warn('[retrieve] neighbor missing (404), skipping:', n.memo_id);
          skipped++;
          continue;
        }
        if (!cr.ok) {
          console.warn('[retrieve] neighbor fetch failed:', n.memo_id, cr.status);
          skipped++;
          continue;
        }
        const content = await cr.json();
        const plaintext = await decryptStringWithDEK(content.memo_ciphertext, content.memo_iv, dek);
        const neighborMemo = JSON.parse(plaintext);
        resolved.push({
          memo_id: n.memo_id,
          title: (neighborMemo && neighborMemo.title) || '(untitled)',
          summary: (neighborMemo && neighborMemo.summary) || '',
          score: typeof n.score === 'number' ? n.score : 0
        });
      } catch (err) {
        console.warn('[retrieve] neighbor decrypt/parse failed, skipping:', n.memo_id, err);
        skipped++;
      }
    }

    renderNeighborsReadout(bodyEl, allNeighbors.length, top.length, resolved, skipped);
  } catch (err) {
    // Unhandled network/runtime error before any per-neighbor work. Show an inline
    // error; the card + summary above are unaffected.
    console.warn('[retrieve] neighbor layer failed:', err);
    showNeighborsError(bodyEl, 'Could not load neighbors (network or server error). The best-match memo is shown above.');
  }
}

function showNeighborsError(bodyEl, text) {
  bodyEl.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'err';
  p.style.margin = '0';
  p.textContent = text;
  bodyEl.appendChild(p);
}

function showNoNeighbors(bodyEl) {
  bodyEl.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'small';
  p.style.margin = '0';
  p.textContent = 'no neighbors for this memo';
  bodyEl.appendChild(p);
}

// totalCount = neighbors in the blob; pickedCount = how many we tried to show (= min(N, total));
// resolved = successfully fetched+decrypted subset; skipped = (pickedCount - resolved.length).
function renderNeighborsReadout(bodyEl, totalCount, pickedCount, resolved, skipped) {
  bodyEl.innerHTML = '';

  // Header line: e.g. "blob: 12 neighbors · showing top 8 · 1 skipped (unfetchable)"
  const summary = document.createElement('p');
  summary.className = 'small';
  summary.style.margin = '0 0 6px';
  let line = `blob: ${totalCount} neighbors · showing top ${pickedCount}`;
  if (skipped > 0) line += ` · ${skipped} skipped (unfetchable)`;
  summary.textContent = line;
  bodyEl.appendChild(summary);

  if (resolved.length === 0) {
    const none = document.createElement('p');
    none.className = 'small';
    none.style.margin = '0';
    none.textContent = '(no neighbors could be fetched — all were unreadable)';
    bodyEl.appendChild(none);
    return;
  }

  // Plain ordered list: title · score · memo_id. textContent throughout so a malicious
  // title can never inject HTML even in this debug surface.
  const list = document.createElement('ol');
  list.style.margin = '0';
  list.style.paddingLeft = '20px';
  for (const n of resolved) {
    const li = document.createElement('li');

    const title = document.createElement('strong');
    title.textContent = n.title;
    li.appendChild(title);

    const rest = document.createElement('span');
    rest.className = 'small';
    rest.textContent = ` · score ${n.score.toFixed(3)} · ${n.memo_id}`;
    li.appendChild(rest);

    list.appendChild(li);
  }
  bodyEl.appendChild(list);
}
