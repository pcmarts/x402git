-- Git x402 — V0 schema. Mirrors PRD Final.md §12 exactly. Five tables plus event and screening.
-- Prices are integers in micro-USDC (6 decimals). Never floats.

create type wallet_mode as enum ('linked', 'custodial');
create type onboarded_via as enum ('web', 'api');
create type listing_source as enum ('github', 'hosted');
create type licence_verdict as enum ('pass', 'manual', 'block');
create type scan_status as enum ('pending', 'pass', 'fail');
create type purchase_kind as enum ('new', 'update', 'free');
create type purchase_source as enum ('web', 'api', 'mcp');
create type payout_status as enum ('pending', 'broadcast', 'confirmed', 'failed');

create table creator (
  id uuid primary key default gen_random_uuid(),
  handle text not null unique check (handle ~ '^[a-z0-9-]{2,40}$'),
  github_user_id bigint unique,                       -- null on Rail B
  api_key_hash text not null unique,
  api_key_scopes text[] not null default '{listings:write,earnings:read}',
  onboarded_via onboarded_via not null,
  wallet_mode wallet_mode not null default 'linked',
  payout_address text not null check (payout_address ~ '^0x[0-9a-fA-F]{40}$'),
  cdp_wallet_id text,
  pending_payout_address text,
  rebind_effective_at timestamptz,                    -- 48h rule
  abuse_contact_url text,
  abuse_contact_email text,
  terms_version text not null,
  terms_accepted_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table listing (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references creator(id),
  slug text not null check (slug ~ '^[a-z0-9-]{2,40}$' and slug not in ('api','v','r','label')),
  source listing_source not null,
  installation_id bigint,
  github_repo_id bigint,
  deploy_key_id bigint,
  price_micro bigint not null default 9000000 check (price_micro = 0 or price_micro >= 10000),
  update_price_micro bigint not null default 5000000 check (update_price_micro >= 0), -- 0 = lifetime
  description text,
  trigger_hint text,
  licence_spdx text,
  licence_verdict licence_verdict,
  published_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  unique (creator_id, slug)
);

create table release (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references listing(id),
  version text not null check (version ~ '^\d+\.\d+\.\d+$'),
  git_ref text not null,
  commit_sha text not null,
  artifact_sha256 text,
  storage_path text,
  size_bytes bigint,
  scan scan_status not null default 'pending',
  scan_report jsonb,
  scanner_version text,
  manifest jsonb,
  changelog text,
  diff_summary jsonb,
  price_micro_at_publish bigint not null,
  update_price_micro_at_publish bigint not null,
  analyzer_version text,
  created_at timestamptz not null default now(),
  unique (listing_id, version)
);

create table purchase (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references listing(id),
  release_id uuid not null references release(id),
  buyer_address text not null check (buyer_address ~ '^0x[0-9a-fA-F]{40}$'),
  all_versions boolean not null default false,        -- FR-16: stamped lifetime
  update_price_at_purchase bigint not null,
  kind purchase_kind not null,
  source purchase_source not null,
  gross_micro bigint not null check (gross_micro >= 0),
  fee_micro bigint not null check (fee_micro >= 0),
  net_micro bigint not null check (net_micro >= 0),
  tx_hash text,
  payment_nonce text unique,                          -- FR-22 idempotency
  granted_at timestamptz not null default now(),
  holdback_until timestamptz not null,
  payout_id uuid,
  revoked_at timestamptz
);
create index purchase_buyer_listing on purchase (buyer_address, listing_id);
create index purchase_sweep on purchase (holdback_until) where payout_id is null and revoked_at is null;

create table payout (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references creator(id),
  amount_micro bigint not null check (amount_micro > 0),
  gas_micro bigint not null default 0,
  to_address text not null,
  idempotency_key text not null unique,
  tx_hash text,
  status payout_status not null default 'pending',
  created_at timestamptz not null default now()
);
alter table purchase add constraint purchase_payout_fk foreign key (payout_id) references payout(id);

-- Analytics (§10) and sanctions screening results (FR-38, 5-year retention).
create table event (
  id bigserial primary key,
  name text not null,
  listing_id uuid,
  buyer_address text,
  source purchase_source,
  props jsonb,
  at timestamptz not null default now()
);
create index event_name_at on event (name, at);

create table screening (
  id bigserial primary key,
  address text not null,
  context text not null,                              -- bind | sweep | settle
  hit boolean not null,
  provider text not null,
  raw jsonb,
  at timestamptz not null default now()
);
create index screening_address on screening (address);
