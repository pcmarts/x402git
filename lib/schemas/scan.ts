/**
 * lib/schemas/scan.ts — the trust report on the wire.
 *
 * "PRD Trust Report.md" §4.2 and §4.4 (accepted 13 Sep 2026). `lib/scan/report.ts` is the
 * shape the scanner writes; this is the same shape as published zod, split in two by the
 * one rule that matters — §4.4, what a reader who is not the creator may see.
 *
 *   - `PublicScanCheck` / `PublicScanFinding` / `Capabilities` go on the manifest
 *     (`computed.scan`, FR-49), on the listing page and in `VersionResponse`. The check
 *     rows lose `socket_scan_id`, which is ours alone, and only findings the scanner
 *     marked `public` are ever put in one.
 *   - `CreatorScanReport` is the whole of it, secrets included, and is served only from
 *     `GET /api/listings/:id` behind the creator's own key. Path and line on a secret are
 *     the creator's own file; withholding them is what docs/BACKLOG.md complains about.
 *
 * **Every date here is a plain `z.string()`, not `IsoDateTime`**, for the reason
 * `ManifestRepoMeta` gives: a manifest that fails to parse is dropped whole by
 * `manifestFor`, and no disclosure row is worth losing a file tree over. The one stamped
 * date the page depends on — `ScanInfo.at` — keeps its format check, because it predates
 * this file and the badge has always carried it.
 *
 * Nothing in this file is required. The producer side (`scanArtifact`, phases 2a/2b of
 * §9) lands after these surfaces do, so a manifest written this morning validates
 * unchanged and the page prints the rows it has.
 */

import * as z from "zod";

/** §4.2. One row per id on every report, ran or not. Mirrors `ScanCheckId`. */
export const ScanCheckId = z.enum(["secrets", "limits", "known_vulns", "known_malware", "dep_behaviour", "capabilities", "injection"]).meta({
  id: "ScanCheckId",
  description: "Which check a finding belongs to. The report carries one row per id whether or not it ran.",
});

/**
 * §4.1. `unavailable` and `partial` are the honest gaps: a vendor was down, over quota,
 * or had not finished analysing every package when the release was cut. The rescan cron
 * (§7) retries both; neither blocks a sale.
 */
export const ScanCheckStatus = z.enum(["pass", "findings", "fail", "unavailable", "partial"]).meta({
  id: "ScanCheckStatus",
  description: "pass · findings · fail · unavailable (could not run, retrying) · partial (ran, some packages still pending).",
});

export const ScanTier = z.enum(["blocking", "disclosed", "review"]).meta({
  id: "ScanTier",
  description:
    "§4.1. `blocking` fails the release. `disclosed` sells and is shown. `review` is a model-derived flag from a vendor — shown as flagged for review, never a verdict.",
});

export const ScanSeverity = z.enum(["CRITICAL", "HIGH", "MODERATE", "LOW", "UNKNOWN"]).meta({ id: "ScanSeverity" });

export const ScanFindingKind = z
  .enum(["secret", "vulnerability", "limit", "malware", "behaviour", "capability", "injection"])
  .meta({ id: "ScanFindingKind" });

export const ScanPackageRef = z
  .object({
    ecosystem: z.string(),
    name: z.string(),
    version: z.string().optional(),
    /** From the dependency tree. OSV knows neither, so both are absent on its findings. */
    direct: z.boolean().optional(),
    dev: z.boolean().optional(),
  })
  .meta({ id: "ScanPackageRef", description: "The package a dependency finding is about." });

/** §4.2's check row, minus `socket_scan_id` — that one is ours and never leaves. */
export const PublicScanCheck = z
  .object({
    id: ScanCheckId,
    /** The thing that ran: `x402git/secrets`, `osv.dev`, `socket.dev`. */
    tool: z.string(),
    /** The ruleset or feed version this row was produced with. */
    tool_version: z.string(),
    status: ScanCheckStatus,
    /** When this row was produced. A rescan rewrites it; the report's `scanned_at` stays. */
    at: z.string(),
    findings: z.number().int().nonnegative(),
    /** Packages examined, on the dependency rows. */
    packages: z.number().int().nonnegative().optional(),
    /**
     * Why the row is what it is, in the scanner's words: `socket quota`, `socket error
     * (503)`, `osv unreachable` — and, on the one `pass` that carries a reason,
     * `no dependency manifests`.
     */
    reason: z.string().optional(),
  })
  .meta({
    id: "ScanCheck",
    description: "§4.2. One check, what ran it, at what version, and what it found. The vendor scan id is never published.",
  });

/**
 * §4.4. A finding a reader who is not the creator may see.
 *
 * `path` and `line` are here because a capability finding is *about* a path — "a
 * .claude hook on PostToolUse" is the path or it is nothing. They are absent on the two
 * kinds that are never public in the first place: a secret (a path and a line is a map
 * for anyone who cloned before the tag) and an injection match (whose text would tell
 * the next creator exactly what to avoid).
 */
const ScanFindingShape = z.object({
  kind: ScanFindingKind,
  check: ScanCheckId,
  tier: ScanTier,
  rule_id: z.string(),
  severity: ScanSeverity,
  description: z.string(),
  path: z.string().optional(),
  line: z.number().int().nonnegative().optional(),
  package: ScanPackageRef.optional(),
  /** GHSA / CVE / MAL ids, so the same advisory is never shown twice under two names. */
  advisory_ids: z.array(z.string()).optional(),
  /** The tool that produced it, when the check has more than one. */
  source: z.string().optional(),
});

/**
 * §4.4's two kinds that are never public, as a rule the schema enforces rather than a
 * sentence the comment above asks for (13 Sep 2026).
 *
 * The object above strips `public`, `blocking` and `match_length` — the fields the producer
 * marks a secret with — and keeps `kind`, `path` and `line`, which is exactly the shape of
 * a secret finding with the evidence that it was one removed. Anything upstream that
 * mislabelled a secret `public: true` therefore serialised cleanly onto public JSON as
 * `{kind: "secret", path: "src/config.ts", line: 12}`: a map, on the manifest, validated.
 * Two producers already get this right; a schema that cannot state the invariant is one
 * refactor away from being the only thing that was holding it.
 */
/**
 * §4.4 amendment, 14 Sep 2026: what a folded row carries instead of a package.
 *
 * `publishedFindings` (lib/scan/report.ts) folds the transitive `dep_behaviour` findings
 * to one row per rule, because the first Socket backfill published 418 identical
 * `networkAccess` lines and made an 844 KB listing page out of them. `packages` is the
 * count of distinct packages the rule caught and `examples` is three of their names, so
 * the row is still checkable without being a list.
 *
 * `packages` is at least 2 by construction: a rule that caught one package is published
 * as that package, and a fold of one would be a longer way of saying the same thing.
 */
export const ScanFindingAggregate = z
  .object({
    packages: z.number().int().min(2),
    /** Up to three `name@version` samples. Never the whole set — that is the point. */
    examples: z.array(z.string()),
  })
  .meta({ id: "ScanFindingAggregate", description: "§4.4. The tally behind a folded finding: how many transitive packages tripped the rule, and three of them." });

export const PublicScanFinding = ScanFindingShape.extend({
  /** Present only on a folded row, and then `package` is absent. */
  aggregate: ScanFindingAggregate.optional(),
})
  .refine((f) => f.kind !== "secret" && f.kind !== "injection", {
    error: "a secret or injection finding is never public (§4.4)",
  })
  .meta({ id: "ScanFinding", description: "§4.4. A disclosed finding. Secrets and injection matches never appear here." });

export const CapabilityRun = z
  .object({
    path: z.string(),
    kind: z.enum(["script", "hook", "mcp_server", "install_script", "workflow", "make", "build_hook"]),
    /** The hook event, the MCP command, the npm lifecycle name — one short line. */
    detail: z.string().optional(),
  })
  .meta({ id: "CapabilityRun" });

export const CapabilityHost = z
  .object({
    host: z.string(),
    /** `localhost`, `127.0.0.1`, `::1`, `0.0.0.0`, `*.local`. Kept and labelled, never dropped. */
    local: z.boolean(),
    /** Hosts in code and config are "talks to"; hosts in prose are documentation links. */
    from: z.enum(["code", "docs"]),
    paths: z.array(z.string()),
  })
  .meta({ id: "CapabilityHost" });

/**
 * §4.3 — "Permissions required", computed from the snapshot and never self-reported.
 *
 * The empty inventory is the point: `summary` says it in words, and that sentence is a
 * claim we stand behind rather than a creator's unticked checkbox.
 */
export const Capabilities = z
  .object({
    tools: z.array(z.object({ name: z.string(), from: z.string() })),
    runs: z.array(CapabilityRun),
    hosts: z.array(CapabilityHost),
    env: z.array(z.object({ name: z.string(), paths: z.array(z.string()) })),
    /** True when something executes at install time. The loudest line in the block. */
    install_runs: z.boolean(),
    summary: z.string(),
  })
  .meta({
    id: "Capabilities",
    description: "§4.3. What the artifact's own files can do: tools, what runs, hosts, environment, and whether anything runs at install.",
  });

/** §4.1's three tiers as three numbers, so an agent can branch without reading the list. */
export const ScanCounts = z
  .object({
    blocking: z.number().int().nonnegative(),
    disclosed: z.number().int().nonnegative(),
    review: z.number().int().nonnegative(),
  })
  .meta({ id: "ScanCounts", description: "§4.1. How many findings sit in each tier." });

// --- the creator's copy --------------------------------------------------------

/**
 * §4.4's right-hand column. The same finding, with what the public copy withholds: the
 * path and line of a secret, and the length of the matched credential.
 *
 * **Never the credential itself.** `lib/scan/secrets.ts` records `match_length` and
 * discards the value at the point of the match, so there is nothing here to leak even if
 * a future surface prints every field.
 */
export const CreatorScanFinding = ScanFindingShape.extend({
  /** §4.4: whether this finding is on the manifest and the listing page. */
  public: z.boolean().optional(),
  /** True when this finding alone fails the release. Equal to `tier === "blocking"`. */
  blocking: z.boolean().optional(),
  /** The length of the matched credential, never the credential. */
  match_length: z.number().int().nonnegative().optional(),
}).meta({ id: "CreatorScanFinding", description: "§4.4. A finding as the creator sees it: path, line, and a secret's length — never its value." });

/**
 * The whole report, for the creator who owns the release. Served from
 * `GET /api/listings/:id` behind that creator's key, and rendered on their dashboard.
 *
 * `version` is `2`; a v1 row is lifted by `normalizeReport` before it is serialised, so
 * a caller never has to know two shapes. The rows v1 never ran arrive `unavailable` with
 * `reason: "predates scanner 2026.09"` — the report says what it did not do.
 */
export const CreatorScanReport = z
  .object({
    version: z.literal(2),
    scanner_version: z.string(),
    /** Cut-time. Never rewritten, even by a rescan. */
    scanned_at: z.string(),
    checks: z.array(PublicScanCheck),
    findings: z.array(CreatorScanFinding),
    capabilities: Capabilities.optional(),
    counts: ScanCounts,
    packages_scanned: z.number().int().nonnegative().optional(),
    /** Set when OSV was unreachable. A gap is recorded, never hidden. */
    osv_error: z.string().optional(),
    /** §7: the last time the dependency rows were refreshed by the rescan cron. */
    advisories_refreshed_at: z.string().optional(),
  })
  .meta({
    id: "CreatorScanReport",
    description:
      "§4.4. The full trust report for the release's own creator: every check, every finding, and the path and line of a secret that failed the release. Never served to anyone else.",
  });

export type PublicScanCheckOutput = z.infer<typeof PublicScanCheck>;
export type PublicScanFindingOutput = z.infer<typeof PublicScanFinding>;
export type CapabilitiesOutput = z.infer<typeof Capabilities>;
export type CreatorScanReportOutput = z.infer<typeof CreatorScanReport>;
