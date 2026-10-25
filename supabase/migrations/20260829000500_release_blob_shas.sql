-- FR-50 (originality, V0 = blob-SHA overlap) and FR-15 (the public release log).
--
-- `release.blob_shas` caches the git blob SHAs of the snapshot so a later release can
-- be intersected against every previously-seen one without re-walking anybody's tree.
-- Quality Signals §5.3: identical files have identical blob SHAs and the recursive
-- tree call already returns them, so verbatim reuse is detectable for free — but only
-- if the corpus is kept. The empty blob and files under 64 bytes are excluded before
-- the array is written (see lib/analysis/originality.ts); leaving them in fires copy
-- detection on every `__init__.py` and `.gitkeep` in existence.
--
-- Additive. Nothing in PRD §12 changes meaning: no entitlement, price or ledger fact
-- lives here, and `lib/core/access.ts` never reads it.

alter table release add column if not exists blob_shas text[];

comment on column release.blob_shas is
  'FR-50: significant git blob SHAs of this snapshot (empty blob and <64 byte files excluded), for blob-overlap originality.';

-- The originality query is "every blob of mine that appears in someone else's release".
create index if not exists release_blob_shas_gin on release using gin (blob_shas);

-- FR-15 pages the release log newest-first per listing.
create index if not exists release_listing_created on release (listing_id, created_at desc);
