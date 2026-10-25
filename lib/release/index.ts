/**
 * lib/release — the release pipeline entry point (PRD §7.5, FR-8, FR-9, FR-15, FR-35).
 *
 * `cutRelease` is called by the GitHub webhook (push tag / release events) and by
 * `POST /api/listings/:id/sync`. It runs analysis (7 REST calls), snapshots the tarball
 * to Storage, scans it, and writes the `release` row (pending → pass | fail).
 *
 * Contract shared between the listings slice (caller) and the pipeline slice (implementer).
 *
 * The order is fixed by §14.5 and §6: **snapshot before you sell**, and the bytes that
 * were scanned are the bytes that are served. The `pending` row is written first, on
 * purpose — §12's state machine says an analysis error leaves the release `pending`
 * with `scan_report.error`, which is only representable if the row already exists. A
 * `sync` re-runs it.
 *
 * Nothing in here executes creator code (NG6) and nothing shells out to a binary.
 */
import {
  MAX_README_ASSETS,
  type RepoAnalysis,
  RepoTooLargeError,
  analyze,
  assetContentType,
  classifySnapshot,
  composeComputed,
  significantBlobs,
  stripChangelogBoilerplate,
} from "@/lib/analysis";
import { originality } from "@/lib/analysis/originality";
import { mirrorToVercel } from "@/lib/analytics/vercel";
import { db } from "@/lib/db";
import type { CreatorRow, ListingRow, ReleaseRow } from "@/lib/db/types";
import { recordedChainId } from "@/lib/events";
import { analyzerVersion, hostedOrgs } from "@/lib/env";
import { notifyIndexNow } from "@/lib/indexnow";
import { type InstallationOctokit, githubApp, installationOctokit } from "@/lib/github/app";
import { REPO_ROLE_REQUIRED, userCanSellRepo } from "@/lib/github/installations";
import { applyLicenceGate } from "@/lib/licence";
import { SCANNER_VERSION, SOCKET_REASONS, type ScanReport, defaultExtraChecks, publicChecks, publicCounts, publishedFindings, scanArtifact } from "@/lib/scan";
import { githubTarball, snapshot } from "@/lib/snapshot";
import { deleteArtifact, putReadmeAsset, readmeAssetPathFor } from "@/lib/storage";

export type CutReleaseInput = {
  listingId: string;
  /** Git ref to snapshot: a tag (`v1.2.0`), a branch, or a commit sha. Defaults to the default branch. */
  ref?: string;
  /** Required when `ref` is not a `v<semver>` tag (FR-8.2). Leading `v` is stripped (FR-9). */
  version?: string;
  /** Creator-supplied notes used as the changelog when present (FR-15). */
  notes?: string;
};

export type CutReleaseResult =
  | { ok: true; release: ReleaseRow }
  | { ok: false; code: "version_exists" | "repo_too_large" | "invalid_version" | "not_found" | "repo_role_required"; message: string };

/**
 * AUTH-2 went live on this date. A Rail A listing whose creator has no linked GitHub
 * identity and that predates it is a legacy headless registration (`resolveRailARepo`
 * has required the identity for longer than this); on 2026-10-25 those were the
 * platform's own `examples` and e2e creators, 9 listings. They keep cutting. Any listing
 * newer than this with no identity is refused, so unlinking is never a way round the check.
 */
export const AUTH2_CUTOVER = new Date("2026-10-25T00:00:00Z");

/** FR-9: the tag with any leading `v` stripped, and it must be MAJOR.MINOR.PATCH. */
export const VERSION_RE = /^\d+\.\d+\.\d+$/;

/**
 * What `scanArtifact` is given of the handler's `maxDuration = 300` (13 Sep 2026).
 *
 * 200 seconds, leaving 100 for the snapshot, the analysis, the licence gate, the
 * originality read, the README assets and the writes that follow. A scan that runs out
 * publishes a gap — `socket processing`, an advisory left at `UNKNOWN` — and the §7 cron
 * repairs it, which is a far better failure than a handler killed mid-write.
 */
export const SCAN_DEADLINE_MS = 200_000;

/** `refs/tags/v1.2.0` → `1.2.0`. Returns null when the ref is not a version tag. */
export function versionFromRef(ref: string | undefined | null): string | null {
  if (!ref) return null;
  const tag = ref.replace(/^refs\/tags\//, "");
  const version = tag.replace(/^v/i, "");
  return VERSION_RE.test(version) ? version : null;
}

/** The tag name a ref refers to, for `git_ref` and the tarball fetch. */
export function tagFromRef(ref: string | undefined | null): string | null {
  if (!ref) return null;
  return ref.startsWith("refs/tags/") ? ref.slice("refs/tags/".length) : ref;
}

export async function cutRelease(input: CutReleaseInput): Promise<CutReleaseResult> {
  const client = db();

  const { data: listingData, error: listingError } = await client.from("listing").select("*").eq("id", input.listingId).maybeSingle();
  if (listingError) throw listingError;
  const listing = listingData as ListingRow | null;
  if (!listing) return { ok: false, code: "not_found", message: "No such listing." };

  const { data: creatorData } = await client.from("creator").select("*").eq("id", listing.creator_id).maybeSingle();
  const creator = creatorData as CreatorRow | null;

  // The repository is resolved before the version, because a bare `sync` — no ref, no
  // version, which is what the dashboard's "Check for releases" sends — has to *ask the repository*
  // what its tags are before it knows what it is cutting.
  const installationId = await resolveInstallationId(listing);
  if (!installationId) return { ok: false, code: "not_found", message: "This listing has no GitHub App installation." };

  let octokit: InstallationOctokit;
  let owner: string;
  let repo: string;
  try {
    octokit = await installationOctokit(installationId);
    // FR-8: resolve by repo id, never by name — a rename must not lose the listing.
    const { data } = await octokit.request("GET /repositories/{repository_id}", { repository_id: Number(listing.github_repo_id) });
    owner = (data as any).owner.login;
    repo = (data as any).name;
  } catch (e) {
    return { ok: false, code: "not_found", message: `The repository could not be reached: ${message(e)}` };
  }

  // AUTH-2: a Rail A snapshot is taken only while the creator still holds `admin` or
  // `maintain` on the repo. Checked here, on every cut, rather than once at creation:
  // roles change after a listing exists, and this is the one door both the webhook and
  // `POST /api/listings/:id/sync` come through. Before any bytes are read. Rail B repos
  // are ours, provisioned for the creator, and carry no GitHub role to check.
  if (listing.source === "github") {
    const githubUserId = creator?.github_user_id;
    if (githubUserId === null || githubUserId === undefined) {
      // No identity to check a role for. Legacy (see AUTH2_CUTOVER) cuts; anything newer is refused.
      const legacy = listing.created_at !== undefined && listing.created_at !== null && new Date(listing.created_at) < AUTH2_CUTOVER;
      if (!legacy) return { ok: false, code: "repo_role_required", message: REPO_ROLE_REQUIRED };
    } else if (!(await userCanSellRepo(installationId, githubUserId, { owner, name: repo }))) {
      return { ok: false, code: "repo_role_required", message: REPO_ROLE_REQUIRED };
    }
  }

  const rest = octokit as unknown as import("@/lib/analysis").OctokitLike;

  // FR-9: the version, from the explicit argument or from the tag.
  const explicit = input.version?.replace(/^v/i, "");
  const fromRef = versionFromRef(input.ref);
  // FR-8.2 (amended 2026-09-01): neither given means "cut whatever this repo is tagged at".
  // A listing created *after* its repo was tagged gets no webhook — the tag was pushed
  // before we were watching — so without this the release log stays empty and the only
  // recovery is to re-push a tag or to hand-write a version. That is the state a creator
  // reports as "it isn't reading the releases on my repo".
  //
  // Only when the caller said nothing at all: a ref that names a branch still has to carry
  // an explicit version, because the branch head is not a release of anything.
  const discovered = explicit || input.ref ? null : await latestUncutTag(client, rest, { owner, repo, listingId: listing.id });
  const version = explicit ?? fromRef ?? discovered?.version ?? null;
  if (!version || !VERSION_RE.test(version)) {
    return {
      ok: false,
      code: "invalid_version",
      message: input.ref
        ? "A version is required and must be MAJOR.MINOR.PATCH; a tag may carry a leading `v`."
        : `No \`vX.Y.Z\` tag was found on ${owner}/${repo}. Push one — \`git tag v1.0.0 && git push origin v1.0.0\` — or sync with an explicit version.`,
    };
  }

  // Cheap pre-check. The UNIQUE (listing_id, version) insert below is the real guard —
  // two webhook deliveries can race this read.
  //
  // §12: `pass` and `fail` are **terminal**, so re-tagging one of those is `version_exists`
  // (FR-9). `pending` is not terminal — it is exactly what an analysis error leaves behind,
  // and §12 says `sync` re-runs it. Refusing a pending row here would make that sentence
  // unimplementable: the failed cut could never be retried by sync, by redelivery, or at all.
  const { data: existingData } = await client.from("release").select("*").eq("listing_id", listing.id).eq("version", version).maybeSingle();
  const existing = (existingData as ReleaseRow | null) ?? null;
  if (existing && existing.scan !== "pending") {
    // `version_exists` is the honest code either way, but "version 1.0.0 already exists"
    // is not an answer to "sync my repository" — which is all a bare sync asked. It got
    // here because every tag was already cut and `latestUncutTag` fell back to the newest
    // (2026-09-01, founder: a failed release with no way forward and no sentence saying
    // why). After a failed scan the creator's next move is a new tag, and until now
    // nothing anywhere said so.
    const explanation = discovered
      ? existing.scan === "fail"
        ? `The newest tag on ${owner}/${repo} is \`${discovered.tag}\`, and v${version} failed its scan. A scan verdict is final, so push a new tag to cut a new version.`
        : `The newest tag on ${owner}/${repo} is \`${discovered.tag}\`, and v${version} has already been cut. Push a new tag to cut a new version.`
      : `Version ${version} already exists for this listing.`;
    return { ok: false, code: "version_exists", message: explanation };
  }

  const gitRef = tagFromRef(input.ref) ?? discovered?.tag ?? undefined;

  // The commit has to be known before the row is inserted: `commit_sha` is NOT NULL.
  let commitSha: string;
  let commitMessage: string | null = null;
  try {
    const { data } = await rest.request("GET /repos/{owner}/{repo}/commits/{ref}", { owner, repo, ref: gitRef ?? "HEAD" });
    commitSha = data.sha;
    commitMessage = data.commit?.message ?? null;
  } catch (e) {
    return { ok: false, code: "not_found", message: `The ref could not be resolved: ${message(e)}` };
  }

  // FR-15: `diff_summary` compares against the previous release's commit. Only the commit
  // and the date are read, so the whole `manifest` blob of every prior release is not.
  const { data: priorData } = await client
    .from("release")
    .select("id, commit_sha, created_at")
    .eq("listing_id", listing.id)
    .order("created_at", { ascending: false });
  const prior = ((priorData ?? []) as Pick<ReleaseRow, "id" | "commit_sha" | "created_at">[]).filter((r) => r.id !== existing?.id);

  // FR-15: the prices in force are stamped at publish and never re-read.
  const row = {
    git_ref: gitRef ?? "HEAD",
    commit_sha: commitSha,
    scan: "pending" as const,
    price_micro_at_publish: String(listing.price_micro),
    update_price_micro_at_publish: String(listing.update_price_micro),
    analyzer_version: analyzerVersion(),
  };

  // Resuming a `pending` row rather than inserting a second one: §12 makes
  // `(listing_id, version)` one release, whatever number of attempts it took.
  const { data: insertedData, error: insertError } = existing
    ? await client
        .from("release")
        .update({ ...row, scan_report: null })
        .eq("id", existing.id)
        .select("*")
        .single()
    : await client
        .from("release")
        .insert({ listing_id: listing.id, version, ...row })
        .select("*")
        .single();

  if (insertError) {
    if (insertError.code === "23505") return { ok: false, code: "version_exists", message: `Version ${version} already exists for this listing.` };
    throw insertError;
  }
  const release = insertedData as ReleaseRow;

  try {
    // 1. Analysis — the ~7 REST calls of §6.
    const analysis = await analyze(rest, {
      owner,
      repo,
      ref: gitRef,
      resolvedCommitSha: commitSha,
      previousCommitSha: prior[0]?.commit_sha ?? null,
      priorReleaseDates: prior.map((r) => r.created_at),
      // FR-49: where a relative README image will be served from. Known here and only
      // here — the analyser has the repository, this has the listing.
      assetBase: creator?.handle ? `/api/label/${creator.handle}/${listing.slug}/asset` : null,
    });

    // 2. Snapshot — §14.5, before anything is sellable. The README's images ride along
    //    in the same pass over the tarball: it is streamed once and discarded, so a file
    //    not named here cannot be recovered later without fetching the whole thing again.
    const snap = await snapshot({
      source: await githubTarball(rest, { owner, repo, ref: commitSha }),
      listingId: listing.id,
      slug: listing.slug,
      version,
      retainPaths: analysis.readme_assets.slice(0, MAX_README_ASSETS),
    });

    // 3. Scan — FR-35, over the exact bytes that were stored. The result is a report v2
    //    ("PRD Trust Report.md" §4.2): `checks[]` with a row per check, findings in three
    //    tiers. It goes onto `release.scan_report` whole, below, and the surfaces read it
    //    through `lib/scan/report.ts` (`normalizeReport` lifts the pre-13-Sep-2026 rows).
    //
    //    `defaultExtraChecks()` is the whole of the wiring for §9's phases 2a and 2b:
    //    capabilities and injection always, Socket only where a token is configured (a
    //    deployment without one gets a `socket unconfigured` row, which reads differently
    //    from a vendor outage and is the truth). Nothing here branches per module — the
    //    seam does, so a fourth check is a line in `lib/scan`, not a line here.
    const classification = classifySnapshot(
      snap.files.map((f) => f.path),
      snap.textFiles,
    );
    const scan = await scanArtifact(
      {
        textFiles: snap.textFiles,
        // W3.1: the secret scanner reads the full bytes of every file that ships.
        secretScanFiles: snap.secretScanFiles,
        secretScanBytes: snap.secretScanBytes,
        fileCount: snap.fileCount,
        extractedBytes: snap.extractedBytes,
        sbomPackages: analysis.sbom.packages.map((p) => ({ name: p.name, version: p.version, ecosystem: p.ecosystem })),
        // `capabilities` needs the whole path list, not just the decodable one — a shell
        // script under `bin/` need not decode to be a thing that runs (§4.3).
        files: snap.files,
        // Socket uploads the archive's own bytes, which is what binds its result to
        // `artifact_sha256` the way OSV's is (D3, §6). FR-42: the listing **id**, never
        // the slug, because Socket's `repo` has to be immutable.
        artifactBytes: snap.bytes,
        listingId: listing.id,
        version,
        commitSha,
      },
      {
        extraChecks: defaultExtraChecks(),
        // 13 Sep 2026: this call runs inside a handler at `maxDuration = 300` with a
        // snapshot, an analysis and six writes around it, and its two slow parts are a
        // vendor that sleeps between polls and a per-advisory lookup that can run 200
        // times. Neither is allowed to discover the ceiling by hitting it — the scan is
        // given 200 s of the 300 and stops cleanly inside it, recording a gap rather than
        // taking the whole cut down. Nothing here can change a verdict by running out of
        // time; see `ScanDeps.deadlineMs`.
        deadlineMs: Date.now() + SCAN_DEADLINE_MS,
      },
    );

    // W3.2 (DC): an incomplete dependency scan (OSV unreachable/timed out) does not earn a
    // passing badge. Leave the release `pending` with `scan_report.osv_error` so it never
    // goes on sale claiming a check that did not run; the creator's next push or a manual
    // `POST /api/listings/:id/sync` retries it. The snapshot bytes are kept (the re-pack is
    // content-addressed and `putArtifact` upserts, W3.3), so the retry is a no-op on content.
    if (scan.verdict === "incomplete") {
      const { data: pendingData, error: pendingError } = await client
        .from("release")
        .update({
          scan: "pending",
          scan_report: scan.report,
          scanner_version: SCANNER_VERSION,
        })
        .eq("id", release.id)
        .select("*")
        .single();
      if (pendingError) throw pendingError;
      await recordEvent("release_scan_incomplete", listing.id, { version, osv_error: scan.report.osv_error });
      return { ok: true, release: pendingData as ReleaseRow };
    }

    // 4. Licence gate — FR-11, on every cut, because a push can add or remove a LICENSE.
    const licence = await applyLicenceGate(listing.id, {
      spdx: analysis.licence_spdx,
      hasLicenceFile: analysis.has_licence_file || snap.hasLicence,
    });

    // 5. Originality — FR-50 V0, blob-SHA overlap against previously-seen snapshots.
    const blobShas = significantBlobs(analysis.tree.map((b) => ({ sha: b.sha, size: b.size })));
    const overlap = await originality(blobShas, listing.id);

    // 5b. README images → the public bucket (FR-49). Best effort by construction: an
    //     image that fails to upload is one image the page does not render, and a
    //     release that failed because a screenshot did would be an absurd trade.
    const readmeAssets = await storeReadmeAssets(listing.id, release.id, snap.retained);

    const computed = composeComputed({
      analysis,
      classification,
      licence: { spdx: licence.spdx, verdict: licence.verdict },
      scan: manifestScan(scan.verdict, scan.report),
      originality: overlap,
      readmeAssets,
      analyzerVersion: analyzerVersion(),
    });

    const manifest = {
      owner: creator?.handle ?? "unknown",
      slug: listing.slug,
      channel: `${creator?.handle ?? "unknown"}/${listing.slug}`,
      version,
      artifact_sha256: snap.sha256,
      published_at: release.created_at,
      computed,
      self_reported: {
        description: listing.description ?? undefined,
        trigger_hint: listing.trigger_hint ?? undefined,
      },
    };

    const changelog = changelogFor(input.notes, analysis, gitRef, commitMessage);

    // 6. On a failing scan the report is stored *first*, then the bytes are deleted
    //    (FR-35). `storage_path` goes null with them, so nothing can sign a URL for
    //    an artifact that no longer exists.
    const failed = scan.verdict === "fail";

    const { data: updatedData, error: updateError } = await client
      .from("release")
      .update({
        artifact_sha256: snap.sha256,
        storage_path: snap.storagePath,
        size_bytes: String(snap.sizeBytes),
        scan: scan.verdict,
        scan_report: scan.report,
        scanner_version: SCANNER_VERSION,
        // W3.5: stamp the per-release licence verdict for *this snapshot* (a release that
        // dropped its LICENSE / carries an incompatible one → `block`; a resale-compatible
        // LICENSE → `pass`; NOASSERTION → `manual`). W1.8 reads this to exclude only
        // `block` from the sellable-release selection; the listing-level verdict above stays
        // the publish gate.
        licence_verdict: licence.verdict,
        manifest,
        changelog,
        diff_summary: analysis.diff_summary,
        analyzer_version: analyzerVersion(),
        blob_shas: blobShas,
      })
      .eq("id", release.id)
      .select("*")
      .single();
    if (updateError) throw updateError;

    if (failed) {
      try {
        await deleteArtifact(snap.storagePath);
        await client.from("release").update({ storage_path: null }).eq("id", release.id);
      } catch (e) {
        console.error("[release] failed snapshot could not be deleted:", message(e));
      }
    }

    await recordEvent(failed ? "release_failed" : "release_cut", listing.id, {
      version,
      commit_sha: commitSha,
      artifact_sha256: snap.sha256,
      scan: scan.verdict,
      blocking_findings: scan.report.counts.blocking,
      licence: licence.verdict,
      artifact_class: computed.artifact_class,
      derivative_of: overlap.derivative_of ?? null,
    });

    // §4.1 and §6.2's failure table: what an operator has to see even though the release
    // sold. Last, so an alert can never cost a release.
    for (const alert of scanAlerts(version, scan.report)) await recordEvent(alert.name, listing.id, alert.props);

    // A passing release changes the public page (version, manifest, price line). Only a
    // live listing has a page worth announcing; a draft's first release is announced by
    // its publish. Never fails the cut (lib/indexnow.ts).
    if (!failed && listing.published_at && !listing.retired_at && creator?.handle) {
      await notifyIndexNow([`/${creator.handle}/${listing.slug}`]);
    }

    const updated = updatedData as ReleaseRow;
    return { ok: true, release: failed ? { ...updated, storage_path: null } : updated };
  } catch (e) {
    // §12: analysis errors leave the release `pending` with `scan_report.error`.
    await client
      .from("release")
      .update({ scan_report: { error: message(e), at: new Date().toISOString(), scanner_version: SCANNER_VERSION } })
      .eq("id", release.id);
    await recordEvent("release_failed", listing.id, { version, error: message(e) });

    if (e instanceof RepoTooLargeError) return { ok: false, code: "repo_too_large", message: e.message };
    throw e;
  }
}

// --- helpers -------------------------------------------------------------------

/**
 * `manifest.computed.scan` — the whole trust report, minus everything §4.4 withholds.
 *
 * The manifest is public JSON served to anyone (FR-49), so **both filters are mandatory**
 * and neither is optional politeness: `publishedFindings` drops the secrets and the
 * injection matches, and `publicChecks` drops `socket_scan_id`, which is ours and
 * identifies a scan under our Socket org. Exported so a test can assert exactly that,
 * without standing up a repository, a snapshot and a database to do it.
 *
 * `publishedFindings`, not `publicFindings` (§4.4, amended 14 Sep 2026): it is the same
 * public set with the transitive `dep_behaviour` rows folded to one per rule. The whole
 * of it stays on `release.scan_report` for the creator, and `counts` below is still the
 * true tally — the fold changes what is printed, never what was found.
 *
 * `counts` is §4.1's three tiers as three numbers, for an agent that will not read the
 * list. `advisories_refreshed_at` is absent at cut time and written by the §7 rescan cron.
 */
export function manifestScan(verdict: "pass" | "fail", report: ScanReport) {
  return {
    verdict,
    scanner_version: report.scanner_version,
    at: report.scanned_at,
    checks: publicChecks(report),
    findings: publishedFindings(report),
    ...(report.capabilities ? { capabilities: report.capabilities } : {}),
    counts: publicCounts(report),
    ...(report.advisories_refreshed_at ? { advisories_refreshed_at: report.advisories_refreshed_at } : {}),
  };
}

/**
 * The admin alerts "PRD Trust Report.md" §4.1 and §6.2 ask for, raised after the release is
 * written so a failed insert never costs an alert and an alert never costs a release.
 *
 * Three of them, and each is a different sentence to the operator:
 *
 * - `release_scan_review` — a `review`-tier finding landed. Socket's model-derived alerts
 *   are 94.5%-precision opinions shown as "flagged for review" and never as a verdict, so
 *   the release sold; someone should still look. The rule ids are the whole point of the
 *   event: `gptMalware` on a direct dependency is a different morning from `troll`.
 * - `release_scan_socket_auth` — a 401. Almost certainly a rotated `SOCKET_TOKEN_VALUE`,
 *   which is silent otherwise: every release keeps cutting with an `unavailable` row.
 * - `release_scan_socket_quota` — a 403/429 or the 10% floor. The free plan's monthly cap
 *   is the number §6.2 says to watch, and this is the only place it shows up.
 *
 * They surface on `/admin/activity` — in the stream by name, and grouped by cause in the
 * failing table (`FAILURE_CAUSE`, lib/admin/activity.ts).
 *
 * Pure, and the caller writes them: an alert is a function of the report and nothing else,
 * and this way the table above is testable without a repository, a snapshot and a webhook.
 */
export function scanAlerts(version: string, report: ScanReport): { name: string; props: Record<string, unknown> }[] {
  const alerts: { name: string; props: Record<string, unknown> }[] = [];

  const review = report.findings.filter((f) => f.tier === "review");
  if (review.length > 0) {
    alerts.push({
      name: "release_scan_review",
      props: {
        version,
        count: review.length,
        // Deduplicated, capped and joined: fifty `gptAnomaly` findings are one thing to
        // look at, and a Telegram line that names fifty packages is one nobody reads
        // (14 Sep 2026 — the first Socket backfill raised 50 of them off one release).
        // The rule ids are the whole payload; no package name is ever in it.
        rule_ids: joinCapped([...new Set(review.map((f) => f.rule_id))], REVIEW_RULE_IDS_SHOWN),
      },
    });
  }

  const reason = report.checks.find((c) => c.id === "dep_behaviour")?.reason ?? "";
  // Prefix, not equality: the quota reason carries `(retry after …)` when Socket sent one.
  if (reason.startsWith(SOCKET_REASONS.auth)) alerts.push({ name: "release_scan_socket_auth", props: { version, reason } });
  else if (reason.startsWith(SOCKET_REASONS.quota)) alerts.push({ name: "release_scan_socket_quota", props: { version, reason } });

  return alerts;
}

/** How many distinct rule ids a `release_scan_review` event names before it says "+N more". */
const REVIEW_RULE_IDS_SHOWN = 5;

/** `"a, b, c, d, e +3 more"`. The count is already a separate prop; this is the sample. */
function joinCapped(values: string[], limit: number): string {
  if (values.length <= limit) return values.join(", ");
  return `${values.slice(0, limit).join(", ")} +${values.length - limit} more`;
}

/**
 * The version tag this listing should cut next, for a `sync` that named neither a ref
 * nor a version (FR-8.2, amended 2026-09-01).
 *
 * **Tags, not releases.** `GET /repos/:owner/:repo/tags` sees a plain `git push --tags`
 * as well as a published GitHub Release; the releases endpoint sees only the second.
 * FR-8's webhook already treats both as the same event, so discovery has to as well.
 *
 * **Newest not already cut**, by semver, then newest overall. A repo tagged v1.0.0 and
 * v1.1.0 where only v1.1.0 has been cut backfills v1.0.0 rather than answering
 * `version_exists` and leaving the creator with no way forward; a repo whose every tag
 * is cut still returns its newest, so the caller gets `version_exists` — the honest
 * answer — instead of "no tags found". `cutRelease` turns that case into a sentence that
 * names the tag and says to push a new one, because the bare code answers a question the
 * caller did not ask.
 *
 * `pending` does not count as cut: §12 says a `pending` release is exactly what `sync`
 * re-runs, so it stays the candidate it was.
 */
async function latestUncutTag(
  client: ReturnType<typeof db>,
  octokit: import("@/lib/analysis").OctokitLike,
  scope: { owner: string; repo: string; listingId: string },
): Promise<{ tag: string; version: string } | null> {
  let candidates: { tag: string; version: string }[];
  try {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/tags", { owner: scope.owner, repo: scope.repo, per_page: 100 });
    candidates = ((data ?? []) as { name?: string }[])
      .map((t) => ({ tag: t.name ?? "", version: versionFromRef(t.name) }))
      .filter((t): t is { tag: string; version: string } => t.version !== null)
      .sort((a, b) => compareVersions(b.version, a.version));
  } catch (e) {
    console.warn("[release] could not list tags for %s/%s: %s", scope.owner, scope.repo, message(e));
    return null;
  }
  if (candidates.length === 0) return null;

  const { data: cutData } = await client.from("release").select("version, scan").eq("listing_id", scope.listingId);
  const cut = new Set(((cutData ?? []) as { version: string; scan: string }[]).filter((r) => r.scan !== "pending").map((r) => r.version));

  return candidates.find((c) => !cut.has(c.version)) ?? candidates[0];
}

/** Numeric semver order. `"1.10.0" > "1.9.0"`, which a string compare gets backwards. */
function compareVersions(a: string, b: string): number {
  const [aMajor, aMinor, aPatch] = a.split(".").map(Number);
  const [bMajor, bMinor, bPatch] = b.split(".").map(Number);
  return aMajor - bMajor || aMinor - bMinor || aPatch - bPatch;
}

/**
 * FR-49: copy the README's images into the public `readme-assets` bucket and return the
 * map the manifest carries — repository path → object key.
 *
 * Keyed by release, so v1.0.1's `docs/shot.png` and v1.0.0's are two objects and an old
 * release never renders a new release's screenshot.
 *
 * Every failure is swallowed to a warning. This runs after the snapshot has been stored
 * and the scan has passed, and the thing being sold does not depend on it; a release
 * that failed because a picture would not upload would be the wrong failure.
 */
async function storeReadmeAssets(listingId: string, releaseId: string, retained: Map<string, Uint8Array>): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  for (const [path, bytes] of retained) {
    const key = readmeAssetPathFor(listingId, releaseId, path);
    try {
      await putReadmeAsset(key, bytes, assetContentType(path));
      map[path] = key;
    } catch (e) {
      console.warn("[release] readme asset upload failed:", path, message(e));
    }
  }
  return map;
}

/**
 * Rail A stores its own `installation_id`. Rail B repos live in a platform-owned org
 * (D10), so the installation is the org's and is looked up once per cut rather than
 * duplicated onto every listing.
 */
async function resolveInstallationId(listing: ListingRow): Promise<number | null> {
  if (listing.installation_id) return Number(listing.installation_id);
  if (listing.source !== "hosted") return null;

  // `GET /orgs/{org}/installation` is one of the few routes the App's own JWT may call,
  // so this works without an installation token to bootstrap it. Orgs are tried in
  // cohort order; the repo fetch that follows fails if the guess was wrong.
  for (const org of hostedOrgs()) {
    try {
      const { data } = await githubApp().octokit.request("GET /orgs/{org}/installation", { org });
      const id = Number((data as any)?.id);
      if (Number.isFinite(id)) return id;
    } catch {
      // Try the next cohort.
    }
  }
  return null;
}

/**
 * FR-15: the creator's `notes`, else the GitHub release body, else the tag's commit
 * message — each with the generated boilerplate stripped.
 */
export function changelogFor(
  notes: string | undefined,
  analysis: RepoAnalysis,
  gitRef: string | undefined,
  commitMessage: string | null,
): string | null {
  if (notes && notes.trim().length > 0) return notes.trim();
  const match = gitRef ? analysis.releases.find((r) => r.tag === gitRef || r.tag === `v${gitRef}`) : undefined;
  return stripChangelogBoilerplate(match?.body) ?? stripChangelogBoilerplate(commitMessage);
}

/** §10 analytics. Never carries a buyer address or a payment. */
export async function recordEvent(name: string, listingId: string, props: Record<string, unknown>): Promise<void> {
  try {
    await db().from("event").insert({ name, listing_id: listingId, props, chain_id: recordedChainId() });
  } catch (e) {
    console.warn("[release] event write failed:", message(e));
  }
  mirrorToVercel(name, props);
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
