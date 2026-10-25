/**
 * lib/scan — FR-35, the gate every release passes before it can be sold, and (since
 * "PRD Trust Report.md", accepted 13 Sep 2026) the trust report every listing publishes.
 *
 * `scanArtifact` produces a report **v2** (`lib/scan/report.ts` — the contract): one row
 * per check in `checks[]`, ran or not, and findings in three tiers. The rows produced
 * here are the ones that need no vendor and no new call:
 *
 * 1. **`secrets`** — a ported subset of the gitleaks ruleset over the bytes that ship.
 * 2. **`limits`** — §6's 200 MB / 20,000 files, re-asserted here so the verdict is
 *    self-contained even if the snapshot path changes, plus the whole-repo secret-scan
 *    CPU guard (W3.1).
 * 3. **`known_vulns`** — OSV advisories over the manifests and lockfiles inside the snapshot
 *    — the commit being sold — with GitHub's SBOM allowed only to add packages they do not
 *    name (SCAN-2, {@link dependencyInventory}).
 * 4. **`known_malware`** — the *same* OSV query, split off by the `MAL-` prefix
 *    (`ossf/malicious-packages`). No second call; see lib/scan/osv.ts.
 *
 * The other three rows the contract names — `capabilities`, `injection` and
 * `dep_behaviour` (Socket) — come from their own modules through `ScanDeps.extraChecks`
 * (below). {@link defaultExtraChecks} is the set a real cut passes, and `cutRelease` is
 * the caller. A row whose module was not passed is still on the report, `unavailable`
 * with a reason: a report that omitted it would be a badge that quietly does not say what
 * it did not do, which is the whole complaint of "PRD Trust Report.md" §1.
 *
 * Nothing here executes a line of creator code (NG6).
 *
 * **What blocks (§4.1).** Any secret · any dependency vulnerability rated HIGH or
 * CRITICAL at a pinned version · any §6 cap · a dependency with an OSV `MAL-` record.
 * MODERATE, LOW and UNKNOWN CVEs are `disclosed`: they sell, and they are shown — hiding
 * them was §1(3). So is a HIGH/CRITICAL CVE found without a version (see `osvFinding`).
 * The HIGH/CRITICAL threshold is documented rather than tuned, and the reasoning is in
 * DECISIONS.md: a MODERATE-fails rule would fail most real repositories on transitive
 * dependencies the creator cannot reach, and a gate that always fires teaches people to
 * ignore it.
 *
 * A failing release is `fail`; the listing keeps selling its last passing release, and
 * there is no override in V0. The failed snapshot's bytes are deleted once the report
 * is stored — that is the caller's job (lib/release), because only the caller knows
 * the report was persisted first.
 */

import { hashApiKey, revokeApiKeyByHash } from "@/lib/auth/api-key";
import { MAX_EXTRACTED_BYTES, MAX_FILES } from "@/lib/analysis";
import { stripNul } from "@/lib/analysis/files";
import { inventoryCapabilities } from "./capabilities";
import { scanInjection } from "./injection";
import {
  type FetchLike,
  type OsvPackage,
  type OsvVulnerability,
  dedupePackages,
  isManifestPath,
  manifestFilesOf,
  packagesFromFiles,
  queryOsv,
} from "./osv";
import {
  SCAN_CHECK_IDS,
  type Capabilities,
  type ScanCheck,
  type ScanCheckId,
  type ScanCheckStatus,
  type ScanFinding,
  type ScanReport,
} from "./report";
import { type SecretFinding, ownApiKeysIn, scanSecrets } from "./secrets";
import {
  SOCKET_REASONS,
  type SocketDeps,
  type SocketScanResult,
  deleteSocketScan,
  readSocketScan,
  socketConfigured,
  socketFullScan,
} from "./socket";

export * from "./capabilities";
export * from "./injection";
export * from "./osv";
export * from "./report";
export * from "./secrets";
export * from "./socket";

/**
 * FR-37: the buyer-facing badge carries this. Bump it when a rule changes.
 *
 * `2026.09.1` is report v2 and the `MAL-` rule ("PRD Trust Report.md" §9, phase 0/1).
 * A badge from `2026.08.1` is a scan that could not see a known-malicious dependency,
 * and `normalizeReport` says so in words rather than lifting it silently.
 *
 * `2026.10.1` is SCAN-1 and SCAN-2: a NUL byte no longer hides a file from the scan, and
 * the dependency rows describe the commit being sold rather than the default branch.
 */
export const SCANNER_VERSION = "2026.10.1";

/** Severities that fail a release. See the module note and DECISIONS.md. */
export const BLOCKING_SEVERITIES = new Set(["HIGH", "CRITICAL"]);

/**
 * The reason prefix a row carries when its module threw rather than returning a row
 * (13 Sep 2026). Read by §7's repair queue, which re-runs the two pure checks —
 * `capabilities` and `injection` — over the stored bytes on the next night, because a
 * function of bytes that did not change is a bug we can retry, not a vendor we must wait on.
 */
export const CHECK_FAILED = "check failed";

/**
 * W3.1: whole-repo CPU guard for secret scanning. The scanner reads the full bytes of
 * every file (no per-file cap that would fail closed on a benign large asset), so the
 * only bound is a repo-wide one — set to the extracted-bytes cap, i.e. the whole repo.
 * A snapshot can never exceed it under normal operation (`snapshot()` already caps
 * `extractedBytes` at `MAX_EXTRACTED_BYTES`); it is a defensive backstop that fails
 * closed with an `unscannable` finding rather than pretending a too-large repo was clean.
 */
export const MAX_SECRET_SCAN_BYTES = MAX_EXTRACTED_BYTES;

export type ScanInput = {
  /** Decoded text of the snapshot, for dependency-manifest parsing. Binary files absent. */
  textFiles: Map<string, string>;
  /**
   * W3.1: full lenient-UTF-8 decode of the bytes of **every** file that ships — binary
   * included, never truncated. When present, this is what the secret scanner reads (the
   * bytes actually sold), so a secret behind a NUL byte or past 4 MB is still caught. When
   * absent, secret scanning falls back to `textFiles` (back-compat for callers/tests that
   * do not yet supply it).
   */
  secretScanFiles?: Map<string, string>;
  /** Total bytes represented by `secretScanFiles`, checked against the whole-repo CPU guard. */
  secretScanBytes?: number;
  /** Override the whole-repo secret-scan CPU guard (default {@link MAX_SECRET_SCAN_BYTES}). */
  maxSecretScanBytes?: number;
  fileCount: number;
  extractedBytes: number;
  /**
   * Packages from GitHub's SBOM (§14.4) — a **supplement**, never the authority (SCAN-2).
   * The endpoint takes no ref and describes the default branch, not the commit being sold,
   * so only a package the snapshot's own manifests do not name at all is added from here.
   * See {@link dependencyInventory}.
   */
  sbomPackages?: OsvPackage[];
  /**
   * Every file that ships, with the shape the snapshot recorded. Nothing here reads it;
   * it is carried for the extra checks — `capabilities` needs the whole path list, not
   * just the decodable one, to see an executable under `bin/` (§4.3).
   */
  files?: readonly { path: string; size: number; executable?: boolean; binary?: boolean }[];
  /**
   * The re-packed zip's bytes — `SnapshotResult.bytes`, the bytes that were hashed. Only
   * a check that uploads the artifact needs them (Socket's archive endpoint, §6.2), and
   * uploading *these* bytes is what binds its result to `artifact_sha256` (D3, §6).
   */
  artifactBytes?: Uint8Array;
  /**
   * FR-42: the listing **id**, never the slug — Socket's `repo` has to be immutable, and
   * a slug is not. Optional because every check but Socket is a function of the bytes
   * alone; a cut always supplies it.
   */
  listingId?: string;
  /** The bare version, `1.2.0`. Socket's `branch` is `v${version}` and it adds the `v`. */
  version?: string;
  /** The resolved commit, for Socket's `commit_hash`. */
  commitSha?: string;
  /**
   * The step-1′ upload set (§6.2), when the caller already holds a better one than
   * `manifestFilesOf(textFiles)` can derive. A cut leaves this unset: its `textFiles` is the
   * whole decoded snapshot and the §6.2 rule is that we upload exactly the files
   * `packagesFromFiles` parses, so the two can never disagree about what a manifest is. The
   * §7 rescan sets it: it reads the stored zip for manifests *and* the lockfiles beside them
   * (`readArtifactTextFiles`, lib/scan/rescan.ts), which is a wider set than our own parser reads
   * and is the set Socket wants when an archive is over its 10,000-file extraction limit.
   */
  socketManifestFiles?: Map<string, string>;
};

/**
 * What an extra check is handed. `at` is the report's own timestamp, so rows agree, and
 * `deadlineMs` is the absolute epoch millisecond the whole scan must be finished by — a
 * vendor check spends what is left of it and no more (see {@link ScanDeps.deadlineMs}).
 */
export type ExtraCheckInput = { input: ScanInput; at: string; deadlineMs?: number };

/**
 * What an extra check gives back: its own row, its findings, and — for `capabilities` —
 * the inventory block (§4.3). `check.id` decides which placeholder row it replaces, so
 * a module owns exactly one row and cannot invent an eighth.
 */
export type ExtraCheckResult = { check: ScanCheck; findings: ScanFinding[]; capabilities?: Capabilities };

/**
 * A check declares its `id` **before** it runs, not only inside the row it returns
 * (13 Sep 2026).
 *
 * The reason is the throw. A module that threw used to leave the placeholder exactly as it
 * was — `reason: "not wired"`, which is the sentence for a check nobody passed — and there
 * was nothing in hand to correct it with, because the only place the id had ever appeared
 * was the row that never arrived. With the id declared up front the catch writes
 * `unavailable · check failed: …` on the right row, the badge says what happened, and §7's
 * repair queue can find it again and re-run it.
 */
export type ExtraCheck = { id: ScanCheckId; run: (input: ExtraCheckInput) => Promise<ExtraCheckResult> };

// --- the three adapters ("PRD Trust Report.md" §9, phases 2a and 2b) -------------------
//
// Each module stays a pure function of its own inputs and knows nothing about `ScanInput`;
// the adapter is the twenty lines that translate. Keeping them here rather than inside the
// modules is what lets `lib/scan/capabilities.ts` be tested on a bare `Map` and Socket be
// tested on a recorded NDJSON stream with no scan input anywhere in sight.

/**
 * §4.3. The whole path list, not just the decodable one — an executable under `bin/` need
 * not decode as text to be a thing that runs. `at` is overridden so every row on one report
 * carries one time.
 */
export const capabilitiesCheck: ExtraCheck = {
  id: "capabilities",
  run: async ({ input, at }) => {
    const inventory = inventoryCapabilities({
      // SCAN-1: a NUL in a package.json made `JSON.parse` refuse it and "nothing runs at
      // install" print over a postinstall hook. A snapshot's text has none; the §7 repair
      // path hands over the archive's raw decode, so they are taken out here as well.
      textFiles: withoutNul(input.textFiles),
      paths: input.files ? input.files.map((f) => f.path) : [...input.textFiles.keys()],
    });
    return { check: { ...inventory.check, at }, findings: inventory.findings, capabilities: inventory.capabilities };
  },
};

/**
 * §6.1's injection row. Reads the artifact's own words.
 *
 * **Both maps, and the difference matters** (13 Sep 2026). `textFiles` is truncated at
 * `MAX_SCANNED_FILE_BYTES` by `snapshot()` — a 6 MB SKILL.md arrives with 4 MB of itself —
 * so the blocking hidden-Unicode pass reads `secretScanFiles`, the untruncated decode of
 * every byte that ships, exactly as the secret scanner does and for the same reason: a
 * payload past the cap is still a payload. `textFiles` remains the file *selection*, since
 * that is the set the snapshot decided is text.
 */
export const injectionCheck: ExtraCheck = {
  id: "injection",
  run: async ({ input, at }) => {
    const { findings, check } = scanInjection(input.textFiles, { at, untruncatedFiles: input.secretScanFiles });
    return { check, findings };
  },
};

/**
 * The one place Socket is called from — cut time through {@link socketCheck}, §7's rescan
 * through {@link dependencyChecks}. Both paths want the same row built from the same input,
 * and the rescan additionally wants the repair path, so it lives here rather than in two
 * copies (13 Sep 2026 reconciliation; the second copy was in lib/scan/rescan.ts).
 *
 * `deps.now` defaults to the report's own timestamp so the row's `at` and the `tool_version`
 * Socket derives from it (§4.2: a feed's version is the day it was read) agree with every
 * other row rather than landing a millisecond — or a midnight — apart.
 *
 * **The repair path (§7).** With `resumeScanId`, a row left at `socket processing` (or
 * `partial`) is finished from the id it stored: one GET, 1 unit instead of 7. The delete is
 * issued here once the read is terminal — `readSocketScan` leaves it to its caller precisely
 * so a still-`partial` scan can be re-read tomorrow from the same id. A resume that comes
 * back `socket error` — by prefix, since the reason now names the status — is a scan Socket
 * no longer has (404), and only then is re-uploading the archive worth the units; `socket
 * auth`, `socket quota` and `socket processing` are answers, not gaps in the id, and they
 * are returned as they are.
 *
 * Without `artifactBytes` there is nothing to upload and nothing to bind a result to
 * `artifact_sha256`, so the row is `unavailable` rather than a scan of we-know-not-what.
 */
async function runSocket(
  input: ScanInput,
  at: string,
  deps: SocketDeps & { resumeScanId?: string },
): Promise<{ result: SocketScanResult; resumed: boolean }> {
  const socket: SocketDeps = { ...deps, now: deps.now ?? (() => Date.parse(at)) };

  if (deps.resumeScanId) {
    const read = await readSocketScan(deps.resumeScanId, socket);
    if (read.check.status !== "unavailable") {
      if (read.check.status !== "partial") await deleteSocketScan(deps.resumeScanId, socket);
      return { result: read, resumed: true };
    }
    // `startsWith`, not equality (14 Sep 2026): a `socket error` reason now carries the
    // status and the vendor's message — `socket error (404: Full scan not found)` — and an
    // exact match against the bare prefix quietly stopped re-uploading the day it did.
    if (!(read.check.reason ?? "").startsWith(SOCKET_REASONS.error)) return { result: read, resumed: false };
  }

  if (!input.artifactBytes) return { result: { check: socketRow(at, SOCKET_REASONS.error), findings: [] }, resumed: false };

  const result = await socketFullScan(
    {
      archive: input.artifactBytes,
      listingId: input.listingId ?? "",
      version: input.version ?? "",
      commitSha: input.commitSha,
      fileCount: input.fileCount,
      // Step 1′ needs the same files `packagesFromFiles` reads, and reads them through
      // the same predicate so the two can never disagree about what a manifest is — unless
      // the caller holds a wider set already (`socketManifestFiles`, see `ScanInput`).
      manifestFiles: input.socketManifestFiles ?? manifestFilesOf(withoutNul(input.textFiles)),
    },
    socket,
  );
  return { result, resumed: false };
}

/**
 * §6.2, the `dep_behaviour` row. Included in {@link defaultExtraChecks} only when
 * {@link socketConfigured}; without the token the placeholder row says `socket
 * unconfigured`, which is a deployment fault and reads differently from a vendor outage.
 *
 * A cut never resumes: it has no stored id, and the id it is about to store is the rescan's
 * to finish. This is {@link runSocket} with that lever left alone.
 */
export function socketCheck(deps?: SocketDeps): ExtraCheck {
  return {
    id: "dep_behaviour",
    run: async ({ input, at, deadlineMs }) => {
      // The scan's deadline is Socket's unless the caller gave Socket a tighter one of its
      // own. Socket is the slow half of a cut and the one thing here that sleeps.
      const { result } = await runSocket(input, at, { ...deps, ...(deps?.deadlineMs === undefined && deadlineMs !== undefined ? { deadlineMs } : {}) });
      return { check: result.check, findings: result.findings };
    },
  };
}

/**
 * The map with NUL bytes taken out of every value (SCAN-1) — the same map when none has one,
 * so the common case copies nothing. Parsers read this; detection reads the raw text.
 */
function withoutNul(files: Map<string, string>): Map<string, string> {
  for (const text of files.values()) {
    if (text.includes("\u0000")) return new Map([...files].map(([path, value]) => [path, stripNul(value)]));
  }
  return files;
}

/**
 * The package set the two OSV rows are about (SCAN-2, red team 21 Sep 2026).
 *
 * `archive` is read from the manifests and lockfiles **inside the snapshot** — the bytes that
 * were hashed into `artifact_sha256` and are the bytes being sold — and it is the authority.
 * Until SCAN-2 the SBOM won whenever it was non-empty, and GitHub's `dependency-graph/sbom`
 * takes no ref: it describes the default branch. Tag a commit on a branch whose package.json
 * pulls a package with a `MAL-` record, keep `main` clean, and OSV was asked about `main`;
 * `known_malware` — one of the few checks that blocks — read `pass` over the malware.
 *
 * `supplement` is what the SBOM may still add: a package the archive does not name **at
 * all**, which is a transitive from a lockfile format `packagesFromFiles` does not parse
 * (`yarn.lock`, `pnpm-lock.yaml`, `poetry.lock`…). A package the archive does name is asked
 * about at the archive's version only — never replaced, never joined by the default branch's
 * version — so a disagreement between the two sources cannot downgrade or drop a finding;
 * the supplement can only add one, and its findings say where they came from.
 *
 * `manifests` is the set of archive files `packagesFromFiles` reads, for the notice raised when
 * none of them yields a package (see {@link noArchiveManifestFinding}).
 */
export type DependencyInventory = {
  packages: OsvPackage[];
  archive: OsvPackage[];
  supplement: OsvPackage[];
  manifests: string[];
};

export function dependencyInventory(input: Pick<ScanInput, "textFiles" | "sbomPackages">): DependencyInventory {
  const textFiles = withoutNul(input.textFiles);
  const archive = packagesFromFiles(textFiles);
  const manifests = [...textFiles.keys()].filter(isManifestPath).sort();
  const named = new Set(archive.map(packageKey));
  const supplement = dedupePackages(input.sbomPackages ?? []).filter((pkg) => !named.has(packageKey(pkg)));
  return { packages: [...archive, ...supplement], archive, supplement, manifests };
}

/**
 * One key per package regardless of version. PyPI names compare as PEP 503 says they do
 * (`Django`, `django`; `typing_extensions`, `typing-extensions`); everything else as written.
 */
function packageKey(pkg: OsvPackage): string {
  const name = pkg.ecosystem === "PyPI" ? pkg.name.toLowerCase().replace(/[-_.]+/g, "-") : pkg.name;
  return `${pkg.ecosystem}|${name}`;
}

/** At most this many manifest paths are named in the notice; the rest are counted. */
const NOTICE_PATHS_SHOWN = 3;

/**
 * SCAN-2: the archive yielded no package at all, and the report says so rather than letting
 * the row read `pass` as if the sold commit's dependencies had been checked. Disclosed,
 * `UNKNOWN` (the page prints "notice"), on the `known_vulns` row — the two OSV rows come from
 * one query and one notice covers both. Kind `limit`: it is a statement about how far the
 * check reached, and it must not be counted as a vulnerability.
 *
 * Two shapes. No manifest the parser reads is in the archive — a Markdown skill, or a
 * project whose only lockfile is one we do not parse. Or manifests are there and none of them
 * yielded a package — malformed, or declaring nothing. Either way, when the SBOM supplied
 * packages, the notice says those describe the default branch.
 */
function noArchiveManifestFinding(inventory: DependencyInventory): ScanFinding {
  const shown = inventory.manifests.slice(0, NOTICE_PATHS_SHOWN).join(", ");
  const more = inventory.manifests.length > NOTICE_PATHS_SHOWN ? ` and ${inventory.manifests.length - NOTICE_PATHS_SHOWN} more` : "";
  const what =
    inventory.manifests.length === 0
      ? "No dependency manifest the scanner reads (package.json, package-lock.json, requirements.txt, go.mod, Cargo.toml) is in this release"
      : `No package is declared in, or could be read from, this release's dependency manifests (${shown}${more})`;
  const supplement =
    inventory.supplement.length > 0
      ? `; the ${inventory.supplement.length === 1 ? "1 package checked comes" : `${inventory.supplement.length} packages checked come`} from the default branch's dependency graph, which may not match this release`
      : "; nothing it ships was checked against OSV";
  return {
    kind: "limit",
    check: "known_vulns",
    tier: "disclosed",
    public: true,
    rule_id: "no-dependency-manifest",
    severity: "UNKNOWN",
    description: `${what}${supplement}.`,
    blocking: false,
    source: "x402git",
  };
}

/** The OSV findings for an inventory, plus the SCAN-2 notice when the archive named nothing. */
function inventoryFindings(inventory: DependencyInventory, vulnerabilities: readonly OsvVulnerability[]): ScanFinding[] {
  const supplemented = new Set(inventory.supplement.map(packageKey));
  const findings = vulnerabilities.map((vuln) =>
    osvFinding(vuln, supplemented.has(packageKey({ name: vuln.package, ecosystem: vuln.ecosystem }))),
  );
  if (inventory.archive.length === 0) findings.push(noArchiveManifestFinding(inventory));
  return findings;
}

/**
 * What a real cut passes. Order matters in one place only: Socket runs **after** OSV, so
 * `scanArtifact` can drop the Socket CVE alerts OSV already reported (§6.2 step 4, "one
 * gate, one source"). OSV is not an extra check, so this list's own order is enough.
 */
export function defaultExtraChecks(deps: { socket?: SocketDeps } = {}): ExtraCheck[] {
  const checks: ExtraCheck[] = [capabilitiesCheck, injectionCheck];
  if (socketConfigured()) checks.push(socketCheck(deps.socket));
  return checks;
}

export type ScanDeps = {
  fetch?: FetchLike;
  /** Seam for FR-4. The default hashes the key and revokes it, whichever kind it is. */
  revokeApiKey?: (plaintextKey: string) => Promise<string[]>;
  /**
   * The seam for the rows this module does not produce: `capabilities`, `injection`,
   * `dep_behaviour` ("PRD Trust Report.md" §9, phases 2a and 2b). Each is a function of
   * the input and the report's timestamp, and each returns one `ScanCheck` row plus its
   * findings; the row replaces the `unavailable` placeholder of the same id.
   *
   * The rules a producer must keep, because `scanArtifact` does not police them:
   * - `check.id` is one of {@link SCAN_CHECK_IDS} and every finding's `check` matches it.
   * - A finding with `tier: "blocking"` has `blocking: true`, and it *will* fail the
   *   release — that is how hidden-Unicode smuggling blocks (§4.1).
   * - A check that could not run returns `status: "unavailable"` with a `reason`, never
   *   a throw and never `pass`. A throw is caught here and becomes exactly that row, so
   *   a vendor outage cannot take a release down with it (§4.1, founder decision §10 Q1).
   * - `public: false` on anything whose text is the payload (§4.4).
   */
  extraChecks?: readonly ExtraCheck[];
  /**
   * Absolute epoch milliseconds the whole scan must be finished by (13 Sep 2026).
   *
   * `cutRelease` runs inside the GitHub webhook handler at `maxDuration = 300` and does a
   * great deal besides scanning, so it hands this down rather than hoping: Socket trims its
   * polls and its per-request ceilings to what is left, and OSV stops looking up advisory
   * *detail* when a lookup would not fit. Neither can change a verdict by running out of
   * time — a truncated detail lookup leaves `UNKNOWN`, which does not block, and Socket has
   * never been able to fail a release (§4.1, founder decision §10 Q1).
   *
   * Left out, nothing is bounded but the individual request timeouts, which is the right
   * default for a script or a test.
   */
  deadlineMs?: number;
  /** The clock the deadline is read against. Injected by the tests that prove it holds. */
  now?: () => number;
};

/**
 * W3.2 (DC): `incomplete` is a distinct, non-terminal verdict for when a check could not
 * run — today, an OSV outage/timeout, and *only* that. It is **not** `pass`: `cutRelease`
 * leaves the release `pending` (retriable) with `scan_report.osv_error` and it never goes
 * on sale. Only secrets-clean *and* OSV-clean earns `pass`.
 *
 * An extra check that comes back `unavailable` does not make the scan incomplete. That is
 * the §4.1 split: OSV is the single source for the blocking CVE decision, so a gap there
 * is a gap in the verdict; Socket and the rest are additions, and a listing that says
 * "dependency behaviour: not yet checked, retrying" is honest where a platform-wide stall
 * on a vendor's uptime is not.
 */
export type ScanResult = { verdict: "pass" | "fail" | "incomplete"; report: ScanReport };

/**
 * FR-4: hash what was found and revoke that row. The plaintext never leaves this line —
 * it is not logged, not stored and not put on the report (which carries a length, never a
 * value). Either kind of key is revoked the same way (FR-60), and `revokeApiKeyByHash`
 * carries the asymmetry: a hit on an *agent* key also revokes that creator's live session
 * keys, because a scan hit means the account is under review and the web session should
 * not outlive it (FR-57, "PRD Session Keys.md").
 */
const defaultRevoke = (key: string) => revokeApiKeyByHash(hashApiKey(key));

export async function scanArtifact(input: ScanInput, deps: ScanDeps = {}): Promise<ScanResult> {
  const at = new Date().toISOString();
  /** OSV is a feed, not a ruleset: the date it was read is the only version it has. */
  const feedVersion = at.slice(0, 10);
  const findings: ScanFinding[] = [];

  // (b) size and zip-bomb limits (§6).
  if (input.fileCount > MAX_FILES) {
    findings.push(limitFinding("file-count", `Snapshot has ${input.fileCount} files; the cap is ${MAX_FILES}.`));
  }
  if (input.extractedBytes > MAX_EXTRACTED_BYTES) {
    findings.push(limitFinding("extracted-bytes", `Snapshot extracts to ${input.extractedBytes} bytes; the cap is ${MAX_EXTRACTED_BYTES}.`));
  }

  // (a) secrets — over the full bytes of every file that ships (W3.1), not the truncated,
  // text-only `textFiles`. The `looksBinary`/`isTextPath` heuristic drives analysis and the
  // manifest but must not gate secret detection, so a secret behind a NUL byte or past the
  // old 4 MB cap is still found. The badge must describe the bytes actually sold.
  const secretSource = input.secretScanFiles ?? input.textFiles;
  const guard = input.maxSecretScanBytes ?? MAX_SECRET_SCAN_BYTES;
  const overBudget = input.secretScanBytes !== undefined && input.secretScanBytes > guard;

  let secrets: SecretFinding[] = [];
  if (overBudget) {
    // Fail closed: too large to scan every byte, so we cannot claim it carries no secret.
    // The finding is a `limits` one and the `secrets` row goes `unavailable` below — the
    // check did not run, and a row that said `pass` here would be the lie the tiers exist
    // to prevent.
    findings.push(
      limitFinding(
        "unscannable",
        `Snapshot is ${input.secretScanBytes} bytes, past the ${guard}-byte secret-scan budget; it cannot be verified free of secrets.`,
      ),
    );
  } else {
    secrets = scanSecrets(secretSource);
    for (const finding of secrets) {
      findings.push({
        kind: "secret",
        check: "secrets",
        tier: "blocking",
        // §4.4: never public, not even on a failed release — a path and a line is a map
        // for anyone who cloned the repo before the tag.
        public: false,
        rule_id: finding.rule_id,
        severity: "CRITICAL",
        description: finding.description,
        path: finding.path,
        line: finding.line,
        blocking: true,
      });
    }
  }

  // FR-4: one of our own keys in a repository is revoked, not merely reported — an agent
  // key or a session key alike (FR-60), and an agent-key hit takes the creator's web
  // sessions with it (FR-57).
  let revokedCreatorIds: string[] | undefined;
  const ourKeys = overBudget ? [] : ownApiKeysIn(secretSource);
  if (ourKeys.length > 0) {
    const revoke = deps.revokeApiKey ?? defaultRevoke;
    revokedCreatorIds = [];
    for (const key of ourKeys) {
      try {
        revokedCreatorIds.push(...(await revoke(key)));
      } catch (e) {
        console.error("[scan] api key revocation failed:", e instanceof Error ? e.message : String(e));
      }
    }
  }

  // (c) and (d) dependency advisories — one OSV query, two rows. See `osvFinding`. The
  // package set is the sold commit's own (SCAN-2); see `dependencyInventory`.
  const inventory = dependencyInventory(input);
  const packages = inventory.packages;
  const { vulnerabilities, error } = await queryOsv(packages, deps.fetch ?? fetch, undefined, {
    ...(deps.deadlineMs !== undefined ? { deadlineMs: deps.deadlineMs } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  findings.push(...inventoryFindings(inventory, vulnerabilities));

  // The rows this module owns. `unavailable` is the honest word for a check that did not
  // run: `secrets` when the repo was past the CPU guard, both OSV rows when OSV was
  // unreachable. `checked` is derived from these statuses, so the badge cannot claim one.
  const osvReason = error ? "osv unreachable" : undefined;
  const checks: ScanCheck[] = [
    row("secrets", "x402git/secrets", SCANNER_VERSION, findings, at, { ran: !overBudget, reason: overBudget ? "over the secret-scan budget" : undefined }),
    row("limits", "x402git/limits", SCANNER_VERSION, findings, at, {}),
    row("known_vulns", "osv.dev", feedVersion, findings, at, { ran: !error, reason: osvReason, packages: packages.length }),
    row("known_malware", "osv.dev/MAL", feedVersion, findings, at, { ran: !error, reason: osvReason, packages: packages.length }),
    // Placeholders for the three rows the extra checks own. Present on every report,
    // because "not checked" is a result and a missing row is not. A caller that passes
    // `defaultExtraChecks()` replaces the first two always and the third when Socket has
    // a token; the reason left behind says which of the two situations this is.
    socketRow(at, socketConfigured() ? "not wired" : SOCKET_REASONS.unconfigured),
    notWired("capabilities", "x402git/caps", SCANNER_VERSION, at),
    notWired("injection", "x402git/inject", SCANNER_VERSION, at),
  ];

  // The extra checks, each replacing its placeholder. A module that throws becomes the
  // `unavailable` row it should have returned — a vendor's bad day is a gap on the report,
  // never a release that could not be cut.
  let capabilities: Capabilities | undefined;
  const seenAdvisories = advisoryIdsIn(findings);
  for (const extra of deps.extraChecks ?? []) {
    let result: ExtraCheckResult;
    try {
      result = await extra.run({ input, at, ...(deps.deadlineMs !== undefined ? { deadlineMs: deps.deadlineMs } : {}) });
    } catch (e) {
      // The row the check declared, marked with what happened to it. Leaving the
      // placeholder behind said `not wired` — "nobody passed this module" — for a module
      // that was passed and blew up, which is a badge misreporting its own gap and the
      // §7 repair queue never looking at it again. See {@link ExtraCheck}.
      const message = e instanceof Error ? e.message : String(e);
      console.error("[scan] extra check failed:", message);
      const failedAt = checks.findIndex((c) => c.id === extra.id);
      if (failedAt !== -1) checks[failedAt] = { ...checks[failedAt], status: "unavailable", findings: 0, reason: `${CHECK_FAILED}: ${message}` };
      continue;
    }
    const index = checks.findIndex((c) => c.id === result.check.id);
    if (index === -1) continue; // Not one of the seven; the contract has no room for it.
    const kept = dedupeByAdvisory(result.findings, seenAdvisories);
    checks[index] = withFindingCount(result.check, kept.length, result.findings.length);
    findings.push(...kept);
    if (result.capabilities) capabilities = result.capabilities;
  }

  const blocking = findings.filter((f) => f.blocking).length;

  // A blocking finding (secret, over-cap, unscannable, a HIGH/CRITICAL CVE, a MAL- record,
  // Socket's confirmed `malware`, hidden-Unicode smuggling) is a definitive `fail`
  // regardless of OSV. Otherwise, an OSV error means the scan is *incomplete* — never a
  // silent `pass`. A Socket row that is `unavailable` or `partial` does not reach this
  // line at all: §4.1's third tier is a gap on the report, not a stalled release.
  const verdict: ScanResult["verdict"] = blocking > 0 ? "fail" : error ? "incomplete" : "pass";

  // §4.3: the inventory belongs on the report whenever its row ran, and a row that ran
  // clean produces no findings at all — so `capabilities` cannot be inferred from the
  // findings list. An empty inventory is a claim ("nothing runs at install"), which is
  // exactly the case that would otherwise go missing.
  const capabilitiesRan = checks.some((c) => c.id === "capabilities" && c.status !== "unavailable");
  if (capabilitiesRan && !capabilities) {
    console.warn("[scan] capabilities row ran without returning an inventory");
  }

  const report: ScanReport = {
    version: 2,
    // §4.2: mirrored onto the report so a reader holding only this blob — the rescan cron,
    // an export — knows what it was. `release.scan` stays the authority.
    verdict,
    scanner_version: SCANNER_VERSION,
    scanned_at: at,
    checks: checks.sort((a, b) => SCAN_CHECK_IDS.indexOf(a.id) - SCAN_CHECK_IDS.indexOf(b.id)),
    findings,
    ...(capabilities ? { capabilities } : {}),
    counts: {
      secrets: secrets.length,
      // Vulnerabilities, not malware: the `known_malware` row carries its own count, and
      // "2 vulnerabilities" must not read as "2 CVEs" when one of them is a MAL- record.
      vulnerabilities: findings.filter((f) => f.kind === "vulnerability").length,
      blocking,
      disclosed: findings.filter((f) => f.tier === "disclosed").length,
      review: findings.filter((f) => f.tier === "review").length,
    },
    // W3.2 (DC): what actually ran, so a `pass` says what it means (Quality Signals §9.2).
    // Derived from the rows rather than written by hand — the two cannot drift.
    checked: checks.filter((c) => c.status !== "unavailable").map((c) => c.id),
    packages_scanned: packages.length,
    ...(revokedCreatorIds && revokedCreatorIds.length > 0 ? { revoked_creator_ids: revokedCreatorIds } : {}),
    ...(error ? { osv_error: error } : {}),
  };

  return { verdict, report };
}

/**
 * One OSV advisory as a finding. A `MAL-` id is a statement that the package *is* malware,
 * so it lands on `known_malware` at CRITICAL and blocks; everything else is a `known_vulns`
 * finding at the severity OSV gives it, and MODERATE/LOW/UNKNOWN sell and are shown
 * (§4.1/§1(3) — hiding them was the gap).
 *
 * A HIGH/CRITICAL CVE blocks only when the package was queried **at a version**
 * (2026-10-15). A versionless query — `numpy` or `numpy>=1.26` in a requirements.txt,
 * a `^7.3.6` range with no lockfile — returns every advisory ever filed against the
 * package, so a listing such as `example-seller/example-listing` v1.0.0 failed on numpy CVEs from
 * 2014 that no current numpy has. Those are still disclosed, at their severity, so the
 * buyer sees them; they just cannot fail a release nobody could fix by upgrading. A
 * `MAL-` record blocks with or without a version: that package name is the problem.
 *
 * `fromDefaultBranch` (SCAN-2) marks a package only the SBOM supplied. It is tiered exactly
 * like the rest — the supplement may add a finding, never soften one — and its description
 * says where the package came from, because the default branch may not be what was sold.
 */
function osvFinding(vuln: OsvVulnerability, fromDefaultBranch = false): ScanFinding {
  const blocking = vuln.malware || (Boolean(vuln.version) && BLOCKING_SEVERITIES.has(vuln.severity));
  const origin = fromDefaultBranch ? ", from the default branch's dependency graph" : "";
  return {
    kind: vuln.malware ? "malware" : "vulnerability",
    check: vuln.malware ? "known_malware" : "known_vulns",
    tier: blocking ? "blocking" : "disclosed",
    public: true,
    rule_id: vuln.id,
    severity: vuln.severity,
    description: `${vuln.package}${vuln.version ? `@${vuln.version}` : ""} (${vuln.ecosystem}${origin}): ${vuln.summary ?? vuln.id}`,
    blocking,
    package: { ecosystem: vuln.ecosystem, name: vuln.package, ...(vuln.version ? { version: vuln.version } : {}) },
    // §6.2: the ids Socket's CVE alerts are matched against, so the same advisory is
    // shown once whichever tool saw it first.
    advisory_ids: [vuln.id, ...(vuln.aliases ?? []).filter((a) => a !== vuln.id)],
    source: "osv.dev",
  };
}

/** §6 caps and the W3.1 guard: always blocking, always public — no path, no payload. */
function limitFinding(rule_id: string, description: string): ScanFinding {
  return { kind: "limit", check: "limits", tier: "blocking", public: true, rule_id, severity: "HIGH", description, blocking: true };
}

/**
 * One check row, with its status read off the findings that belong to it: `fail` if any
 * of them blocks, `findings` if there are any at all, `pass` if the check ran clean, and
 * `unavailable` when it could not run.
 */
function row(
  id: ScanCheckId,
  tool: string,
  tool_version: string,
  findings: readonly ScanFinding[],
  at: string,
  options: { ran?: boolean; reason?: string; packages?: number },
): ScanCheck {
  const mine = findings.filter((f) => f.check === id);
  const ran = options.ran ?? true;
  const status: ScanCheckStatus = !ran ? "unavailable" : mine.some((f) => f.blocking) ? "fail" : mine.length > 0 ? "findings" : "pass";
  return {
    id,
    tool,
    tool_version,
    status,
    at,
    findings: mine.length,
    ...(options.packages !== undefined ? { packages: options.packages } : {}),
    ...(options.reason ? { reason: options.reason } : {}),
  };
}

/** A row for a check whose module exists but was not passed to this call. */
function notWired(id: ScanCheckId, tool: string, tool_version: string, at: string): ScanCheck {
  return { id, tool, tool_version, status: "unavailable", at, findings: 0, reason: "not wired" };
}

/** The `dep_behaviour` placeholder, in the shape `lib/scan/socket.ts` produces itself. */
function socketRow(at: string, reason: string): ScanCheck {
  return { id: "dep_behaviour", tool: "socket.dev", tool_version: at.slice(0, 10), status: "unavailable", at, findings: 0, reason };
}

/** Every GHSA / CVE / MAL id already accounted for, so the same advisory is shown once. */
function advisoryIdsIn(findings: readonly ScanFinding[]): Set<string> {
  const ids = new Set<string>();
  for (const finding of findings) for (const id of finding.advisory_ids ?? []) ids.add(id);
  return ids;
}

/**
 * §6.2 step 4, "one gate, one source". A Socket `criticalCVE`/`cve`/`mediumCVE`/`mildCVE`
 * alert arrives carrying `props.ghsaId`/`props.cveId`; where OSV already reported the same
 * advisory under one of those ids, Socket's copy is dropped and OSV's — the one that
 * decided whether the release blocks — is the one the buyer reads. A CVE Socket knows and
 * OSV does not has no shared id, survives, and is disclosed.
 *
 * Written against `advisory_ids` rather than against Socket's tier, so the rule is a
 * property of the finding and any future second opinion de-duplicates the same way.
 * `seen` is mutated: a later check does not re-report an earlier one's advisories either.
 */
function dedupeByAdvisory(findings: readonly ScanFinding[], seen: Set<string>): ScanFinding[] {
  const kept: ScanFinding[] = [];
  for (const finding of findings) {
    const ids = finding.advisory_ids ?? [];
    if (ids.length > 0 && ids.some((id) => seen.has(id))) continue;
    for (const id of ids) seen.add(id);
    kept.push(finding);
  }
  return kept;
}

/**
 * The row a producer returned, with its count corrected for what de-duplication removed.
 * `findings` on a row is what that row is claiming to have found *on this report*, so it
 * cannot keep counting a finding that is not in `findings[]`. A row that ran, said
 * `findings`, and had every one of them de-duplicated away becomes `pass` — it did run,
 * and it has nothing of its own left to show. `fail`, `partial` and `unavailable` are
 * never rewritten: those are statements about the check, not about its count.
 */
function withFindingCount(check: ScanCheck, kept: number, produced: number): ScanCheck {
  if (kept === produced) return check;
  const status: ScanCheckStatus = check.status === "findings" && kept === 0 ? "pass" : check.status;
  return { ...check, status, findings: kept };
}

/**
 * `socket: false`. A caller that ran OSV on purpose and left Socket alone — §7's weekly
 * cadence, and the quota floor that trips mid-run — is not a caller that failed to reach
 * Socket, and the row says so in its own words rather than borrowing a vendor's.
 */
export const SOCKET_SKIPPED = "socket skipped";

/**
 * The dependency rows on their own — `known_vulns`, `known_malware`, `dep_behaviour` — for
 * a caller that already has an artifact and wants only those re-run over it.
 *
 * That caller is §7's rescan cron (`app/api/cron/rescan`, "PRD Trust Report.md" phase 2c):
 * a verdict is terminal and never re-decided, but an advisory published since the cut is
 * news, and re-reading it must not mean re-running the secret scan or re-deciding whether
 * the release passed. The three rows and their findings come back exactly as `scanArtifact`
 * would have built them, de-duplication included, and the caller splices them into the
 * stored report and stamps `advisories_refreshed_at`.
 *
 * **`socket`, the three levers §7 needs** (widened 13 Sep 2026, when the rescan's private
 * copy of all of this was deleted in favour of this call):
 * - **omitted** — the cut-time default: Socket runs when {@link socketConfigured}, and the
 *   row says `socket unconfigured` when it is not. Nothing about that path moved.
 * - **`false`** — OSV only, and the row says {@link SOCKET_SKIPPED}. This is the weekly
 *   cadence and the mid-run quota floor: free OSV keeps going, Socket does not.
 * - **an object** — Socket runs with these deps, environment or no environment, so a test
 *   and a cron can both hand it a token. `resumeScanId` finishes a scan already paid for
 *   from its stored id instead of re-uploading the archive (see {@link runSocket}).
 *
 * A `dep_behaviour` row that comes back `unavailable` is a gap, and what to do with a gap
 * is the caller's rule, not this function's: `scanArtifact` publishes it, and the rescan
 * keeps the row it already had so that a bad minute at a vendor never erases a disclosure.
 *
 * Nothing here reads the clock beyond `at`, which the caller supplies so the rewritten rows
 * carry the refresh time rather than three slightly different ones.
 */
export async function dependencyChecks(
  input: ScanInput,
  deps: {
    fetch?: FetchLike;
    socket?: false | (SocketDeps & { resumeScanId?: string });
    at?: string;
    /**
     * §7's per-release deadline, absolute epoch ms (13 Sep 2026). The cron's budget is for
     * the *run*; this is the one release's share of it, so one enormous listing cannot eat
     * the night. Handed to Socket and to OSV's detail lookups exactly as `scanArtifact`
     * hands down its own.
     */
    deadlineMs?: number;
    now?: () => number;
  } = {},
): Promise<{
  checks: ScanCheck[];
  findings: ScanFinding[];
  packages: number;
  error?: string;
  /** True when the `dep_behaviour` row was finished from a stored `socket_scan_id`. */
  socketResumed: boolean;
  /** Files Socket was handed and did not recognise as a manifest (§6.2 step 3). */
  unmatchedFiles?: string[];
}> {
  const at = deps.at ?? new Date().toISOString();
  const feedVersion = at.slice(0, 10);

  // The same inventory a cut builds (SCAN-2): the §7 rescan hands over the stored zip's
  // manifests as `textFiles` and the stored dependency list as `sbomPackages`, and the zip
  // stays the authority there too.
  const inventory = dependencyInventory(input);
  const packages = inventory.packages;
  const { vulnerabilities, error } = await queryOsv(packages, deps.fetch ?? fetch, undefined, {
    ...(deps.deadlineMs !== undefined ? { deadlineMs: deps.deadlineMs } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  const findings = inventoryFindings(inventory, vulnerabilities);

  const osvReason = error ? "osv unreachable" : undefined;
  const checks: ScanCheck[] = [
    row("known_vulns", "osv.dev", feedVersion, findings, at, { ran: !error, reason: osvReason, packages: packages.length }),
    row("known_malware", "osv.dev/MAL", feedVersion, findings, at, { ran: !error, reason: osvReason, packages: packages.length }),
  ];

  const skipped = deps.socket === false ? SOCKET_SKIPPED : deps.socket === undefined && !socketConfigured() ? SOCKET_REASONS.unconfigured : undefined;
  if (skipped) {
    checks.push(socketRow(at, skipped));
    return { checks, findings, packages: packages.length, socketResumed: false, ...(error ? { error } : {}) };
  }

  let socket: SocketScanResult;
  let socketResumed = false;
  try {
    const socketDeps = { ...deps.socket };
    if (socketDeps.deadlineMs === undefined && deps.deadlineMs !== undefined) socketDeps.deadlineMs = deps.deadlineMs;
    if (socketDeps.now === undefined && deps.now) socketDeps.now = deps.now;
    const ran = await runSocket(input, at, socketDeps);
    socket = ran.result;
    socketResumed = ran.resumed;
  } catch (e) {
    console.error("[scan] socket check failed:", e instanceof Error ? e.message : String(e));
    socket = { check: socketRow(at, SOCKET_REASONS.error), findings: [] };
  }
  const kept = dedupeByAdvisory(socket.findings, advisoryIdsIn(findings));
  checks.push(withFindingCount(socket.check, kept.length, socket.findings.length));

  return {
    checks,
    findings: [...findings, ...kept],
    packages: packages.length,
    socketResumed,
    ...(socket.unmatchedFiles && socket.unmatchedFiles.length > 0 ? { unmatchedFiles: socket.unmatchedFiles } : {}),
    ...(error ? { error } : {}),
  };
}

export type { OsvVulnerability };
