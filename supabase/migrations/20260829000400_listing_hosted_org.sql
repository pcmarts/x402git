-- 20260829000400_listing_hosted_org.sql
--
-- D10 shards Rail B repos across platform-owned orgs "by cohort", so the org a listing
-- was provisioned into is not the org a listing created tomorrow goes into. §12's
-- `listing` table records `github_repo_id` but not where that repo lives, which means
-- the moment a second cohort org opens, every remote we hand back for an older listing
-- points at the wrong org — and `archiveHostedRepo` / `deleteHostedRepo` (FR-43, FR-44)
-- address the wrong repository.
--
-- Resolving it from the id (`GET /repositories/{id}`) is a network call on a read path
-- that has no other network call. One nullable text column is cheaper and correct.
-- Null on Rail A, where GitHub owns the namespace and we do not.

alter table listing add column if not exists hosted_org text;

comment on column listing.hosted_org is
  'D10: the platform-owned GitHub org a Rail B repo was provisioned into. Null on Rail A.';
