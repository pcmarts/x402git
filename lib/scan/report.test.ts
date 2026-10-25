/**
 * The v1 → v2 read path ("PRD Trust Report.md" §4.2). No migration was run: rows written
 * before 13 Sep 2026 are still v1 jsonb on `release.scan_report`, and every surface reads
 * them through `normalizeReport`. What it must not do is invent a tick — a v1 report never
 * ran the malware, behaviour, capability or injection checks, and the lifted report says so.
 */
import { describe, expect, it } from "vitest";
import { FOLD_EXAMPLES, SCAN_CHECK_IDS, isReportV2, normalizeReport, publicChecks, publicFindings, publishedFindings, type ScanFinding, type ScanReport, type ScanReportV1 } from "./report";

const V1: ScanReportV1 = {
  scanner_version: "2026.08.1",
  scanned_at: "2026-08-30T09:00:00.000Z",
  findings: [
    { kind: "secret", rule_id: "aws-access-key-id", severity: "CRITICAL", description: "AWS access key id", path: "deploy.sh", line: 3, blocking: true },
    { kind: "vulnerability", rule_id: "GHSA-mid", severity: "MODERATE", description: "lodash@4.17.20 (npm): prototype pollution", blocking: false },
  ],
  counts: { secrets: 1, vulnerabilities: 1, blocking: 1 },
  checked: ["secrets", "dependency_cves", "size_limits"],
  packages_scanned: 41,
};

describe("normalizeReport (v1 → v2)", () => {
  it("lifts a v1 report to the seven rows, vouching only for the three v1 ran", () => {
    const report = normalizeReport(V1)!;

    expect(report.version).toBe(2);
    expect(isReportV2(report)).toBe(true);
    expect(report.checks.map((c) => c.id)).toEqual([...SCAN_CHECK_IDS]);
    expect(report.checked).toEqual(["secrets", "limits", "known_vulns"]);
    for (const id of ["known_malware", "dep_behaviour", "capabilities", "injection"] as const) {
      expect(report.checks.find((c) => c.id === id)).toMatchObject({ status: "unavailable", reason: "predates scanner 2026.09" });
    }
    // The cut-time facts are carried through untouched — a lift is not a rescan.
    expect(report.scanner_version).toBe("2026.08.1");
    expect(report.scanned_at).toBe("2026-08-30T09:00:00.000Z");
    expect(report.packages_scanned).toBe(41);
  });

  it("gives every v1 finding its check, tier and public flag", () => {
    const report = normalizeReport(V1)!;

    expect(report.findings[0]).toMatchObject({ check: "secrets", tier: "blocking", public: false, path: "deploy.sh", line: 3 });
    expect(report.findings[1]).toMatchObject({ check: "known_vulns", tier: "disclosed", public: true });
    expect(report.counts).toMatchObject({ secrets: 1, vulnerabilities: 1, blocking: 1, disclosed: 1, review: 0 });
    // §4.4: the secret is not among the findings a stranger may read.
    expect(publicFindings(report).map((f) => f.rule_id)).toEqual(["GHSA-mid"]);
  });

  it("records the OSV gap rather than a passing dependency row", () => {
    const report = normalizeReport({ ...V1, checked: ["secrets", "size_limits"], osv_error: "osv querybatch returned 503" })!;
    expect(report.checks.find((c) => c.id === "known_vulns")).toMatchObject({ status: "unavailable", reason: "osv querybatch returned 503" });
    expect(report.checked).not.toContain("known_vulns");
    expect(report.osv_error).toBe("osv querybatch returned 503");
  });

  it("passes a v2 report through unchanged, and null through as null", () => {
    const v2 = normalizeReport(V1)!;
    expect(normalizeReport(v2)).toBe(v2);
    expect(normalizeReport(null)).toBeNull();
    expect(normalizeReport(undefined)).toBeNull();
  });

  it("keeps `socket_scan_id` off the public check rows", () => {
    const report = normalizeReport(V1)!;
    report.checks[4] = { ...report.checks[4], socket_scan_id: "fs_secret" };
    expect(JSON.stringify(publicChecks(report))).not.toContain("fs_secret");
  });
});


/**
 * The fold — "PRD Trust Report.md" §4.4, amended 14 Sep 2026.
 *
 * The first Socket backfill put 1,209 `dep_behaviour` findings on one release and every
 * one of them went on the manifest, the label and the listing page: 844 KB of HTML, 418
 * lines of it identical. §4.1 had said the tiering would hold and it did; what did not
 * hold was publishing each row on its own. The report keeps all 1,209 — these tests are
 * about the smaller set the public surfaces carry.
 */
describe("publishedFindings (§4.4, 14 Sep 2026)", () => {
  const socket = (rule_id: string, name: string, direct: boolean, over: Partial<ScanFinding> = {}): ScanFinding => ({
    kind: "behaviour",
    check: "dep_behaviour",
    tier: "disclosed",
    public: true,
    rule_id,
    severity: "UNKNOWN",
    description: `${name} (${direct ? "direct" : "transitive"}) — declares ${rule_id}`,
    blocking: false,
    package: { ecosystem: "npm", name, version: "1.0.0", direct, dev: false },
    source: "socket.dev",
    ...over,
  });

  const report = (findings: ScanFinding[]): ScanReport =>
    ({
      version: 2,
      scanner_version: "2026.09.1",
      scanned_at: "2026-09-14T09:00:00.000Z",
      checks: [],
      findings,
      counts: { secrets: 0, vulnerabilities: 0, blocking: 0, disclosed: findings.length, review: 0 },
      checked: [],
      packages_scanned: 545,
    }) as ScanReport;

  it("keeps a direct dependency's finding as itself and folds the transitives behind it", () => {
    const findings = [socket("networkAccess", "esbuild", true), ...Array.from({ length: 418 }, (_, i) => socket("networkAccess", `t-${i}`, false))];
    const published = publishedFindings(report(findings));

    expect(published).toHaveLength(2);
    expect(published[0]).toMatchObject({ package: { name: "esbuild", direct: true } });
    expect(published[1]).toMatchObject({
      rule_id: "networkAccess",
      description: "networkAccess in 418 transitive packages",
      aggregate: { packages: 418 },
    });
    // A folded row stands for many packages, so it names none of them.
    expect(published[1].package).toBeUndefined();
    // And the report itself is untouched: the creator still reads all 419.
    expect(findings).toHaveLength(419);
  });

  it("folds one row per rule, not one per check", () => {
    const findings = [
      ...Array.from({ length: 418 }, (_, i) => socket("networkAccess", `n-${i}`, false)),
      ...Array.from({ length: 364 }, (_, i) => socket("envVars", `e-${i}`, false)),
      ...Array.from({ length: 106 }, (_, i) => socket("filesystemAccess", `f-${i}`, false)),
    ];
    const published = publishedFindings(report(findings));
    expect(published.map((f) => f.rule_id)).toEqual(["networkAccess", "envVars", "filesystemAccess"]);
    expect(published.map((f) => f.aggregate?.packages)).toEqual([418, 364, 106]);
  });

  it("caps the examples at three `name@version` samples", () => {
    const published = publishedFindings(report(Array.from({ length: 9 }, (_, i) => socket("envVars", `pkg-${i}`, false))));
    expect(FOLD_EXAMPLES).toBe(3);
    expect(published[0].aggregate?.examples).toEqual(["pkg-0@1.0.0", "pkg-1@1.0.0", "pkg-2@1.0.0"]);
  });

  it("keeps a review row a review row, and says whose opinion it is", () => {
    const flags = Array.from({ length: 49 }, (_, i) => socket("gptAnomaly", `odd-${i}`, false, { tier: "review", severity: "MODERATE" }));
    const [folded] = publishedFindings(report(flags));
    expect(folded).toMatchObject({
      tier: "review",
      severity: "MODERATE",
      description: "flagged for review by Socket's classifier in 49 transitive packages",
      aggregate: { packages: 49 },
    });
  });

  it("leaves everything that is not a transitive dependency finding alone", () => {
    const findings: ScanFinding[] = [
      {
        kind: "vulnerability",
        check: "known_vulns",
        tier: "disclosed",
        public: true,
        rule_id: "GHSA-1",
        severity: "MODERATE",
        description: "prototype pollution",
        blocking: false,
        package: { ecosystem: "npm", name: "lodash", version: "4.17.20" },
      },
      { kind: "capability", check: "capabilities", tier: "disclosed", public: true, rule_id: "hook", severity: "UNKNOWN", description: "a hook", blocking: false, path: ".claude/settings.json" },
      // Blocking, and a fold is never allowed to turn "this dependency is malware" into a
      // tally. It is published as itself however many of it there are.
      ...Array.from({ length: 3 }, (_, i) => socket("malware", `bad-${i}`, false, { kind: "malware", tier: "blocking", severity: "CRITICAL", blocking: true })),
      // Never public, and the fold is not the place that decides that.
      { kind: "secret", check: "secrets", tier: "blocking", public: false, rule_id: "aws-key", severity: "CRITICAL", description: "…", blocking: true, path: ".env", line: 3 },
    ];
    const published = publishedFindings(report(findings));
    expect(published.map((f) => f.rule_id)).toEqual(["GHSA-1", "hook", "malware", "malware", "malware"]);
    expect(published.every((f) => f.aggregate === undefined)).toBe(true);
  });

  it("changes nothing about a report whose dependency findings are all direct", () => {
    const findings = [socket("installScripts", "esbuild", true), socket("networkAccess", "axios", true), socket("envVars", "dotenv", true)];
    expect(publishedFindings(report(findings))).toEqual(publicFindings(report(findings)));
  });

  it("does not fold a rule that caught a single package — a fold of one is longer", () => {
    const findings = [socket("unmaintained", "left-pad", false), socket("deprecated", "request", false), socket("deprecated", "request", false)];
    const published = publishedFindings(report(findings));
    expect(published).toHaveLength(3);
    expect(published.every((f) => f.aggregate === undefined)).toBe(true);
  });
});
