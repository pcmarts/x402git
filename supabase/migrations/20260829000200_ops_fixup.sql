-- Idempotent reconcile of the ops tables in 20260829000100_ops.sql.
--
-- Why this exists: 20260829000100 was recorded as applied on the remote before its
-- file landed in the repo, so `supabase db push` will never re-run it. Everything
-- below is `if not exists` / `create or replace`, so this file is the one that makes
-- "what the code assumes" and "what the database has" provably the same. Safe to
-- re-run. No PRD semantic change — see DECISIONS.md (2026-08-29).

create table if not exists challenge (
  nonce       text primary key,
  address     text not null check (address ~ '^0x[0-9a-fA-F]{40}$'),
  message     text not null,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
alter table challenge add column if not exists message    text;
alter table challenge add column if not exists used_at    timestamptz;
alter table challenge add column if not exists created_at timestamptz not null default now();
create index if not exists challenge_address on challenge (address, expires_at desc);
create index if not exists challenge_expiry  on challenge (expires_at);

create table if not exists idempotency (
  key           text primary key,
  route         text not null,
  request_hash  text,
  status        int not null,
  response      jsonb not null,
  creator_id    uuid references creator(id),
  created_at    timestamptz not null default now()
);
alter table idempotency add column if not exists route        text;
alter table idempotency add column if not exists request_hash text;
alter table idempotency add column if not exists creator_id   uuid references creator(id);
alter table idempotency add column if not exists created_at   timestamptz not null default now();
create index if not exists idempotency_created_at on idempotency (created_at);

create table if not exists webhook_delivery (
  delivery_id text primary key,
  received_at timestamptz not null default now()
);
create index if not exists webhook_delivery_received_at on webhook_delivery (received_at);

create table if not exists rate_limit (
  bucket       text primary key,
  count        int not null default 0,
  window_start timestamptz not null default now()
);
create index if not exists rate_limit_window_start on rate_limit (window_start);

-- Atomic fixed-window counter: one statement, so two concurrent requests cannot
-- read the same pre-increment value. Returns the count *after* this hit.
create or replace function rate_limit_hit(p_bucket text, p_window_seconds int)
returns table (count int, window_start timestamptz)
language sql
as $$
  insert into rate_limit as rl (bucket, count, window_start)
  values (p_bucket, 1, now())
  on conflict (bucket) do update
    set count = case
          when rl.window_start < now() - make_interval(secs => p_window_seconds) then 1
          else rl.count + 1
        end,
        window_start = case
          when rl.window_start < now() - make_interval(secs => p_window_seconds) then now()
          else rl.window_start
        end
  returning rl.count, rl.window_start;
$$;

-- Reached only through the service role, which bypasses RLS. Enabling it with no
-- policies means a leaked publishable key reads nothing.
alter table challenge        enable row level security;
alter table idempotency      enable row level security;
alter table webhook_delivery enable row level security;
alter table rate_limit       enable row level security;
