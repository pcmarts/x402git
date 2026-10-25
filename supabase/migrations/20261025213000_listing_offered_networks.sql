-- Offered rails per listing (2026-10-25, HackMeridian; founder that evening: "The listing,
-- we should give the user the option to switch their payment address easily, right now,
-- it just takes them to the wallet page, but we should have the option to switch between").
--
-- A creator can now hold two payout addresses, an EVM `0x…` and a Stellar `G…`, and a
-- listing is offered on every rail the deployment runs that reaches one of them: USDC on
-- Base and USDT0 on Arbitrum land at the EVM address, USDT0 on Stellar at the `G…`. This
-- column is the listing's own choice among those rails, ticked on its dashboard.
--
-- Null is every rail the creator can be paid on, which is what every listing did before
-- today, so nothing changes for a listing nobody edits, and a listing left at null picks
-- up a newly bound wallet or a newly enabled rail by itself. An array is only those CAIP-2
-- networks. It only ever narrows: a network named here that the creator cannot be paid on,
-- or that the deployment no longer runs, is not offered (lib/core/access.ts#railsFor).
--
-- The CHECK is about spelling only, because the set of rails is open (X402_EXTRA_EVM_RAILS
-- adds EVM chains without a migration). Whether a network is served, and whether the
-- creator can be paid on it, is checked in lib/listings/service.ts at write time, where the
-- deployment's configuration is known. A CHECK cannot hold a subquery, so the per-element
-- test is a small immutable function.

create or replace function offered_networks_well_formed(networks text[]) returns boolean
  language sql
  immutable
  set search_path = ''
as $$
  select coalesce(bool_and(n is not null and n ~ '^(eip155:[0-9]+|stellar:(pubnet|testnet))$'), true)
    from unnest(networks) as n
$$;

alter table listing add column if not exists offered_networks text[] null;

alter table listing drop constraint if exists listing_offered_networks_well_formed;
alter table listing add constraint listing_offered_networks_well_formed
  check (offered_networks is null or offered_networks_well_formed(offered_networks));
