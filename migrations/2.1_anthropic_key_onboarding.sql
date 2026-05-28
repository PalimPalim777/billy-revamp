-- Milestone 2.1 — Anthropic API key onboarding (BYO key).
-- Run in the Supabase SQL editor (project fzjgdgwadjdkeksraqaz, eu-west-3).
-- Idempotent: safe to run whether or not the columns already exist.
--
-- Columns mirror the existing DEK-wrapping convention (2-column *_wrapped + *_iv),
-- prefixed anthropic_key_. They store ONLY AES-256-GCM ciphertext of the user's
-- Anthropic API key (wrapped with the DEK) — never plaintext. All nullable.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS anthropic_key_wrapped text,
  ADD COLUMN IF NOT EXISTS anthropic_key_iv text,
  ADD COLUMN IF NOT EXISTS onboarding_complete boolean NOT NULL DEFAULT false;
