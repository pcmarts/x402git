-- W3.5 / FR-36: enforce the licence at sale, not only at first publish.
--
-- The listing-level `licence_verdict` is the publish gate. But a live listing can push a
-- new release that *removes* its LICENSE, and the old sellable-release path ignored the
-- licence, so it kept selling an unlicensed artifact. This column records the licence
-- verdict for **this release's own snapshot**, stamped at cut; W1.8 reads it and excludes
-- only the exact value 'block' from the sellable-release selection.
--
-- Nullable, default NULL, and reuses the existing `licence_verdict` enum
-- ('pass' | 'manual' | 'block'). **No backfill** — pre-migration releases stay NULL and
-- keep selling (NULL, 'pass' and 'manual' are all sellable; only 'block' excludes). The
-- read side must treat NULL as sellable (`licence_verdict is distinct from 'block'`),
-- never `!= 'block'`, which is unknown for NULL and would de-list every old release.
--
-- Additive. No entitlement, price or ledger fact lives here; access.ts only reads it.

alter table release add column if not exists licence_verdict licence_verdict;

comment on column release.licence_verdict is
  'W3.5/FR-36: licence verdict for this release''s snapshot, stamped at cut. NULL = pre-migration (sellable). Only ''block'' excludes the release from sale (W1.8).';
