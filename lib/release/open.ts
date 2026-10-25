/**
 * lib/release/open.ts — stamping the open-release promise at cut (25 Oct 2026, HackMeridian).
 *
 * An open release is a release sold early, from a private mirror, with a promise that
 * the same commit goes public in the project's own repository by a date, under the
 * licence it was sold under (docs/HACKMERIDIAN-STRATEGY.md §6a). The promise is
 * stamped on the release row at cut, because that is the moment the thing being
 * promised — `commit_sha` — becomes fixed.
 *
 * Eligibility is **computed, never declared**. Four checks, each a sentence the page can
 * print, and each one a fact read from somewhere the creator does not control:
 *
 *   licence         the sold snapshot carries a resale-compatible licence (FR-11 `pass`)
 *   public_repo     `public_repo_url` names a repository that exists and is public
 *   not_yet_public  the release commit is *not* already reachable there (BUILD H6: if it
 *                   is, there is nothing early to sell and nothing to verify)
 *   payout_address  the creator can be paid, on any rail
 *
 * A failed check makes the release `ineligible` and changes nothing else: it still
 * sells as a normal release, the fee is the normal fee, and the page says which check
 * failed and why. This is FR-11's posture — a signal, not a gate — applied to a second
 * signal. Nothing here can refuse a cut.
 *
 * GitHub not answering is a failed check, not a skipped one. "We could not look" is not
 * evidence that the commit is unpublished, and `pending` is a claim the platform then
 * has to stand behind. The detail says so in plain words.
 */

import type { CreatorRow, ListingRow, ReleaseRow } from "@/lib/db/types";
import type { LicenceVerdict } from "@/lib/db/types";
import { GithubUnreachable, parseGithubRepoUrl, publicGithub, type PublicGithub } from "@/lib/github/public";
import { OPEN_RELEASE_MAX_DAYS, type OpenReleaseCheckOutput } from "@/lib/schemas/listings";

export { OPEN_RELEASE_MAX_DAYS };

export type OpenCheck = OpenReleaseCheckOutput;

export type OpenEligibilityInput = {
  listing: Pick<ListingRow, "public_repo_url">;
  creator: Pick<CreatorRow, "payout_address" | "stellar_payout_address"> | null;
  licence: { verdict: LicenceVerdict; spdx: string | null };
  commitSha: string;
  github?: PublicGithub;
};

/** The four checks, in the order a maintainer would fix them. Pure apart from the two GitHub reads. */
export async function openEligibility(input: OpenEligibilityInput): Promise<OpenCheck[]> {
  const github = input.github ?? publicGithub();
  const checks: OpenCheck[] = [];

  checks.push(
    input.licence.verdict === "pass"
      ? { id: "licence", ok: true, detail: `${input.licence.spdx} permits resale, so the same licence can be promised for the public copy.` }
      : {
          id: "licence",
          ok: false,
          detail:
            input.licence.verdict === "block"
              ? "The release has no licence file. An open release has to name the licence it will open under."
              : `The licence${input.licence.spdx ? ` (${input.licence.spdx})` : ""} is not on the resale-compatible list, so it cannot be promised as the open licence.`,
        },
  );

  const target = parseGithubRepoUrl(input.listing.public_repo_url);
  if (!target) {
    checks.push({ id: "public_repo", ok: false, detail: "No public repository is set. Add the https://github.com/owner/name the code will open in." });
    checks.push({ id: "not_yet_public", ok: false, detail: "Cannot be checked without a public repository." });
  } else {
    const where = `${target.owner}/${target.name}`;
    try {
      const repo = await github.repo(target.owner, target.name);
      if (!repo) {
        checks.push({ id: "public_repo", ok: false, detail: `github.com/${where} does not exist, or is not public.` });
        checks.push({ id: "not_yet_public", ok: false, detail: "Cannot be checked until the public repository exists." });
      } else if (repo.private) {
        checks.push({ id: "public_repo", ok: false, detail: `github.com/${where} is private. The repository the code opens in has to be public.` });
        checks.push({ id: "not_yet_public", ok: false, detail: "Cannot be checked until the repository is public." });
      } else {
        checks.push({ id: "public_repo", ok: true, detail: `github.com/${where} exists and is public.` });
        const commit = await github.commit(target.owner, target.name, input.commitSha);
        checks.push(
          commit
            ? {
                id: "not_yet_public",
                ok: false,
                detail: `Commit ${input.commitSha.slice(0, 12)} is already public in github.com/${where}, so there is nothing early to sell and nothing to verify.`,
              }
            : { id: "not_yet_public", ok: true, detail: `Commit ${input.commitSha.slice(0, 12)} is not yet in github.com/${where}.` },
        );
      }
    } catch (e) {
      const why = e instanceof GithubUnreachable ? (e.status ? `HTTP ${e.status}` : "no answer") : e instanceof Error ? e.message : String(e);
      checks.push({ id: "public_repo", ok: false, detail: `GitHub could not be asked about github.com/${where} (${why}). Cut again once it answers.` });
      checks.push({ id: "not_yet_public", ok: false, detail: "Cannot be checked while GitHub is not answering." });
    }
  }

  const paid = Boolean(input.creator?.payout_address || input.creator?.stellar_payout_address);
  checks.push(
    paid
      ? { id: "payout_address", ok: true, detail: "A payout address is bound, so sales have somewhere to go." }
      : { id: "payout_address", ok: false, detail: "No payout address is bound. Bind one on the wallet page before selling an open release." },
  );

  return checks;
}

export type OpenStampInput = {
  listing: Pick<ListingRow, "open_after_days">;
  /** The row as it stands before the stamp: `created_at` anchors the date and the 90-day cap, `opens_at` the only-earlier rule. */
  release: Pick<ReleaseRow, "created_at" | "opens_at">;
  licenceSpdx: string | null;
  checks: OpenCheck[];
};

/**
 * The columns to write for this release's promise. Pure.
 *
 * `opens_at` is this release's cut plus the listing's `open_after_days` (founder, 25 Oct
 * 2026: the offer is "buyers get each release N days early", restated from every cut,
 * not one calendar date promised in advance). It is clamped two ways so the write can
 * never trip the database: never later than `created_at + 90 days` (the cap, which a
 * well-formed listing cannot exceed anyway), and never later than an `opens_at` the row
 * already carries (a resumed `pending` cut must not push a stamped date back). A
 * `pending` promise is only ever written when every check passed.
 */
export function openStamp(input: OpenStampInput): Pick<ReleaseRow, "opens_at" | "open_licence_spdx" | "promise_status" | "open_eligibility" | "promise_checked_at"> {
  const eligible = input.checks.every((c) => c.ok);

  const days = input.listing.open_after_days;
  const cutAt = new Date(input.release.created_at);
  let opensAt: Date | null =
    typeof days === "number" && Number.isInteger(days) && days >= 1 && !Number.isNaN(cutAt.getTime())
      ? new Date(cutAt.getTime() + Math.min(days, OPEN_RELEASE_MAX_DAYS) * 86_400_000)
      : null;
  if (opensAt) {
    const already = input.release.opens_at ? new Date(input.release.opens_at) : null;
    if (already && !Number.isNaN(already.getTime()) && opensAt > already) opensAt = already;
  }

  return {
    opens_at: opensAt ? opensAt.toISOString() : null,
    open_licence_spdx: input.licenceSpdx,
    promise_status: eligible && opensAt ? "pending" : "ineligible",
    open_eligibility: input.checks,
    promise_checked_at: null,
  };
}
