-- A second payment rail (2026-10-25, HackMeridian; docs/HACKMERIDIAN-BUILD.md §3.1 and
-- §0b, docs/HACKMERIDIAN-USDT0.md §2). Until now every row in this ledger settled on an
-- EVM chain and said so with `chain_id`. Stellar has no chain id. The partition key
-- becomes `network`, the CAIP-2 string x402 v2 already puts on the wire (`eip155:8453`,
-- `stellar:pubnet`), and `chain_id` becomes what it always was underneath: the EVM
-- spelling of the same fact, null where there is none.
--
-- Purely additive, so `main` keeps inserting: a BEFORE INSERT trigger fills `network`
-- (and the EVM asset) from `chain_id` for code that does not know the new columns yet.
-- Every existing `.eq("chain_id", …)` read keeps working and, by construction, never sees
-- a Stellar row. The reads that must see both rails — the nonce replay lookup and the
-- entitlement reads in lib/core/access.ts — switch to `network` in the same change
-- (BATTLE-TEST finding 1: a Stellar row has `chain_id = null`, so the chain-scoped
-- lookup from 20261025085950 would miss it, the insert would hit the global nonce key,
-- and an idempotent retry would 500).
--
-- `asset` records which token was paid (USDT0 T5). The two stablecoins are both $1 in
-- this ledger and are never converted, so a payout is always in the asset received, and
-- the sweep partitions on `(network, asset)`.
--
-- Address shape is enforced here, not only in code. EVM addresses are stored lower-case;
-- Stellar strkeys are case-sensitive base32 and must stay upper-case (BUILD H11). The two
-- CHECKs below are the reason a payer or payee that would not fit is refused *before*
-- the facilitator is called (BATTLE-TEST finding 11): a settle followed by a 23514 on
-- insert would charge a buyer and write nothing.

-- --- purchase -----------------------------------------------------------------------

alter table purchase add column if not exists network text;
update purchase set network = 'eip155:' || chain_id where network is null and chain_id is not null;
alter table purchase alter column network set not null;
alter table purchase alter column chain_id drop not null;

-- Which token. The backfill is an attribution from the chain: every EVM row to date paid
-- Circle's USDC on its chain (lib/env.ts `usdcAddress`). New code writes it explicitly.
alter table purchase add column if not exists asset text;
update purchase set asset = case chain_id
    when 8453 then '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
    when 84532 then '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
  end
  where asset is null and chain_id in (8453, 84532);

-- The inline check from 20260829000000 is named by Postgres convention; the new one
-- carries the same EVM rule and adds the Stellar shape. A `G…` account or `C…` contract
-- buyer is 56 upper-case base32 characters, and on Stellar the asset is always a SAC.
alter table purchase drop constraint if exists purchase_buyer_address_check;
alter table purchase drop constraint if exists purchase_network_shape;
alter table purchase add constraint purchase_network_shape check (
  (network like 'eip155:%' and chain_id is not null and buyer_address ~ '^0x[0-9a-fA-F]{40}$')
  or
  (network in ('stellar:testnet', 'stellar:pubnet') and chain_id is null
    and buyer_address ~ '^[GC][A-Z2-7]{55}$' and asset ~ '^C[A-Z2-7]{55}$')
);

-- The replay ledger is per network (the per-chain index from 20261025085950 stays and is
-- simply never populated for Stellar). The global `payment_nonce` unique from init stays
-- too: a Stellar nonce is written as `stellar:<network>:<payer>:<auth nonce>`, so it can
-- never equal an EIP-3009 nonce, and "Nonce is UNIQUE" remains true as the PRD states.
create unique index if not exists purchase_network_payment_nonce
  on purchase (network, payment_nonce);

-- The sweep's hot query, now per rail and per token.
create index if not exists purchase_sweepable_by_network
  on purchase (network, asset, listing_id)
  where payout_id is null and revoked_at is null;

-- --- payout -------------------------------------------------------------------------

alter table payout add column if not exists network text;
update payout set network = 'eip155:' || chain_id where network is null and chain_id is not null;
alter table payout alter column network set not null;
alter table payout alter column chain_id drop not null;

alter table payout add column if not exists asset text;
update payout set asset = case chain_id
    when 8453 then '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
    when 84532 then '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
  end
  where asset is null and chain_id in (8453, 84532);

-- Payouts had no address CHECK at all. A Stellar payout goes to a `G…` account only: a
-- contract cannot be paid a classic payment, and the sweep source never pays itself.
alter table payout drop constraint if exists payout_network_shape;
alter table payout add constraint payout_network_shape check (
  (network like 'eip155:%' and chain_id is not null and to_address ~ '^0x[0-9a-fA-F]{40}$')
  or
  (network in ('stellar:testnet', 'stellar:pubnet') and chain_id is null
    and to_address ~ '^G[A-Z2-7]{55}$' and asset ~ '^C[A-Z2-7]{55}$')
);

-- FR-28's in-flight guard, per creator per rail. Replaces `payout_one_in_flight_per_creator`
-- (20260829000600): a Stellar payout stuck at `pending` must not block a Base sweep for
-- the same creator, and vice versa. `in_transit` is in flight (BATTLE-TEST finding 5): the
-- money has left, the purchases are stamped, and nothing may be sent until it lands.
drop index if exists payout_one_in_flight_per_creator;
create unique index if not exists payout_one_in_flight_per_creator_network
  on payout (creator_id, network)
  where status in ('pending', 'broadcast', 'in_transit');

-- One hot account on Stellar. Two concurrent submits from the same source collide on the
-- sequence number (`tx_bad_seq`), so while the platform pays every Stellar payout from a
-- single account, at most one may be in flight per Stellar network, whoever the creator
-- (BATTLE-TEST finding 9). The loser gets 23505 and returns `payout_in_flight`, exactly as
-- the per-creator index does today. Becomes `(network, source_address)` when there is
-- more than one source.
create unique index if not exists payout_one_in_flight_per_stellar_network
  on payout (network)
  where network like 'stellar:%' and status in ('pending', 'broadcast', 'in_transit');

-- --- compatibility trigger ------------------------------------------------------------

-- Code on `main` inserts `chain_id` and knows nothing of `network` or `asset`. Fill both
-- from the chain so its inserts keep passing the NOT NULL and the CHECK. New code always
-- writes `network` (and `asset`) itself; the trigger is a no-op for it.
create or replace function set_network_from_chain() returns trigger language plpgsql as $$
begin
  if new.network is null and new.chain_id is not null then
    new.network := 'eip155:' || new.chain_id;
  end if;
  if new.asset is null and new.chain_id is not null then
    new.asset := case new.chain_id
      when 8453 then '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
      when 84532 then '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
      else null
    end;
  end if;
  return new;
end
$$;

drop trigger if exists purchase_set_network on purchase;
create trigger purchase_set_network before insert on purchase
  for each row execute function set_network_from_chain();

drop trigger if exists payout_set_network on payout;
create trigger payout_set_network before insert on payout
  for each row execute function set_network_from_chain();

-- --- creator ------------------------------------------------------------------------

-- A creator's identity address may now be a Stellar account (BUILD H5): a Freighter-only
-- maintainer binds a `G…` and never touches an EVM wallet. `payout_address` therefore
-- accepts either shape. Which rails a listing offers follows from which shapes the
-- creator has bound (JOURNEYS rule 4), decided in one place in lib/core/access.ts.
alter table creator drop constraint if exists creator_payout_address_check;
alter table creator add constraint creator_payout_address_check check (
  payout_address ~ '^0x[0-9a-fA-F]{40}$' or payout_address ~ '^G[A-Z2-7]{55}$'
);

-- The Stellar payout address, separate from the EVM one, with the same 48-hour rebind
-- rule (§7.6). `stellar_payout_meta` holds what was checked on-chain at bind time
-- (`{ network, trustline: { code, issuer, authorized }, checked_at }`).
alter table creator add column if not exists stellar_payout_address text
  check (stellar_payout_address ~ '^G[A-Z2-7]{55}$');
alter table creator add column if not exists pending_stellar_payout_address text
  check (pending_stellar_payout_address ~ '^G[A-Z2-7]{55}$');
alter table creator add column if not exists stellar_rebind_effective_at timestamptz;
alter table creator add column if not exists stellar_payout_meta jsonb;
alter table creator add column if not exists stellar_payout_verified_at timestamptz;

-- --- challenge ----------------------------------------------------------------------

-- SEP-53 challenges are signed by a Stellar key (BUILD F3): the challenge address may be
-- a `G…`. `signer` records which key signed, for the audit trail; for an EVM challenge it
-- equals `address`.
alter table challenge drop constraint if exists challenge_address_check;
alter table challenge add constraint challenge_address_check check (
  address ~ '^0x[0-9a-fA-F]{40}$' or address ~ '^G[A-Z2-7]{55}$'
);
alter table challenge add column if not exists signer text;

-- --- event --------------------------------------------------------------------------

-- Same reason as `chain_id` on event (20260914010000): which rail an event belongs to.
-- Nullable like `chain_id`; operator events have neither.
alter table event add column if not exists network text;
