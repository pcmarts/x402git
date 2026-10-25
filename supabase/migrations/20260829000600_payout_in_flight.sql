-- FR-28: one serialised signer per creator, expressed as a constraint PostgREST can rely on.
-- supabase-js speaks REST and cannot hold a `SELECT … FOR UPDATE`, so two overlapping sweeps
-- (cron + a manual POST /api/payouts/sweep) whose purchase sets differ would produce two
-- distinct idempotency keys. This partial unique index makes the second insert fail with
-- 23505 while the first payout is pending or broadcast; the loser returns `payout_in_flight`.
create unique index if not exists payout_one_in_flight_per_creator
  on payout (creator_id)
  where status in ('pending', 'broadcast');
