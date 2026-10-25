/**
 * lib/scan/socket.ts — the `dep_behaviour` check ("PRD Trust Report.md" §6.2, accepted
 * 13 Sep 2026). Socket answers a question OSV cannot: not "is this dependency known to be
 * broken" but "what does this dependency actually do" — install scripts, network, shell,
 * filesystem, env, native code, `eval`, obfuscation, telemetry — plus a human-confirmed
 * `malware` flag for packages no advisory has caught up with yet, over the full transitive
 * tree resolved from the lockfile, which `packagesFromFiles` (lib/scan/osv.ts) does not do.
 *
 * The division of labour with our own scripts is §6.1's rule: our modules look at the
 * artifact's own files, Socket looks at the published packages the artifact depends on.
 * Socket never sees the artifact's source — it ingests only the files matching its
 * supported-manifest globs out of the archive we upload.
 *
 * **Socket never fails a release** (§4.1, founder decision §10 Q1). An outage, a 401, an
 * empty quota window or a scan that is still processing when the cut has to finish is a
 * *gap*, recorded: the check row is `unavailable` with a reason carrying the status and, as
 * of 14 Sep 2026, the vendor's own message; the release cuts on the checks that did run;
 * and the §7 rescan cron repairs the row later. Nothing in this file throws for transport;
 * a caller only sees an exception for programmer error.
 *
 * A gap is not the same thing as an empty answer, and one 400 is not a gap at all: a
 * repository with no dependency manifests gets a `pass` row reading `no dependency
 * manifests` (see {@link SOCKET_NO_MANIFESTS}), because Socket looked and there was
 * nothing to look at.
 *
 * Quota (§6.2, free plan — 500 units/hour, 1,000 full scans/month): a release costs
 * 1 (create) + ≤ 3 (polls) + 1 (delete) = **≤ 5 units**. `GET /quota` costs nothing and
 * runs before every create; under 10% of the window left, cut-time Socket is skipped as
 * `unavailable` rather than spending the last units a paying cut might need.
 *
 * **Wall clock (13 Sep 2026).** The cut runs inside a handler at `maxDuration = 300` and
 * Socket is one of the things inside it, so the module owns a bounded worst case rather
 * than an optimistic one: six requests at {@link SOCKET_TIMEOUT_MS} plus 30 s of poll
 * sleeps is **90 seconds**, and a caller that has less than that says so with
 * {@link SocketDeps.deadlineMs}.
 *
 * The token is read here and nowhere else. `SOCKET_TOKEN_VALUE` is the secret and is sent
 * only as `Authorization: Bearer`; `SOCKET_TOKEN_HASH` beside it in the environment is the
 * token's public id, authenticates nothing, and is never read by this module. Nothing in
 * here logs, and no reason string, finding or check row can carry a credential.
 */

import { archiveFormat } from "./archive";
import type { FetchLike } from "./osv";
import type { ScanCheck, ScanFinding, ScanSeverity, ScanTier } from "./report";

export const SOCKET_BASE_URL = "https://api.socket.dev/v0";

/** The `tool` on the check row, and the `source` on every finding this file produces. */
export const SOCKET_TOOL = "socket.dev";

/**
 * Per-request ceiling. A hung vendor must not eat the webhook's `maxDuration = 300`.
 *
 * **10 s, not 30 (13 Sep 2026).** At 30 s the arithmetic did not close: quota + create +
 * five polls + delete is eight requests, and eight hung requests plus 60 s of poll sleeps
 * is 300 s on Socket alone — the whole of `maxDuration`, before OSV has been asked
 * anything. With the trimmed poll table below the worst case is 6 × 10 s of requests plus
 * 30 s of sleeps = **90 s**, which leaves the rest of the cut its budget. A caller with a
 * {@link SocketDeps.deadlineMs} gets less than 10 s per request as the deadline closes.
 */
export const SOCKET_TIMEOUT_MS = 10_000;

/** §6.2 step 2, trimmed 13 Sep 2026: three polls — 5 s, 10 s, 15 s — so ≤ 30 s and ≤ 3 units. */
export const SOCKET_POLL_DELAYS_MS: readonly number[] = [5000, 10000, 15000];

/** §6.2: Socket extracts at most 10,000 files from an archive; past that, step 1′. */
export const SOCKET_MAX_ARCHIVE_FILES = 10_000;

/** §6.2 quota budget: under a tenth of the window left, the cut skips Socket. */
export const SOCKET_QUOTA_FLOOR = 0.1;

/** The multipart field the archive is uploaded under. Named so it is one edit to change. */
export const SOCKET_ARCHIVE_FIELD = "file";

// --- the alert table ---------------------------------------------------------------

/**
 * Which family an alert belongs to. Only read for alerts that produce a finding — the
 * `ignore` and `partial` rows below carry the nearest group so the table has one shape.
 */
export type SocketAlertGroup = "malware" | "capability" | "review" | "hygiene" | "cve" | "repo";

/**
 * `dedupe_cve` is disclosed and *never* blocking: OSV stays the single source for the
 * blocking CVE decision (§6.2 step 4, "one gate, one source"), and the finding carries
 * `advisory_ids` so the integrator can drop the ones OSV already reported. `partial` is
 * Socket telling us it has not finished (`pendingScan`/`notFound`) — no finding, the row
 * goes `partial` and the cron re-reads. `ignore` produces nothing at all.
 */
export type SocketAlertTier = ScanTier | "ignore" | "dedupe_cve" | "partial";

export type SocketAlertRule = {
  tier: SocketAlertTier;
  /** Fixed where the table decides; otherwise Socket's own severity is mapped through. */
  severity?: ScanSeverity;
  group: SocketAlertGroup;
};

const blocking = (group: SocketAlertGroup, severity: ScanSeverity): SocketAlertRule => ({ tier: "blocking", severity, group });
const capability: SocketAlertRule = { tier: "disclosed", group: "capability" };
const review: SocketAlertRule = { tier: "review", group: "review" };
const hygiene: SocketAlertRule = { tier: "disclosed", severity: "LOW", group: "hygiene" };
const repo: SocketAlertRule = { tier: "disclosed", severity: "MODERATE", group: "repo" };
const cve: SocketAlertRule = { tier: "dedupe_cve", group: "cve" };
const partialRule: SocketAlertRule = { tier: "partial", group: "hygiene" };
const ignore = (group: SocketAlertGroup = "hygiene"): SocketAlertRule => ({ tier: "ignore", group });

/**
 * §6.2 step 4, with Socket's real slugs. Every alert type the pipeline can meet is here,
 * and a type that is *not* here is disclosed at `LOW` under its own slug rather than
 * dropped (`SOCKET_UNKNOWN_RULE`) — a new Socket category must never go quiet.
 */
export const SOCKET_ALERTS: Record<string, SocketAlertRule> = {
  // Blocking. The human-confirmed type and nothing else — `gptMalware` is a classifier
  // opinion at 94.5% precision (§4.1) and lands in `review`.
  malware: blocking("malware", "CRITICAL"),

  // Disclosed · capability. What the package does. Feeds §4.3's "What this can do".
  installScripts: capability,
  networkAccess: capability,
  shellAccess: capability,
  filesystemAccess: capability,
  envVars: capability,
  hasNativeCode: capability,
  usesEval: capability,
  dynamicRequire: capability,
  debugAccess: capability,
  telemetry: capability,
  obfuscatedFile: capability,
  highEntropyStrings: capability,
  urlStrings: capability,
  minifiedFile: capability,

  // Review. Model-derived, shown as "flagged for review", never a verdict (§4.1).
  gptMalware: review,
  gptSecurity: review,
  gptAnomaly: review,
  potentialVulnerability: review,
  didYouMean: review,
  gptDidYouMean: review,
  troll: review,
  suspiciousStarActivity: review,
  // The `skill*` family is unreachable through the public full-scan API today — the
  // 13 Sep 2026 preflight found no skill-shaped glob in `supported-files`, so nothing in a
  // SKILL.md gets to Socket from our upload (§6.2, "The `skill*` alerts"). The rows stay so
  // that the day a glob appears the family is already handled, and lib/scan/capabilities.ts
  // and lib/scan/injection.ts are the skill analysis this design actually ships.
  skillCommandInjection: review,
  skillDataExfiltration: review,
  skillHardcodedSecrets: review,
  skillPreExecution: review,
  skillPromptInjection: review,
  skillToolChaining: review,
  skillObfuscation: review,
  skillResourceAbuse: review,
  skillSupplyChain: review,
  skillToolAbuse: review,
  skillTransitiveTrust: review,
  skillAutonomyAbuse: review,
  skillDiscoveryAbuse: review,

  // Disclosed · hygiene. Low and folded: true, worth publishing, never a verdict.
  deprecated: hygiene,
  unmaintained: hygiene,
  unstableOwnership: hygiene,
  newAuthor: hygiene,
  missingAuthor: hygiene,
  recentlyPublished: hygiene,
  gitDependency: hygiene,
  gitHubDependency: hygiene,
  httpDependency: hygiene,
  floatingDependency: hygiene,
  badSemverDependency: hygiene,
  missingLockfile: hygiene,
  shrinkwrap: hygiene,
  manifestConfusion: hygiene,
  unpopularPackage: hygiene,
  trivialPackage: hygiene,
  tooManyFiles: hygiene,
  unresolvedYarnDependency: hygiene,
  oversizedManifest: hygiene,
  unresolvedPomReference: hygiene,

  // Disclosed · repo. `.github/workflows/*.y{a,}ml` is an ingested glob (preflight,
  // 13 Sep 2026), so these are reachable: a workflow the buyer inherits when they fork.
  ghaContextToSink: repo,
  ghaArgToSink: repo,
  ghaEnvToSink: repo,
  ghaContextToEnv: repo,
  ghaContextToOutput: repo,
  ghaArgToEnv: repo,
  ghaArgToOutput: repo,

  // De-duplicated against OSV by `props.ghsaId` / `props.cveId`.
  criticalCVE: cve,
  cve: cve,
  mediumCVE: cve,
  mildCVE: cve,

  // Socket has not finished. Row `partial`, cron re-reads (§7).
  pendingScan: partialRule,
  notFound: partialRule,

  // Ignored. Licences are FR-11's job, read from the artifact's own SPDX; `policy` and
  // `generic` are Socket's own plumbing; `socketUpgradeAvailable` is an upsell. The
  // extension families are not an artifact class we sell — and a repo with a root
  // `manifest.json` (a PWA, say) is read by Socket as a Chrome extension, which is exactly
  // the false positive this row exists to swallow (§6.2, preflight note).
  policy: ignore(),
  generic: ignore(),
  socketUpgradeAvailable: ignore(),
  ambiguousClassifier: ignore(),
  copyleftLicense: ignore(),
  deprecatedLicense: ignore(),
  explicitlyUnlicensedItem: ignore(),
  licenseChange: ignore(),
  licenseException: ignore(),
  licenseSpdxDisj: ignore(),
  miscLicenseIssue: ignore(),
  modifiedLicense: ignore(),
  newLicense: ignore(),
  noLicenseFound: ignore(),
  nonOSILicense: ignore(),
  nonSPDXLicense: ignore(),
  nonpermissiveLicense: ignore(),
  unclearLicense: ignore(),
  unidentifiedLicense: ignore(),
  chromeExtension: ignore("capability"),
  chromeExtensionPermissions: ignore("capability"),
  browserExtension: ignore("capability"),
  browserExtensionPermissions: ignore("capability"),
  vsxExtension: ignore("capability"),
  vsxExtensionPermissions: ignore("capability"),
};

/** A slug the table has never heard of: disclosed at `LOW`, under its own name (§6.2). */
export const SOCKET_UNKNOWN_RULE: SocketAlertRule = { tier: "disclosed", severity: "LOW", group: "hygiene" };

/**
 * Prefixes swallowed whole. Socket keeps minting licence and extension slugs, and every
 * one of them is either FR-11's job or an artifact class we do not sell; matching the
 * family means a new member does not arrive on a listing page as an unknown alert.
 */
const IGNORED_PREFIXES = ["license", "browserExtension", "chromeExtension", "vsxExtension", "vscodeExtension"];

/** The table row for an alert type, prefix families and the unknown default included. */
export function socketAlertRule(type: string): SocketAlertRule {
  const known = Object.hasOwn(SOCKET_ALERTS, type) ? SOCKET_ALERTS[type] : undefined;
  if (known) return known;
  if (IGNORED_PREFIXES.some((p) => type.startsWith(p))) return { tier: "ignore", group: "hygiene" };
  return SOCKET_UNKNOWN_RULE;
}

/** Socket's four-word severity scale onto ours. `middle` is what GHSA calls `MODERATE`. */
export function socketSeverity(value: string | undefined): ScanSeverity {
  switch ((value ?? "").toLowerCase()) {
    case "critical":
      return "CRITICAL";
    case "high":
      return "HIGH";
    case "middle":
    case "medium":
      return "MODERATE";
    case "low":
      return "LOW";
    default:
      return "LOW";
  }
}

// --- the wire shapes ---------------------------------------------------------------

/** One alert on one artifact, as it arrives on the NDJSON stream. */
export type SocketAlert = {
  key?: string;
  type: string;
  severity?: string;
  category?: string;
  props?: Record<string, unknown>;
  action?: string;
};

/**
 * One line of the full-scan stream. `type` is the ecosystem (`npm`, `pypi`, `golang`, …),
 * not a kind; the trailer line carries `_type: "scores"` instead and is skipped.
 */
export type SocketArtifact = {
  _type?: string;
  type?: string;
  namespace?: string;
  name?: string;
  version?: string;
  id?: string;
  direct?: boolean;
  dev?: boolean;
  dead?: boolean;
  alerts?: SocketAlert[];
  score?: unknown;
};

export type SocketDeps = {
  fetch?: FetchLike;
  token?: string;
  orgSlug?: string;
  pollDelaysMs?: readonly number[];
  now?: () => number;
  /**
   * Absolute epoch milliseconds this call must be finished by (13 Sep 2026). Every request
   * is given the smaller of {@link SOCKET_TIMEOUT_MS} and what is left, a poll whose sleep
   * would cross it is not slept, and a scan still processing when the budget runs out ends
   * exactly where it ends when the polls run out: `unavailable`, `reason: "socket
   * processing"`, `socket_scan_id` kept, and the §7 cron finishes it for one unit.
   *
   * `now` is what it is measured against, so a test drives it with an injected clock.
   */
  deadlineMs?: number;
};

export type SocketScanResult = {
  check: ScanCheck;
  findings: ScanFinding[];
  /** Files we uploaded that Socket did not recognise as a manifest (§6.2 step 3). */
  unmatchedFiles?: string[];
};

export type SocketFullScanInput = {
  /** The re-packed zip — `SnapshotResult.bytes`, the same bytes `artifact_sha256` covers. */
  archive: Uint8Array;
  /** FR-42: the listing **id**, never the slug. Socket's `repo` must be immutable. */
  listingId: string;
  version: string;
  commitSha?: string;
  /** `SnapshotResult.fileCount`. Past 10,000 the archive route cannot be used. */
  fileCount: number;
  /** path → text, for step 1′. The same manifests `packagesFromFiles` reads. */
  manifestFiles?: Map<string, string>;
};

// --- mapping -------------------------------------------------------------------------

/**
 * A short plain phrase per alert type, so the finding reads as a sentence a buyer can act
 * on rather than a slug. An entry that is missing falls back to the slug itself — which is
 * ugly and therefore self-reporting: the day Socket ships a category we have not described,
 * it shows up on a page looking like the loose end it is.
 */
const PHRASES: Record<string, string> = {
  malware: "confirmed by Socket as malware",
  installScripts: "install scripts run when installed",
  networkAccess: "makes network requests at runtime",
  shellAccess: "runs shell commands",
  filesystemAccess: "reads or writes files",
  envVars: "reads environment variables",
  hasNativeCode: "ships compiled native code",
  usesEval: "evaluates code at runtime",
  dynamicRequire: "loads modules by a computed name",
  debugAccess: "can attach a debugger",
  telemetry: "sends telemetry",
  obfuscatedFile: "contains an obfuscated file",
  highEntropyStrings: "contains high-entropy strings",
  urlStrings: "contains hard-coded URLs",
  minifiedFile: "ships minified code with no source",
  gptMalware: "flagged for review by Socket's classifier as possible malware",
  gptSecurity: "flagged for review by Socket's classifier as a security risk",
  gptAnomaly: "flagged for review by Socket's classifier as anomalous",
  potentialVulnerability: "flagged for review as a possible vulnerability",
  didYouMean: "name is close to a more popular package",
  gptDidYouMean: "name is close to a more popular package",
  troll: "flagged for review as a joke or troll package",
  suspiciousStarActivity: "flagged for review over suspicious GitHub star activity",
  deprecated: "deprecated by its author",
  unmaintained: "not updated in a long time",
  unstableOwnership: "recent change of maintainer",
  newAuthor: "published by an author new to this package",
  missingAuthor: "has no author on the registry",
  recentlyPublished: "published very recently",
  gitDependency: "resolved from a git URL, not a registry",
  gitHubDependency: "resolved from GitHub, not a registry",
  httpDependency: "resolved over plain HTTP",
  floatingDependency: "pinned to a floating range, so installs drift",
  badSemverDependency: "declares a version range semver cannot read",
  missingLockfile: "no lockfile, so installs are not reproducible",
  shrinkwrap: "ships an npm-shrinkwrap that overrides the buyer's lockfile",
  manifestConfusion: "manifest disagrees with the published tarball",
  unpopularPackage: "very few downloads",
  trivialPackage: "trivially small",
  tooManyFiles: "ships an unusual number of files",
  unresolvedYarnDependency: "a dependency the yarn lockfile does not resolve",
  oversizedManifest: "an unusually large manifest",
  unresolvedPomReference: "a POM reference that does not resolve",
  ghaContextToSink: "a workflow passes untrusted context into a command",
  ghaArgToSink: "a workflow passes an input argument into a command",
  ghaEnvToSink: "a workflow passes an environment value into a command",
  ghaContextToEnv: "a workflow writes untrusted context into an environment variable",
  ghaContextToOutput: "a workflow writes untrusted context into a step output",
  ghaArgToEnv: "a workflow writes an input argument into an environment variable",
  ghaArgToOutput: "a workflow writes an input argument into a step output",
  criticalCVE: "has a known vulnerability",
  cve: "has a known vulnerability",
  mediumCVE: "has a known vulnerability",
  mildCVE: "has a known vulnerability",
  pendingScan: "Socket has not finished analysing this package",
  notFound: "Socket has no record of this package",
};

export function describeSocketAlert(type: string): string {
  return PHRASES[type] ?? type;
}

/** `@scope/name` where Socket splits the scope out, plain `name` where it does not. */
function fullName(artifact: SocketArtifact): string {
  const name = artifact.name ?? "";
  return artifact.namespace ? `${artifact.namespace}/${name}` : name;
}

/** GHSA first, CVE second — the ids OSV also keys on, so the two can be matched (§6.1). */
function advisoryIds(props: Record<string, unknown> | undefined): string[] {
  const ids: string[] = [];
  for (const key of ["ghsaId", "cveId"]) {
    const value = props?.[key];
    if (typeof value === "string" && value !== "") ids.push(value);
  }
  return ids;
}

/**
 * The stream, mapped. Pure — no clock, no network — so the whole table is testable from a
 * fixture. One finding per (artifact, alert); `packages` counts artifacts, which is what
 * goes on the check row and which will exceed the OSV row's count because Socket resolves
 * the transitive tree (§4.2).
 */
export function mapSocketArtifacts(lines: SocketArtifact[]): { findings: ScanFinding[]; packages: number; partial: boolean } {
  const findings: ScanFinding[] = [];
  let packages = 0;
  let partial = false;

  for (const artifact of lines) {
    if (artifact._type === "scores") continue;
    packages++;

    const name = fullName(artifact);
    const version = artifact.version;
    const qualifiers = [artifact.direct ? "direct" : "transitive", ...(artifact.dev ? ["dev only"] : [])].join(", ");
    const subject = [name, version].filter(Boolean).join(" ");

    for (const alert of artifact.alerts ?? []) {
      const rule = socketAlertRule(alert.type);
      if (rule.tier === "ignore") continue;
      if (rule.tier === "partial") {
        partial = true;
        continue;
      }

      const ids = rule.tier === "dedupe_cve" ? advisoryIds(alert.props) : [];
      const phrase = ids.length > 0 ? `${describeSocketAlert(alert.type)} ${ids.join(", ")}` : describeSocketAlert(alert.type);
      const tier: ScanTier = rule.tier === "dedupe_cve" ? "disclosed" : rule.tier;

      findings.push({
        kind: rule.group === "malware" ? "malware" : "behaviour",
        check: "dep_behaviour",
        tier,
        // §4.4: a Socket alert on a dependency is public — package, version, type,
        // severity, one line, and the direct/dev mark. Socket's `html_report_url` is not,
        // and is not read anywhere in this file: the badge must not depend on Socket.
        public: true,
        rule_id: alert.type,
        severity: rule.severity ?? socketSeverity(alert.severity),
        description: `${subject} (${qualifiers}) — ${phrase}`,
        blocking: tier === "blocking",
        package: {
          ecosystem: artifact.type ?? "unknown",
          name,
          ...(version ? { version } : {}),
          direct: artifact.direct === true,
          dev: artifact.dev === true,
        },
        ...(ids.length > 0 ? { advisory_ids: ids } : {}),
        source: SOCKET_TOOL,
      });
    }
  }

  return { findings, packages, partial };
}

/** One JSON object per line. A line that will not parse fails the whole read (§6.2). */
export function parseSocketNdjson(text: string): SocketArtifact[] {
  const out: SocketArtifact[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const value = JSON.parse(line) as unknown;
    if (typeof value !== "object" || value === null) throw new Error("socket ndjson line is not an object");
    out.push(value as SocketArtifact);
  }
  return out;
}

// --- transport -----------------------------------------------------------------------

/** `socket unconfigured` is a deployment fault, not a vendor one, and reads differently. */
export const SOCKET_REASONS = {
  auth: "socket auth",
  quota: "socket quota",
  processing: "socket processing",
  error: "socket error",
  unconfigured: "socket unconfigured",
} as const;

export function socketConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.SOCKET_TOKEN_VALUE) && Boolean(env.SOCKET_ORG_SLUG);
}

type Resolved = { fetchImpl: FetchLike; token: string; orgSlug: string; pollDelays: readonly number[]; now: () => number; deadlineMs?: number };

function resolve(deps: SocketDeps | undefined, env: Record<string, string | undefined> = process.env): Resolved | null {
  // `SOCKET_TOKEN_VALUE` is the secret half of the dashboard's pair. `SOCKET_TOKEN_HASH`
  // is the token's public id and is deliberately not read here or anywhere else.
  const token = deps?.token ?? env.SOCKET_TOKEN_VALUE;
  const orgSlug = deps?.orgSlug ?? env.SOCKET_ORG_SLUG;
  if (!token || !orgSlug) return null;
  return {
    fetchImpl: deps?.fetch ?? fetch,
    token,
    orgSlug,
    pollDelays: deps?.pollDelaysMs ?? SOCKET_POLL_DELAYS_MS,
    now: deps?.now ?? Date.now,
    ...(deps?.deadlineMs !== undefined ? { deadlineMs: deps.deadlineMs } : {}),
  };
}

/** Milliseconds left on the caller's deadline, or `Infinity` when it set none. */
function remainingMs(r: Resolved): number {
  return r.deadlineMs === undefined ? Number.POSITIVE_INFINITY : r.deadlineMs - r.now();
}

/**
 * A request we cannot start and finish inside the deadline is not started. One second is
 * the floor: below it the request is only a way to spend the last of somebody else's budget.
 */
const MIN_REQUEST_MS = 1_000;

async function socketFetch(r: Resolved, path: string, init: RequestInit = {}): Promise<Response> {
  // A vendor that stops answering must not hold the cut open, and a caller that is nearly
  // out of time gets the smaller ceiling. The abort surfaces on the same path a network
  // failure does, and both end as `socket error`.
  const budget = Math.min(SOCKET_TIMEOUT_MS, remainingMs(r));
  if (budget < MIN_REQUEST_MS) throw new Error("socket: past the caller's deadline");

  return r.fetchImpl(`${SOCKET_BASE_URL}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${r.token}`,
      accept: "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(budget),
  });
}

/**
 * Socket's 400 that is an **answer**, not an outage (14 Sep 2026).
 *
 * `pcmarts/crypto-balanced-portolio-builder` is a 256 KB repository with no `package.json`,
 * no lockfile, no `requirements.txt` — nothing any of the 55 supported-manifest globs the
 * preflight listed can match — and the archive endpoint says exactly that: `400
 * {"error":{"message":"No supported manifest files were found in the uploaded archive."}}`.
 * The failure table read every non-OK create as `unavailable · socket error`, so the rescan
 * kept the old row, the listing sat at "predates scanner 2026.09" for ever and the run's
 * notes blamed a vendor that had done nothing wrong. Socket looked and there was nothing to
 * analyse, which is a **pass with nothing in it**: no findings, no packages, no scan id to
 * store, nothing to poll and nothing to delete.
 */
export const SOCKET_NO_MANIFESTS = "no dependency manifests";
const NO_MANIFESTS_MESSAGE = /no supported manifest files/i;

/** How much of a vendor's message a reason carries: enough to diagnose, short enough to print. */
export const SOCKET_REASON_MESSAGE_MAX = 80;

/**
 * §6.2's failure table, as one function — and since 14 Sep 2026 it carries the vendor's own
 * words. Every non-OK response that was not a 401, a 403 or a 429 came back as the four
 * letters `socket error`, so "there is nothing here to analyse" and "come back later"
 * reached the operator as the same sentence. The status is always in the reason now, and
 * the message with it when the body is the uniform `{"error":{"message":…}}` that every
 * Socket error uses (§6.2, live shapes, 13 Sep 2026).
 *
 * **The prefix is load-bearing and the suffix is not.** `runSocket` (lib/scan/index.ts)
 * decides whether to spend seven units re-uploading an archive by asking whether the reason
 * is a `socket error`, `scanAlerts` (lib/release/index.ts) raises its two admin alerts off
 * `socket auth` and `socket quota`, and §7's repair queue looks for `socket processing`.
 * Every one of those is a `startsWith`, so a reason may grow a suffix and may never change
 * its first two words.
 *
 * 403 and 429 are both "you have no budget"; the `Retry-After` is recorded in the reason so
 * the operator and the cron can read how long the window has left without another call. A
 * 404 is a scan that is gone — `socket error (404)`, whose action in the table is "cron
 * re-uploads", which is the right move.
 */
async function reasonForResponse(response: Response): Promise<string> {
  if (response.status === 401) return SOCKET_REASONS.auth;
  if (response.status === 403 || response.status === 429) {
    const after = response.headers.get("retry-after")?.trim();
    return after ? `${SOCKET_REASONS.quota} (retry after ${after})` : SOCKET_REASONS.quota;
  }
  return errorReason(response.status, await socketErrorMessage(response));
}

function errorReason(status: number, message: string | null): string {
  return message ? `${SOCKET_REASONS.error} (${status}: ${message})` : `${SOCKET_REASONS.error} (${status})`;
}

/**
 * The one place an error body is read. Socket's bodies are `{"error":{"message":…}}` and
 * nothing else — a body that is HTML, empty or shaped any other way reads as no message
 * rather than as text to paste onto a listing page — and the message is collapsed to one
 * line and truncated, because a reason is a diagnosis and not a paragraph.
 *
 * Reading the body is safe here and only here: every caller is already on the failure path
 * and has no further use for the response.
 */
async function socketErrorMessage(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    const message = body?.error?.message;
    if (typeof message !== "string") return null;
    const line = message.replace(/\s+/g, " ").trim();
    if (line === "") return null;
    return line.length > SOCKET_REASON_MESSAGE_MAX ? `${line.slice(0, SOCKET_REASON_MESSAGE_MAX)}…` : line;
  } catch {
    return null;
  }
}

function isoAt(now: () => number): string {
  return new Date(now()).toISOString();
}

function row(at: string, fields: Partial<ScanCheck>): ScanCheck {
  return {
    id: "dep_behaviour",
    tool: SOCKET_TOOL,
    // §4.2: the feed's date is the version of a vendor check. Socket has no ruleset
    // number to publish, so the day it ran is the honest answer to "which rules".
    tool_version: at.slice(0, 10),
    status: "unavailable",
    at,
    findings: 0,
    ...fields,
  };
}

function unavailable(at: string, reason: string, scanId?: string): SocketScanResult {
  return { check: row(at, { status: "unavailable", reason, ...(scanId ? { socket_scan_id: scanId } : {}) }), findings: [] };
}

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((done) => setTimeout(done, ms)) : Promise.resolve());

/** `{quota, maxQuota, nextWindowRefresh}`. Costs nothing, so it runs before every create. */
export async function socketQuota(deps?: SocketDeps): Promise<{ quota: number; maxQuota: number; nextWindowRefresh: string | null } | null> {
  const r = resolve(deps);
  if (!r) return null;
  try {
    const response = await socketFetch(r, "/quota");
    if (!response.ok) return null;
    const body = (await response.json()) as { quota?: number; maxQuota?: number; nextWindowRefresh?: string | null };
    if (typeof body.quota !== "number" || typeof body.maxQuota !== "number") return null;
    // Live 13 Sep 2026: an untouched window answers `nextWindowRefresh: null`, so the
    // field is nullable and a caller may not treat its absence as an error.
    return { quota: body.quota, maxQuota: body.maxQuota, nextWindowRefresh: body.nextWindowRefresh ?? null };
  } catch {
    return null;
  }
}

/**
 * §6.2 steps 1–5, cut-time. Returns the `dep_behaviour` row and its findings; on any
 * transport trouble it returns the row `unavailable` with a reason from the failure table
 * and the release cuts anyway. The only exceptions that escape are programmer errors.
 */
export async function socketFullScan(input: SocketFullScanInput, deps?: SocketDeps): Promise<SocketScanResult> {
  const nowFn = deps?.now ?? Date.now;
  const r = resolve(deps);
  if (!r) return unavailable(isoAt(nowFn), SOCKET_REASONS.unconfigured);

  const at = isoAt(r.now);

  // 0. Quota, at no cost. Under a tenth of the window, the cut spends nothing: a release
  //    with an unavailable Socket row still sells (§4.1), a 429 mid-scan wastes a unit.
  let quotaResponse: Response;
  try {
    quotaResponse = await socketFetch(r, "/quota");
  } catch {
    return unavailable(at, SOCKET_REASONS.error);
  }
  if (!quotaResponse.ok) return unavailable(at, await reasonForResponse(quotaResponse));
  let quota: { quota?: number; maxQuota?: number };
  try {
    quota = (await quotaResponse.json()) as { quota?: number; maxQuota?: number };
  } catch {
    return unavailable(at, SOCKET_REASONS.error);
  }
  if (typeof quota.quota === "number" && typeof quota.maxQuota === "number" && quota.maxQuota > 0 && quota.quota / quota.maxQuota < SOCKET_QUOTA_FLOOR) {
    return unavailable(at, SOCKET_REASONS.quota);
  }

  // 1. Create. The archive route when Socket can extract it, the manifest route when the
  //    snapshot is over Socket's 10,000-file extraction limit and we can name the files.
  const useManifests = input.fileCount > SOCKET_MAX_ARCHIVE_FILES && input.manifestFiles !== undefined && input.manifestFiles.size > 0;
  const query = new URLSearchParams({ repo: input.listingId, branch: `v${input.version}`, integration_type: "api", tmp: "true" });
  if (input.commitSha) query.set("commit_hash", input.commitSha);

  const form = new FormData();
  if (useManifests) {
    // Step 1′: only the manifests, each under its own path as the field name — which is
    // how Socket learns where in the tree the file sat.
    for (const [path, text] of input.manifestFiles!) form.append(path, new Blob([text], { type: "text/plain" }), path);
  } else {
    // The artifact is uploaded as whatever it *was written as*, not as whatever today's
    // writer would produce (14 Sep 2026). The three `examples/*` releases were cut hours
    // before DECISIONS 2026-08-30 chose zip and are still gzip in Storage; Socket's archive
    // endpoint takes `.tar`, `.tar.gz` and `.zip` and reads the filename, so a tarball sent
    // as `….zip` is refused for being what it honestly is. One sniff, shared with §7's
    // reader (`archiveFormat`, lib/scan/archive.ts), so the two cannot disagree.
    const gzip = archiveFormat(input.archive) === "tar.gz";
    form.append(
      SOCKET_ARCHIVE_FIELD,
      new Blob([input.archive as BlobPart], { type: gzip ? "application/gzip" : "application/zip" }),
      `${input.listingId}-${input.version}${gzip ? ".tar.gz" : ".zip"}`,
    );
  }

  let created: Response;
  try {
    created = await socketFetch(r, `/orgs/${encodeURIComponent(r.orgSlug)}/full-scans${useManifests ? "" : "/archive"}?${query}`, { method: "POST", body: form });
  } catch {
    return unavailable(at, SOCKET_REASONS.error);
  }
  if (!created.ok) {
    // The 400 that is an answer. See {@link SOCKET_NO_MANIFESTS}: a repository with no
    // dependency manifests is not an outage, it is a clean row with nothing behind it.
    if (created.status === 400) {
      const message = await socketErrorMessage(created);
      if (message && NO_MANIFESTS_MESSAGE.test(message)) {
        return { check: row(at, { status: "pass", findings: 0, packages: 0, reason: SOCKET_NO_MANIFESTS }), findings: [] };
      }
      return unavailable(at, errorReason(400, message));
    }
    return unavailable(at, await reasonForResponse(created));
  }

  let createdBody: { id?: string; full_scan_id?: string; unmatchedFiles?: string[]; unmatched_files?: string[] };
  try {
    createdBody = (await created.json()) as typeof createdBody;
  } catch {
    return unavailable(at, SOCKET_REASONS.error);
  }
  const scanId = createdBody.id ?? createdBody.full_scan_id;
  if (!scanId) return unavailable(at, SOCKET_REASONS.error);
  const unmatchedFiles = createdBody.unmatchedFiles ?? createdBody.unmatched_files;

  // 2–4. Poll the stream, map it, then delete. The id is kept on the row whatever happens
  //      next, so the cron can finish or sweep the scan without re-uploading.
  //
  //      **`partial` is not deleted** (fixed 13 Sep 2026). A `partial` row is Socket saying
  //      some packages were still `pendingScan`/`notFound`, and §7's repair queue re-reads
  //      exactly that scan from the id for one unit. Deleting it while keeping the id left
  //      the cron re-reading a scan Socket no longer had — a 404, `socket error`, and a
  //      seven-unit re-upload every night for a row that only needed finishing.
  const read = await pollAndMap(r, scanId, at);
  if (read.check.status !== "unavailable" && read.check.status !== "partial") await deleteSocketScan(scanId, deps);
  return { ...read, ...(unmatchedFiles && unmatchedFiles.length > 0 ? { unmatchedFiles } : {}) };
}

/**
 * §7 repair path: finish a row left at `socket processing`. One GET, no create, 1 unit —
 * the reason the id is stored in the first place. The delete is the caller's to issue, so
 * a cron can re-read a scan more than once before letting go of it.
 */
export async function readSocketScan(scanId: string, deps?: SocketDeps): Promise<SocketScanResult> {
  const nowFn = deps?.now ?? Date.now;
  const r = resolve(deps);
  if (!r) return unavailable(isoAt(nowFn), SOCKET_REASONS.unconfigured, scanId);
  return pollAndMap(r, scanId, isoAt(r.now), 1);
}

/**
 * `202 {status:"processing"}` until it is done, `200 application/x-ndjson` when it is. The
 * metadata endpoint's `scan_state` enum has no terminal value (§6.2 step 2), so the stream's
 * status code is the only completion signal there is.
 */
async function pollAndMap(r: Resolved, scanId: string, at: string, attempts?: number): Promise<SocketScanResult> {
  const delays = attempts === undefined ? r.pollDelays : new Array<number>(attempts).fill(0);
  const path = `/orgs/${encodeURIComponent(r.orgSlug)}/full-scans/${encodeURIComponent(scanId)}?include_scores=false&include_license_details=false`;

  for (const delay of delays) {
    // The deadline ends the poll loop the same way running out of polls does — `socket
    // processing`, id kept — rather than as an abort the failure table would read as
    // `socket error` and answer by re-uploading an archive we have already paid for.
    if (delay + MIN_REQUEST_MS > remainingMs(r)) break;
    await sleep(delay);

    let response: Response;
    try {
      response = await socketFetch(r, path, { headers: { accept: "application/x-ndjson" } });
    } catch {
      return unavailable(at, SOCKET_REASONS.error, scanId);
    }
    if (response.status === 202) continue;
    if (!response.ok) return unavailable(at, await reasonForResponse(response), scanId);

    let artifacts: SocketArtifact[];
    try {
      artifacts = parseSocketNdjson(await response.text());
    } catch {
      return unavailable(at, SOCKET_REASONS.error, scanId);
    }

    const { findings, packages, partial } = mapSocketArtifacts(artifacts);
    const failed = findings.some((f) => f.blocking);
    return {
      check: row(at, {
        status: failed ? "fail" : partial ? "partial" : findings.length > 0 ? "findings" : "pass",
        findings: findings.length,
        packages,
        socket_scan_id: scanId,
        // §4.2: `partial` is Socket's own admission that some packages were still
        // `pendingScan`/`notFound`. It is a gap with a reason, retried by the cron.
        ...(partial ? { reason: SOCKET_REASONS.processing } : {}),
      }),
      findings,
    };
  }

  // Still 202 after the whole budget. The id is the whole point of storing it.
  return unavailable(at, SOCKET_REASONS.processing, scanId);
}

/**
 * Best effort, and deliberately so: `tmp=true` scans that pile up under the org are an
 * operational annoyance, not a correctness problem, and a failed delete must never turn a
 * good read into an unavailable row. The id stays on the check row and the cron sweeps it.
 */
export async function deleteSocketScan(scanId: string, deps?: SocketDeps): Promise<boolean> {
  const r = resolve(deps);
  if (!r) return false;
  try {
    const response = await socketFetch(r, `/orgs/${encodeURIComponent(r.orgSlug)}/full-scans/${encodeURIComponent(scanId)}`, { method: "DELETE" });
    return response.ok;
  } catch {
    return false;
  }
}
