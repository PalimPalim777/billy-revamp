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

- 2026-06-12 · papercut · capture · Capture surface still legacy: monospace
  15px input, two-pill mode toggle instead of segmented control, no save
  feedback moment. Redesign branch ui-capture pending.
- 2026-06-12 · papercut · auth · Auth surfaces (login, signup, setup,
  recovery, unlock) functionally dark-themed but not yet restyled to spec
  (recovery phrase grid, confirm step, key step). Redesign branch ui-auth
  pending.

## Fixed

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
