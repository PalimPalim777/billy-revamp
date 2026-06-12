# Billy dogfood log

Running log of bugs, papercuts, and ideas found through real daily use.
Rules: log as you use, never fix as you use. Fixes happen in deliberate
batches — one grievance, one atomic revamp/<short-spec> branch, diff review
before merge. Newest entries first within each section.

Severity tiers:
- **blocker** — cannot capture or retrieve; fix immediately
- **bug** — wrong behavior, workaround exists; batch
- **papercut** — friction or ugliness; batch
- **idea** — improvement, not a defect; defer until dogfood exit review

Entry format:
`YYYY-MM-DD · tier · surface · one-line description` — detail lines below if
needed. When fixed: append `→ fixed in revamp/<branch> (merged YYYY-MM-DD)`.

## Open

- 2026-06-12 · idea · capture · Live amber hashtag tinting while typing
  (needs input-overlay technique on the conversational textarea; weigh value
  at exit review since tags are LLM-extracted from the transcript).
- 2026-06-12 · idea · capture · Single-shot quick-capture mode (type one
  memo, skip the conversation) — product flow change, not restyling.

## Fixed

- 2026-06-12 · papercut · auth · Auth surfaces dark via foundation overrides
  but phrase grid was 4-col (unreadable at iPhone width), confirm grid 3-col,
  plus two stray light-theme color values in setup.html.
  → fixed in revamp/ui-auth (merged 2026-06-12)
- 2026-06-12 · papercut · capture · Capture surface legacy: monospace 15px
  input (also triggered iOS focus-zoom on sub-16px inputs app-wide),
  two-pill mode toggle, light-theme status colors, save/discard buttons
  visually identical.
  → fixed in revamp/ui-capture (merged 2026-06-12)
- 2026-06-12 · bug · retrieve/graph · Double-tap to open memo overlay dead on
  iOS (Safari does not synthesize dblclick on SVG in standalone PWAs); two
  fast taps on different neighbors silently killed both actions.
  → fixed in revamp/graph-tap-ios (merged 2026-06-12)
- 2026-06-12 · papercut · retrieve/graph · Breadcrumb trail convoluted:
  mixed chip/bold/text-button row, Return to origin crammed inline.
  → fixed in revamp/ui-breadcrumb-row (merged 2026-06-12)
- 2026-06-12 · papercut · retrieve/graph · Graph painted light-theme
  (white nodes, invisible labels) on the dark app.
  → fixed in revamp/ui-retrieve-graph (merged 2026-06-12)
- 2026-06-12 · bug · auth/landing · Auth links unreadable (#111 on dark);
  landing CTA buttons wrapped labels and oversized; pure-black background
  too harsh.
  → fixed in revamp/ui-polish-1 (merged 2026-06-12)

## Dogfood exit criteria (review at phase end)

- Daily capture + retrieve feel solid on iPhone PWA and desktop
- No open blockers or bugs; papercuts triaged or accepted
- Feeds the written parallel-or-migrate decision
- Manual full-fidelity Supabase restore drill completed BEFORE any second
  human user is onboarded
