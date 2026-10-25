-- Session keys (2026-08-31). Implements §7 of "PRD Session Keys.md" — D14, FR-54..FR-61.
--
-- Keys move off `creator` and into their own table, because a creator now has two kinds
-- of credential: one long-lived `agent` key (`x4c_live_…`, unchanged for agents) and
-- short-lived `session` keys (`x4s_live_…`) minted silently on sign-in, one per browser
-- session. A session key row *is* the server-side session record, which is why
-- `creator.session_epoch` goes away in the same breath (FR-56): revocation is per-row,
-- so the guards ask one question instead of two, and rotating the agent key stops
-- signing the creator out of the web (FR-58).

create type api_key_kind as enum ('agent', 'session');

create table api_key (
  id             uuid primary key default gen_random_uuid(),
  creator_id     uuid not null references creator(id) on delete cascade,
  kind           api_key_kind not null,
  hash           text not null unique,
  scopes         text[] not null default '{listings:write,earnings:read}',
  created_at     timestamptz not null default now(),
  expires_at     timestamptz,                    -- null for agent keys
  revoked_at     timestamptz,
  revoked_reason text,                           -- e.g. 'found_in_repository', 'rotated', 'signed_out'
  last_used_at   timestamptz,
  check (kind = 'agent' or expires_at is not null)
);

-- one live agent key per creator
create unique index api_key_one_live_agent
  on api_key (creator_id) where kind = 'agent' and revoked_at is null;

create index api_key_creator_live on api_key (creator_id) where revoked_at is null;

-- Rows are never deleted in V0: FR-61's attribution ("did a human or an agent retire
-- this listing?") reads `kind` and `last_used_at` off revoked and expired rows too.

-- RLS, matching what 20260830001100_security_hardening.sql did for `creator`. Every read
-- and write goes through the service role, which bypasses RLS; a leaked publishable key
-- must not be able to enumerate key hashes.
alter table api_key enable row level security;

-- Backfill. `creator.api_key_hash` holds either a bare sha256 hex hash or, for keys the
-- scanner already revoked, `revoked:<reason>:<epoch-ms>:<hash>` (lib/auth/api-key.ts's
-- revokeApiKeyByHash trick, which existed because the hash column was NOT NULL UNIQUE
-- and is retired by this table — revocation becomes a plain `revoked_at` write).
-- Revoked keys must land with `revoked_at` set or the partial unique index counts them
-- as live and the backfill can violate it.
insert into api_key (creator_id, kind, hash, scopes, revoked_at, revoked_reason)
  select id, 'agent',
         case when api_key_hash like 'revoked:%' then api_key_hash  -- stays unique as-is; unmatchable by any bearer
              else api_key_hash end,
         api_key_scopes,
         case when api_key_hash like 'revoked:%'
              then to_timestamp(nullif(split_part(api_key_hash, ':', 3), '')::bigint / 1000.0)
              else null end,
         case when api_key_hash like 'revoked:%' then split_part(api_key_hash, ':', 2)
              else null end
  from creator;

alter table creator
  drop column api_key_hash,
  drop column api_key_scopes,
  drop column session_epoch;    -- FR-56: the session key row replaces the epoch
