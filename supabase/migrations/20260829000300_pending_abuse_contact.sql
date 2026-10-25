-- FR-5: "Abuse-contact changes take effect after 48h and are announced to the *old*
-- contact." The §12 creator table has the queue columns for the payout-address 48h rule
-- (pending_payout_address, rebind_effective_at) but not for the abuse contact, so the
-- delay could not be represented. These three extend the same pattern to the same rule.
-- Additive; no existing column changes meaning. See DECISIONS.md (2026-08-29).

alter table creator add column if not exists pending_abuse_contact_url   text;
alter table creator add column if not exists pending_abuse_contact_email text;
alter table creator add column if not exists abuse_contact_effective_at  timestamptz;
