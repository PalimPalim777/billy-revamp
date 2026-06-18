// Retrieve tab (milestone 3.3 + 3.4a/3.4b ego-graph + 3.5 inter-neighbor edges + 3.6a pivot + 3.6c neighbor floor + 3.7 memo overlay + 3.8a sparse caption + 3.8b disambig hoist + 3.8c mobile profile + 5.1 retrieve thread) —
// typed-query sweep + single-center selection (3.2c), a CENTER-ONLY streaming written summary
// ABOVE (3.3), and the ego-graph BETWEEN the summary and the center card: the 3.4a data layer
// (read+decrypt the center's connection blob, N-fetch each shown neighbor's content) now
// feeds a hand-rolled inline SVG — center node + a radial ring of score-sized neighbor
// nodes + center↔neighbor spokes + hover-for-full-title labels + (3.5) thin dashed,
// thresholded (union/directed) neighbor↔neighbor edges. (3.6a) The post-center-selection
// render (graph + center card) is extracted into renderEgoGraphForCenter(), shared by the
// typed-query flow and a single-click PIVOT: clicking a NEIGHBOR node re-centers the graph on
// that memo with NO LLM call and NO corpus sweep (fetch+decrypt that memo by id, redraw graph
// + card in place, summary above left untouched). A ~240ms click/double-click disambiguator
// reserves double-click for the 3.7 overlay. (3.6b) Pivots build a breadcrumb trail above the
// cluster; a crumb click jumps back to that memo and a return-to-origin control snaps back to the
// typed-query center (pure client trail on top of the 3.6a pivot; no new fetch). (3.6c) A
// display-time neighbor relevance floor
// (NEIGHBOR_DISPLAY_THRESHOLD) drops stored neighbors below it BEFORE the top-N, so a center
// with few strong neighbors renders fewer nodes (or a lone center) instead of padding the ring
// with weak matches. (3.7) Double-clicking any node (center or neighbor) opens that memo's FULL
// synthesized text in a modal overlay over the cluster (already-decrypted in-session data — NO
// fetch, NO LLM); closing it restores the exact graph state. (3.8a) A lone-center cluster shows an
// honest caption for WHY it is empty (no connections yet / nothing closely related yet / related
// notes couldn't be loaded). (3.8b) The click/double-click disambiguation timer is module-scoped
// and cancellable, so any re-center (pivot/crumb/return/typed query) pre-empts a stale single-click
// pivot; its window widened 240→350ms to cut slow-double-click misfires. (3.8c) On narrow
// viewports (≤600px, a matchMedia breakpoint — NOT device detection) the graph uses a mobile
// geometry profile: ≤5 larger nodes on a tighter ring with longer inline labels, and
// touch-action:manipulation disables double-tap-zoom; desktop output is byte-identical. NO
// pass-through dots (deferred).
// Reuses capture/connection primitives by import; NO crypto/embedding/scoring logic is
// reimplemented here. The query is embedded LOCALLY and is never sent to our server. The
// streaming summary calls api.anthropic.com directly with the user's own key (capture
// parity). The 3.4a neighbor layer talks ONLY to GET /api/memos/<id>/connection-blob
// (ciphertext-only, merged in #10) and the existing GET /api/memos/<id> (ciphertext-only)
// — no plaintext crosses the server, no batch endpoint, no /api or schema change.
// ui-retrieve-graph: dark-theme paint migration (colors only, no logic)
// ui-breadcrumb-row: crumb chip restyle + Return-to-origin pinned right (paint/layout only)
// graph-tap-ios: manual same-node double-tap detection; dblclick wiring removed; center opens on single tap
// (5.1 retrieve thread) #retrieveResult is an APPEND-AND-KEEP scrollback of "verses" (one per
// typed turn) instead of a single-live-cluster that wiped on every query. Each verse owns its DOM
// (a right-aligned user-query bubble plus a full-width answer block holding the cluster) AND all of
// its cluster-interaction state (trail / breadcrumbs / nav guard / single-click pivot timer) —
// these moved OUT of the mount closure and ONTO the per-verse object so multiple live clusters
// never collide. Every verse stays EXPANDED (no collapse/accordion); the answer blocks stack and
// the user scrolls the thread. PURE client-side rearrangement: zero new LLM calls, zero new
// endpoints, zero E2EE-surface change; every turn is still a fresh standalone sweep (R1).
import { startLoadingEmbeddingModel, embedText, base64ToFloat32Array, topKNeighbors } from '/lib/embeddings.js';
import { getSessionDEK } from '/crypto/session-dek.js';
import { decryptStringWithDEK } from '/crypto/dek.js';
import { callLLMStream } from '/lib/llm.js';
import { loadRetrievePromptV1 } from '/lib/prompts-loader.js';

// Matches the server's EMBEDDINGS_PAGE_SIZE cap; pages the full corpus via ?limit=&cursor=.
const SWEEP_PAGE_SIZE = 200;

// The center blob can hold up to 20 neighbors (K_NEIGHBORS in embeddings.js). The ego-graph
// draws only the top 8 by score, to keep the ring (and its inter-neighbor edges) legible.
const NEIGHBOR_DISPLAY_COUNT = 8;

// 3.6c neighbor MEMBERSHIP floor: a stored neighbor is only drawn as a node when its
// connection score to the center is >= this. Distinct from (and lower than) the 0.6
// inter-neighbor EDGE threshold: a spoke is a weaker bar than an extra inter-neighbor edge.
// Below the floor the neighbor is dropped entirely — the graph renders fewer than
// NEIGHBOR_DISPLAY_COUNT nodes (possibly a lone center) rather than padding with weak
// matches (spec section 12 "never pad with weak matches" / 5.1 "sparse-and-meaningful over
// dense-and-noisy"). STRAWMAN value — bge-small-and-corpus-dependent, the second parameter
// to calibrate during dogfooding after the edge threshold; err toward dropping too many.
const NEIGHBOR_DISPLAY_THRESHOLD = 0.5;

// 3.5 inter-neighbor edges: draw a neighbor↔neighbor edge when EITHER of the two visible
// neighbors lists the other in its own blob (union/directed — connection blobs are forward-only
// / write-once, so a pair is almost never listed in both directions) AND the qualifying score — the MAX of
// the present directional score(s) — is >= this threshold. Below it the connection exists but no
// edge is drawn (the graph is not a complete mesh).
const INTER_NEIGHBOR_EDGE_THRESHOLD = 0.6;

export function mountRetrieve(container, opts = {}) {
  // app.html guards against a second mount, but clear defensively so a stray
  // re-call can never stack a duplicate UI inside the container.
  container.innerHTML = '';

  // The unified shell (app.html #inputBar) now owns the query input. This module no longer mounts
  // its own input row; it exposes submitQuery(text) and reports state through callbacks:
  //   opts.onBusyChange(bool)        — disable/enable the shell's input + send during a sweep
  //   opts.onPlaceholderChange(text) — reframe the shell's placeholder after turn 1
  const onBusyChange = typeof opts.onBusyChange === 'function' ? opts.onBusyChange : () => {};
  const onPlaceholderChange = typeof opts.onPlaceholderChange === 'function' ? opts.onPlaceholderChange : () => {};
  let placeholderReframed = false;

  // Result region: idle empty-state now; the verse scrollback fills it on submit.
  const result = document.createElement('div');
  result.id = 'retrieveResult';
  const empty = document.createElement('p');
  empty.id = 'retrieveEmpty';
  empty.textContent = 'Ask a question to search your memos.';
  result.appendChild(empty);

  container.appendChild(result);

  // Warm the embedding model when the tab opens so the first query is fast.
  // Idempotent and shared with capture (same module instance) — never double-fetches.
  startLoadingEmbeddingModel().catch(err => console.warn('[retrieve] model warm failed:', err));

  // inFlight serializes SUBMITS (one typed sweep at a time). It is NOT cluster-interaction state,
  // so it stays here, global to the mount. (5.1) ALL per-cluster exploration state — trail,
  // breadcrumb container, nav guard, single-click disambiguation timer — now lives on the per-verse
  // object built by createVerse() (see module-level verses[]), so multiple live clusters in the
  // scrollback never collide.
  let inFlight = false;

  // (5.1) Fresh thread per mount: reset the append-and-keep verse scrollback state.
  verses = [];

  function setBusy(b) {
    inFlight = b;
    onBusyChange(b);
  }

  // (5.1) Build a new verse: a wrapper appended to #retrieveResult holding a right-aligned, static
  // user-query bubble and a full-width answer block that holds the cluster (summary → breadcrumbs →
  // graph → card). Every cluster-interaction handler closes over THIS object; verses stack and stay
  // expanded (never torn down / re-rendered, so each keeps its DOM + drill state — Fork 1).
  function createVerse(query) {
    // Drop the idle empty-state once the first real verse appears.
    const emptyEl = result.querySelector('#retrieveEmpty');
    if (emptyEl) emptyEl.remove();

    const wrapperEl = document.createElement('div');
    wrapperEl.className = 'retrieve-verse';
    wrapperEl.style.margin = '0 0 18px';

    // Right-aligned user-query bubble: a STATIC label (not a toggle), showing the original query.
    // textContent only — a hostile query can never inject markup.
    const bubbleEl = document.createElement('div');
    bubbleEl.className = 'retrieve-verse-bubble';
    bubbleEl.style.width = 'fit-content';
    bubbleEl.style.maxWidth = '85%';
    bubbleEl.style.marginLeft = 'auto'; // right-align within the column
    bubbleEl.style.background = '#2a3a4a';
    bubbleEl.style.color = '#d4e4f7';
    bubbleEl.style.borderRadius = '16px';
    bubbleEl.style.borderBottomRightRadius = '4px'; // tail toward the user side
    bubbleEl.style.padding = '10px 14px';
    bubbleEl.style.fontSize = '13px';
    bubbleEl.textContent = query;

    // Full-width answer block: left-flush, full column width, NOT a bubble. Holds the cluster.
    const bodyEl = document.createElement('div');
    bodyEl.className = 'retrieve-verse-body';
    bodyEl.style.background = '#252525';
    bodyEl.style.color = '#d0d0d0';
    bodyEl.style.borderRadius = '12px';
    bodyEl.style.padding = '14px';
    bodyEl.style.marginTop = '8px';

    wrapperEl.appendChild(bubbleEl);
    wrapperEl.appendChild(bodyEl);
    result.appendChild(wrapperEl);

    const verse = {
      index: verses.length,
      query,
      centerTitle: null,
      wrapperEl, bubbleEl, bodyEl,
      // ---- per-verse cluster-interaction state (lifted out of the mount closure) ----
      // Trail invariant: trail[last].memo_id is ALWAYS the current graph center, trail[0] the
      // origin; trail[0].memo holds the already-decrypted typed-query center (WITH its cosineScore)
      // so return-to-origin re-renders identically; pivot crumbs carry memo:null, re-fetched on demand.
      trail: [],               // array of { memo_id, title, memo }; current center = trail[last]
      breadcrumbsEl: null,     // this verse's .retrieve-breadcrumbs container
      navBusy: false,          // serialize guard for THIS verse's pivot/crumb re-centers
      pendingClickTimer: null, // (3.8b→5.1) single-click pivot disambiguation timer — now per-verse
      pendingClickNode: null,  // memo_id that armed the timer; same-node 2nd tap opens the overlay
    };
    verses.push(verse);

    return verse;
  }

  // Per-verse message line (working / error) written INTO the verse body — never wipes the
  // scrollback or any other verse.
  function showVerseMessage(verse, text, isError) {
    verse.bodyEl.innerHTML = '';
    const p = document.createElement('p');
    if (isError) p.className = 'err';
    p.textContent = text;
    verse.bodyEl.appendChild(p);
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

    return card;
  }

  // ---- 3.6b breadcrumb trail UI (labels via textContent ONLY — a hostile title must never
  // inject markup) ----

  // The breadcrumb row container; the caller mounts it BETWEEN the summary and the graph so it
  // survives every pivot (renderEgoGraphForCenter removes ONLY .retrieve-graph + .memo-card).
  function buildBreadcrumbsRegion() {
    const el = document.createElement('div');
    el.className = 'retrieve-breadcrumbs';
    el.style.display = 'flex';
    el.style.flexWrap = 'wrap';
    el.style.alignItems = 'center';
    el.style.gap = '6px';
    el.style.margin = '0 0 12px';
    return el;
  }

  // Render the trail into breadcrumbsEl. Hidden at depth ≤ 1 (no lone Origin chip on a fresh query
  // or right after returning to origin). Past crumbs are clickable pills that jump back; the last
  // crumb is the current center (bold, NOT a button); a trailing "Return to origin" text-button is
  // the explicit affordance. Chips disable while navBusy so a re-center can't be double-fired.
  function renderBreadcrumbs(verse) {
    const breadcrumbsEl = verse.breadcrumbsEl;
    const trail = verse.trail;
    if (breadcrumbsEl === null) return;
    breadcrumbsEl.innerHTML = '';
    if (trail.length <= 1) {
      breadcrumbsEl.style.display = 'none';
      return;
    }
    breadcrumbsEl.style.display = 'flex';

    const last = trail.length - 1;
    for (let i = 0; i <= last; i++) {
      // Muted separator BETWEEN consecutive crumbs.
      if (i > 0) {
        const sep = document.createElement('span');
        sep.textContent = '›';
        sep.style.color = C_MUTED;
        sep.style.fontSize = '12px';
        sep.style.pointerEvents = 'none';
        breadcrumbsEl.appendChild(sep);
      }
      if (i < last) {
        // Past crumb → clickable pill that jumps back to that memo.
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = truncateLabel(trail[i].title, 18);
        btn.style.border = 'none';
        btn.style.background = C_NODE_FILL;
        btn.style.color = C_CENTER_FILL;
        btn.style.borderRadius = '999px';
        btn.style.padding = '3px 12px';
        btn.style.fontSize = '12px';
        btn.style.fontWeight = '500';
        btn.style.cursor = 'pointer';
        btn.disabled = verse.navBusy;
        btn.style.opacity = verse.navBusy ? '0.5' : '1';
        btn.addEventListener('click', () => goToIndex(verse, i));
        breadcrumbsEl.appendChild(btn);
      } else {
        // Current center → NON-clickable bold label.
        const cur = document.createElement('span');
        cur.textContent = truncateLabel(trail[i].title, 18);
        cur.style.fontWeight = '600';
        cur.style.color = C_INK;
        breadcrumbsEl.appendChild(cur);
      }
    }

    // Explicit "Return to origin" affordance (the i=0 crumb does this too). Light text-button.
    const ret = document.createElement('button');
    ret.type = 'button';
    ret.textContent = 'Return to origin';
    ret.style.background = C_NODE_FILL;
    ret.style.border = 'none';
    ret.style.color = C_INK;
    ret.style.fontSize = '12px';
    ret.style.fontWeight = '500';
    ret.style.cursor = 'pointer';
    ret.style.padding = '3px 12px';
    ret.style.borderRadius = '999px';
    ret.style.marginLeft = 'auto';
    ret.style.opacity = verse.navBusy ? '0.5' : '1';
    ret.disabled = verse.navBusy;
    ret.addEventListener('click', () => goToIndex(verse, 0));
    breadcrumbsEl.appendChild(ret);
  }

  // ---- 3.6b navigation: pivot deeper / jump back (BOTH reuse renderEgoGraphForCenter and add NO
  // network beyond what it already does) ----

  // Neighbor-click target: push a new crumb on THIS verse, then re-center on it (3.6a pivot fetch).
  async function pivotTo(verse, memoId, title) {
    if (verse.navBusy) return;
    verse.navBusy = true;
    verse.trail.push({ memo_id: memoId, title: title || '(untitled)', memo: null });
    renderBreadcrumbs(verse);                                 // new depth; chips disabled while navBusy
    try { await renderEgoGraphForCenter(verse, memoId); }     // memo omitted → 3.6a pivot fetch
    finally { verse.navBusy = false; renderBreadcrumbs(verse); } // re-enable chips
  }

  // Crumb / return-to-origin target: truncate THIS verse's trail to i, then re-center on trail[i].
  async function goToIndex(verse, i) {
    if (verse.navBusy) return;
    if (i < 0 || i >= verse.trail.length) return;
    if (i === verse.trail.length - 1) return;                 // already current → no-op
    verse.navBusy = true;
    verse.trail = verse.trail.slice(0, i + 1);                // drop everything after i
    renderBreadcrumbs(verse);
    const entry = verse.trail[i];
    // Origin (i=0) carries its decrypted memo → preserves the badge and skips a center re-fetch;
    // a pivot crumb carries memo:null → renderEgoGraphForCenter fetches it by id.
    try { await renderEgoGraphForCenter(verse, entry.memo_id, entry.memo); }
    finally { verse.navBusy = false; renderBreadcrumbs(verse); }
  }

  // ---- 3.6a shared center renderer (typed-query render path AND single-click pivot) ----
  //
  // Owns the ego-graph + center card ONLY — the region BELOW the streaming summary. It renders
  // the graph + card for `centerMemoId`, replacing any previously rendered graph + card IN
  // PLACE while leaving the summary element ABOVE it untouched (DOM order: summary → graph →
  // card). Deliberately self-contained: it never embeds text, never sweeps the corpus, and
  // never calls the LLM — so a neighbor click can re-center with NO model and no network beyond
  // the same blob + content reads the typed flow already does. Never throws (mirrors the other
  // render helpers), so it is safe both inside the typed flow's Promise.all and on a bare pivot.
  //
  //   centerMemoId — the memo to center on (its memo_id); used for the blob + content reads.
  //   centerMemo   — typed-query path passes the center memo it already decrypted (avoids a
  //                  double fetch) and carries the winning cosine score on it (memo.cosineScore)
  //                  so the card + center node can surface it. The pivot path omits it (null) →
  //                  we fetch + decrypt that memo by id via the SAME fetch + decryptStringWithDEK
  //                  + JSON.parse path the neighbor loop uses (no new decrypt helper), and it has
  //                  no cosine score → the card + center node omit the "best match" line.
  async function renderEgoGraphForCenter(verse, centerMemoId, centerMemo = null) {
    cancelPendingPivot(verse); // (3.8b) any re-center (pivot/crumb/return/typed) pre-empts a pending single-click pivot
    const isPivot = (centerMemo == null);
    // (3.8c) One viewport snapshot per render drives BOTH the fetch count and the geometry.
    const profile = graphProfile();

    // (5.1) Replace the prior cluster (graph + center card) WITHIN THIS VERSE's body so a pivot
    // re-centers in place. The summary + breadcrumbs ABOVE (this verse's own children) are
    // intentionally NOT matched here → they stay visible and unchanged. Other verses are untouched.
    verse.bodyEl.querySelectorAll(':scope > .retrieve-graph, :scope > .memo-card')
      .forEach(el => el.remove());

    // Graph region first (placeholder); the center card is appended below it once we have the
    // memo → DOM order stays summary → graph → card.
    const { region: graphRegion, bodyEl: graphBody } = buildGraphRegion();
    verse.bodyEl.appendChild(graphRegion);

    // Pivot path: no DEK / memo in hand. Derive the session DEK, then fetch + decrypt the
    // center's own content by id reusing the SAME path the neighbor loop uses. Every failure
    // lands in the graph region; the summary above is untouched.
    let dek = null;
    if (isPivot) {
      dek = await getSessionDEK();
      if (!dek) { showGraphError(graphBody, 'Your session is locked — re-unlock to open this memo.'); return; }
      try {
        const cr = await fetch(`/api/memos/${encodeURIComponent(centerMemoId)}`, {
          method: 'GET', credentials: 'same-origin'
        });
        if (cr.status === 404) { showGraphError(graphBody, 'That memo could not be loaded (it may have just been deleted).'); return; }
        if (!cr.ok) { showGraphError(graphBody, `Could not load that memo (HTTP ${cr.status}).`); return; }
        const content = await cr.json();
        const plaintext = await decryptStringWithDEK(content.memo_ciphertext, content.memo_iv, dek);
        centerMemo = JSON.parse(plaintext);
      } catch (err) {
        console.warn('[retrieve] pivot center fetch/decrypt failed:', centerMemoId, err);
        showGraphError(graphBody, 'Found that memo but could not decrypt it.');
        return;
      }
    }

    // Cosine score is meaningful only for the typed-query best match (the typed flow stashes it
    // on the memo); a pivot has none → null, and the card + center node omit the cosine line.
    const score = (centerMemo && typeof centerMemo.cosineScore === 'number') ? centerMemo.cosineScore : null;

    // Center card BELOW the graph (within this verse's body).
    verse.bodyEl.appendChild(buildCenterCard(centerMemo, score));

    // The typed-query path still needs a DEK for the neighbor content/blob reads (its sweep DEK
    // is out of scope here). getSessionDEK is idempotent — re-deriving it from sessionStorage is
    // cheap and never hits the network.
    if (!dek) dek = await getSessionDEK();
    if (!dek) { showGraphError(graphBody, 'Your session is locked — re-unlock to load neighbors.'); return; }

    // Neighbor data layer + ego-graph render (self-contained; never throws). (3.6b) The onPivot
    // callback routes a NEIGHBOR single-click through pivotTo on THIS verse, which pushes a
    // breadcrumb and then re-enters this renderer (memo omitted → the 3.6a pivot fetch-by-id path).
    // `verse` is threaded to renderEgoGraph so its per-verse single-click timer is used.
    await loadAndRenderNeighbors(centerMemoId, centerMemo, score, dek, graphBody, (memoId, title) => pivotTo(verse, memoId, title), profile, verse);
  }

  async function submitQuery(q) {
    if (inFlight) return;
    q = (q || '').trim();
    if (!q) return;                 // the shell guards empties; nothing to do here
    setBusy(true);

    // (5.1) Each submit creates a NEW verse appended to the #retrieveResult scrollback. Every verse
    // stays expanded, so prior verses stay live, visible, and intact. The working/error/result
    // content goes into verse.bodyEl — never wiping the scrollback or any other verse.
    const verse = createVerse(q);
    showVerseMessage(verse, 'Searching your memos…', false);

    // (3.7) Close any stray full-memo overlay (and detach its Escape listener) before the sweep.
    closeAnyMemoOverlay();
    cancelPendingPivot(verse); // (3.8b) keep the invariant explicit (a fresh verse has no pending pivot)

    try {
      // The DEK decrypts both corpus embeddings and the center's content.
      const dek = await getSessionDEK();
      if (!dek) { showVerseMessage(verse, 'Your session is locked — re-unlock to search.', true); return; }

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
        if (r.status === 401) { showVerseMessage(verse, 'Your session expired — please re-unlock.', true); return; }
        if (!r.ok) { showVerseMessage(verse, `Couldn't load your memos (HTTP ${r.status}). Try again.`, true); return; }
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
        showVerseMessage(verse, 'Nothing to search yet — capture a few memos first.', false);
        return;
      }

      // Cosine-score the whole corpus with the reused scorer; pick the single best = CENTER.
      const center = topKNeighbors(queryVec, candidates, 1)[0];

      // Fetch + decrypt the center's content (3.2b endpoint).
      const cr = await fetch(`/api/memos/${encodeURIComponent(center.memo_id)}`, {
        method: 'GET', credentials: 'same-origin'
      });
      if (cr.status === 401) { showVerseMessage(verse, 'Your session expired — please re-unlock.', true); return; }
      if (cr.status === 404) { showVerseMessage(verse, 'The best match could not be loaded (it may have just been deleted).', true); return; }
      if (!cr.ok) { showVerseMessage(verse, `Couldn't load the best match (HTTP ${cr.status}). Try again.`, true); return; }
      const content = await cr.json();

      let memo;
      try {
        const plaintext = await decryptStringWithDEK(content.memo_ciphertext, content.memo_iv, dek);
        memo = JSON.parse(plaintext);
      } catch {
        showVerseMessage(verse, 'Found the best match but could not decrypt it.', true);
        return;
      }

      // 3.2c center card + 3.3 streaming summary ABOVE it + the ego-graph BETWEEN them, built INTO
      // this verse's body. DOM order within the body: summary → breadcrumbs → graph → center card.
      // streamSummary AND renderEgoGraphForCenter each handle their own errors and NEVER throw, so a
      // summary failure OR a graph/neighbor failure leaves the other regions intact.
      verse.bodyEl.innerHTML = ''; // clear THIS verse's "Searching…" placeholder (scrollback intact)
      const { region: summaryRegion, textEl: summaryText } = buildSummaryRegion();
      verse.bodyEl.appendChild(summaryRegion);

      // Carry the winning cosine score on the (already-decrypted) center memo so the shared
      // renderer can surface it on the center node. A 3.6a pivot has no score → omitted.
      memo.cosineScore = center.score;

      // (5.1) Center resolved → record it on the verse (downstream R2 reads verse.centerTitle; the
      // query bubble above stays the user's question only and is not rewritten here).
      verse.centerTitle = memo.title || '(untitled)';

      // (3.6b) Origin = trail[0]: keep the decrypted typed-query center memo (with cosineScore) so
      // returning to origin re-renders it identically — no re-fetch. Mount the breadcrumb row
      // BETWEEN the summary and the graph; renderEgoGraphForCenter removes only the graph + card, so
      // the row survives every pivot/crumb. Hidden at depth 1.
      verse.trail = [{ memo_id: center.memo_id, title: memo.title || '(untitled)', memo }];
      verse.breadcrumbsEl = buildBreadcrumbsRegion();
      verse.bodyEl.appendChild(verse.breadcrumbsEl);
      renderBreadcrumbs(verse);

      // Run the summary stream and the graph + card render in parallel. Both are
      // self-contained: each catches internally and resolves (never rejects), so
      // Promise.all reliably awaits both. setBusy(false) flips only once both finish.
      await Promise.all([
        streamSummary(q, memo, summaryText),
        renderEgoGraphForCenter(verse, center.memo_id, memo)
      ]);

      // (5.1, item 6) Turn 1 now exists → ask the shell to reframe its placeholder to read as
      // "respond to this thread" rather than "new search". PURE COPY — the query path is unchanged
      // (R1: every turn is still a fresh standalone sweep). Fired once.
      if (!placeholderReframed) { onPlaceholderChange('Respond to this thread…'); placeholderReframed = true; }
    } catch (err) {
      // Most likely the embedding model failed to load (CDN/network); never leave a blank panel.
      console.warn('[retrieve] sweep failed:', err);
      showVerseMessage(verse, "Search failed — the model couldn't load or a network error occurred. Try again.", true);
    } finally {
      setBusy(false);
    }
  }

  // The shell drives submits through this controller (no internal input row / listeners).
  return { submitQuery, isBusy: () => inFlight };
}

// ---- 3.3 streaming summary helpers (CENTER-ONLY; no neighbor context) ----

// A region for the streamed summary, placed ABOVE the center card. Returns the wrapper
// plus the inner text element that the stream progressively writes into.
function buildSummaryRegion() {
  const region = document.createElement('div');
  region.className = 'retrieve-summary';
  region.style.margin = '0 0 16px';
  // The visible "Summary" caption is dropped (the italic body below now signals "summary");
  // keep the semantic for assistive tech via an aria-label on the container.
  region.setAttribute('aria-label', 'Summary');

  const textEl = document.createElement('div');
  textEl.className = 'retrieve-summary-text';
  // Italic signals this is the LLM summary (replaces the removed label). Set on the persistent
  // container so it survives streaming — streamSummary only rewrites textEl's text/children.
  textEl.style.fontStyle = 'italic';
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

// ---- 3.4a data layer + 3.4b ego-graph render ----
//
// Reads the center's connection blob, decrypts it with the session DEK, picks the top
// neighbors by score, N-fetches each neighbor's content via the EXISTING /api/memos/<id>
// endpoint, decrypts, and (3.4b) draws a hand-rolled inline SVG ego-graph BETWEEN the
// summary and the center card. The DATA path is unchanged from 3.4a; only the render
// target changed from a text readout to the SVG graph.
//
// Fully self-contained error handling: every failure mode lands in the graph region; the
// 3.2c center card and the 3.3 streaming summary do NOT depend on this and must keep
// rendering even if everything below fails.

// Empty graph region with a placeholder line — appended to the result column immediately
// so the DOM order (summary, graph, card) is fixed before either async path resolves.
function buildGraphRegion() {
  const region = document.createElement('div');
  region.className = 'retrieve-graph';
  region.style.margin = '0 0 14px';

  const bodyEl = document.createElement('div');
  const waiting = document.createElement('span');
  waiting.className = 'small';
  waiting.textContent = 'Building graph…';
  bodyEl.appendChild(waiting);
  region.appendChild(bodyEl);

  return { region, bodyEl };
}

// Read the center's connection blob, fetch+decrypt the top-N neighbors, draw the graph.
// Never throws: any uncaught path lands in the catch and shows an inline error.
//   centerId    — the center memo's id (memo_id), used for the blob fetch.
//   centerMemo  — the already-decrypted center memo { title, body, summary, ... }.
//   centerScore — the center's cosine score for the center node's hover title, or null for a
//                 3.6a pivot center (no sweep → no score; the hover then shows the title only).
//   onPivot     — (3.6a) callback(neighborMemoId) a NEIGHBOR single-click invokes to re-center
//                 the graph on that neighbor; threaded straight through to renderEgoGraph.
//   profile     — (3.8c) the per-render geometry profile (desktop/mobile); caps the neighbor
//                 slice (profile.neighborCount) and is threaded straight to renderEgoGraph.
//   verse       — (5.1) the owning verse; threaded straight to renderEgoGraph so the neighbor
//                 single-click uses THAT verse's per-verse disambiguation timer.
async function loadAndRenderNeighbors(centerId, centerMemo, centerScore, dek, bodyEl, onPivot, profile, verse) {
  const center = { memo_id: centerId, title: (centerMemo && centerMemo.title) || '(untitled)', score: centerScore, memo: centerMemo };
  try {
    // 1) GET the center's blob (ciphertext-only sibling of the content endpoint).
    const r = await fetch(`/api/memos/${encodeURIComponent(centerId)}/connection-blob`, {
      method: 'GET',
      credentials: 'same-origin'
    });
    if (r.status === 401) { showGraphError(bodyEl, 'Session expired — re-unlock to load neighbors.'); return; }
    if (r.status === 404) { showGraphError(bodyEl, 'Could not load the center memo blob (it may have just been deleted).'); return; }
    if (!r.ok) { showGraphError(bodyEl, `Could not load neighbors (HTTP ${r.status}).`); return; }
    const blobResponse = await r.json();

    // 2) Null blob fields = the memo exists but was never connected (e.g. the very first
    // memo, or one whose connect pass never finished). Draw the center node ALONE — an
    // honest "no connections yet" graph, distinct from a fetch error. No crash, no ring.
    if (blobResponse.connection_blob_ciphertext == null || blobResponse.connection_blob_iv == null) {
      renderEgoGraph(bodyEl, center, [], [], onPivot, 'unconnected', profile, verse);
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
      showGraphError(bodyEl, 'Found the neighbor set but could not decrypt it.');
      return;
    }

    const allNeighbors = Array.isArray(blob && blob.neighbors) ? blob.neighbors : [];
    if (allNeighbors.length === 0) {
      // The connect pass ran but produced an empty set (e.g. first memo). Lone center node.
      renderEgoGraph(bodyEl, center, [], [], onPivot, 'unconnected', profile, verse);
      return;
    }

    // 4) Top-N by score, descending. The blob holds up to K_NEIGHBORS (20) from the connect
    // pass; we display only profile.neighborCount here (3.8c: desktop = NEIGHBOR_DISPLAY_COUNT,
    // mobile fewer), so a mobile render also fetches fewer neighbors in the loop below.
    const top = allNeighbors
      .slice()
      .filter(n => (typeof n.score === 'number' ? n.score : 0) >= NEIGHBOR_DISPLAY_THRESHOLD)
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, profile.neighborCount);

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
          score: typeof n.score === 'number' ? n.score : 0,
          memo: neighborMemo
        });
      } catch (err) {
        console.warn('[retrieve] neighbor decrypt/parse failed, skipping:', n.memo_id, err);
        skipped++;
      }
    }

    // 6) (3.5) Inter-neighbor edges. Fetch each RESOLVED neighbor's OWN connection blob
    // (the SAME GET /api/memos/<id>/connection-blob + DEK-decrypt + JSON.parse path as the
    // center blob above — no new endpoint, no batch, no plaintext to our server) to learn
    // that neighbor's outgoing connections, then keep union/directed, thresholded pairs (an
    // edge when EITHER neighbor lists the other) among the on-screen neighbors. A per-neighbor
    // blob failure yields no outgoing edges for that neighbor (fewer edges, never fatal). This
    // stays inside the same try as everything else, so an edge-layer error is isolated to the
    // graph region — card + summary are unaffected.
    const adjacency = await fetchNeighborAdjacencies(resolved, dek);
    const edges = computeInterNeighborEdges(resolved, adjacency);

    // Draw the ego-graph from the resolved set + the inter-neighbor edge set. If every picked
    // neighbor was unfetchable (resolved empty but the blob had neighbors), renderEgoGraph
    // falls back to the lone center node — honest, no crash, no empty ring. No qualifying
    // edges → exactly the 3.4b look (spokes + nodes, no inter-edges).
    // (3.8a) Lone-center reason for the honest caption: every stored neighbor fell below the 3.6c
    // display floor ('below-floor') vs above-floor neighbors existed but all failed to fetch/decrypt
    // ('unresolved'). Stays null when a ring renders (resolved non-empty) → caption block never runs.
    let emptyReason = null;
    if (resolved.length === 0) {
      emptyReason = (top.length === 0) ? 'below-floor' : 'unresolved';
    }
    renderEgoGraph(bodyEl, center, resolved, edges, onPivot, emptyReason, profile, verse);
  } catch (err) {
    // Unhandled network/runtime error before any per-neighbor work. Show an inline
    // error; the card + summary above are unaffected.
    console.warn('[retrieve] neighbor layer failed:', err);
    showGraphError(bodyEl, 'Could not load neighbors (network or server error). The best-match memo is shown above.');
  }
}

// ---- 3.5 inter-neighbor edge data ----
//
// For each RESOLVED (on-screen) neighbor, read its OWN connection blob via the SAME
// ciphertext-only endpoint + DEK-decrypt + JSON.parse path used for the center blob (no new
// endpoint, no batch, no plaintext to our server) and project it to a { targetMemoId → score }
// map of that neighbor's outgoing connections. Per-neighbor tolerance: a null/empty blob, a
// 404/!ok fetch, or a decrypt/parse failure yields an EMPTY map (console.warn) — that neighbor
// simply contributes no edges. Missing blob data means fewer edges, NEVER a crash.
async function fetchNeighborAdjacencies(resolved, dek) {
  const adjacency = new Map(); // memo_id → Map(targetMemoId → score)
  for (const nb of resolved) {
    adjacency.set(nb.memo_id, await fetchOneNeighborAdjacency(nb.memo_id, dek));
  }
  return adjacency;
}

// One neighbor's outgoing connections as Map(targetMemoId → score). Never throws: every
// failure path returns an empty map so the edge computation just sees no outgoing edges.
async function fetchOneNeighborAdjacency(memoId, dek) {
  const out = new Map();
  try {
    const r = await fetch(`/api/memos/${encodeURIComponent(memoId)}/connection-blob`, {
      method: 'GET',
      credentials: 'same-origin'
    });
    if (!r.ok) {
      // 404 (since-deleted), 401, 5xx — treat as "no outgoing edges", not fatal.
      console.warn('[retrieve] neighbor blob fetch failed, no edges for:', memoId, r.status);
      return out;
    }
    const blobResponse = await r.json();
    // Null fields = this neighbor exists but was never connected → no outgoing edges.
    if (blobResponse.connection_blob_ciphertext == null || blobResponse.connection_blob_iv == null) {
      return out;
    }
    const plaintext = await decryptStringWithDEK(
      blobResponse.connection_blob_ciphertext,
      blobResponse.connection_blob_iv,
      dek
    );
    const blob = JSON.parse(plaintext);
    const list = Array.isArray(blob && blob.neighbors) ? blob.neighbors : [];
    for (const e of list) {
      // Same field names as the center blob: { memo_id, score }.
      if (e && typeof e.memo_id === 'string' && typeof e.score === 'number') {
        out.set(e.memo_id, e.score);
      }
    }
  } catch (err) {
    console.warn('[retrieve] neighbor blob decrypt/parse failed, no edges for:', memoId, err);
  }
  return out;
}

// UNION (directed) thresholded edge set among the ON-SCREEN neighbors ONLY. Connection blobs
// are forward-only / write-once: a memo's blob lists the memos that existed when it was
// captured and is never back-filled, so for any pair almost exactly ONE direction is ever
// present and the pair is virtually never listed in both directions. We therefore draw an edge when
// EITHER direction lists the other at >= INTER_NEIGHBOR_EDGE_THRESHOLD, using the MAX of the
// present directional score(s) as the qualifying score. Neither direction present → no edge
// (the two memos genuinely never listed each other). Off-screen ids a blob may reference are
// ignored because we only test ids that are themselves in the resolved set. Returns { a, b }
// memo_id pairs; renderEgoGraph maps each id to its ring position.
function computeInterNeighborEdges(resolved, adjacency) {
  const edges = [];
  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      const A = resolved[i];
      const B = resolved[j];
      // Directional scores from each neighbor's OWN blob (either may be absent — blobs are
      // forward-only, so a pair is almost never listed in both directions).
      const sAB = adjacency.get(A.memo_id)?.get(B.memo_id);
      const sBA = adjacency.get(B.memo_id)?.get(A.memo_id);
      const present = [];
      if (typeof sAB === 'number') present.push(sAB);
      if (typeof sBA === 'number') present.push(sBA);
      if (present.length === 0) continue; // neither lists the other → no edge
      // Union: qualify on the MAX of whichever direction(s) exist.
      if (Math.max(...present) >= INTER_NEIGHBOR_EDGE_THRESHOLD) {
        edges.push({ a: A.memo_id, b: B.memo_id });
      }
    }
  }
  return edges;
}

// Inline error in the graph region. Reuses the app's .err token (#b00020). The center
// card + summary are siblings and are unaffected — a graph failure is isolated here.
function showGraphError(bodyEl, text) {
  bodyEl.innerHTML = '';
  const panel = makeGraphPanel();
  const p = document.createElement('p');
  p.className = 'err';
  p.style.margin = '0';
  p.textContent = text;
  panel.appendChild(p);
  bodyEl.appendChild(panel);
}

// ---- 3.7 full-memo overlay (double-click a node → modal over the cluster) ----
//
// Opens the FULL synthesized memo (already decrypted in-session — NO fetch, NO LLM) in a singleton
// modal over the cluster; closing it returns to the exact same graph state (the cluster DOM is
// never touched). Reuses the .memo-card frame + existing design tokens. Every field renders via
// textContent ONLY — a hostile title/body/tag can never inject markup.

// Build the backdrop + card for `memo`; returns the backdrop element (not yet attached).
function buildMemoOverlay(memo) {
  const backdrop = document.createElement('div');
  backdrop.className = 'retrieve-memo-overlay';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-label', memo.title || 'Memo');
  backdrop.style.position = 'fixed';
  backdrop.style.inset = '0';
  backdrop.style.background = 'rgba(0,0,0,0.6)';
  backdrop.style.display = 'flex';
  backdrop.style.alignItems = 'center';
  backdrop.style.justifyContent = 'center';
  backdrop.style.zIndex = '1000';
  backdrop.style.padding = '16px'; // card never touches the screen edge on mobile

  const card = document.createElement('div');
  card.className = 'memo-card';
  card.style.position = 'relative';
  card.style.width = '100%';
  card.style.maxWidth = '560px';
  card.style.maxHeight = '82vh';
  card.style.overflowY = 'auto';
  card.style.textAlign = 'left';
  card.style.background = C_NODE_FILL;

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.style.position = 'absolute';
  closeBtn.style.top = '8px';
  closeBtn.style.right = '12px';
  closeBtn.style.background = 'transparent';
  closeBtn.style.border = 'none';
  closeBtn.style.fontSize = '22px';
  closeBtn.style.lineHeight = '1';
  closeBtn.style.cursor = 'pointer';
  closeBtn.style.color = C_MUTED;
  closeBtn.addEventListener('click', () => closeMemoOverlay(backdrop));

  // Fields, in order, each via textContent; skip any absent field.
  const h = document.createElement('h3');
  h.textContent = memo.title || '(untitled)';
  card.appendChild(h);

  if (memo.para_bucket) {
    const bucket = document.createElement('span');
    bucket.className = 'bucket';
    bucket.textContent = memo.para_bucket;
    card.appendChild(bucket);
  }

  if (memo.time_reference) {
    const when = document.createElement('p');
    when.className = 'small';
    when.style.color = C_MUTED;
    when.textContent = `When: ${memo.time_reference}`;
    card.appendChild(when);
  }

  if (memo.summary) {
    const summary = document.createElement('div');
    summary.className = 'memo-summary';
    summary.textContent = memo.summary;
    card.appendChild(summary);
  }

  const body = document.createElement('div');
  body.className = 'memo-body';
  body.style.whiteSpace = 'pre-wrap'; // preserve paragraph breaks in the body
  body.textContent = memo.body || '';
  card.appendChild(body);

  if (Array.isArray(memo.tags) && memo.tags.length) {
    const tags = document.createElement('div');
    tags.className = 'memo-tags';
    tags.textContent = memo.tags.join(' · '); // visible here (spec 4.3), NOT clickable
    card.appendChild(tags);
  }

  backdrop._closeBtn = closeBtn; // stash for initial focus
  card.appendChild(closeBtn);
  backdrop.appendChild(card);
  return backdrop;
}

// Open `memo` in the singleton overlay (no-op if memo is falsy). Backdrop click + Escape + the ×
// button all close; clicks inside the card do not. Initial focus lands on the × control.
function openMemoOverlay(memo) {
  if (!memo) return;
  closeAnyMemoOverlay(); // singleton: only one open at a time
  const backdrop = buildMemoOverlay(memo);
  backdrop.addEventListener('click', (e) => {
    // Backdrop click closes; clicks inside the card do not (they don't hit the backdrop itself).
    if (e.target === backdrop) closeMemoOverlay(backdrop);
  });
  const esc = (e) => { if (e.key === 'Escape') closeMemoOverlay(backdrop); };
  backdrop._esc = esc;
  document.addEventListener('keydown', esc);
  document.body.appendChild(backdrop);
  if (backdrop._closeBtn) backdrop._closeBtn.focus();
}

// Close a specific overlay: detach its Escape listener, then remove it from the DOM.
function closeMemoOverlay(backdrop) {
  if (!backdrop) return;
  if (backdrop._esc) document.removeEventListener('keydown', backdrop._esc);
  backdrop.remove();
}

// Close whatever overlay is currently open (singleton), if any.
function closeAnyMemoOverlay() {
  const el = document.querySelector('.retrieve-memo-overlay');
  if (el) closeMemoOverlay(el);
}

// ---- 3.4b ego-graph SVG render ----
//
// Hand-rolled inline SVG (no library, no new dependency). Single radial ring: the center
// node in the middle, the resolved neighbors evenly spaced on one circle around it, a spoke
// from the center to each neighbor, (3.5) thin dashed edges between related neighbors (union/directed)
// (distinct from the spokes), neighbor radius scaled by cosine score (center stays largest),
// and a truncated label per node with the full title in an SVG <title> for hover. Styling
// inherits the app's existing design tokens (see makeGraphPanel / the scoped <style>).
//
// Colours/sizes are LOCAL constants so the whole graph is tunable in one place. All text
// is set via textContent / SVG text nodes — never innerHTML — so a hostile memo title
// can never inject markup.
const SVG_NS = 'http://www.w3.org/2000/svg';

// viewBox geometry. The SVG scales to its container (width:100%, height:auto) so it never
// overflows at narrow width. Nodes are rounded-rectangle memo cards in a STATIC TIERED layout
// (center card in the middle, neighbour cards in a row above and a row below) — NOT a radial
// ring — so the per-profile geometry is expressed in card dimensions + row baselines, not radii.
const LABEL_TRUNCATE_DESKTOP = 20; // per-line char budget for the two-line card title (desktop)

// (3.8c) Geometry profiles. Selected per-render by viewport width (breakpoint, NOT device
// detection). Both profiles carry IDENTICAL field names so renderEgoGraph reads them uniformly:
//   vbW/vbH      — viewBox size (the SVG scales to its container)
//   cx/cy        — center-card center (also the spoke origin)
//   centerW/centerH — center card size; nodeW/nodeH — neighbour card size
//   topRowY/bottomRowY — the two neighbour-row baselines (card-center y)
//   labelChars   — per-line char budget for the two-line in-card title wrap
//   neighborCount — how many neighbours are fetched + drawn (the ring cap)
// Desktop fits ceil(8/2)=4 cards per row via slotWidth = vbW / rowCount (see renderEgoGraph);
// vbW is widened so 4 cards sit with comfortable gaps and never overlap. STRAWMAN values.
const GRAPH_MOBILE_MAX_WIDTH = 600; // px; <= this picks the mobile profile
const GRAPH_PROFILE_DESKTOP = {
  vbW: 820, vbH: 500, cx: 410, cy: 250,
  centerW: 180, centerH: 56, nodeW: 150, nodeH: 48,
  topRowY: 78, bottomRowY: 422,
  labelChars: LABEL_TRUNCATE_DESKTOP,
  neighborCount: NEIGHBOR_DISPLAY_COUNT,
};
const GRAPH_PROFILE_MOBILE = {
  vbW: 380, vbH: 460, cx: 190, cy: 230,
  centerW: 150, centerH: 52, nodeW: 150, nodeH: 46,
  topRowY: 69, bottomRowY: 391,
  labelChars: 18,
  neighborCount: 4,
};
// Single viewport snapshot per render. Guard matchMedia for non-browser/test contexts.
function graphProfile() {
  const isMobile = (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia(`(max-width: ${GRAPH_MOBILE_MAX_WIDTH}px)`).matches);
  return isMobile ? GRAPH_PROFILE_MOBILE : GRAPH_PROFILE_DESKTOP;
}

// Design-token palette (lifted from public/app.html so the graph reads as part of the app).
const C_INK = 'rgba(255,255,255,0.92)'; // primary ink / hover label
const C_INK_BODY = '#8e8e93';    // label ink
const C_MUTED = '#8e8e93';       // captions
const C_NODE_FILL = '#2e2e31';   // neighbor fill (surface-2)
const C_NODE_STROKE = '#48484a'; // neighbor stroke
const C_SPOKE = 'rgba(255,255,255,0.22)'; // center spokes

// 3.5 inter-neighbor edges: deliberately DISTINCT from the solid grey center spokes — a muted
// blue, dashed, lighter weight — so a center spoke vs a neighbor↔neighbor edge reads at a
// glance. UNIFORM (not scaled by strength; node size already encodes magnitude).
const C_INTER_EDGE = 'rgba(255,255,255,0.12)'; // inter-neighbor edges (dashed)
const C_CENTER_FILL = '#ff9f0a'; // center node (accent)
const C_CENTER_LABEL = '#000000'; // label on center node
const INTER_EDGE_WIDTH = 1;      // lighter than the spokes
const INTER_EDGE_DASH = '5 4';   // dashed (vs solid spokes)

// Spokes now carry the connection-strength signal (node size no longer does — cards are uniform):
// each spoke's stroke-width scales with its neighbour's score, normalised against this set's own
// min/max into [SPOKE_MIN_WIDTH, SPOKE_MAX_WIDTH]. Equal/absent scores fall back to a flat width.
const SPOKE_MIN_WIDTH = 1.0;
const SPOKE_MAX_WIDTH = 3.0;

// 3.6a click/double-click disambiguation window (ms). A single-click pivot waits this long
// before firing so a double-click — reserved for the 3.7 full-memo overlay — can pre-empt it.
// (3.8b) Widened 240 → 350: 240 sat below typical OS double-click thresholds, so a slow double
// click could misfire the single-click pivot before the 2nd click landed.
const CLICK_DISAMBIG_MS = 350;

// (3.8b→5.1) The single-click disambiguation timer is now PER-VERSE (verse.pendingClickTimer /
// verse.pendingClickNode), so a pending pivot on one verse can't be stranded by a re-render OR
// fired by activity on a different verse. cancelPendingPivot(verse) clears THAT verse's timer; any
// re-center (pivot/crumb/return/typed) pre-empts a stale single-click pivot.
function cancelPendingPivot(verse) {
  if (!verse) return;
  if (verse.pendingClickTimer !== null) { clearTimeout(verse.pendingClickTimer); }
  verse.pendingClickTimer = null;
  verse.pendingClickNode = null;
}

// (5.1) Append-and-keep scrollback state: each typed turn creates a verse (query bubble + answer
// block). Tracked at module scope so the thread persists across submits; reset at the top of each
// mount. Verses stay expanded and stacked — there is no active/collapsed verse to track.
let verses = [];

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k]);
  return el;
}

// Truncate to a small char budget with an ellipsis. The FULL title always lives in the
// node's <title> for hover, so truncation never hides information.
function truncateLabel(s, n) {
  s = (s || '').trim();
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

// Map a neighbor's score → radius. Normalize against THIS set's own min/max so size
// differences are visible even when cosine scores cluster. Divide-by-zero-safe: if every
// score is equal (or a single neighbor), every node gets the mid radius.
function makeScoreToRadius(neighbors, nMin, nMax) {
  const scores = neighbors.map(n => (typeof n.score === 'number' ? n.score : 0));
  const lo = Math.min(...scores);
  const hi = Math.max(...scores);
  const span = hi - lo;
  const mid = (nMin + nMax) / 2;
  return (score) => {
    if (!(span > 0)) return mid;                       // all-equal / single → mid
    const t = Math.max(0, Math.min(1, (score - lo) / span)); // clamp to [0,1]
    return nMin + t * (nMax - nMin);
  };
}

// Map a neighbor's score → spoke stroke-width. Mirrors makeScoreToRadius's normalisation:
// normalize against THIS set's own min/max so strength differences are visible even when cosine
// scores cluster. Returns a flat 1.5 when a score is absent (null, e.g. a pivot) or every score
// is equal (single neighbour / divide-by-zero-safe), so the spoke never collapses to a hairline.
function makeScoreToSpokeWidth(neighbors) {
  const scores = neighbors.map(n => (typeof n.score === 'number' ? n.score : 0));
  const lo = Math.min(...scores);
  const hi = Math.max(...scores);
  const span = hi - lo;
  return (score) => {
    if (typeof score !== 'number' || !(span > 0)) return 1.5; // absent / all-equal → flat
    const t = Math.max(0, Math.min(1, (score - lo) / span));  // clamp to [0,1]
    return SPOKE_MIN_WIDTH + t * (SPOKE_MAX_WIDTH - SPOKE_MIN_WIDTH);
  };
}

// Wrap a card title to AT MOST two lines for rendering INSIDE the node. Returns [line1, line2]:
//   - title.length <= maxChars → [title, ''] (one line, vertically centred by the caller).
//   - otherwise greedily pack whole words into line1 until the next word would exceed maxChars;
//     a single over-long word that never fits → line1 = title.slice(0, maxChars).
//   - line2 = the remainder; if it still exceeds maxChars, hard-truncate to maxChars-1 + '…'.
// The FULL title always lives in the node's <title> for hover, so wrapping never hides info.
function wrapTwoLines(title, maxChars) {
  const s = (title || '').trim();
  if (s.length <= maxChars) return [s, ''];
  const words = s.split(/\s+/);
  let line1 = '';
  let i = 0;
  for (; i < words.length; i++) {
    const candidate = line1 ? `${line1} ${words[i]}` : words[i];
    if (candidate.length > maxChars) break;
    line1 = candidate;
  }
  let line2;
  if (line1 === '') {
    // First word alone already exceeds the budget: hard-split it across the two lines.
    line1 = s.slice(0, maxChars);
    line2 = s.slice(maxChars);
  } else {
    line2 = words.slice(i).join(' ');
  }
  if (line2.length > maxChars) line2 = line2.slice(0, maxChars - 1).trimEnd() + '…';
  return [line1, line2];
}

// Append a centred, two-line title to a card's SVG group. line2 empty → a single line is
// vertically centred (y = cy + 4); otherwise line1 sits above (cy - 6) and line2 below (cy + 10).
// All text via textContent (svgEl) → a hostile title can never inject markup.
function appendCardLabel(group, title, cx, cy, maxChars, fill, fontWeight) {
  const [line1, line2] = wrapTwoLines(title, maxChars);
  const mk = (text, y) => {
    const t = svgEl('text', {
      x: cx, y, 'text-anchor': 'middle', 'font-size': 12, fill, class: 'ego-label'
    });
    if (fontWeight) t.setAttribute('font-weight', fontWeight);
    t.textContent = text;
    group.appendChild(t);
  };
  if (line2) { mk(line1, cy - 6); mk(line2, cy + 10); }
  else { mk(line1, cy + 4); }
}

// A card-framed panel matching .memo-card so the graph sits in the same visual frame as
// the rest of the retrieve column.
function makeGraphPanel() {
  const panel = document.createElement('div');
  panel.className = 'memo-card';      // inherit the app's card frame (border/radius/bg/pad)
  panel.style.textAlign = 'center';
  return panel;
}

// (3.8a) Honest sparse-cluster captions. A lone center (no ring) has three distinct causes; the
// caller in loadAndRenderNeighbors knows which and threads the reason to renderEgoGraph. Calm,
// non-alarming wording. (Network/decrypt failures are NOT here — those use showGraphError.)
const EGO_EMPTY_CAPTIONS = {
  unconnected: 'no connections yet',
  'below-floor': 'nothing closely related yet',
  unresolved: "related notes couldn't be loaded",
};
function egoEmptyCaption(reason) {
  return EGO_EMPTY_CAPTIONS[reason] || EGO_EMPTY_CAPTIONS.unconnected;
}

// Draw the ego-graph. center = { memo_id, title, score }; neighbors = resolved set
// [{ memo_id, title, summary, score }]; edges = inter-neighbor pairs [{ a, b }] of
// neighbor memo_ids (3.5; may be omitted/empty). An empty neighbors array → lone center node;
// an empty/omitted edges array → exactly the 3.4b look (spokes + nodes, no inter-edges).
// (3.6a) onPivot(neighborMemoId) — invoked by a NEIGHBOR single-click to re-center the graph
// on that neighbor; the center node is NOT wired. center.score may be null for a pivot center
// (no sweep) → its hover then shows the title alone (no "best match · cosine …").
// (3.8a) emptyReason — when neighbors is empty (lone center), selects the honest caption via
// egoEmptyCaption ('unconnected' | 'below-floor' | 'unresolved'); ignored when a ring renders.
function renderEgoGraph(bodyEl, center, neighbors, edges, onPivot, emptyReason = null, profile = null, verse = null) {
  const G = profile || GRAPH_PROFILE_DESKTOP; // (3.8c) desktop profile mirrors the bare constants → byte-identical
  bodyEl.innerHTML = '';
  const panel = makeGraphPanel();

  const svg = svgEl('svg', {
    viewBox: `0 0 ${G.vbW} ${G.vbH}`,
    width: '100%',
    role: 'img',
    'aria-label': 'Ego-graph of the best-match memo and its nearest neighbors',
    preserveAspectRatio: 'xMidYMid meet'
  });
  svg.style.display = 'block';
  svg.style.width = '100%';
  svg.style.height = 'auto';
  svg.style.maxWidth = `${G.vbW}px`;
  svg.style.margin = '0 auto';
  svg.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif';
  // (3.8c) Disable double-tap-zoom so it can't fight the 3.7 overlay open gesture on touch
  // (inert on non-touch / desktop). Single inline style; no media query needed.
  svg.style.touchAction = 'manipulation';

  // Scoped hover styling: emphasize a node's stroke and bold its label on hover. Desktop
  // hover only (mobile tap is 3.8). (3.6a) NEIGHBOR nodes are single-click pivot targets →
  // cursor:pointer; the center node is NOT a pivot target → it keeps the default cursor.
  const style = svgEl('style');
  style.textContent = `
    .ego-node { cursor: default; }
    .ego-center { cursor: pointer; }
    .ego-neighbor { cursor: pointer; }
    .ego-neighbor rect { transition: stroke-width .12s ease; }
    .ego-neighbor:hover rect { stroke-width: 3; }
    .ego-neighbor:hover .ego-label { font-weight: 600; fill: ${C_INK}; }
    .ego-label { pointer-events: none; }
  `;
  svg.appendChild(style);

  // ---- static tiered layout: center card in the middle, neighbour cards in a row above and a
  // row below (NO radial ring). Neighbours arrive score-descending; the strongest fill the TOP
  // row first, then the bottom row, preserving that order. Per design §7 the cards in a row are
  // evenly spaced by slot: slotWidth = vbW / rowCount; cardCenterX = slotWidth * (index + 0.5).
  const count = neighbors.length;
  const topCount = Math.ceil(count / 2);
  const bottomCount = Math.floor(count / 2);
  const positions = neighbors.map((n, i) => {
    const inTop = i < topCount;
    const rowIndex = inTop ? i : i - topCount;   // index within its own row
    const rowCount = inTop ? topCount : bottomCount;
    return {
      n,
      x: (G.vbW / rowCount) * (rowIndex + 0.5),   // slot-centred
      y: inTop ? G.topRowY : G.bottomRowY         // card-center y
    };
  });

  // ---- spokes first (drawn behind; the opaque cards clip the line ends at their borders) ----
  // The spoke carries the connection-strength signal now: stroke-width scales with the
  // neighbour's score (node cards are uniform). Equal/absent scores fall back to a flat width.
  const scoreToSpokeWidth = count ? makeScoreToSpokeWidth(neighbors) : null;
  for (const p of positions) {
    svg.appendChild(svgEl('line', {
      x1: G.cx, y1: G.cy, x2: p.x, y2: p.y,
      stroke: C_SPOKE,
      'stroke-width': scoreToSpokeWidth(typeof p.n.score === 'number' ? p.n.score : null)
    }));
  }

  // ---- inter-neighbor edges (3.5): above the spokes, still BEHIND every node ----
  // Order: center spokes are the base layer; the inter-neighbor edges (the new 3.5 signal)
  // overlay them so they are never occluded by a spoke; both stay behind the nodes, which are
  // drawn afterward. Each edge is one straight line between two neighbor positions, uniform
  // and visually distinct from the spokes (dashed, muted blue). NO pass-through dots where an
  // edge happens to cross an unrelated node (deferred).
  if (edges && edges.length) {
    const posById = new Map(positions.map(p => [p.n.memo_id, p]));
    for (const e of edges) {
      const pa = posById.get(e.a);
      const pb = posById.get(e.b);
      if (!pa || !pb) continue; // defensive: only on-screen pairs are drawable
      svg.appendChild(svgEl('line', {
        x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y,
        stroke: C_INTER_EDGE, 'stroke-width': INTER_EDGE_WIDTH,
        'stroke-dasharray': INTER_EDGE_DASH, 'stroke-linecap': 'round'
      }));
    }
  }

  // ---- neighbour cards (on top of spokes; opaque rects clip the spoke + edge line ends) ----
  // (3.8b→5.1) The single-click disambiguation timer is now PER-VERSE (verse.pendingClickTimer /
  // cancelPendingPivot(verse)) so a pending pivot on one verse can't be stranded by a re-render or
  // fired by activity on another verse; the handlers below reference the threaded `verse`.
  for (const p of positions) {
    const g = svgEl('g', { class: 'ego-node ego-neighbor' });

    // (3.6a→tap-ios) Single click/tap on a NEIGHBOR re-centers the graph on it (pivot), held
    // for CLICK_DISAMBIG_MS so a 2nd tap can pre-empt it. The 2nd click/tap on the SAME node
    // inside the window opens the 3.7 overlay DIRECTLY — manual double-tap detection, because
    // iOS Safari does not reliably synthesize dblclick on SVG (especially standalone PWAs).
    // A tap on a DIFFERENT node cancels the old pending pivot and arms its own, so two fast
    // taps on different neighbors no longer silently kill both actions.
    if (onPivot) {
      const neighborMemoId = p.n.memo_id;
      g.addEventListener('click', () => {
        // (5.1) Same-node 2nd tap inside the window opens the overlay; otherwise arm a per-verse
        // single-click pivot. With no verse (defensive), fall back to an immediate pivot.
        if (verse && verse.pendingClickTimer !== null && verse.pendingClickNode === neighborMemoId) {
          cancelPendingPivot(verse);
          // (3.7) Open the FULL memo (already in hand on the node) over the cluster.
          if (p.n.memo) openMemoOverlay(p.n.memo);
          return;
        }
        cancelPendingPivot(verse);
        if (!verse) { onPivot(neighborMemoId, p.n.title); return; }
        verse.pendingClickNode = neighborMemoId;
        verse.pendingClickTimer = setTimeout(() => {
          verse.pendingClickTimer = null;
          verse.pendingClickNode = null;
          // (3.6b) onPivot(memoId, title) → pivotTo: push a crumb, then re-center (3.6a fetch by id).
          onPivot(neighborMemoId, p.n.title);
        }, CLICK_DISAMBIG_MS);
      });
    }

    const rect = svgEl('rect', {
      x: p.x - G.nodeW / 2, y: p.y - G.nodeH / 2,
      width: G.nodeW, height: G.nodeH, rx: 12,
      fill: C_NODE_FILL, stroke: C_NODE_STROKE, 'stroke-width': 1.5
    });
    // Full title on hover (native SVG tooltip). textContent → no markup injection.
    const tip = svgEl('title');
    tip.textContent = `${p.n.title || '(untitled)'} · cosine ${Number(p.n.score || 0).toFixed(3)}`;
    g.appendChild(tip);
    g.appendChild(rect);

    // Title INSIDE the card, clamped to two lines (no outside-the-node radial offset anymore).
    appendCardLabel(g, p.n.title, p.x, p.y, G.labelChars, C_INK);

    svg.appendChild(g);
  }

  // ---- center card last (largest, on top) ----
  const cg = svgEl('g', { class: 'ego-node ego-center' });
  const cTip = svgEl('title');
  // Typed-query center is the "best match" with a cosine score; a 3.6a pivot center has no
  // score (no sweep) → show its title alone, not a misleading "best match · cosine 0.000".
  const centerScoreSuffix = (typeof center.score === 'number')
    ? ` · best match · cosine ${center.score.toFixed(3)}`
    : '';
  cTip.textContent = `${center.title || '(untitled)'}${centerScoreSuffix}`;
  cg.appendChild(cTip);
  cg.appendChild(svgEl('rect', {
    x: G.cx - G.centerW / 2, y: G.cy - G.centerH / 2,
    width: G.centerW, height: G.centerH, rx: 12,
    fill: C_CENTER_FILL, stroke: C_CENTER_FILL, 'stroke-width': 1.5
  }));
  // Title INSIDE the card, two-line clamp (same labelChars as the neighbours), bold center ink.
  appendCardLabel(cg, center.title, G.cx, G.cy, G.labelChars, C_CENTER_LABEL, 600);
  // (3.7→tap-ios) SINGLE click/tap on the center opens its FULL memo (already in hand). The
  // center is not a pivot target — no competing action, no disambiguator — and dblclick is
  // unreliable on iOS SVG, so single-tap is the dependable affordance.
  cg.addEventListener('click', () => { if (center.memo) openMemoOverlay(center.memo); });
  svg.appendChild(cg);

  panel.appendChild(svg);

  // Honest caption for the no-neighbors case: a lone center with no ring.
  if (count === 0) {
    const note = document.createElement('p');
    note.className = 'small';
    note.style.margin = '6px 0 0';
    note.style.color = C_MUTED;
    note.textContent = egoEmptyCaption(emptyReason);
    panel.appendChild(note);
  }

  bodyEl.appendChild(panel);
}
