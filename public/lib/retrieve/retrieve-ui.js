// Retrieve UI shell (milestone 3.1) — pure client-side placeholder.
// Self-contained: imports nothing. No crypto, no session/key access, no LLM,
// no embedding model, no network. Real retrieval is wired in a later milestone.

export function mountRetrieve(container) {
  // app.html guards against a second mount, but clear defensively so a stray
  // re-call can never stack a duplicate UI inside the container.
  container.innerHTML = '';

  // Query row: a single-line input (Enter submits) plus a Search button.
  // Mirrors the onboarding key-input row already present in app.html.
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

  // Inline hint for empty submits. Kept separate from the result region so an
  // empty submit never disturbs the idle empty-state or a prior placeholder.
  const hint = document.createElement('p');
  hint.id = 'retrieveHint';
  hint.className = 'small';
  hint.style.display = 'none';
  hint.textContent = 'Type a question to search.';

  // Result region: shows the idle empty-state now, the placeholder after submit.
  const result = document.createElement('div');
  result.id = 'retrieveResult';

  const empty = document.createElement('p');
  empty.id = 'retrieveEmpty';
  empty.textContent = 'Ask a question to search your memos.';
  result.appendChild(empty);

  container.appendChild(row);
  container.appendChild(hint);
  container.appendChild(result);

  // Submit: placeholder ONLY. No fetch, no decrypt, no scoring, no import.
  function submit() {
    const q = input.value.trim();
    if (!q) {
      // Empty / whitespace-only: no network, no result-region change — brief hint only.
      hint.style.display = 'block';
      input.focus();
      return;
    }
    hint.style.display = 'none';

    result.innerHTML = '';

    const card = document.createElement('div');
    card.className = 'memo-card';

    const label = document.createElement('div');
    label.className = 'memo-summary';
    label.textContent = 'Your query';

    const queryText = document.createElement('div');
    queryText.className = 'memo-body';
    queryText.textContent = q; // textContent: never interpret user text as HTML

    card.appendChild(label);
    card.appendChild(queryText);

    const note = document.createElement('p');
    note.textContent = "Search isn't wired up yet — retrieval arrives in the next milestone.";

    result.appendChild(card);
    result.appendChild(note);
  }

  searchBtn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });
  input.addEventListener('input', () => { hint.style.display = 'none'; });
}
