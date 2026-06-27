-- 5.1_chat_schema.sql — Chat Mode foundation (Branch: revamp/chat-schema)
-- Additive only. No RLS: Billy uses the service-role client behind HMAC-cookie
-- /api handlers; no anon/auth Supabase key ever reaches the browser, so RLS is
-- intentionally unused (parallels memos). TRIPWIRE: if a direct browser->Supabase
-- path is ever added, RLS becomes mandatory on BOTH chats and memos.
-- Plaintext metadata columns parallel the existing prompt_version convention.
-- Content stays in ciphertext; due_date stays inside encrypted time_reference.

-- 1. Transcript-node discriminator on memos.
alter table public.memos
  add column if not exists kind text not null default 'memo',
  add column if not exists parent_memo_id uuid null
    references public.memos(id) on delete cascade;

alter table public.memos drop constraint if exists memos_kind_check;
alter table public.memos add constraint memos_kind_check
  check (kind in ('memo','chat-transcript'));

-- decision-9 guardrail, enforced in-DB: transcript MUST be parented; memo MUST NOT be.
alter table public.memos drop constraint if exists memos_parent_rule_check;
alter table public.memos add constraint memos_parent_rule_check check (
  (kind = 'chat-transcript' and parent_memo_id is not null)
  or (kind = 'memo' and parent_memo_id is null)
);

-- 2. Per-memo cooldown marker (novelty). null = off cooldown. Set anchor-only at write-back.
alter table public.memos
  add column if not exists cooldown_until timestamptz null;

-- 3. Chat lifecycle table — live working state, NOT a node until ended.
create table if not exists public.chats (
  id                    uuid primary key,
  user_id               uuid not null references public.users(id) on delete cascade,
  hub_memo_id           uuid not null references public.memos(id) on delete cascade,
  state                 text not null default 'proposed'
                          check (state in ('proposed','responded','ended')),
  transcript_ciphertext text null,
  transcript_iv         text null,
  prompt_version        text null,
  slot                  smallint null,
  created_at            timestamptz not null default now(),
  responded_at          timestamptz null,
  ended_at              timestamptz null
);

create index if not exists chats_user_state_idx on public.chats (user_id, state);
create index if not exists chats_hub_idx        on public.chats (hub_memo_id);
create index if not exists memos_parent_idx
  on public.memos (parent_memo_id) where parent_memo_id is not null;
create index if not exists memos_user_cooldown_idx
  on public.memos (user_id, cooldown_until);
