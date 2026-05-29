# Billy LifeOS Prompts

This directory holds the versioned LifeOS system prompts that shape Billy's brain-layer behavior. The LifeOS prompt is the most important artifact in the project (per `billy-revamp-multiuser.md` §1.2) — it is the interpretive lens Claude operates from on every capture and every retrieval.

These files live under `public/prompts/` so Vercel serves them statically; the client fetches them at `/prompts/<file>` (e.g. `/prompts/lifeos-capture-v1.md`). The prompt is non-sensitive per the open-architecture philosophy.

## Versioning convention

- Each prompt file is named `<role>-v<n>.md` (e.g. `lifeos-capture-v1.md`).
- A new revision is a new file, not an edit to the existing one. Old versions are retained in the repo.
- The version is part of the artifact's identity. Code that consumes a prompt references it by exact filename, not by "current version."
- Schema changes (the JSON output shape for synthesis-style prompts) are breaking changes and require a version bump.

## Related artifacts (move together)

Per `billy-revamp-retrieve-graph.md` §7.3, three artifacts must be versioned in lockstep because a change to any of them can invalidate the cached graph:

1. **The LifeOS capture/synthesis prompt** (this directory).
2. **The embedding model** — `bge-small-en-v1.5`, 384-dim, wired in at milestone 2.5.
3. **The connection-scoring function** — introduced in milestone 2.6.

When any of these three changes, audit the other two.

## Files

- `lifeos-capture-v1.md` — capture-mode system prompt. Two sections (conversation companion + synthesis). Consumed by `callLLM` from milestone 2.3 onward.

Future:

- `lifeos-retrieve-v1.md` — retrieve-mode system prompt for the streaming summary call. Drafted alongside Phase 3 implementation.
