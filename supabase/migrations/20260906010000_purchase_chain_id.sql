-- Which chain a row settled on (2026-09-06). One Supabase project serves both networks
-- — localhost and CI run against Base Sepolia and production is about to run against
-- Base mainnet, and they share this database (docs/archive/E2E-REPORT.md, BLOCKERS B4).
-- Until now nothing on a row said which chain it belonged to. `tx_hash` does not: a hash
-- is opaque, and telling the two apart meant querying both chains. `granted_at` does
-- not either, because dev keeps writing Sepolia rows after the mainnet cutover, so the
-- two interleave rather than splitting at a date.
--
-- That was not merely untidy. `sweepablePurchases` sums every unswept purchase for a
-- creator with no chain filter, so the first mainnet sweep would have paid **real USDC
-- for testnet sales**. The FR-28 reconciliation compares recorded amounts against an
-- on-chain balance, and a mixed ledger reads as permanent variance.
--
-- Backfilled to 84532: every row that exists today is Base Sepolia, and the first
-- mainnet purchase will be the first row stamped 8453.

alter table purchase add column if not exists chain_id bigint;
update purchase set chain_id = 84532 where chain_id is null;
alter table purchase alter column chain_id set not null;

alter table payout add column if not exists chain_id bigint;
update payout set chain_id = 84532 where chain_id is null;
alter table payout alter column chain_id set not null;

-- The sweep's hot query: unswept, unrevoked purchases on one chain.
create index if not exists purchase_sweepable_by_chain
  on purchase (chain_id, listing_id)
  where payout_id is null and revoked_at is null;

-- The in-flight guard is per creator per chain: a Sepolia payout stuck at `pending`
-- must not block a mainnet sweep, and vice versa.
create index if not exists payout_in_flight_by_chain on payout (creator_id, chain_id, status);
