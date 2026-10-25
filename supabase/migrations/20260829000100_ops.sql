-- Ops tables. Additive to the PRD §12 five-table model; no semantic change to it.
-- See DECISIONS.md (2026-08-29). Every table here is short-lived machinery that the
-- PRD's prose requires but its data model does not name:
--   challenge        FR-2 / FR-4 / FR-20 — single-use 5-minute signed challenges
--   idempotency      FR-2               — 24h Idempotency-Key replay
--   webhook_delivery FR-8               — reject a redelivered/replayed delivery id
--   rate_limit       §9                 — fixed-window counters

create table challenge (
  nonce       text primary key,
  address     text not null check (address ~ '^0x[0-9a-fA-F]{40}$'),
  message     text not null,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
-- Lookups are always (nonce, address); expiry sweep is by expires_at.
create index challenge_address on challenge (address, expires_at desc);
create index challenge_expiry on challenge (expires_at);

create table idempotency (
  key           text primary key,
  route         text not null,
  request_hash  text,
  status        int not null,
  response      jsonb not null,
  creator_id    uuid references creator(id),
  created_at    timestamptz not null default now()
);
create index idempotency_created_at on idempotency (created_at);

create table webhook_delivery (
  delivery_id text primary key,
  received_at timestamptz not null default now()
);
create index webhook_delivery_received_at on webhook_delivery (received_at);

create table rate_limit (
  bucket       text primary key,
  count        int not null default 0,
  window_start timestamptz not null default now()
);
create index rate_limit_window_start on rate_limit (window_start);

-- Atomic fixed-window counter. One statement, so concurrent requests cannot both
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

-- These tables are reached only through the service role, which bypasses RLS.
-- Enabling it with no policies means a leaked publishable key reads nothing.
alter table challenge        enable row level security;
alter table idempotency      enable row level security;
alter table webhook_delivery enable row level security;
alter table rate_limit       enable row level security;
