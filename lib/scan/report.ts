/**
 * lib/scan/report.ts — the trust report's shape (report v2).
 *
 * "PRD Trust Report.md" §4.2 (accepted 13 Sep 2026): the scan publishes what it checked,
 * per check, and discloses what it found in three tiers. This file is the contract every
 * scan module writes to and every surface reads from — `lib/scan/index.ts` assembles a
 * report from the modules, `lib/release/index.ts` stores it on `release.scan_report`, and
 * the manifest, the listing page, the dashboard and `VersionResponse` read it back.
 *
 * Nothing here calls anything. Types, the two constants that name the tiers and the
 * check ids, and the v1 → v2 shim for reports written before `checks[]` existed.
 *
 * The rule that keeps the tiers honest (§4.1): `blocking` fails the release and is the
 * small set of absolutes — secrets, HIGH/CRITICAL CVEs, size caps, a dependency *known*
 * to be malicious, instruction smuggling. `disclosed` sells and is shown. `review` is a
 * model-derived flag from Socket (`gpt*`, `skill*`): shown as "flagged for review", never
 * a verdict, and it raises an admin alert. No finding this codebase computes itself is
 * ever `review` — our own rules are deterministic and stand behind what they say.
 */

/** Which check a finding belongs to. One row per id on every report, ran or not. */
export type ScanCheckId =
  | "secrets" //        lib/scan/secrets.ts — our gitleaks-derived ruleset
  | "limits" //         §6 size / file-count / zip-bomb caps
  | "known_vulns" //    OSV advisories (CVE/GHSA), lib/scan/osv.ts
  | "known_malware" //  OSV `MAL-` records (ossf/malicious-packages), same query
  | "dep_behaviour" //  Socket full scan of the artifact's dependency manifests
  | "capabilities" //   lib/scan/capabilities.ts — what the artifact's own files can do
  | "injection"; //     lib/scan/injection.ts — instruction smuggling in .md / tool text

export const SCAN_CHECK_IDS: readonly ScanCheckId[] = [
  "secrets",
  "limits",
  "known_vulns",
  "known_malware",
  "dep_behaviour",
  "capabilities",
  "injection",
] as const;

export type ScanTier = "blocking" | "disclosed" | "review";

/**
 * `pass` ran clean · `findings` ran and found something non-blocking · `fail` ran and
 * found something blocking · `unavailable` could not run (vendor down, over quota, still
 * processing at cut time) and the rescan cron retries it · `partial` ran but Socket had
 * not finished analysing every package (`pendingScan` / `notFound`), retried likewise.
 */
export type ScanCheckStatus = "pass" | "findings" | "fail" | "unavailable" | "partial";

export type ScanCheck = {
  id: ScanCheckId;
  /** The thing that ran, e.g. `x402git/secrets`, `osv.dev`, `socket.dev`. Public. */
  tool: string;
  /** The ruleset or feed version the row was produced with. Public. */
  tool_version: string;
  status: ScanCheckStatus;
  /** ISO time this row was produced — a rescan rewrites it, `scanned_at` stays. */
  at: string;
  /** Count of findings on this row, every tier. */
  findings: number;
  /** Packages examined, for the dependency rows. Socket's count exceeds OSV's (transitives). */
  packages?: number;
  /**
   * Why `unavailable` / `partial`: `socket quota`, `socket error (503)`, `osv unreachable`…
   * A `pass` may carry one too, and exactly one does: `no dependency manifests`, Socket's
   * answer for a repository that declares none (14 Sep 2026).
   */
  reason?: string;
  /** Socket full-scan id, kept so the cron can finish or re-read it. Never public. */
  socket_scan_id?: string;
};

export type ScanSeverity = "CRITICAL" | "HIGH" | "MODERATE" | "LOW" | "UNKNOWN";

export type ScanFindingKind =
  | "secret"
  | "vulnerability"
  | "limit"
  | "malware" //     a dependency known to be malicious (OSV MAL- or Socket `malware`)
  | "behaviour" //   what a dependency does (Socket capability / hygiene / review alerts)
  | "capability" //  what the artifact's own files can do
  | "injection"; //  instruction smuggling in the artifact's own text

/** A package a finding is about. `direct`/`dev` come from Socket's tree; OSV has neither. */
export type ScanPackageRef = {
  ecosystem: string;
  name: string;
  version?: string;
  direct?: boolean;
  dev?: boolean;
};

export type ScanFinding = {
  kind: ScanFindingKind;
  check: ScanCheckId;
  tier: ScanTier;
  /**
   * §4.4: whether this finding goes on the manifest, the page and `VersionResponse`.
   * Secrets are never public. Injection findings are public as a count, so the finding
   * itself is `public: false` and only the check row's count shows. Everything else is.
   */
  public: boolean;
  rule_id: string;
  severity: ScanSeverity;
  description: string;
  path?: string;
  line?: number;
  /** True when this finding, on its own, fails the release. Equivalent to `tier === "blocking"`. */
  blocking: boolean;
  package?: ScanPackageRef;
  /** GHSA / CVE / MAL ids, so Socket's CVE alerts de-duplicate against OSV by id. */
  advisory_ids?: string[];
  /** The tool that produced it when the check has more than one (`osv.dev`, `socket.dev`). */
  source?: string;
  /**
   * Set only on a row `publishedFindings` folded (§4.4, amended 14 Sep 2026). A folded row
   * stands for every transitive package that tripped one rule, so it has no `package` of
   * its own and carries the tally and three names instead. Never written by a scan module:
   * `report.findings` is always the unfolded truth.
   */
  aggregate?: { packages: number; examples: string[] };
};

/** One entry the artifact's files can run. */
export type CapabilityRun = {
  path: string;
  kind: "script" | "hook" | "mcp_server" | "install_script" | "workflow" | "make" | "build_hook";
  /** The hook event, the MCP command, the npm lifecycle name — one short line. */
  detail?: string;
};

export type CapabilityHost = {
  host: string;
  /** `localhost`, `127.0.0.1`, `::1`, `0.0.0.0`, `*.local`. Kept and labelled, never dropped. */
  local: boolean;
  /** Hosts in code/config are "talks to"; hosts in README/docs are "documentation links". */
  from: "code" | "docs";
  paths: string[];
};

/**
 * §4.3 — "Permissions required", computed. An empty inventory is a claim in itself, and
 * `summary` says it in words: "No tools, no hosts, no environment variables, nothing runs
 * at install."
 */
export type Capabilities = {
  /** Claude Code tools from `allowed-tools:` frontmatter and `.claude/settings.json` allow lists. */
  tools: { name: string; from: string }[];
  runs: CapabilityRun[];
  hosts: CapabilityHost[];
  env: { name: string; paths: string[] }[];
  /** True when something executes at install time (npm lifecycle scripts, setup.py, build hooks). */
  install_runs: boolean;
  summary: string;
};

export type ScanReportCounts = {
  secrets: number;
  vulnerabilities: number;
  blocking: number;
  disclosed: number;
  review: number;
};

export type ScanReport = {
  version: 2;
  /**
   * The release verdict at cut time, mirrored here so a reader holding only the report
   * (the rescan cron, an export) knows it. `release.scan` and `manifest.computed.scan`
   * remain the authorities; a rescan never rewrites this (§7).
   */
  verdict?: "pass" | "fail" | "incomplete";
  scanner_version: string;
  /** Cut-time. Never rewritten. */
  scanned_at: string;
  checks: ScanCheck[];
  findings: ScanFinding[];
  capabilities?: Capabilities;
  counts: ScanReportCounts;
  /** v1 compatibility: the ids of checks whose status is not `unavailable`. Derived. */
  checked: string[];
  packages_scanned: number;
  /** FR-4: creator ids whose key — agent or session (FR-60) — was found here and revoked. */
  revoked_creator_ids?: string[];
  /** Set when OSV was unreachable. A gap is recorded, never hidden. */
  osv_error?: string;
  /** §7: the last time the dependency rows were refreshed by the rescan cron. */
  advisories_refreshed_at?: string;
  /** Files we uploaded that Socket did not recognise as manifests, from the create response. */
  socket_unmatched_files?: string[];
};

/** The shape stored before 13 Sep 2026. Read-only; `normalizeReport` lifts it to v2. */
export type ScanReportV1 = {
  scanner_version: string;
  scanned_at: string;
  findings: {
    kind: "secret" | "vulnerability" | "limit";
    rule_id: string;
    severity: ScanSeverity;
    description: string;
    path?: string;
    line?: number;
    blocking: boolean;
  }[];
  counts: { secrets: number; vulnerabilities: number; blocking: number };
  checked: string[];
  packages_scanned: number;
  revoked_creator_ids?: string[];
  osv_error?: string;
};

export function isReportV2(report: unknown): report is ScanReport {
  return typeof report === "object" && report !== null && (report as { version?: unknown }).version === 2;
}

/**
 * A v1 report becomes a v2 report with the rows it can vouch for: `secrets` and `limits`
 * from `checked`, `known_vulns` from `checked`/`osv_error`. The rows v1 never ran
 * (`known_malware`, `dep_behaviour`, `capabilities`, `injection`) are `unavailable` with
 * `reason: "predates scanner 2026.09"`, so a badge from that era says what it did not do
 * rather than pretending. Every finding gets `check`, `tier` and `public` by its kind.
 */
export function normalizeReport(report: ScanReport | ScanReportV1 | null | undefined): ScanReport | null {
  if (!report) return null;
  if (isReportV2(report)) return report;

  const v1 = report as ScanReportV1;
  const at = v1.scanned_at;
  const findings: ScanFinding[] = v1.findings.map((f) => {
    const check: ScanCheckId = f.kind === "secret" ? "secrets" : f.kind === "limit" ? "limits" : "known_vulns";
    return {
      ...f,
      check,
      tier: f.blocking ? "blocking" : "disclosed",
      public: f.kind !== "secret",
    };
  });
  const count = (id: ScanCheckId) => findings.filter((f) => f.check === id).length;
  const row = (id: ScanCheckId, tool: string, ran: boolean, reason?: string): ScanCheck => {
    const n = count(id);
    const blocking = findings.some((f) => f.check === id && f.blocking);
    return {
      id,
      tool,
      tool_version: v1.scanner_version,
      status: !ran ? "unavailable" : blocking ? "fail" : n > 0 ? "findings" : "pass",
      at,
      findings: n,
      ...(reason ? { reason } : {}),
    };
  };
  const ranOsv = v1.checked.includes("dependency_cves") && !v1.osv_error;
  const predates = "predates scanner 2026.09";
  const checks: ScanCheck[] = [
    row("secrets", "x402git/secrets", v1.checked.includes("secrets")),
    row("limits", "x402git/limits", v1.checked.includes("size_limits")),
    { ...row("known_vulns", "osv.dev", ranOsv, ranOsv ? undefined : v1.osv_error ?? "osv unreachable"), packages: v1.packages_scanned },
    row("known_malware", "osv.dev/MAL", false, predates),
    row("dep_behaviour", "socket.dev", false, predates),
    row("capabilities", "x402git/caps", false, predates),
    row("injection", "x402git/inject", false, predates),
  ];
  return {
    version: 2,
    scanner_version: v1.scanner_version,
    scanned_at: at,
    checks,
    findings,
    counts: {
      secrets: v1.counts.secrets,
      vulnerabilities: v1.counts.vulnerabilities,
      blocking: v1.counts.blocking,
      disclosed: findings.filter((f) => f.tier === "disclosed").length,
      review: 0,
    },
    checked: checks.filter((c) => c.status !== "unavailable").map((c) => c.id),
    packages_scanned: v1.packages_scanned,
    ...(v1.revoked_creator_ids ? { revoked_creator_ids: v1.revoked_creator_ids } : {}),
    ...(v1.osv_error ? { osv_error: v1.osv_error } : {}),
  };
}

/** The findings a surface may show to someone who is not the creator (§4.4). */
export function publicFindings(report: ScanReport): ScanFinding[] {
  return report.findings.filter((f) => f.public);
}

/** How many `name@version` examples a folded row carries. Three is a sample, not a list. */
export const FOLD_EXAMPLES = 3;

/**
 * The findings the *public* surfaces carry — `publicFindings` with the transitive
 * dependency noise folded (§4.4, amended 14 Sep 2026).
 *
 * The first Socket backfill ran on `pcmarts/acl-recovery-tracker` on 14 Sep 2026: 545
 * packages, 1,209 `dep_behaviour` findings, of which 447 were `networkAccess` (418 of them
 * on transitive packages), 364 `envVars`, 106 `filesystemAccess`. Published one row each,
 * that was 844 KB of listing HTML and a manifest an agent pays to read. §4.1 had already
 * warned that "every real Node project has an `installScripts` transitive"; the tiering was
 * right and the publication was not. Nobody reads 418 identical lines and nobody should be
 * charged for them.
 *
 * So: everything that is not a `dep_behaviour` finding is published as it always was, and
 * within `dep_behaviour` a finding is published on its own when
 *
 *   - it is on a **direct** dependency — that is the one a buyer can act on, and 29 of
 *     the 447 were;
 *   - it is **blocking** — a dependency known to be malicious is never a tally; or
 *   - it names **no package at all**, which leaves nothing to count it by.
 *
 * Everything else folds to one row per `rule_id`, with `package` omitted and `aggregate`
 * carrying the number of distinct packages and three of their names. A rule that caught a
 * single package is left alone: a fold of one is a longer way of saying the same thing,
 * and the schema's `packages >= 2` says so too.
 *
 * **The report is untouched.** `release.scan_report.findings` keeps all 1,209 — the
 * creator's dashboard and `GET /api/listings/:id` read it in full — and so do `counts`:
 * `disclosed: 1175` is a fact about the scan, not about the page.
 */
export function publishedFindings(report: ScanReport): ScanFinding[] {
  const alone: ScanFinding[] = [];
  const groups = new Map<string, ScanFinding[]>();

  for (const finding of publicFindings(report)) {
    if (finding.check !== "dep_behaviour" || finding.blocking || !finding.package || finding.package.direct === true) {
      alone.push(finding);
      continue;
    }
    const group = groups.get(finding.rule_id);
    if (group) group.push(finding);
    else groups.set(finding.rule_id, [finding]);
  }

  const folded: ScanFinding[] = [];
  for (const [rule_id, group] of groups) {
    // Distinct packages, not findings: `aggregate.packages` is counted in the noun it is
    // named after, so the page's "418 transitive packages" is true of the packages.
    const names = [...new Set(group.map(packageSubject))];
    if (names.length < 2) {
      alone.push(...group);
      continue;
    }
    const first = group[0];
    folded.push({
      kind: first.kind,
      check: first.check,
      tier: first.tier,
      public: true,
      rule_id,
      severity: first.severity,
      // §4.1: a `review` row is a classifier's opinion and never a verdict, so the folded
      // sentence says whose opinion it is rather than naming the rule as if it were a fact.
      description:
        first.tier === "review"
          ? `flagged for review by Socket's classifier in ${names.length} transitive packages`
          : `${rule_id} in ${names.length} transitive packages`,
      blocking: false,
      aggregate: { packages: names.length, examples: names.slice(0, FOLD_EXAMPLES) },
      ...(first.source ? { source: first.source } : {}),
    });
  }

  // Review first (it is the one somebody has to look at), then severity, then the biggest
  // tally, then the rule id so two equal rows never swap places between two writes.
  folded.sort(
    (a, b) =>
      Number(b.tier === "review") - Number(a.tier === "review") ||
      SEVERITY_RANK.indexOf(a.severity) - SEVERITY_RANK.indexOf(b.severity) ||
      (b.aggregate?.packages ?? 0) - (a.aggregate?.packages ?? 0) ||
      a.rule_id.localeCompare(b.rule_id),
  );
  return [...alone, ...folded];
}

const SEVERITY_RANK: readonly ScanSeverity[] = ["CRITICAL", "HIGH", "MODERATE", "LOW", "UNKNOWN"];

/** `lodash@4.17.20`, or the bare name when Socket gave no version. */
function packageSubject(finding: ScanFinding): string {
  const pkg = finding.package;
  if (!pkg) return finding.rule_id;
  return pkg.version ? `${pkg.name}@${pkg.version}` : pkg.name;
}

/**
 * §4.1's three tiers as three numbers — the `counts` block a *published* scan carries.
 *
 * Not `ScanReportCounts`: `secrets` and `vulnerabilities` are the creator's numbers and
 * the manifest is public JSON, so a manifest that carried `secrets: 1` would announce the
 * existence of the secret whose path §4.4 is careful never to print. One helper because
 * there are two writers — `manifestScan` at cut time (lib/release/index.ts) and
 * `withRefreshedScan` on the §7 rescan — and on 13 Sep 2026 they disagreed: the rescan
 * republished the whole five-key object, so a manifest gained two keys the schema does not
 * have the first time the cron touched it.
 */
export function publicCounts(report: ScanReport): { blocking: number; disclosed: number; review: number } {
  return { blocking: report.counts.blocking, disclosed: report.counts.disclosed, review: report.counts.review };
}

/** The check rows minus the fields that are ours alone (`socket_scan_id`). */
export function publicChecks(report: ScanReport): Omit<ScanCheck, "socket_scan_id">[] {
  return report.checks.map(({ socket_scan_id: _omit, ...rest }) => rest);
}
