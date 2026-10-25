-- W3.7: make the free-purchase path DB-idempotent, mirroring the paid path's
-- `payment_nonce` uniqueness. Two concurrent signed free fetches for the same
-- (listing, release, wallet) race a read-then-insert (access.ts grantFree) and could
-- insert two rows; this partial unique index makes the second insert fail with 23505,
-- which W1.7 catches to re-read and return the one existing free purchase.
--
-- Scoped to `kind = 'free'` on purpose: a paid re-purchase of the same
-- (listing, release, wallet) is legitimate and must not collide. Confirm no existing
-- duplicate free rows before applying (V0 has none — the free path is new).
create unique index if not exists purchase_one_free_per_wallet_release
  on purchase (listing_id, release_id, buyer_address)
  where kind = 'free';
