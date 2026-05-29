-- Milestone 2.4 — Encrypted Memo write. First persistence milestone.
-- Run in the Supabase SQL editor (project fzjgdgwadjdkeksraqaz, eu-west-3).
-- Idempotent: CREATE TABLE / INDEX IF NOT EXISTS — safe to re-run.
--
-- Schema notes:
-- - id is a uuid generated client-side (crypto.randomUUID), not a server default.
--   The PRIMARY KEY constraint catches the negligible collision case.
-- - memo_ciphertext holds the encrypted JSON of the full Memo object
--   {title, body, para_bucket, tags, summary, time_reference}. The whole Memo is
--   one ciphertext, one IV. Field-level encryption would balloon write count for no
--   privacy gain (the user owns the DEK; partial knowledge is no better than full
--   ciphertext to the server).
-- - embedding_* and connection_blob_* are nullable because 2.5 (embedding generation)
--   and 2.6 (blob computation) run AFTER the memo is written, each via a later UPDATE.
--   This keeps the synthesis hot path fast (one ciphertext write); embedding/blob
--   computation happens client-side in the background after the user sees "Saved ✓".
-- - prompt_version is plaintext metadata ("lifeos-capture-v1") — not user content, no
--   privacy stake. Required so retrieval-time logic knows which prompt produced a memo.
--   embedding_model_version and scoring_fn_version are nullable now (filled by 2.5/2.6).
-- - The (user_id, created_at DESC) index serves chronological list queries the
--   retrieve milestones will need.

CREATE TABLE IF NOT EXISTS memos (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),

  memo_ciphertext text NOT NULL,
  memo_iv text NOT NULL,

  embedding_ciphertext text,
  embedding_iv text,

  connection_blob_ciphertext text,
  connection_blob_iv text,

  prompt_version text NOT NULL,
  embedding_model_version text,
  scoring_fn_version text
);

CREATE INDEX IF NOT EXISTS memos_user_id_created_at_idx
  ON memos (user_id, created_at DESC);
