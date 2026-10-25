-- Security-audit hardening (2026-08-30). Three additive changes, no data rewritten.

-- 1. RLS on the §12 core tables, matching what 0100 already did for the ops tables.
--    Every read and write goes through the service role, which bypasses RLS, so
--    enabling it with no policies changes nothing for the server — and means a leaked
--    publishable/anon key reads nothing: no api_key_hash, no payout addresses, no
--    buyer↔sale linkage (FR-40).
alter table creator   enable row level security;
alter table listing   enable row level security;
alter table release   enable row level security;
alter table purchase  enable row level security;
alter table payout    enable row level security;
alter table event     enable row level security;
alter table screening enable row level security;

-- 2. FR-5: a step-up challenge can be bound to its operand. A payout rebind stores
--    `rebind:<new address>` here and in the signed message, so the signature authorises
--    that one change — a phished generic step-up cannot redirect earnings. Null for
--    every purpose/action that has no operand. See lib/auth/challenge.ts.
alter table challenge add column context text;

-- 3. Session revocation. The web session cookie is stateless and embeds the plaintext
--    API key; clearing it on logout never invalidated captured copies. Each cookie now
--    carries the epoch it was minted under, and logout / key rotation bumps this —
--    every outstanding cookie for the creator dies at once. See lib/web/session.ts.
alter table creator add column session_epoch int not null default 0;
