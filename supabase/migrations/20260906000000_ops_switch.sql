-- Kill switches (2026-09-06). PRD §19's launch checklist requires them — "pause
-- registrations, pause publishing, pause payments → 503 not 402, pause sweeps,
-- per-listing takedown" — and none existed. This table is the first four; the fifth is
-- per-listing and is an action, not a switch (scripts/ops-takedown.mjs).
--
-- One row per switch. **A missing row reads as not paused**, so a deployment whose
-- migration has not run behaves exactly as it does today, and this table can never
-- become the reason commerce stopped. `lib/ops/switches.ts` fails open for the same
-- reason: a switch that cannot be read is a switch that is off.
--
-- `reason` is operator prose and is never shown to a caller. A paused endpoint says the
-- same thing to everyone — 503, "temporarily unavailable" — because a pause is usually
-- an incident, and an incident is not something to narrate to strangers mid-flight.

create table if not exists ops_switch (
  name       text primary key,
  paused     boolean not null default false,
  reason     text,
  updated_at timestamptz not null default now(),
  updated_by text
);

-- Seeded so `list` shows the full set rather than only the ones somebody has touched.
insert into ops_switch (name) values
  ('registrations'),
  ('publishing'),
  ('payments'),
  ('sweeps')
on conflict (name) do nothing;

-- Same posture as the other ops tables: no anon/authenticated path reaches this, and
-- the app holds the secret key. Nothing here is creator- or buyer-scoped.
alter table ops_switch enable row level security;
