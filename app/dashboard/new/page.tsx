/**
 * GET /dashboard/new — pick the repository to sell (Rail A, §7.1 step 1).
 *
 * The list comes from GitHub, through the *user's* OAuth token, so it contains exactly
 * the repositories this person has already granted the app access to and nothing else.
 * There is no "connect all my repos" path: FR-1 says per-repo scope and never org-wide
 * write, and the shape of this page is that requirement made visible — if a repo is not
 * here, the answer is to install the app on it, not to widen a permission.
 *
 * Repos are resolved by id, never by name (FR-8), so a rename does not detach a listing.
 *
 * Every granted repository is listed, public ones included — but only a private one gets
 * a button. FR-10, amended 2026-08-30 and again 2026-09-01: a public repo can be cloned
 * for nothing, so selling access to one is not a thing this sells, and `POST /api/listings`
 * answers `422 public_repo` whatever this page renders. What changed on 2026-09-01 is
 * only where that fact is said: hiding the public rows left a creator unable to tell a
 * repo they had forgotten to grant from one that was simply public. The row is now
 * there, marked, and inert.
 *
 * The install link is on the page in every state, not only the empty ones: a creator
 * who has granted one repository has a table here and still needs a way to grant the
 * next. The App's Setup URL is this page, with "Redirect on update" on, so saving the
 * repository selection on GitHub lands back here (RED-TEAM-2026-09-21 UXC-5).
 *
 * Order is a query parameter, not a script: `?sort=updated` (default) and `?sort=name`
 * are links on the column headers, so the sorted page is a real URL that server-renders
 * (§14.1) and survives a reload.
 */

import type { Metadata } from "next";
import { Notice } from "@/app/_components/notice";
import { githubAppSlug } from "@/lib/env";
import { isSellableRepo, repoSort, repoUpdatedAt, requireDashboard, sortRepoRows } from "@/lib/web/dashboard";
import { installAppUrl, listInstallationRepos, listInstallations, slugFromRepoName, type GithubRepo } from "@/lib/web/github-oauth";
import { listingsForCreator } from "@/lib/web/loaders";
import { formatDateTime, relativeDate } from "@/lib/web/manifest-view";

export const metadata: Metadata = { title: "Sell a repository" };
export const dynamic = "force-dynamic";

type Row = { installationId: number; repo: GithubRepo };

export default async function NewListingPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string; sort?: string }>;
}) {
  const { ok, error, sort: sortParam } = await searchParams;
  const sort = repoSort(sortParam);
  const { session, creator } = await requireDashboard("/dashboard/new");
  const installUrl = installAppUrl(githubAppSlug());

  const existing = await listingsForCreator(creator.id);
  const taken = new Set(existing.map((l) => String(l.listing.github_repo_id ?? "")));

  let rows: Row[] = [];
  let reachError: string | null = null;
  if (session.github.token) {
    try {
      const installations = await listInstallations(session.github.token);
      const collected = await Promise.all(
        installations.map(async (installation) => {
          const repos = await listInstallationRepos(session.github.token as string, installation.id);
          return repos.map((repo) => ({ installationId: installation.id, repo }));
        }),
      );
      rows = sortRepoRows(collected.flat(), sort);
    } catch (e) {
      reachError = e instanceof Error ? e.message : "GitHub did not answer.";
    }
  } else {
    reachError = "This session has no GitHub token. Sign out and back in.";
  }

  const sellable = rows.filter((row) => isSellableRepo(row.repo)).length;

  return (
    <main>
      <h1>Your repositories</h1>
      <Notice ok={ok} error={error} />
      {reachError ? (
        <p role="alert" data-status="fail">
          {reachError}
        </p>
      ) : null}

      {rows.length > 0 && sellable === 0 ? (
        <section>
          <h2>No private repositories here</h2>
          <p className="written measure">
            Every repository you have granted is public, and anyone can clone a public repository for nothing, so there is nothing to
            sell access to. <a href={installUrl}>Install the app on a private repository</a>, or make one of these private on GitHub,
            then come back.
          </p>
        </section>
      ) : null}

      {rows.length === 0 && !reachError ? (
        <section>
          <h2>Nothing granted yet</h2>
          <p className="written measure">
            <a href={installUrl}>Install the app on one private repository</a>, then come back. Pick the repository you want to sell — one
            listing is one repository.
          </p>
        </section>
      ) : null}

      {rows.length > 0 ? (
        <table>
          <caption className="sr-only">Repositories you have granted, {sort === "name" ? "by name" : "most recently updated first"}</caption>
          <thead>
            <tr>
              <th scope="col" aria-sort={sort === "name" ? "ascending" : "none"}>
                <a href="/dashboard/new?sort=name" data-sort={sort === "name" ? "asc" : "off"}>
                  Repository
                </a>
              </th>
              <th scope="col" aria-sort={sort === "updated" ? "descending" : "none"}>
                <a href="/dashboard/new?sort=updated" data-sort={sort === "updated" ? "desc" : "off"}>
                  Last updated
                </a>
              </th>
              <th scope="col">&nbsp;</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ installationId, repo }) => {
              const already = taken.has(String(repo.id));
              const canSell = isSellableRepo(repo);
              const updated = repoUpdatedAt(repo);
              return (
                <tr key={`${installationId}:${repo.id}`} data-inert={!canSell || already ? "" : undefined}>
                  <td className="wrap" title={repo.full_name}>
                    {slugFromRepoName(repo.name)}
                  </td>
                  <td className="muted" title={updated ? formatDateTime(updated) : undefined}>
                    {(updated && relativeDate(updated)) ?? "—"}
                  </td>
                  <td className="repo-action">
                    {!canSell ? (
                      <span className="muted">public</span>
                    ) : already ? (
                      <span className="muted">already listed</span>
                    ) : (
                      <form method="post" action="/dashboard/new/create">
                        <input type="hidden" name="installation_id" value={installationId} />
                        <input type="hidden" name="github_repo_id" value={repo.id} />
                        <input type="hidden" name="slug" value={slugFromRepoName(repo.name)} />
                        <button type="submit">Create listing</button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}

      {sellable > 0 ? (
        <p className="written measure">
          Not in the list? <a href={installUrl}>Grant the app another repository</a> on GitHub. Saving there brings you back here.
        </p>
      ) : null}
    </main>
  );
}
