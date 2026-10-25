-- Remediation W2.2 — bind every signed challenge to a purpose.
--
-- One signature must authorise exactly one action, so a benign "prove your wallet"
-- prompt (wallet_ownership) can never be replayed as a payout rebind (step_up) or a
-- key rotation (rotate_key). `issueChallenge` stamps the purpose and writes it into the
-- signed message; `consumeChallenge` refuses a signature whose stored purpose is not the
-- one the calling path expects.
--
-- Nullable: challenges are ephemeral (5-minute TTL), so any row predating this migration
-- ages out within minutes; the application always writes a purpose on new inserts. The
-- CHECK still constrains every non-null value to the known set.

alter table challenge
  add column purpose text
  check (purpose in ('address_proof', 'step_up', 'rotate_key', 'wallet_ownership'));
