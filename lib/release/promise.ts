/**
 * lib/release/promise.ts — was the promise kept? (25 Oct 2026, HackMeridian)
 *
 * An open release says: this commit goes public in that repository, under this licence,
 * by this date (docs/HACKMERIDIAN-STRATEGY.md §6a, Proof 4). Once the date has passed
 * the platform asks GitHub whether it did, once, and records the answer with evidence a
 * buyer can follow. This module is that one question.
 *
 *   pending  + opens_at ≤ now + commit found + same licence   → opened_on_time
 *   pending  + opens_at ≤ now + commit found + other licence  → overdue (evidence says why)
 *   pending  + opens_at ≤ now + commit not found              → overdue
 *   anything else                                            → untouched
 *
 * **Only a `pending` release is ever checked, and only once.** `opened_on_time` and
 * `overdue` are verdicts, not observations: a release that opened a week late does not
 * become "on time" because a later read found it, and one that opened on time does not
 * lose the mark because a tag was later deleted. The check runs when the date has
 * passed, records what it saw, and the row is then history.
 *
 * It runs in two places, by design. **On read** — the listing page, the listing JSON
 * and MCP `get_listing` call `checkPromiseIfDue` — so a demo listing whose date is
 * already past flips on the first visit ("backdated allowed", BATTLE-TEST §4), and so a
 * buyer never reads a stale `pending` from a cron that has not come round. **By cron**
 * — `GET /api/cron/promises`, daily — so a page nobody visits still gets its verdict.
 * The read path is cheap: a release whose date has not passed costs nothing, and one
 * that has costs two GETs once, then never again. A 60-second in-memory guard stops a
 * reload storm from re-asking GitHub when it did not answer.
 *
 * The read path never throws. GitHub being unreachable leaves the row `pending` with
 * `promise_checked_at` set, and the page renders what it had. The cron reports the
 * failure per release instead.
 */

import { db } from "@/lib/db";
import type { ListingRow, ReleaseRow } from "@/lib/db/types";
import { parseGithubRepoUrl, publicGithub, type PublicGithub } from "@/lib/github/public";

/** `{ ref, html_url, licence, checked_url }` as the migration describes it, plus `reason` on a miss. */
export type PromiseEvidence = {
  /** The tag that points at the commit when one does, else the short sha. */
  ref: string | null;
  /** The public commit, where a buyer can see it. */
  html_url: string | null;
  /** The SPDX id GitHub read from the public repository at check time. */
  licence: string | null;
  /** The API URL that was asked, so the evidence is reproducible. */
  checked_url: string;
  /** On `overdue`: why, in one sentence. */
  reason?: string;
};

export type CheckPromiseOptions = {
  now?: Date;
  github?: PublicGithub;
};

/** True when `checkPromise` would do something: pending, with a date that has passed. */
export function promiseDue(release: Pick<ReleaseRow, "promise_status" | "opens_at">, now = new Date()): boolean {
  if (release.promise_status !== "pending" || !release.opens_at) return false;
  const opensAt = new Date(release.opens_at);
  return !Number.isNaN(opensAt.getTime()) && opensAt.getTime() <= now.getTime();
}

/**
 * Ask GitHub and record the verdict. Returns the row as written, or the row untouched
 * when nothing was due. Throws when GitHub could not be asked, after stamping
 * `promise_checked_at` so the attempt is on the record.
 */
export async function checkPromise(release: ReleaseRow, listing: Pick<ListingRow, "public_repo_url">, options: CheckPromiseOptions = {}): Promise<ReleaseRow> {
  const now = options.now ?? new Date();
  if (!promiseDue(release, now)) return release;

  const target = parseGithubRepoUrl(listing.public_repo_url);
  if (!target) {
    // Cannot happen for a `pending` row — the cut's `public_repo` check would have made
    // it ineligible — but a row edited by hand must not crash the page.
    return write(release.id, { promise_status: "overdue", promise_checked_at: now.toISOString(), promise_evidence: { ref: null, html_url: null, licence: null, checked_url: "", reason: "The listing has no public repository URL." } satisfies PromiseEvidence });
  }

  const github = options.github ?? publicGithub();
  const checkedUrl = `https://api.github.com/repos/${target.owner}/${target.name}/commits/${release.commit_sha}`;

  let commit: Awaited<ReturnType<PublicGithub["commit"]>>;
  let licence: string | null = null;
  try {
    commit = await github.commit(target.owner, target.name, release.commit_sha);
    if (commit) licence = await github.licence(target.owner, target.name);
  } catch (e) {
    // The attempt is recorded; the verdict is not. The row stays `pending` and the next
    // read or the next cron asks again.
    await write(release.id, { promise_checked_at: now.toISOString() });
    throw e;
  }

  if (!commit) {
    return write(release.id, {
      promise_status: "overdue",
      promise_checked_at: now.toISOString(),
      promise_evidence: {
        ref: null,
        html_url: null,
        licence: null,
        checked_url: checkedUrl,
        reason: `Commit ${release.commit_sha.slice(0, 12)} was not in github.com/${target.owner}/${target.name} when checked.`,
      } satisfies PromiseEvidence,
    });
  }

  // Best effort, after the verdict is already known: a tag reads better than a sha, and
  // a failure here must not cost the verdict.
  let ref: string | null = null;
  try {
    ref = await github.tagFor(target.owner, target.name, release.commit_sha);
  } catch {
    ref = null;
  }
  ref ??= release.commit_sha.slice(0, 12);

  const promised = release.open_licence_spdx ?? null;
  const sameLicence = promised !== null && licence !== null && promised.toLowerCase() === licence.toLowerCase();
  if (!sameLicence) {
    return write(release.id, {
      promise_status: "overdue",
      promise_checked_at: now.toISOString(),
      promise_evidence: {
        ref,
        html_url: commit.html_url,
        licence,
        checked_url: checkedUrl,
        reason: licence
          ? `The commit is public, but github.com/${target.owner}/${target.name} is licensed ${licence}, not ${promised ?? "the licence it was sold under"}.`
          : `The commit is public, but github.com/${target.owner}/${target.name} has no licence GitHub recognises; it was sold under ${promised ?? "a licence"}.`,
      } satisfies PromiseEvidence,
    });
  }

  return write(release.id, {
    promise_status: "opened_on_time",
    promise_checked_at: now.toISOString(),
    opened_at: now.toISOString(),
    promise_evidence: { ref, html_url: commit.html_url, licence, checked_url: checkedUrl } satisfies PromiseEvidence,
  });
}

async function write(releaseId: string, patch: Partial<ReleaseRow>): Promise<ReleaseRow> {
  const { data, error } = await db().from("release").update(patch).eq("id", releaseId).select("*").single();
  if (error) throw error;
  return data as ReleaseRow;
}

// --- the read path -------------------------------------------------------------

/** How long a failed attempt holds before a read asks GitHub again. */
export const PROMISE_RECHECK_MS = 60_000;

const attempted = new Map<string, number>();

/** Tests: forget every recent attempt. */
export function resetPromiseCache(): void {
  attempted.clear();
}

/**
 * The read-path check: never throws, never asks GitHub about the same release twice in
 * a minute. Returns the row to render — updated when the check ran, the input otherwise.
 */
export async function checkPromiseIfDue(release: ReleaseRow, listing: Pick<ListingRow, "public_repo_url">, options: CheckPromiseOptions = {}): Promise<ReleaseRow> {
  const now = options.now ?? new Date();
  if (!promiseDue(release, now)) return release;

  const last = attempted.get(release.id);
  if (last !== undefined && now.getTime() - last < PROMISE_RECHECK_MS) return release;
  attempted.set(release.id, now.getTime());

  try {
    return await checkPromise(release, listing, { ...options, now });
  } catch (e) {
    console.warn(`[promise] could not check release ${release.id}:`, e instanceof Error ? e.message : String(e));
    return release;
  }
}

/**
 * The same, over a listing bundle, in place: the page, the JSON and MCP all hold a
 * `{ listing, latest, releases }` and render `latest`. Only the release that sells is
 * checked here — the cron covers the rest.
 */
export async function refreshPromiseOnRead<B extends { listing: ListingRow; latest: ReleaseRow | null; releases: ReleaseRow[] }>(bundle: B, options: CheckPromiseOptions = {}): Promise<B> {
  if (!bundle.latest || !promiseDue(bundle.latest, options.now)) return bundle;
  const checked = await checkPromiseIfDue(bundle.latest, bundle.listing, options);
  if (checked === bundle.latest) return bundle;
  bundle.latest = checked;
  bundle.releases = bundle.releases.map((r) => (r.id === checked.id ? checked : r));
  return bundle;
}

// --- the cron ------------------------------------------------------------------

/** Every pending release whose date has passed, with its listing. Oldest date first. */
export async function duePromises(now = new Date()): Promise<{ release: ReleaseRow; listing: ListingRow }[]> {
  const { data, error } = await db()
    .from("release")
    .select("*")
    .eq("promise_status", "pending")
    .lte("opens_at", now.toISOString())
    .order("opens_at", { ascending: true });
  if (error) throw error;
  const releases = (data as ReleaseRow[] | null) ?? [];
  if (releases.length === 0) return [];

  const listingIds = [...new Set(releases.map((r) => r.listing_id))];
  const { data: listingData, error: listingError } = await db().from("listing").select("*").in("id", listingIds);
  if (listingError) throw listingError;
  const listings = new Map(((listingData as ListingRow[] | null) ?? []).map((l) => [l.id, l]));

  return releases.flatMap((release) => {
    const listing = listings.get(release.listing_id);
    return listing ? [{ release, listing }] : [];
  });
}
