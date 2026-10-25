-- Who may read /admin (2026-09-07). See DECISIONS.md.
--
-- `/admin` reads across every creator, so "who is allowed in" is the highest-value
-- answer in this database and it gets written down here rather than only in an
-- environment variable. Two lists, and the split is the whole design:
--
--   ADMIN_GITHUB_LOGINS   the **root** list, in the deployment's environment. Cannot be
--                         granted or revoked from inside the app, so a mistake made in
--                         the UI — including revoking the last admin — is always
--                         recoverable without a database console.
--   this table            everybody else, granted and revoked by an existing admin.
--
-- A GitHub login rather than a `creator.id`: an operator is not necessarily a seller,
-- and requiring a bound payout address before somebody can look at a dashboard is a
-- strange thing to ask of the person looking because something appears wrong. The login
-- is the identity FR-1's OAuth already proves and the session cookie already carries.
--
-- **Rows are never deleted.** Revoking sets `revoked_at`, exactly as `api_key` does, so
-- the table is its own audit record: who was let in, by whom, when, and when they were
-- let go. A deleted row would answer none of those.
--
-- Logins are stored lowercase because GitHub treats them case-insensitively, and a table
-- holding both `PCMarts` and `pcmarts` would be two answers to one question.

create table if not exists admin (
  github_login text primary key check (github_login = lower(github_login) and length(github_login) between 1 and 39),
  note         text,
  granted_by   text,
  granted_at   timestamptz not null default now(),
  revoked_at   timestamptz,
  revoked_by   text
);

-- The live set, which is the only thing the guard reads.
create index if not exists admin_live on admin (github_login) where revoked_at is null;

-- No seed row. The first operator comes from ADMIN_GITHUB_LOGINS, the root list, which is
-- the recoverable path described above and the one docs/SELF-HOST.md documents. A login
-- written into a migration would make the upstream maintainer an administrator of every
-- instance built from this repository. (Until 25 Oct 2026 this migration inserted the
-- founding operator's login here; the production row it created predates the change and
-- stands. Schema migration history is by version, so this edit re-runs nothing.)

-- Same posture as every other ops table: reached only through the service role, which
-- bypasses RLS. Enabling it with no policies means a leaked publishable key cannot
-- enumerate — or worse, insert — an administrator.
alter table admin enable row level security;
