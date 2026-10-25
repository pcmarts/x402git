/**
 * lib/scan/rescan.ts — §7 of "PRD Trust Report.md" (accepted 13 Sep 2026): a verdict ages,
 * a disclosure should not.
 *
 * "Verified clean 5 months ago" is the weakest line a listing can carry, because the
 * advisories published in those five months are not in it. We hold the passing artifact's
 * bytes in Storage, content-addressed, so re-reading the dependency rows costs no GitHub
 * call and no creator involvement — just the zip, one OSV query and (weekly) one Socket
 * full scan.
 *
 * **Three rows move and nothing else does.** `known_vulns`, `known_malware` and
 * `dep_behaviour` are rewritten with today's answers; `secrets`, `limits`, `capabilities`
 * and `injection` are functions of bytes that have not changed and are left exactly as
 * they were, along with their findings. `scanned_at` stays at cut time and
 * `advisories_refreshed_at` records the re-read, so the page can say both.
 *
 * **The verdict is terminal and this file never touches it** (PRD §12, FR-39). Neither
 * `release.scan` nor `scan_report.verdict` is written here. If a refreshed row turns up
 * something that *would* have blocked at cut time — an OSV `MAL-` record, or a Socket
 * `malware` alert — that is a takedown question, not a scan question: the event
 * `release_compromised` is recorded, the FR-41 abuse webhook fires `release.compromised`,
 * and a human uses the existing FR-39 control. Nothing is paused, nothing is revoked, and
 * the listing keeps selling until somebody decides otherwise (§10 Q2).
 *
 * **A gap never erases a disclosure.** If OSV is unreachable this run, the OSV rows and
 * their findings are left alone rather than rewritten empty; likewise Socket. The failure
 * mode a rescan must not have is quietly deleting eight CVEs from a published manifest
 * because a vendor had a bad minute — the next run repairs it, and until then the page
 * shows what was last actually known.
 *
 * **Backfill** (14 Sep 2026). The nightly is a refresh, and a refresh deliberately leaves
 * alone every row the old scanner never ran: `capabilities` and `injection` on a listing cut
 * before scanner 2026.09 say `unavailable · predates scanner 2026.09`, and the repair queue
 * does not touch them because "predates" is not a bug to retry. That is right for a cron and
 * wrong for the week the new checks ship — those listings are live, they are selling, and
 * nobody has ever looked at what their files can do. {@link backfillQueue} and
 * `deps.backfill` are the operator-triggered run that closes it: the same merge policy, the
 * same verdict rule, but the two pure checks are re-run whenever their row is `unavailable`
 * for *any* reason and Socket is called regardless of the weekly cadence. It is never
 * scheduled; it is a `curl` a human types (§7).
 *
 * Nothing here executes a line of creator code (NG6), and nothing re-fetches the
 * repository: the bytes read are the bytes sold, by `artifact_sha256`.
 */

import { MAX_EXTRACTED_BYTES, MAX_FILES } from "@/lib/analysis";
import { decodeText } from "@/lib/analysis/files";
import { db } from "@/lib/db";
import type { ReleaseRow } from "@/lib/db/types";
import { record } from "@/lib/events";
import { readArtifact } from "@/lib/storage";
import { commonRoot } from "@/lib/snapshot";
import { sendAbuseWebhook } from "@/lib/abuse-webhook";
import { readArtifactEntries } from "./archive";
import { CHECK_FAILED, capabilitiesCheck, dependencyChecks, injectionCheck } from "./index";
import type { FetchLike, OsvPackage } from "./osv";
import {
  type ScanCheck,
  type ScanCheckId,
  type ScanFinding,
  type ScanReport,
  normalizeReport,
  publicChecks,
  publicCounts,
  publishedFindings,
} from "./report";
import { SOCKET_REASONS, type SocketDeps, socketConfigured, socketQuota } from "./socket";

/**
 * §7 budget guard. Socket's free window is 500 units an hour and a cut costs ≤ 7 of them;
 * the cut is what people are waiting on, so the cron stops spending at a fifth of the
 * window rather than the tenth `socketFullScan` allows itself. OSV keeps going — it is
 * free and it is the row that carries the blocking decision.
 */
export const RESCAN_SOCKET_QUOTA_FLOOR = 0.2;

/** §7: OSV nightly, Socket weekly. Measured against the `dep_behaviour` row's own `at`. */
export const RESCAN_SOCKET_MAX_AGE_MS = 7 * 86_400_000;

/** `maxDuration = 300` on the route; stop cleanly at 250s and say the rest resumes tomorrow. */
export const RESCAN_BUDGET_MS = 250_000;

/**
 * One release's share of the run (13 Sep 2026). Two rules, and they are the same number:
 *
 * 1. **A deadline.** `dependencyChecks` is handed `now + RESCAN_RELEASE_BUDGET_MS`, so a
 *    listing whose Socket scan sleeps through its polls stops there rather than running to
 *    the route's own ceiling. The row it leaves is `socket processing` with the id kept,
 *    which is the row the *next* night finishes for one unit — the cost of stopping early
 *    is a night, and the cost of not stopping is every release behind it in the queue.
 * 2. **A reservation.** The run does not *start* a release it cannot finish inside
 *    {@link RESCAN_BUDGET_MS}. Checking the clock only between releases was checking it
 *    after the damage: at 249 s the loop happily began a release that could take another
 *    ninety, and `maxDuration` killed the handler mid-flight.
 */
export const RESCAN_RELEASE_BUDGET_MS = 45_000;

/**
 * §7's weaker-package-set guard (13 Sep 2026).
 *
 * A rescan may only rewrite the OSV rows when it asked about **at least this share** of the
 * packages the stored report asked about. The failure it exists to prevent is silent and
 * total: `packagesFromFiles` parses `package-lock.json` and four other basenames and knows
 * nothing of `yarn.lock`, `pnpm-lock.yaml` or `poetry.lock`, so a pnpm repo cut against
 * GitHub's resolved graph at 300 packages was rescanned at ten versionless ranges, came
 * back clean, and the two disclosed moderates vanished from a published manifest — the
 * exact "a gap never erases a disclosure" failure this module is written to avoid, arriving
 * as a `pass` rather than as an outage. The SBOM stored on the manifest is used first
 * (see {@link sbomFromManifest}); this is the backstop for when it is missing too.
 */
export const RESCAN_MIN_PACKAGE_RATIO = 0.8;

/** Read caps, so one enormous deployment cannot make the queue query the slow part. */
export const RESCAN_RELEASE_LIMIT = 2_000;
export const RESCAN_LISTING_LIMIT = 2_000;

/** A manifest past this is not a manifest. Keeps a hostile zip from being decoded whole. */
export const MAX_MANIFEST_FILE_BYTES = 4 * 1024 * 1024;

// --- reading the artifact back -------------------------------------------------

export type ReadArtifactTextFilesOptions = {
  /**
   * Manifests only (the default), or every file that decodes as text.
   *
   * `false` is the §7 repair path for `capabilities` and `injection` — two pure functions
   * of the artifact's own words, which need the words. It costs an inflate per file and is
   * asked for only for the releases whose rows say those checks threw.
   */
  manifestsOnly?: boolean;
};

/**
 * The dependency manifests inside a stored artifact, and how many files it holds.
 *
 * Only the manifests, by default: `packagesFromFiles` (lib/scan/osv.ts) reads five
 * basenames, and the lockfiles beside them are what Socket's step 1′ uploads when an
 * archive is over its 10,000-file extraction limit. Everything else in the archive is bytes
 * we already scanned at cut time and have no reason to decode again — and the reader is
 * told so rather than filtered afterwards, so an entry we do not want is never inflated at
 * all (`readZip`'s `inflate` predicate, walking the central directory first).
 *
 * **Zip or tar.gz, by magic bytes** (14 Sep 2026, and the reason this is no longer called
 * `unzipTextFiles`). The three `examples/*` releases were cut on 30 Aug 2026, hours before
 * DECISIONS 2026-08-30 chose zip, and are stored as `.tar.gz`; the backfill met every one
 * of them as `artifact unreadable` and skipped it. `readArtifactEntries` (lib/scan/archive.ts)
 * sniffs the format and fronts both readers, so the wrapper-stripping and the manifest
 * predicate below are the same code for both eras of artifact.
 *
 * **The caps are the same ones `snapshot()` reads a tarball under** (13 Sep 2026): 20,000
 * entries and 200 MB declared, checked before anything is decompressed, throwing the same
 * `TarLimitError` on the zip path and `RepoTooLargeError` on the gzip one. This function is
 * handed an object out of Storage and asked to decompress it, and "we wrote it ourselves"
 * is not a defence a decompressor gets to rely on.
 *
 * Paths come back **relative to the archive root**, with the `<slug>-<version>/` wrapper
 * stripped — or GitHub's `<owner>-<repo>-<sha>/`, since `commonRoot` asks the entries and
 * not the naming convention — so they are the same strings `snapshot()` put in `textFiles`,
 * which matters because `packagesFromFiles` skips `node_modules/` and `vendor/` by path.
 */
export async function readArtifactTextFiles(
  bytes: Uint8Array,
  options: ReadArtifactTextFilesOptions = {},
): Promise<{ textFiles: Map<string, string>; fileCount: number }> {
  const manifestsOnly = options.manifestsOnly !== false;
  // The predicate reads the *stored* path, wrapper directory and all; `isManifestPath`
  // looks at the basename, so the wrapper cannot change its answer.
  const { entries } = await readArtifactEntries(bytes, {
    maxEntries: MAX_FILES,
    maxBytes: MAX_EXTRACTED_BYTES,
    inflate: (path) => (manifestsOnly ? isManifestPath(path) : true),
  });
  const prefix = commonRoot(entries.map((e) => e.path));
  const textFiles = new Map<string, string>();

  // `decodeText` is the snapshot's decoder: UTF-16 by its byte-order mark, lenient UTF-8
  // otherwise. NUL bytes are left in — the scan's parsers strip them, and the injection check
  // reads them to report `nul-in-source` (SCAN-1), on the repair path as at cut time.
  for (const entry of entries) {
    if (entry.skipped) continue;
    const relative = prefix && entry.path.startsWith(`${prefix}/`) ? entry.path.slice(prefix.length + 1) : entry.path;
    if (manifestsOnly) {
      if (!isManifestPath(relative)) continue;
      // A manifest past this is not a manifest, and there is nothing further to say about
      // it: no check reads a `package.json` for anything but its dependencies.
      if (entry.body.length > MAX_MANIFEST_FILE_BYTES) continue;
      textFiles.set(relative, decodeText(entry.body));
      continue;
    }
    // The repair path keeps the ceiling but not the silence: an oversized file arrives
    // truncated, which puts it past `capabilities`' and `injection`'s own 2 MB caps, and
    // those disclose it as unscannable rather than passing it. A file simply missing from
    // the map would have been the silent skip both of them stopped doing today.
    const body = entry.body.length > MAX_MANIFEST_FILE_BYTES ? entry.body.subarray(0, MAX_MANIFEST_FILE_BYTES) : entry.body;
    textFiles.set(relative, decodeText(body));
  }

  return { textFiles, fileCount: entries.length };
}

/**
 * The five basenames `packagesFromFiles` parses, plus the lockfiles and manifests Socket
 * recognises. A name not here is not read; a name here that neither tool understands costs
 * one decode and is harmless.
 */
const MANIFEST_BASENAMES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "requirements.txt",
  "pipfile",
  "pipfile.lock",
  "poetry.lock",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "go.mod",
  "go.sum",
  "cargo.toml",
  "cargo.lock",
  "gemfile",
  "gemfile.lock",
  "composer.json",
  "composer.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
]);

function isManifestPath(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return MANIFEST_BASENAMES.has(base) || /^requirements[-.].*\.txt$/.test(base);
}

// --- one release ---------------------------------------------------------------

export type RescanDeps = {
  /** OSV's transport. Socket has its own, in `socket`. */
  fetch?: FetchLike;
  readArtifact?: (path: string) => Promise<Uint8Array | null>;
  socket?: SocketDeps;
  /** Seams for the two side effects, so a test can watch them without a network. */
  sendWebhook?: typeof sendAbuseWebhook;
  recordEvent?: typeof record;
  now?: () => number;
  /** False when Socket is unconfigured or the run has hit the quota floor (§7). */
  socketEnabled?: boolean;
  /** False on the refresh queue when the Socket row is less than a week old. */
  socketDue?: boolean;
  /**
   * The operator's backfill (14 Sep 2026), and it moves exactly two levers:
   *
   * 1. `capabilities` and `injection` are re-run whenever their row is `unavailable` — not
   *    only when it says `check failed`. "Predates scanner 2026.09", "not wired" and a
   *    module that threw are all the same sentence to a reader of the page: this listing
   *    does not say what its files can do.
   * 2. Socket is owed a call whatever its row's `at` says. The weekly cadence is a cost
   *    control for a nightly loop over every live listing; a run somebody typed is not that.
   *
   * Everything else is the nightly's: the quota floor still stops Socket, the per-release
   * deadline still applies, the weaker-set guard still protects the OSV rows, and the
   * verdict is still never written.
   */
  backfill?: boolean;
  /**
   * Absolute epoch ms this one release must be finished by. `runRescan` sets it to
   * `now + RESCAN_RELEASE_BUDGET_MS`; called directly, nothing is bounded but the
   * individual request timeouts.
   */
  deadlineMs?: number;
};

export type RescanResult = {
  status: "rescanned" | "skipped";
  /** Why it was skipped, or which dependency rows could not be refreshed. */
  reason?: string;
  /**
   * Anything the run's summary should carry about this release that is not a skip and not
   * a throw: the weaker-package-set guard firing, an FR-41 webhook that did not deliver.
   * `runRescan` copies them into `RescanSummary.notes` with the release named.
   */
  notes?: string[];
  compromised: boolean;
  /** True when Socket was called and produced a row. */
  socketRan: boolean;
  /** True when the Socket row was finished from its stored id rather than re-uploaded. */
  socketResumed: boolean;
  osvRan: boolean;
  /**
   * The report as it was written, for the single-listing backfill's `public_checks`
   * (14 Sep 2026). Present on a rescan and absent on a skip, because on a skip nothing was
   * written and the caller already holds the row it read.
   */
  report?: ScanReport;
};

/** What `rescanRelease` needs off the row. `ReleaseRow` satisfies it. */
export type RescanReleaseInput = Pick<
  ReleaseRow,
  "id" | "listing_id" | "version" | "commit_sha" | "scan" | "storage_path" | "scan_report" | "manifest"
>;

export async function rescanRelease(release: RescanReleaseInput, deps: RescanDeps = {}): Promise<RescanResult> {
  const nowFn = deps.now ?? Date.now;
  const at = new Date(nowFn()).toISOString();
  const skip = (reason: string): RescanResult => ({ status: "skipped", reason, compromised: false, socketRan: false, socketResumed: false, osvRan: false });

  // A failed cut's bytes are deleted and `storage_path` goes null with them (FR-35). There
  // is nothing to re-read and nothing that release could be selling, so it is not a gap.
  if (!release.storage_path) return skip("no artifact bytes");

  const report = liftReport(release.scan_report);
  if (!report) return skip("no scan report");

  const bytes = await (deps.readArtifact ?? readArtifact)(release.storage_path);
  if (!bytes) return skip("artifact missing from storage");

  // §7's repair queue, second half (13 Sep 2026): a `capabilities` or `injection` row whose
  // module *threw* at cut time. Those two are pure functions of bytes that have not
  // changed, so unlike a vendor gap they can simply be re-run — but they need the words,
  // not the manifests, which is the one case this cron reads the whole archive. On a
  // backfill the same path takes every `unavailable` row, `predates` included — see
  // {@link RescanDeps.backfill}.
  const backfill = deps.backfill === true;
  const repairable = pureChecksToRepair(report, backfill);

  let unzipped: { textFiles: Map<string, string>; fileCount: number };
  try {
    unzipped = await readArtifactTextFiles(bytes, { manifestsOnly: repairable.length === 0 });
  } catch (e) {
    return skip(`artifact unreadable: ${message(e)}`);
  }

  // --- the three rows, from the one place that builds them (lib/scan/index.ts). Before
  // 13 Sep 2026 this file had its own OSV query, its own Socket call and its own copy of
  // §6.2 step 4's de-duplication; `dependencyChecks` now takes the three levers §7 needs, so
  // there is one source for the rows, one de-duplication and one row-count rule. What stays
  // here is the *merge* policy below, which is a rescan rule and not a scan rule.
  //
  // §7's cadence, expressed in the `socket` lever: `false` is OSV-only — the Socket row is
  // not due this week, or the run has hit the quota floor — and an object is Socket with our
  // deps, carrying `resumeScanId` when the row we hold was left mid-scan.
  const previousDep = report.checks.find((c) => c.id === "dep_behaviour");
  // A backfill is owed a Socket call whatever the cadence says; the quota floor, which
  // arrives as `socketEnabled: false`, still outranks both.
  const socketOn = deps.socketEnabled !== false && (backfill || deps.socketDue !== false);
  const resumeScanId = socketOn ? resumableScanId(previousDep) : undefined;

  // §7's package set, and the whole of finding 1 (13 Sep 2026). Since SCAN-2 the zip's own
  // manifests are the authority here exactly as at cut time (`dependencyInventory`), and
  // the manifest's stored `computed.dependencies` — GitHub's graph of the default branch,
  // which has read the `yarn.lock`, `pnpm-lock.yaml` or `poetry.lock` our parser does not —
  // may only add packages the zip does not name. The count guard below catches the case
  // where both come back smaller than the stored report.
  const storedPackages = sbomFromManifest(release.manifest);
  const socketManifestFiles = new Map([...unzipped.textFiles].filter(([path]) => isManifestPath(path)));

  const refresh = await dependencyChecks(
    {
      textFiles: unzipped.textFiles,
      fileCount: unzipped.fileCount,
      // Not read by the dependency rows — the secret scan and the §6 caps are functions of
      // bytes that have not changed and §7 does not re-run them.
      extractedBytes: 0,
      artifactBytes: bytes,
      listingId: release.listing_id,
      version: release.version,
      commitSha: release.commit_sha,
      ...(storedPackages.length > 0 ? { sbomPackages: storedPackages } : {}),
      // `readArtifactTextFiles` already read the lockfiles beside the manifests, which is a wider
      // step-1′ set than `manifestFilesOf` derives; hand Socket all of it.
      socketManifestFiles,
    },
    {
      fetch: deps.fetch,
      at,
      socket: socketOn ? { ...deps.socket, ...(resumeScanId ? { resumeScanId } : {}) } : false,
      ...(deps.deadlineMs !== undefined ? { deadlineMs: deps.deadlineMs } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    },
  );

  const osvError = refresh.error;
  const socketRan = refresh.checks.some((c) => c.id === "dep_behaviour" && c.status !== "unavailable");
  const notes: string[] = [];

  // The weaker-set guard. A run that asked about materially fewer packages than the stored
  // report did has not learned that the missing ones are clean — it has not asked — so it
  // does not get to rewrite rows that say they are not. See {@link RESCAN_MIN_PACKAGE_RATIO}.
  const before = report.packages_scanned ?? 0;
  const weakerSet = !osvError && before > 0 && refresh.packages < before * RESCAN_MIN_PACKAGE_RATIO;
  if (weakerSet) notes.push(`skipped: weaker package set (${refresh.packages} packages this run against ${before} on the stored report)`);
  const osvRan = !osvError && !weakerSet;

  if (!osvRan && !socketRan && repairable.length === 0) {
    const why = weakerSet ? notes[0] : `nothing refreshed (${osvError ?? "osv unreachable"})`;
    return { status: "skipped", reason: why, notes, compromised: false, socketRan: false, socketResumed: false, osvRan: false };
  }

  // --- rewrite the three rows, and only those three.
  //
  // **A gap never erases a disclosure**, and this one line is the whole of that rule: a row
  // that could not run today comes back `unavailable`, and an `unavailable` answer is a
  // vendor gap, not new knowledge, so the row we already had stays in place along with its
  // findings. That is the difference between "Socket saw nothing today" and "Socket has
  // never run". It is the rescan's rule and not the scanner's — a fresh cut publishes the
  // gap, because there is no older answer to keep.
  const refreshed = new Set<ScanCheckId>();
  const nextChecks = [...report.checks];

  for (const check of refresh.checks) {
    if (check.status === "unavailable") {
      // The gap stays out of the row and goes into the run's notes instead, so whoever
      // reads a backfill summary learns *why* Socket did not answer. The first backfill
      // (14 Sep 2026) left `dep_behaviour` at "predates" with no word of the reason, and
      // the only way to find out was to reproduce it.
      if (check.id === "dep_behaviour" && socketOn) notes.push(`dep_behaviour not refreshed: ${check.reason ?? "unavailable"}`);
      continue;
    }
    // A weaker package set is neither an answer nor an outage: it is a smaller question,
    // and the two OSV rows keep the answer they have rather than the answer to it.
    if (weakerSet && (check.id === "known_vulns" || check.id === "known_malware")) continue;
    refreshed.add(check.id);
    replaceRow(nextChecks, check);
  }
  const nextFindings = refresh.findings.filter((f) => refreshed.has(f.check));

  // The two pure checks, re-run over the same bytes. Nothing here can gain a vendor, so a
  // row that throws twice simply says so twice — but the common case is a bug we have since
  // fixed, and a listing whose "what it can do" section has been blank since the day it was
  // cut is exactly what §1 complains about.
  let repairedCapabilities: ScanReport["capabilities"];
  for (const id of repairable) {
    const check = id === "capabilities" ? capabilitiesCheck : injectionCheck;
    try {
      const result = await check.run({ input: { textFiles: unzipped.textFiles, fileCount: unzipped.fileCount, extractedBytes: 0 }, at });
      refreshed.add(id);
      replaceRow(nextChecks, result.check);
      nextFindings.push(...result.findings);
      if (result.capabilities) repairedCapabilities = result.capabilities;
    } catch (e) {
      // Same rule as `scanArtifact`'s: the row says what happened to it, and the queue
      // will find it again tomorrow.
      replaceRow(nextChecks, { ...(report.checks.find((c) => c.id === id) as ScanCheck), status: "unavailable", findings: 0, reason: `${CHECK_FAILED}: ${message(e)}`, at });
      notes.push(`${id} still failing: ${message(e)}`);
    }
  }

  // Everything the rescan did not touch, in the order it was in: secrets, limits,
  // capabilities, injection, and any dependency row that could not be refreshed today.
  const preserved = report.findings.filter((f) => !refreshed.has(f.check));
  const findings = [...preserved, ...nextFindings];

  const next: ScanReport = {
    ...report,
    // §12, and the whole point of §7: neither of these is written here.
    verdict: report.verdict,
    scanned_at: report.scanned_at,
    checks: nextChecks,
    findings,
    ...(repairedCapabilities ? { capabilities: repairedCapabilities } : {}),
    counts: {
      secrets: findings.filter((f) => f.kind === "secret").length,
      vulnerabilities: findings.filter((f) => f.kind === "vulnerability").length,
      blocking: findings.filter((f) => f.blocking).length,
      disclosed: findings.filter((f) => f.tier === "disclosed").length,
      review: findings.filter((f) => f.tier === "review").length,
    },
    checked: nextChecks.filter((c) => c.status !== "unavailable").map((c) => c.id),
    packages_scanned: osvRan ? refresh.packages : report.packages_scanned,
    advisories_refreshed_at: at,
    ...(osvError ? { osv_error: osvError } : {}),
    ...(socketRan && refresh.unmatchedFiles && refresh.unmatchedFiles.length > 0 ? { socket_unmatched_files: refresh.unmatchedFiles } : {}),
  };
  // An OSV run that succeeded clears the error a previous run recorded.
  if (osvRan) delete next.osv_error;

  const { error: writeError } = await db()
    .from("release")
    .update({ scan_report: next, manifest: withRefreshedScan(release.manifest, next) })
    .eq("id", release.id);
  if (writeError) throw writeError;

  // --- §7 / §10 Q2: a would-have-blocked finding on a release that passed.
  //
  // Raised on the *transition* only — and a transition is a **new identity**, not a new
  // boolean (fixed 13 Sep 2026). `already = wouldHaveBlocked(report.findings).length > 0`
  // meant the first MAL- record a release ever carried silenced every one after it: night 1
  // fires for `pkg-a`, night 8 a second dependency turns out to be malware and nothing at
  // all happens, because something was already there. A release that acquires a second
  // piece of malware is precisely the release somebody needs telling about. The set below
  // is compared member by member, and the notice names only what is new; a compromised
  // release still does not re-announce the same package every night, which is what the
  // boolean was for.
  const previouslyBlocking = blockingIdentities(report.findings);
  const compromising = wouldHaveBlocked(findings).filter((f) => !previouslyBlocking.has(identityOf(f)));
  const compromised = release.scan === "pass" && compromising.length > 0;

  if (compromised) {
    const props = {
      version: release.version,
      release_id: release.id,
      packages: compromising.map((f) => [f.package?.ecosystem, f.package?.name, f.package?.version].filter(Boolean).join("@")).filter(Boolean),
      // Injection findings are excluded rather than folded in under the `?? [f.rule_id]`
      // fallback: `hidden-unicode-tags` is a rule of ours and calling it an advisory id
      // would send a reader to OSV looking for a record that does not exist.
      advisory_ids: [...new Set(compromising.filter((f) => f.check !== "injection").flatMap((f) => f.advisory_ids ?? [f.rule_id]))],
      // What fired and where (14 Sep 2026). §4.4 governs what a *buyer* is shown; this is
      // the operator's audit trail, and a hidden-Unicode notice with no path in it is a
      // notice nobody can act on. The webhook below gets the rule ids without the path.
      rules: compromising.map((f) => ({ rule_id: f.rule_id, ...(f.path ? { path: f.path } : {}) })),
      sources: [...new Set(compromising.map((f) => f.source ?? f.check))],
      // The verdict this release keeps. Named in the event so the log cannot be read as a
      // record of a flip that never happened.
      verdict: release.scan,
    };
    await (deps.recordEvent ?? record)({ name: "release_compromised", listingId: release.listing_id, props });
    // FR-41's delivery is best effort and returns why rather than throwing — which is only
    // useful if somebody reads it. Before 13 Sep 2026 the result was dropped on the floor,
    // so a creator whose endpoint had been 500ing for a month looked exactly like a creator
    // who had been told. It goes in the run's summary, which the cron records as an event.
    const sent = await (deps.sendWebhook ?? sendAbuseWebhook)({
      event: "release.compromised",
      listingId: release.listing_id,
      version: release.version,
      code: compromiseCode(compromising),
    });
    if (!sent.delivered) notes.push(`release.compromised webhook not delivered: ${sent.reason ?? "unknown"}`);
  }

  return {
    status: "rescanned",
    ...(weakerSet ? { reason: notes[0] } : osvError ? { reason: `osv rows kept: ${osvError}` } : {}),
    ...(notes.length > 0 ? { notes } : {}),
    compromised,
    socketRan,
    socketResumed: refresh.socketResumed,
    osvRan,
    report: next,
  };
}

/**
 * The findings §7 calls a takedown question rather than a scan question: an OSV `MAL-`
 * record, a Socket `malware` alert, and — since the backfill, 14 Sep 2026 — a **blocking
 * injection finding**.
 *
 * The third is new only because the check is. Nothing before scanner 2026.09 ran
 * `injection`, so every listing cut before it carries `unavailable · predates` and the
 * backfill is the first time anybody has read those words. Hidden Unicode tag characters
 * and a non-orthographic zero-width run are `tier: "blocking"` at cut time (§4.1, §6.1) —
 * a release carrying one does not ship — so finding one on a release that *did* ship is
 * the same sentence as finding malware in its dependencies, and it gets the same notice
 * and the same §10 Q2 answer: a human decides, nothing is paused here.
 *
 * The vendored downgrade keeps a dependency's README out of it without a rule of its own:
 * a hit under `node_modules/` is `-vendored`, `disclosed` and not `blocking`, so it never
 * reaches this filter.
 */
function wouldHaveBlocked(findings: readonly ScanFinding[]): ScanFinding[] {
  return findings.filter(
    (f) => f.blocking && (f.check === "known_malware" || f.check === "injection" || (f.check === "dep_behaviour" && f.rule_id === "malware")),
  );
}

/**
 * FR-41's `code`, built from what actually fired.
 *
 * The body FR-41 signs has six keys and none of them is a list, so `code` is the only place
 * a notice can say *which* rule (14 Sep 2026). `dependency_malware` is unchanged and still
 * stands alone for the OSV/Socket half — a receiver that has been parsing it since 13 Sep
 * keeps working. An injection finding adds `instruction_smuggling:` and the rule ids that
 * fired, joined: **ids only, never the path** (§4.4), because the path is the recipe and
 * this body goes to a creator-supplied URL over the open internet.
 */
function compromiseCode(findings: readonly ScanFinding[]): string {
  const parts: string[] = [];
  if (findings.some((f) => f.check !== "injection")) parts.push("dependency_malware");
  const rules = [...new Set(findings.filter((f) => f.check === "injection").map((f) => f.rule_id))].sort();
  if (rules.length > 0) parts.push(`instruction_smuggling:${rules.join("+")}`);
  return parts.join(",");
}

/**
 * What makes one would-have-blocked finding the *same* one as another: the rule that fired
 * and the thing it fired on. The advisory id is the rule id for an OSV record (`MAL-…`)
 * and the alert slug for Socket (`malware`), so the pair is unambiguous either way, and a
 * package with no version still has a stable identity under its own name. An injection
 * finding has no package and its subject is the file — `zero-width-run|SKILL.md` — which is
 * what makes a second smuggled file on the same release a second notice rather than silence.
 */
function identityOf(finding: ScanFinding): string {
  const pkg = finding.package;
  const subject = pkg ? `${pkg.ecosystem}/${pkg.name}${pkg.version ? `@${pkg.version}` : ""}` : (finding.path ?? "");
  return `${finding.rule_id}|${subject}`;
}

/** The identities that would have blocked on a report, for the transition test above. */
function blockingIdentities(findings: readonly ScanFinding[]): Set<string> {
  return new Set(wouldHaveBlocked(findings).map(identityOf));
}

/**
 * The `capabilities` / `injection` rows a run may simply re-run. Both are pure functions of
 * bytes that have not changed, so the retry is free of anybody else's uptime — the only
 * question is which `unavailable` rows are worth spending an inflate-every-file read on.
 *
 * **Nightly**: only `check failed: …`, the mark `scanArtifact`'s catch leaves when a module
 * threw. That is a bug of ours and the one kind of gap a cron can close on its own; a row
 * that says `predates scanner 2026.09` is not a bug, and re-reading every archive on the
 * platform every night on the off-chance is not what a nightly is for.
 *
 * **Backfill** (14 Sep 2026): every `unavailable` row, whatever its reason. That is the
 * whole point of the mode — `predates` is precisely the row the operator is trying to fill,
 * and `not wired` and `check failed` are the same blank section to a reader of the page. A
 * row that ran and answered is left alone in both modes: re-running a `pass` over identical
 * bytes can only produce the same answer with a newer timestamp on it.
 */
function pureChecksToRepair(report: ScanReport, backfill = false): ScanCheckId[] {
  return report.checks
    .filter(
      (c) =>
        (c.id === "capabilities" || c.id === "injection") && c.status === "unavailable" && (backfill || (c.reason ?? "").startsWith(CHECK_FAILED)),
    )
    .map((c) => c.id);
}

/**
 * The SBOM the cut stored, off `manifest.computed.dependencies` — the resolved graph
 * `cutRelease` handed `scanArtifact` as `sbomPackages`, in the same shape
 * (`{name, version?, ecosystem}`). Empty when the manifest predates it or does not parse,
 * and the caller falls back to the manifests in the zip exactly as a cut does.
 */
export function sbomFromManifest(manifest: unknown): OsvPackage[] {
  if (!manifest || typeof manifest !== "object") return [];
  const computed = (manifest as { computed?: unknown }).computed;
  if (!computed || typeof computed !== "object") return [];
  const list = (computed as { dependencies?: unknown }).dependencies;
  if (!Array.isArray(list)) return [];

  const out: OsvPackage[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const { name, version, ecosystem } = entry as { name?: unknown; version?: unknown; ecosystem?: unknown };
    if (typeof name !== "string" || name === "" || typeof ecosystem !== "string" || ecosystem === "") continue;
    out.push({ name, ecosystem, ...(typeof version === "string" && version !== "" ? { version } : {}) });
  }
  return out;
}

/** A Socket row that can be finished from its id instead of re-uploaded (1 unit, not 7). */
function resumableScanId(check: ScanCheck | undefined): string | undefined {
  if (!check?.socket_scan_id) return undefined;
  if (check.status === "partial") return check.socket_scan_id;
  if (check.status === "unavailable" && (check.reason ?? "").startsWith(SOCKET_REASONS.processing)) return check.socket_scan_id;
  return undefined;
}

function replaceRow(checks: ScanCheck[], row: ScanCheck): void {
  const index = checks.findIndex((c) => c.id === row.id);
  if (index === -1) checks.push(row);
  else checks[index] = row;
}

/**
 * `manifest.computed.scan`, republished from the refreshed report.
 *
 * `verdict`, `scanner_version` and `at` survive the spread untouched — they are cut-time
 * facts and §7 does not move them. `checks` and `findings` go through `publicChecks` /
 * `publishedFindings` because this blob is the public one: no secret, no injection match
 * text, no `socket_scan_id` (§4.4) — and, since 14 Sep 2026, no 418 identical
 * `networkAccess` lines either. `manifestScan` in lib/release writes it the same way, and
 * the backfill that produced those 418 is exactly the run that has to fix them.
 *
 * A manifest that has no `computed.scan` block is left exactly as it is rather than grown
 * one. Those are pre-report rows and inventing half a manifest for them would be worse
 * than the honest absence the page already handles.
 */
export function withRefreshedScan(manifest: unknown, report: ScanReport): unknown {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return manifest;
  const root = manifest as Record<string, unknown>;
  const computed = root.computed;
  if (!computed || typeof computed !== "object" || Array.isArray(computed)) return manifest;
  const block = (computed as Record<string, unknown>).scan;
  if (!block || typeof block !== "object" || Array.isArray(block)) return manifest;

  return {
    ...root,
    computed: {
      ...(computed as Record<string, unknown>),
      scan: {
        ...(block as Record<string, unknown>),
        checks: publicChecks(report),
        findings: publishedFindings(report),
        // `publicCounts`, not `report.counts` (fixed 13 Sep 2026). The internal counts have
        // five keys and two of them — `secrets` and `vulnerabilities` — are the creator's;
        // republishing them here wrote a `secrets: 1` onto public JSON and grew a manifest
        // that the cut had written correctly two keys the schema does not have. One helper,
        // shared with `manifestScan` in lib/release, so the two writers cannot drift again.
        counts: publicCounts(report),
        // The inventory itself, not only its findings (fixed 14 Sep 2026: the first
        // backfill published seventeen capability findings and a `capabilities` block of
        // null, so the page had "listed below" and nothing to list under "What this can
        // do"). `manifestScan` in lib/release writes it the same way.
        ...(report.capabilities ? { capabilities: report.capabilities } : {}),
        advisories_refreshed_at: report.advisories_refreshed_at,
      },
    },
  };
}

/** `normalizeReport`, but a blob that is neither v1 nor v2 is null rather than a throw. */
function liftReport(value: unknown): ScanReport | null {
  if (!value || typeof value !== "object") return null;
  try {
    const lifted = normalizeReport(value as Parameters<typeof normalizeReport>[0]);
    return lifted && Array.isArray(lifted.checks) && Array.isArray(lifted.findings) ? lifted : null;
  } catch {
    return null;
  }
}

// --- the two queues ------------------------------------------------------------

export type RescanQueue = "repair" | "refresh" | "backfill";

/** Which run this is: the nightly cron, or the operator's `?mode=backfill` (14 Sep 2026). */
export type RescanMode = "nightly" | "backfill";

export type RescanCandidate = {
  release: ReleaseRow;
  queue: RescanQueue;
  /** `advisories_refreshed_at ?? scanned_at`, as epoch ms. Oldest first, so nothing starves. */
  since: number;
  /** Whether Socket is owed a call: always on a repair, weekly on a refresh. */
  socketDue: boolean;
};

/**
 * §7's two queues, in order.
 *
 * 1. **Repairs** — every release whose `dep_behaviour` row is `unavailable` or `partial`,
 *    at any verdict except `fail` (a failed release has no bytes). That includes every row
 *    written before Socket existed, which carries `reason: "not wired"` or
 *    `"predates scanner 2026.09"` — a badge that says what it did not do is exactly the
 *    thing this queue exists to turn into a badge that did it.
 * 2. **Refresh** — the latest passing release of every live listing. OSV nightly, Socket
 *    only when its row is over a week old.
 *
 * The `dep_behaviour` row lives inside a jsonb column, so the selection is done here rather
 * than in the query: PostgREST could express it, the mock DB the tests use could not, and a
 * predicate that only exists in production is a predicate nothing checks.
 */
export async function rescanQueues(now: number = Date.now()): Promise<RescanCandidate[]> {
  const client = db();

  const [releaseRes, listingRes] = await Promise.all([
    client
      .from("release")
      .select("*")
      .neq("scan", "fail")
      .not("storage_path", "is", null)
      .order("created_at", { ascending: false })
      .limit(RESCAN_RELEASE_LIMIT),
    client.from("listing").select("id").is("retired_at", null).not("published_at", "is", null).limit(RESCAN_LISTING_LIMIT),
  ]);
  if (releaseRes.error) throw releaseRes.error;
  if (listingRes.error) throw listingRes.error;

  const releases = (releaseRes.data as ReleaseRow[] | null) ?? [];
  const live = new Set(((listingRes.data as { id: string }[] | null) ?? []).map((l) => l.id));

  const repairs: RescanCandidate[] = [];
  const refresh: RescanCandidate[] = [];
  const queued = new Set<string>();

  for (const release of releases) {
    const report = liftReport(release.scan_report);
    if (!report) continue;
    const dep = report.checks.find((c) => c.id === "dep_behaviour");
    const socketOwed = dep?.status === "unavailable" || dep?.status === "partial";
    // …and the two pure rows whose module threw. A `check failed` row is a bug of ours, not
    // a vendor's, and it is the one kind of gap a rescan can close on its own.
    if (!socketOwed && pureChecksToRepair(report).length === 0) continue;
    repairs.push({ release, queue: "repair", since: sortKey(report), socketDue: socketOwed });
    queued.add(release.id);
  }

  // `releases` is newest-first, so the first `pass` seen for a listing is its latest.
  const latestPassing = new Map<string, ReleaseRow>();
  for (const release of releases) {
    if (release.scan !== "pass" || !live.has(release.listing_id)) continue;
    if (!latestPassing.has(release.listing_id)) latestPassing.set(release.listing_id, release);
  }
  for (const release of latestPassing.values()) {
    if (queued.has(release.id)) continue;
    const report = liftReport(release.scan_report);
    if (!report) continue;
    const dep = report.checks.find((c) => c.id === "dep_behaviour");
    const socketDue = !dep?.at || now - Date.parse(dep.at) > RESCAN_SOCKET_MAX_AGE_MS;
    refresh.push({ release, queue: "refresh", since: sortKey(report), socketDue });
  }

  const oldestFirst = (a: RescanCandidate, b: RescanCandidate) => a.since - b.since;
  return [...repairs.sort(oldestFirst), ...refresh.sort(oldestFirst)];
}

/**
 * The backfill's queue (14 Sep 2026): **every live listing's latest passing release**, or
 * one listing's when the operator named it.
 *
 * It is the refresh queue's population and not its rules. There is no cadence to respect
 * (`socketDue` is always true) and no repair/refresh split to make, because a backfill does
 * to every release what the repair queue does to a broken one — which is the difference
 * that matters: `rescanQueues` deliberately skips a `predates` row, and this is the run that
 * exists because that skip left `capabilities` and `injection` blank on every listing cut
 * before scanner 2026.09.
 *
 * A named listing is taken whether or not it is live. `retired_at` is a selling decision and
 * an operator who typed the path meant that listing; the unnamed sweep keeps the live filter,
 * because "every listing we ever had" is not what "every current live listing" means.
 *
 * A release with no readable report is queued anyway, unlike on the nightly, so it arrives in
 * the summary as `skipped: no scan report` rather than vanishing from a run somebody is
 * watching.
 */
export async function backfillQueue(listingId?: string): Promise<RescanCandidate[]> {
  const client = db();

  let query = client.from("release").select("*").eq("scan", "pass").not("storage_path", "is", null);
  if (listingId) query = query.eq("listing_id", listingId);
  const releaseRes = await query.order("created_at", { ascending: false }).limit(RESCAN_RELEASE_LIMIT);
  if (releaseRes.error) throw releaseRes.error;
  const releases = (releaseRes.data as ReleaseRow[] | null) ?? [];

  let live: Set<string> | null = null;
  if (!listingId) {
    const listingRes = await client.from("listing").select("id").is("retired_at", null).not("published_at", "is", null).limit(RESCAN_LISTING_LIMIT);
    if (listingRes.error) throw listingRes.error;
    live = new Set(((listingRes.data as { id: string }[] | null) ?? []).map((l) => l.id));
  }

  // Newest-first, so the first `pass` seen for a listing is its latest — the same rule the
  // refresh queue uses, and the same release the listing is selling.
  const latest = new Map<string, ReleaseRow>();
  for (const release of releases) {
    if (live && !live.has(release.listing_id)) continue;
    if (!latest.has(release.listing_id)) latest.set(release.listing_id, release);
  }

  const candidates: RescanCandidate[] = [...latest.values()].map((release) => {
    const report = liftReport(release.scan_report);
    return { release, queue: "backfill", since: report ? sortKey(report) : 0, socketDue: true };
  });
  return candidates.sort((a, b) => a.since - b.since);
}

/**
 * `owner/slug` → the listing id, resolved the way `loadListingByPath` (lib/web/loaders.ts)
 * resolves the page: the handle is the creator, and the slug is unique within that creator.
 * Only the id is wanted here, so neither the listing row nor its releases are carried back —
 * the queue re-reads what it needs.
 *
 * Null for a malformed path, an unknown handle and an unknown slug alike. The operator gets
 * one 404 either way; which of the two halves was wrong is not a fact worth confirming to
 * whoever is holding the cron token.
 */
export async function listingIdByPath(path: string): Promise<string | null> {
  const [owner, slug, ...rest] = path.split("/");
  if (!owner || !slug || rest.length > 0) return null;

  const client = db();
  const { data: creatorData, error: creatorError } = await client.from("creator").select("id").eq("handle", owner.toLowerCase()).maybeSingle();
  if (creatorError) throw creatorError;
  const creator = creatorData as { id: string } | null;
  if (!creator) return null;

  const { data, error } = await client.from("listing").select("id").eq("creator_id", creator.id).eq("slug", slug).maybeSingle();
  if (error) throw error;
  return (data as { id: string } | null)?.id ?? null;
}

function sortKey(report: ScanReport): number {
  const value = Date.parse(report.advisories_refreshed_at ?? report.scanned_at ?? "");
  return Number.isFinite(value) ? value : 0;
}

// --- the run --------------------------------------------------------------------

export type RescanSummary = {
  ran_at: string;
  /** Which run this was. `nightly` unless the operator asked for `?mode=backfill`. */
  mode: RescanMode;
  queued: number;
  repaired: number;
  refreshed: number;
  compromised: number;
  /** Releases whose Socket call was owed and not made — quota floor, or no token. */
  socket_skipped: number;
  skipped: { release_id: string; listing_id: string; version: string; reason: string }[];
  errors: { release_id: string; listing_id: string; version: string; error: string }[];
  /** Why the run stopped early, or why Socket stopped. One sentence each, for the log. */
  notes: string[];
  /**
   * Only on a single-listing backfill: the refreshed rows, `publicChecks`-filtered, so the
   * `curl` that triggered the run shows what it produced instead of a count to go and look
   * up. `socket_scan_id` is stripped exactly as it is on the manifest (§4.4) — this body
   * goes wherever the operator's terminal scrollback goes.
   */
  public_checks?: { release_id: string; version: string; checks: Omit<ScanCheck, "socket_scan_id">[] };
};

export type RunRescanOptions = RescanDeps & {
  budgetMs?: number;
  /** `backfill` swaps the queue and sets {@link RescanDeps.backfill} on every release. */
  mode?: RescanMode;
  /** Backfill only: one listing instead of all of them. Already resolved from `owner/slug`. */
  listingId?: string;
};

export async function runRescan(deps: RunRescanOptions = {}): Promise<RescanSummary> {
  const nowFn = deps.now ?? Date.now;
  const started = nowFn();
  const budget = deps.budgetMs ?? RESCAN_BUDGET_MS;
  const mode: RescanMode = deps.mode ?? "nightly";
  const backfill = mode === "backfill";

  const candidates = backfill ? await backfillQueue(deps.listingId) : await rescanQueues(started);
  const summary: RescanSummary = {
    ran_at: new Date(started).toISOString(),
    mode,
    queued: candidates.length,
    repaired: 0,
    refreshed: 0,
    compromised: 0,
    socket_skipped: 0,
    skipped: [],
    errors: [],
    notes: [],
  };

  // A token supplied through `deps.socket` beats the environment, so a test never needs one.
  const socketAvailable = Boolean(deps.socket?.token && deps.socket?.orgSlug) || socketConfigured();
  if (!socketAvailable) summary.notes.push("SOCKET_TOKEN_VALUE / SOCKET_ORG_SLUG are not set; the dependency-behaviour rows were left alone.");
  let quotaFloorHit = false;

  for (const [index, candidate] of candidates.entries()) {
    // The reservation, not merely the reading: a release is started only when the budget
    // has room for a whole one of them (§7, {@link RESCAN_RELEASE_BUDGET_MS}). Checking
    // `elapsed > budget` alone let the loop begin a release at 249 s of 250.
    if (nowFn() - started > budget - RESCAN_RELEASE_BUDGET_MS) {
      summary.notes.push(`Stopped after ${Math.round((nowFn() - started) / 1000)}s with ${candidates.length - index} releases still queued; resumes tomorrow.`);
      break;
    }

    let socketEnabled = socketAvailable && candidate.socketDue && !quotaFloorHit;
    if (socketEnabled) {
      // Free, so it runs before every call rather than once per run: the window can be
      // spent by a cut happening while this loop is running.
      const quota = await socketQuota(deps.socket);
      if (quota && quota.maxQuota > 0 && quota.quota / quota.maxQuota < RESCAN_SOCKET_QUOTA_FLOOR) {
        quotaFloorHit = true;
        socketEnabled = false;
        summary.notes.push(
          `Socket quota is under ${Math.round(RESCAN_SOCKET_QUOTA_FLOOR * 100)}% of the window (${quota.quota}/${quota.maxQuota}); Socket is skipped for the rest of the run and OSV continued.`,
        );
      }
    }
    if (candidate.socketDue && !socketEnabled) summary.socket_skipped += 1;

    const { release } = candidate;
    try {
      const result = await rescanRelease(release, {
        ...deps,
        backfill,
        socketEnabled,
        socketDue: candidate.socketDue,
        // One release's share of the run, so a slow Socket costs a night and not a queue.
        deadlineMs: Math.min(nowFn() + RESCAN_RELEASE_BUDGET_MS, started + budget),
      });
      for (const note of result.notes ?? []) summary.notes.push(`${release.listing_id} v${release.version}: ${note}`);
      // The rows this run produced, when the operator asked about one listing — and the
      // stored ones when it skipped, because "here is what the page says now" is still the
      // answer to the question that was asked.
      if (backfill && deps.listingId) {
        const report = result.report ?? liftReport(release.scan_report);
        if (report) summary.public_checks = { release_id: release.id, version: release.version, checks: publicChecks(report) };
      }
      if (result.status === "skipped") {
        summary.skipped.push({ release_id: release.id, listing_id: release.listing_id, version: release.version, reason: result.reason ?? "skipped" });
        continue;
      }
      if (candidate.queue === "repair") summary.repaired += 1;
      else summary.refreshed += 1;
      if (result.compromised) summary.compromised += 1;
    } catch (e) {
      // One release's bad day is a line in the summary, never the end of the run.
      summary.errors.push({ release_id: release.id, listing_id: release.listing_id, version: release.version, error: message(e) });
    }
  }

  return summary;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
