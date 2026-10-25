-- Open releases, second cut (2026-10-25, HackMeridian; founder's direction on the listing
-- form that evening): the standing offer is a number of days, not a calendar date.
--
-- "Opens on <date>" asked a maintainer to promise one day for whatever the next release
-- turned out to be, and to come back and re-promise after every cut. The rule people
-- actually mean is "buyers get each release N days before everyone else". So the listing
-- now holds `open_after_days` (1..90) and each release's `opens_at` is stamped at cut as
-- `created_at + open_after_days`. The release-level rules are unchanged: at most 90 days
-- after the cut (`release_opens_at_within_90_days`) and a stamped date only ever moves
-- earlier (`release_opens_at_only_earlier`).
--
-- Changing the number applies to releases cut from then on, like a price change (FR-16).
-- Releases already cut keep the date they were sold with.

alter table listing add column if not exists open_after_days integer
  check (open_after_days is null or open_after_days between 1 and 90);

-- Carry an existing offer over as "days from now", clamped into range, so no listing that
-- was an open release silently stops being one.
update listing
   set open_after_days = least(90, greatest(1, ceil(extract(epoch from (next_opens_at - now())) / 86400)::int))
 where next_opens_at is not null and open_after_days is null;

alter table listing drop column if exists next_opens_at;
