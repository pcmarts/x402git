-- The replay ledger is per chain (2026-10-25, CORE-1 in docs/RED-TEAM-2026-09-21.md).
--
-- An EIP-3009 nonce is unique per token contract per chain, so the same 32 bytes can be
-- signed legally on Base Sepolia and on Base mainnet, and this one database holds rows
-- for both (20260906010000). `purchaseByNonce` in lib/core/access.ts now filters on
-- `chain_id` as well as `payment_nonce`; this index is the key that lookup reads by, and
-- states in the schema that a nonce identifies a payment only together with its chain.
--
-- Additive on purpose. The global `payment_nonce text unique` from 20260829000000_init
-- stays: "Nonce is UNIQUE" is a PRD rule and this does not weaken it. Because that
-- constraint already holds, no two rows can share `(chain_id, payment_nonce)`, so the
-- build below cannot fail on live data and rewrites nothing. Not `concurrently`: the
-- migration runs in a transaction, and `purchase` is small enough that the brief write
-- lock is a non-event. Nulls (free purchases carry no nonce) never collide.

create unique index if not exists purchase_chain_payment_nonce
  on purchase (chain_id, payment_nonce);
