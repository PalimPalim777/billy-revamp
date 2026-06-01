// Retrieve tab (milestone 3.2c) — typed-query full sweep + single-center selection.
// Reuses capture/connection primitives by import; NO crypto/embedding/scoring logic is
// reimplemented here. No graph, no neighbors, no connection-blob read, no LLM/streaming.
// The query text is embedded LOCALLY (transformers.js in the browser) and is NEVER
// transmitted: the only network calls are GET /api/memos/embeddings (paginated sweep)
// and GET /api/memos/<id> (center content) — neither carries the query.
import { startLoadingEmbeddingModel, embedText, base64ToFloat32Array, topKNeighbors } from '/lib/embeddings.js';
import { getSessionDEK } from '/crypto/session-dek.js';
import { decryptStringWithDEK } from '/crypto/dek.js';

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

  function renderCenter(memo, score) {
    result.innerHTML = '';
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

    result.appendChild(card);
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

      renderCenter(memo, center.score);
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
