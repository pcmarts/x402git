-- Open releases (2026-10-25, HackMeridian; docs/HACKMERIDIAN-BUILD.md §3.1 and W3,
-- docs/HACKMERIDIAN-STRATEGY.md). A maintainer sells the next release of an open-source
-- project early, from a private mirror, and commits to a date on which the same commit
-- goes public in the project's own repo under its licence. The platform records the
-- promise here and, after the date, checks that it was kept.
--
-- Two rules are enforced in the database rather than in code, because they are promises
-- to buyers and a bug in a handler must not be able to break them:
--   1. an opening date is at most 90 days after the release was cut;
--   2. once set, an opening date can only move *earlier*. A later date, or removing it,
--      is refused by a trigger.
--
-- The fee refund that the strategy first described (a `fee_refund` payout kind) is
-- roadmap (BUILD §0a F1): nothing about it is here. The eligibility and promise-kept
-- checks stay.

-- --- listing: the standing offer -----------------------------------------------------

-- `open_release` is the listing-level switch. `public_repo_url` is where the code opens
-- (a different repo from the private one being sold, BUILD H6). `next_opens_at` is the
-- date the maintainer commits to for the *next* cut; each release copies it at cut time.
-- `open_eligibility` is the last listing-time check result, kept so the page can show
-- *why* a listing is or is not eligible without recomputing.
alter table listing add column if not exists open_release boolean not null default false;
alter table listing add column if not exists public_repo_url text
  check (public_repo_url is null or public_repo_url ~ '^https://github\.com/[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$');
alter table listing add column if not exists next_opens_at timestamptz;
alter table listing add column if not exists open_eligibility jsonb;

-- --- release: the promise, stamped at cut -------------------------------------------

alter table release add column if not exists opens_at timestamptz;
alter table release add column if not exists open_licence_spdx text;
alter table release add column if not exists promise_status text
  check (promise_status is null or promise_status in ('pending', 'opened_on_time', 'overdue', 'not_open', 'ineligible'));
alter table release add column if not exists promise_checked_at timestamptz;
alter table release add column if not exists opened_at timestamptz;
-- `{ ref, html_url, licence, checked_url }`: what the check saw, so "Opened on time" is a
-- claim with evidence a buyer can follow.
alter table release add column if not exists promise_evidence jsonb;
alter table release add column if not exists open_eligibility jsonb;

-- Rule 1. A release is cut once, so `created_at` is a fixed point to measure from.
alter table release drop constraint if exists release_opens_at_within_90_days;
alter table release add constraint release_opens_at_within_90_days
  check (opens_at is null or opens_at <= created_at + interval '90 days');

-- Rule 2. "Only earlier" is a promise to the people who already paid; the trigger makes
-- it hold whatever a handler does. Setting a date on a release that had none is allowed
-- (that is how a date is first stamped); clearing one or pushing it back is not.
create or replace function opens_at_only_earlier() returns trigger language plpgsql as $$
begin
  if old.opens_at is not null and (new.opens_at is null or new.opens_at > old.opens_at) then
    raise exception 'opens_at can only move earlier (was %, got %)', old.opens_at, new.opens_at
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

drop trigger if exists release_opens_at_only_earlier on release;
create trigger release_opens_at_only_earlier before update of opens_at on release
  for each row execute function opens_at_only_earlier();

-- The promise cron reads "every release whose date has passed and whose status is still
-- pending", in that order.
create index if not exists release_promise_due
  on release (opens_at)
  where promise_status = 'pending';
