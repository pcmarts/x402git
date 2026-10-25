-- Which chain an event happened on (2026-09-14). See DECISIONS.md.
--
-- Same reason as 20260906010000 for `purchase` and `payout`: one Supabase project serves
-- Base and Base Sepolia, and `/admin` now switches between them. From here on `record()`
-- stamps the writing deployment's payment chain, which is the chain every 402, settlement
-- and sweep that deployment writes belongs to.
--
-- Nullable, unlike `purchase.chain_id`: `scripts/ops-takedown.mjs` writes operator events
-- without one, and an operator action is not a chain's event. Those rows stay on
-- `/admin/audit`, which does not filter by chain.

alter table event add column if not exists chain_id bigint;

-- The backfill is an attribution, not a record, and it is best-effort after the cutover.
-- Production moved to Base mainnet on 2026-09-07 (DECISIONS.md); local and preview runs
-- kept writing Base Sepolia rows into the same table after that. In order:
--
-- 1. Before the cutover every deployment was on Sepolia.
-- 2. A sweep event names its payout, and the payout row knows its chain.
-- 3. A purchase event is Sepolia while no mainnet purchase exists — true when this ran.
-- 4. Anything on a listing owned by an e2e harness account (`e2ea…`/`e2eb…`) is Sepolia.
-- 5. Everything else since the cutover is production, so mainnet: its crons, reconciles,
--    rescans, and nearly all manifest views.
update event e
set chain_id = case
  when e.at < '2026-09-07' then 84532
  when p.chain_id is not null then p.chain_id
  when e.name in ('settled', 'update_purchase', 'settle_failed')
       and not exists (select 1 from purchase where chain_id = 8453) then 84532
  when c.handle ~ '^e2e[ab][0-9a-f]{6}$' then 84532
  else 8453
end
from event src
left join payout p on p.id::text = src.props->>'payout_id'
left join listing l on l.id = src.listing_id
left join creator c on c.id = l.creator_id
where e.id = src.id and e.chain_id is null;

create index if not exists event_chain_at on event (chain_id, at desc);
