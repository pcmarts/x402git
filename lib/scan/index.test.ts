import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashApiKey, revokeApiKeyByHash } from "@/lib/auth/api-key";
import { type Db, resetDb, setDb } from "@/lib/db";
import { makeMockDb } from "@/lib/test/mock-db";
import { SCANNER_VERSION, SOCKET_SKIPPED, capabilitiesCheck, defaultExtraChecks, dependencyChecks, dependencyInventory, scanArtifact } from "./index";
import { SCAN_CHECK_IDS, type ScanCheckId } from "./report";
import { SOCKET_BASE_URL } from "./socket";

const files = (entries: Record<string, string>) => new Map(Object.entries(entries));

/** A fetch that answers every OSV batch with "no vulnerabilities". */
const cleanOsv = vi.fn(async (url: string) =>
  url.includes("querybatch") ? new Response(JSON.stringify({ results: [{}, {}, {}, {}] }), { status: 200 }) : new Response("{}", { status: 404 }),
);

const CLEAN = {
  textFiles: files({
    "README.md": "# widget\n\nDoes a thing.\n",
    "src/index.ts": "export const widget = () => 42;\n",
  }),
  fileCount: 2,
  extractedBytes: 1024,
};

const statusOf = (report: { checks: { id: ScanCheckId; status: string }[] }, id: ScanCheckId) => report.checks.find((c) => c.id === id)?.status;

describe("scanArtifact (FR-35)", () => {
  it("passes a clean artifact and says what it checked", async () => {
    const { verdict, report } = await scanArtifact(CLEAN, { fetch: cleanOsv });
    expect(verdict).toBe("pass");
    expect(report.version).toBe(2);
    // SCAN-2: the one thing a manifest-less artifact is told is that it has no manifest —
    // a notice on `known_vulns`, never a vulnerability and never blocking.
    expect(report.findings).toEqual([
      expect.objectContaining({ rule_id: "no-dependency-manifest", check: "known_vulns", kind: "limit", tier: "disclosed", severity: "UNKNOWN", blocking: false }),
    ]);
    expect(report.scanner_version).toBe(SCANNER_VERSION);
    expect(report.checked).toEqual(["secrets", "limits", "known_vulns", "known_malware"]);
    expect(report.counts).toEqual({ secrets: 0, vulnerabilities: 0, blocking: 0, disclosed: 1, review: 0 });
  });

  /**
   * "PRD Trust Report.md" §4.2: every check the contract names is a row on every report,
   * ran or not. A missing row is a badge quietly not saying what it did not do, which is
   * §1's whole complaint — so the unwired modules are `unavailable`, in words.
   */
  it("carries all seven check rows, in contract order, with the ones this call did not run unavailable", async () => {
    const { report } = await scanArtifact(CLEAN, { fetch: cleanOsv });
    expect(report.checks.map((c) => c.id)).toEqual([...SCAN_CHECK_IDS]);
    for (const id of ["dep_behaviour", "capabilities", "injection"] as const) {
      expect(report.checks.find((c) => c.id === id)).toMatchObject({ status: "unavailable", findings: 0 });
      expect(report.checked).not.toContain(id);
    }
    // The two reasons a row can be missing read differently on purpose: "not wired" is
    // this call passing no producer, `socket unconfigured` is a deployment with no token
    // — a fault of ours, not a vendor's, and no cron retry will fix it. The test suite
    // has no `SOCKET_TOKEN_VALUE`, so it sees the second.
    expect(report.checks.find((c) => c.id === "capabilities")?.reason).toBe("not wired");
    expect(report.checks.find((c) => c.id === "dep_behaviour")?.reason).toBe("socket unconfigured");
    // The tool and its version are on the row, not inferred by the reader. OSV is a feed,
    // so its version is the date it was read.
    expect(report.checks.find((c) => c.id === "secrets")).toMatchObject({ tool: "x402git/secrets", tool_version: SCANNER_VERSION });
    expect(report.checks.find((c) => c.id === "known_vulns")).toMatchObject({ tool: "osv.dev", tool_version: report.scanned_at.slice(0, 10) });
    expect(report.checks.find((c) => c.id === "known_malware")).toMatchObject({ tool: "osv.dev/MAL" });
  });

  it("fails on a hardcoded secret, and the report never carries it", async () => {
    const { verdict, report } = await scanArtifact(
      { ...CLEAN, textFiles: files({ "deploy.sh": 'AWS_ACCESS_KEY_ID="AKIA2E0A8F3B244C9986"' }) },
      { fetch: cleanOsv },
    );
    expect(verdict).toBe("fail");
    expect(report.counts.secrets).toBe(1);
    expect(report.findings[0]).toMatchObject({
      kind: "secret",
      check: "secrets",
      tier: "blocking",
      // §4.4: a secret is never public, not even on a failed release.
      public: false,
      rule_id: "aws-access-key-id",
      blocking: true,
      path: "deploy.sh",
    });
    expect(statusOf(report, "secrets")).toBe("fail");
    expect(JSON.stringify(report)).not.toContain("AKIA2E0A8F3B244C9986");
  });

  it("fails on a HIGH or CRITICAL dependency vulnerability and tolerates the rest", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("querybatch")) return new Response(JSON.stringify({ results: [{ vulns: [{ id: "GHSA-high" }, { id: "GHSA-low" }] }] }), { status: 200 });
      const id = url.slice(url.lastIndexOf("/") + 1);
      const severity = id === "GHSA-high" ? "HIGH" : "LOW";
      return new Response(JSON.stringify({ summary: id, database_specific: { severity } }), { status: 200 });
    });

    const { verdict, report } = await scanArtifact(
      { ...CLEAN, textFiles: files({ "package.json": '{"dependencies":{"left-pad":"1.3.0"}}' }), fileCount: 1 },
      { fetch: fetchImpl },
    );

    expect(verdict).toBe("fail");
    expect(report.counts.vulnerabilities).toBe(2);
    expect(report.counts.blocking).toBe(1);
    expect(report.findings.find((f) => f.rule_id === "GHSA-low")!.blocking).toBe(false);
    expect(statusOf(report, "known_vulns")).toBe("fail");
    expect(report.checks.find((c) => c.id === "known_vulns")).toMatchObject({ findings: 2, packages: 1 });
  });

  /**
   * 2026-10-15. `numpy` with no `==` pin is a versionless OSV query, which returns every
   * advisory ever filed against numpy; `example-seller/example-listing` failed on 2014 CVEs.
   * The HIGH is still shown, at its severity; it just does not block.
   */
  it("discloses a HIGH CVE found without a version and still passes", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("querybatch")) return new Response(JSON.stringify({ results: [{ vulns: [{ id: "GHSA-old" }] }] }), { status: 200 });
      return new Response(JSON.stringify({ summary: "arbitrary file write", database_specific: { severity: "HIGH" } }), { status: 200 });
    });

    const { verdict, report } = await scanArtifact(
      { ...CLEAN, textFiles: files({ "requirements.txt": "numpy>=1.26\n" }) },
      { fetch: fetchImpl },
    );

    expect(verdict).toBe("pass");
    expect(report.findings[0]).toMatchObject({
      check: "known_vulns",
      tier: "disclosed",
      severity: "HIGH",
      blocking: false,
      package: { ecosystem: "PyPI", name: "numpy" },
    });
    expect(report.findings[0].package).not.toHaveProperty("version");
    expect(statusOf(report, "known_vulns")).toBe("findings");
  });

  it("still fails on a MAL- record found without a version", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("querybatch")) return new Response(JSON.stringify({ results: [{ vulns: [{ id: "MAL-2024-7" }] }] }), { status: 200 });
      return new Response(JSON.stringify({ summary: "Malicious code" }), { status: 200 });
    });

    const { verdict, report } = await scanArtifact(
      { ...CLEAN, textFiles: files({ "requirements.txt": "evil-pkg\n" }) },
      { fetch: fetchImpl },
    );

    expect(verdict).toBe("fail");
    expect(report.findings[0]).toMatchObject({ check: "known_malware", tier: "blocking", blocking: true });
  });

  /**
   * §1(3) and §4.1: the middle band was recorded and never shown. It sells, so it is
   * `disclosed` and public — the buyer paying for the artifact gets to read what is in it.
   */
  it("discloses a MODERATE CVE in public and still passes", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("querybatch")) return new Response(JSON.stringify({ results: [{ vulns: [{ id: "GHSA-mid" }] }] }), { status: 200 });
      return new Response(JSON.stringify({ summary: "prototype pollution", database_specific: { severity: "MODERATE" } }), { status: 200 });
    });

    const { verdict, report } = await scanArtifact(
      { ...CLEAN, textFiles: files({ "package.json": '{"dependencies":{"lodash":"4.17.20"}}' }) },
      { fetch: fetchImpl },
    );

    expect(verdict).toBe("pass");
    expect(report.findings[0]).toMatchObject({
      kind: "vulnerability",
      check: "known_vulns",
      tier: "disclosed",
      public: true,
      severity: "MODERATE",
      blocking: false,
      package: { ecosystem: "npm", name: "lodash", version: "4.17.20" },
      advisory_ids: ["GHSA-mid"],
      source: "osv.dev",
    });
    expect(report.counts.disclosed).toBe(1);
    expect(statusOf(report, "known_vulns")).toBe("findings");
    // A disclosure is not a gap: the check ran, so the badge may say so.
    expect(report.checked).toContain("known_vulns");
  });

  /**
   * "PRD Trust Report.md" §1(1), phase 0. The record states no severity at all — which is
   * how every `ossf/malicious-packages` record looks — and it still fails the release.
   */
  it("fails on a MAL- record with no severity fields, on its own check row (§6.1)", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("querybatch")) return new Response(JSON.stringify({ results: [{ vulns: [{ id: "MAL-2024-1337" }] }] }), { status: 200 });
      // No `database_specific.severity`, no CVSS vector — the whole of the hole.
      return new Response(JSON.stringify({ summary: "Malicious code in evil-pkg" }), { status: 200 });
    });

    const { verdict, report } = await scanArtifact(
      { ...CLEAN, textFiles: files({ "package.json": '{"dependencies":{"evil-pkg":"9.9.9"}}' }) },
      { fetch: fetchImpl },
    );

    expect(verdict).toBe("fail");
    expect(report.findings[0]).toMatchObject({
      kind: "malware",
      check: "known_malware",
      tier: "blocking",
      public: true,
      severity: "CRITICAL",
      rule_id: "MAL-2024-1337",
      blocking: true,
    });
    expect(statusOf(report, "known_malware")).toBe("fail");
    // It is malware, not a vulnerability: the two rows count separately.
    expect(statusOf(report, "known_vulns")).toBe("pass");
    expect(report.counts.vulnerabilities).toBe(0);
    expect(report.counts.blocking).toBe(1);
  });

  // W3.2 (DC): an OSV outage makes the scan INCOMPLETE, never a silent `pass`. cutRelease
  // leaves such a release pending; it must not go on sale claiming a check that did not run.
  it("returns incomplete (not pass) when OSV is unreachable, and records the gap", async () => {
    const fetchImpl = vi.fn(async () => new Response("down", { status: 503 }));
    const { verdict, report } = await scanArtifact(
      { ...CLEAN, textFiles: files({ "package.json": '{"dependencies":{"left-pad":"1.3.0"}}' }) },
      { fetch: fetchImpl },
    );
    expect(verdict).toBe("incomplete");
    expect(report.osv_error).toMatch(/503/);
    // The badge must not claim a dependency check that did not run. Both OSV-driven rows
    // go `unavailable` with the reason on them — one query, two rows, one outage.
    expect(report.checked).toEqual(["secrets", "limits"]);
    expect(report.checks.find((c) => c.id === "known_vulns")).toMatchObject({ status: "unavailable", reason: "osv unreachable" });
    expect(report.checks.find((c) => c.id === "known_malware")).toMatchObject({ status: "unavailable", reason: "osv unreachable" });
  });

  // A definitive secret finding is a `fail` even when OSV is also down — we already know
  // the artifact is bad, so there is no need to wait on the dependency check.
  it("fails (not incomplete) on a secret even when OSV is unreachable", async () => {
    const fetchImpl = vi.fn(async () => new Response("down", { status: 503 }));
    const { verdict } = await scanArtifact(
      {
        ...CLEAN,
        textFiles: files({ "package.json": '{"dependencies":{"left-pad":"1.3.0"}}' }),
        secretScanFiles: files({ "deploy.sh": 'AWS_ACCESS_KEY_ID="AKIA2E0A8F3B244C9986"' }),
        secretScanBytes: 40,
      },
      { fetch: fetchImpl },
    );
    expect(verdict).toBe("fail");
  });

  // W3.1: the scanner reads the full bytes of every file. A secret behind a leading NUL
  // byte — invisible to the text/binary heuristic — is still a blocking finding and a fail.
  it("finds a secret hidden behind a NUL byte and fails (W3.1)", async () => {
    const secret = `sk_live_${"A1b2C3d4".repeat(3)}`; // 24 chars after the prefix
    const { verdict, report } = await scanArtifact(
      { ...CLEAN, secretScanFiles: files({ "assets/blob.bin": `\u0000\u0000 ${secret} trailing` }), secretScanBytes: 64 },
      { fetch: cleanOsv },
    );
    expect(verdict).toBe("fail");
    expect(report.counts.secrets).toBe(1);
    expect(report.findings[0]).toMatchObject({ kind: "secret", rule_id: "stripe-secret-key", blocking: true, path: "assets/blob.bin" });
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  // W3.1: a secret far past the old 4 MB per-file scan cap is still detected, because the
  // full bytes are handed to the scanner untruncated.
  it("finds a secret past the old 4 MB scan cap (W3.1)", async () => {
    const secret = `sk_live_${"Z9y8X7w6".repeat(3)}`;
    const big = `${"a".repeat(5 * 1024 * 1024)}\n${secret}\n`;
    const { verdict, report } = await scanArtifact(
      { ...CLEAN, secretScanFiles: files({ "big.txt": big }), secretScanBytes: big.length },
      { fetch: cleanOsv },
    );
    expect(verdict).toBe("fail");
    expect(report.findings.some((f) => f.rule_id === "stripe-secret-key")).toBe(true);
  });

  // W3.1: a repo carrying a large benign binary (no secret) still scans `pass`. The
  // whole-repo guard is a CPU backstop, not a per-file fail-closed that would reject any
  // repo shipping an image, a bundle or a model.
  it("passes a large benign binary asset with no secret (W3.1)", async () => {
    const benign = new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(3 * 1024 * 1024)); // 3 MB of NUL, no secret
    const { verdict, report } = await scanArtifact(
      { ...CLEAN, secretScanFiles: files({ "model.bin": benign }), secretScanBytes: 3 * 1024 * 1024 },
      { fetch: cleanOsv },
    );
    expect(verdict).toBe("pass");
    expect(report.counts.secrets).toBe(0);
  });

  // W3.1: only when the *whole-repo* CPU guard is exceeded does the release fail closed with
  // an `unscannable` finding — proving the guard is repo-wide, not a small per-file cap.
  it("fails closed with an unscannable finding when the whole-repo guard is exceeded (W3.1)", async () => {
    const { verdict, report } = await scanArtifact(
      { ...CLEAN, secretScanFiles: files({ "huge.bin": "x" }), secretScanBytes: 1000, maxSecretScanBytes: 500 },
      { fetch: cleanOsv },
    );
    expect(verdict).toBe("fail");
    expect(report.findings.some((f) => f.rule_id === "unscannable" && f.blocking)).toBe(true);
    // The secret scan did not run, so its row does not say `pass` and `checked` omits it.
    expect(report.checks.find((c) => c.id === "secrets")).toMatchObject({ status: "unavailable", reason: "over the secret-scan budget" });
    expect(report.checked).not.toContain("secrets");
  });

  it("fails when the artifact is over a §6 cap", async () => {
    const { verdict, report } = await scanArtifact({ ...CLEAN, fileCount: 20_001, extractedBytes: 300 * 1024 * 1024 }, { fetch: cleanOsv });
    expect(verdict).toBe("fail");
    expect(report.findings.map((f) => f.rule_id)).toEqual(expect.arrayContaining(["file-count", "extracted-bytes"]));
  });

  it("revokes one of our own keys when it is found in a repository (FR-4)", async () => {
    const key = `x4c_live_${"A1b2C3d4".repeat(4)}`;
    const revoke = vi.fn(async () => ["creator-1"]);

    const { verdict, report } = await scanArtifact(
      { ...CLEAN, textFiles: files({ ".env.example": `X402GIT_API_KEY=${key}` }) },
      { fetch: cleanOsv, revokeApiKey: revoke },
    );

    expect(revoke).toHaveBeenCalledWith(key);
    expect(report.revoked_creator_ids).toEqual(["creator-1"]);
    expect(verdict).toBe("fail");
  });

});

/**
 * SCAN-2 (red team, 21 Sep 2026). GitHub's `dependency-graph/sbom` takes no ref — it is the
 * default branch's graph — and it used to win whenever it was non-empty. Keep `main` clean,
 * tag a branch whose lockfile pins a package with a `MAL-` record, and OSV was asked about
 * `main`: `known_malware` read pass over the malware being sold.
 */
describe("the dependency scan describes the commit being sold (SCAN-2)", () => {
  /** OSV that knows exactly one thing: evil-pkg@6.6.6 is malware. Records every query it is asked. */
  function osvKnowingEvil() {
    const asked: { name: string; version?: string }[] = [];
    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      if (!url.includes("querybatch")) return new Response(JSON.stringify({ summary: "Malicious code" }), { status: 200 });
      const { queries } = JSON.parse(String(init?.body)) as { queries: { package: { name: string }; version?: string }[] };
      asked.push(...queries.map((q) => ({ name: q.package.name, version: q.version })));
      const results = queries.map((q) => (q.package.name === "evil-pkg" && q.version === "6.6.6" ? { vulns: [{ id: "MAL-2026-4242" }] } : {}));
      return new Response(JSON.stringify({ results }), { status: 200 });
    });
    return { impl, asked };
  }

  /** The tagged commit's lockfile: a clean direct dependency and a malicious transitive. */
  const DIRTY_LOCK = JSON.stringify({
    name: "widget",
    lockfileVersion: 3,
    packages: {
      "": { name: "widget", dependencies: { "left-pad": "^1.3.0" } },
      "node_modules/left-pad": { version: "1.3.0" },
      "node_modules/evil-pkg": { version: "6.6.6" },
    },
  });

  /** `main`'s graph: the same project before the bad commit — evil-pkg at a version OSV calls clean. */
  const CLEAN_MAIN_SBOM = [
    { name: "left-pad", ecosystem: "npm", version: "1.3.0" },
    { name: "evil-pkg", ecosystem: "npm", version: "1.0.0" },
  ];

  it("blocks on known_malware pinned by the archive's lockfile when the default branch's SBOM is clean", async () => {
    const osv = osvKnowingEvil();
    const { verdict, report } = await scanArtifact(
      { ...CLEAN, textFiles: files({ "package-lock.json": DIRTY_LOCK }), sbomPackages: CLEAN_MAIN_SBOM },
      { fetch: osv.impl },
    );

    expect(verdict).toBe("fail");
    expect(statusOf(report, "known_malware")).toBe("fail");
    expect(report.findings.find((f) => f.check === "known_malware")).toMatchObject({
      rule_id: "MAL-2026-4242",
      blocking: true,
      package: { ecosystem: "npm", name: "evil-pkg", version: "6.6.6" },
    });
    // The archive's version is the one asked about; main's version of the same package is
    // not asked at all — a disagreement between the two cannot replace or soften a finding.
    expect(osv.asked).toContainEqual({ name: "evil-pkg", version: "6.6.6" });
    expect(osv.asked).not.toContainEqual({ name: "evil-pkg", version: "1.0.0" });
    expect(report.findings.some((f) => f.rule_id === "no-dependency-manifest")).toBe(false);
  });

  it("does the same on the §7 rescan path", async () => {
    const result = await dependencyChecks(
      { ...CLEAN, textFiles: files({ "package-lock.json": DIRTY_LOCK }), sbomPackages: CLEAN_MAIN_SBOM },
      { fetch: osvKnowingEvil().impl, socket: false },
    );
    expect(result.checks.find((c) => c.id === "known_malware")).toMatchObject({ status: "fail", findings: 1 });
  });

  it("keeps a clean archive clean", async () => {
    const osv = osvKnowingEvil();
    const cleanLock = JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/left-pad": { version: "1.3.0" } } });
    const { verdict, report } = await scanArtifact({ ...CLEAN, textFiles: files({ "package-lock.json": cleanLock }), sbomPackages: CLEAN_MAIN_SBOM }, { fetch: osv.impl });

    expect(verdict).toBe("pass");
    expect(report.findings).toEqual([]);
    expect(statusOf(report, "known_vulns")).toBe("pass");
    expect(statusOf(report, "known_malware")).toBe("pass");
  });

  it("lets the SBOM add only packages the archive does not name, and says where a finding came from", async () => {
    const osv = osvKnowingEvil();
    const { verdict, report } = await scanArtifact(
      {
        ...CLEAN,
        textFiles: files({ "package.json": '{"dependencies":{"left-pad":"1.3.0"}}' }),
        // A transitive our parser cannot see (say, from a yarn.lock) — the supplement's job.
        sbomPackages: [{ name: "left-pad", ecosystem: "npm", version: "1.2.0" }, { name: "evil-pkg", ecosystem: "npm", version: "6.6.6" }],
      },
      { fetch: osv.impl },
    );

    // left-pad is asked about at the archive's 1.3.0 only; main's 1.2.0 is not added.
    expect(osv.asked).toHaveLength(2);
    expect(osv.asked).toEqual(expect.arrayContaining([{ name: "left-pad", version: "1.3.0" }, { name: "evil-pkg", version: "6.6.6" }]));
    expect(report.packages_scanned).toBe(2);
    // The supplement can add a finding — tiered exactly as any other — and it is labelled.
    expect(verdict).toBe("fail");
    expect(report.findings.find((f) => f.rule_id === "MAL-2026-4242")?.description).toMatch(/default branch/);
  });

  it("says so when the archive has no manifest, and that the packages checked are the default branch's", async () => {
    const osv = osvKnowingEvil();
    const { verdict, report } = await scanArtifact({ ...CLEAN, sbomPackages: [{ name: "left-pad", ecosystem: "npm", version: "1.3.0" }] }, { fetch: osv.impl });

    expect(verdict).toBe("pass");
    expect(report.packages_scanned).toBe(1);
    const notice = report.findings.find((f) => f.rule_id === "no-dependency-manifest");
    expect(notice).toMatchObject({ check: "known_vulns", tier: "disclosed", public: true, blocking: false });
    expect(notice?.description).toMatch(/No dependency manifest/);
    expect(notice?.description).toMatch(/1 package checked comes from the default branch/);
    // Never a vulnerability: the count a reader checks the list against stays honest.
    expect(report.counts.vulnerabilities).toBe(0);
    expect(statusOf(report, "known_vulns")).toBe("findings");
  });

  it("names the manifests that yielded nothing rather than passing them in silence", async () => {
    const { report } = await scanArtifact({ ...CLEAN, textFiles: files({ "package.json": "{ not json", "requirements.txt": "# nothing pinned\n" }) }, { fetch: cleanOsv });
    const notice = report.findings.find((f) => f.rule_id === "no-dependency-manifest");
    expect(notice?.description).toMatch(/package\.json, requirements\.txt/);
  });

  it("parses a manifest carrying a NUL byte (SCAN-1 meets SCAN-2)", async () => {
    const osv = osvKnowingEvil();
    const { verdict } = await scanArtifact({ ...CLEAN, textFiles: files({ "package-lock.json": `\u0000${DIRTY_LOCK}` }) }, { fetch: osv.impl });
    expect(osv.asked).toContainEqual({ name: "evil-pkg", version: "6.6.6" });
    expect(verdict).toBe("fail");
  });

  it("reads a go.mod from the snapshot now that it counts as text", () => {
    expect(dependencyInventory({ textFiles: files({ "go.mod": "module x\n\nrequire github.com/a/b v1.2.3\n" }) }).archive).toEqual([
      { name: "github.com/a/b", ecosystem: "Go", version: "1.2.3" },
    ]);
  });
});

/**
 * The seam `lib/scan/capabilities.ts`, `lib/scan/injection.ts` and `lib/scan/socket.ts`
 * are wired through ("PRD Trust Report.md" §9, phases 2a/2b). `scanArtifact` does not
 * grow a branch per module: a producer returns its row and its findings, and the row
 * replaces the `unavailable` placeholder of the same id.
 */
describe("scanArtifact — the extraChecks seam", () => {
  it("lets a check replace its placeholder row, contribute findings, and block", async () => {
    const injection = {
      id: "injection" as const,
      run: async ({ at }: { at: string }) => ({
        check: { id: "injection" as const, tool: "x402git/inject", tool_version: "2026.09.1", status: "fail" as const, at, findings: 1 },
        findings: [
          {
            kind: "injection" as const,
            check: "injection" as const,
            tier: "blocking" as const,
            // §4.4: the count is public, the matched text is not.
            public: false,
            rule_id: "hidden-unicode-tags",
            severity: "CRITICAL" as const,
            description: "Tag characters U+E0000–E007F in SKILL.md",
            path: "SKILL.md",
            blocking: true,
          },
        ],
      }),
    };

    const { verdict, report } = await scanArtifact(CLEAN, { fetch: cleanOsv, extraChecks: [injection] });

    expect(verdict).toBe("fail");
    expect(report.checks.map((c) => c.id)).toEqual([...SCAN_CHECK_IDS]);
    expect(statusOf(report, "injection")).toBe("fail");
    expect(report.checked).toContain("injection");
    expect(report.counts.blocking).toBe(1);
  });

  it("carries the capability inventory a check returns", async () => {
    const capabilities = {
      tools: [{ name: "Bash", from: "SKILL.md" }],
      runs: [],
      hosts: [],
      env: [],
      install_runs: false,
      summary: "One tool. No hosts, no environment variables, nothing runs at install.",
    };
    const check = {
      id: "capabilities" as const,
      run: async ({ at }: { at: string }) => ({
        check: { id: "capabilities" as const, tool: "x402git/caps", tool_version: "2026.09.1", status: "findings" as const, at, findings: 0 },
        findings: [],
        capabilities,
      }),
    };

    const { report } = await scanArtifact(CLEAN, { fetch: cleanOsv, extraChecks: [check] });
    expect(report.capabilities).toEqual(capabilities);
  });

  // §4.1, founder decision §10 Q1: a vendor's bad day is a gap on the report, never a
  // release that could not be cut. Only OSV's outage makes a scan `incomplete`.
  //
  // 13 Sep 2026: and the gap has to say which gap it is. The catch used to `continue`,
  // which left the placeholder's `not wired` — the sentence for a module nobody passed —
  // on a module that was passed and threw. The row now names the failure, and §7's repair
  // queue reads that same prefix to find the two pure checks worth re-running.
  it("writes `check failed` on the row a check declared when its module throws", async () => {
    const socket = {
      id: "dep_behaviour" as const,
      run: async () => {
        throw new Error("socket 503");
      },
    };
    const { verdict, report } = await scanArtifact(CLEAN, { fetch: cleanOsv, extraChecks: [socket] });
    expect(verdict).toBe("pass");
    expect(report.checks.find((c) => c.id === "dep_behaviour")).toMatchObject({ status: "unavailable", findings: 0, reason: "check failed: socket 503" });
    expect(report.checked).not.toContain("dep_behaviour");
  });

  it("writes `check failed` on a pure check too, so the rescan can re-run it", async () => {
    const injection = {
      id: "injection" as const,
      run: async () => {
        throw new TypeError("Cannot read properties of undefined (reading 'length')");
      },
    };
    const { report } = await scanArtifact(CLEAN, { fetch: cleanOsv, extraChecks: [capabilitiesCheck, injection] });
    expect(report.checks.find((c) => c.id === "injection")?.reason).toMatch(/^check failed: /);
    // The check beside it is untouched: one module's bug is one row.
    expect(statusOf(report, "capabilities")).not.toBe("unavailable");
  });
});

/**
 * The adapters that hold the three modules to the seam ("PRD Trust Report.md" §9, phases
 * 2a/2b). What is under test here is the *wiring* — the modules have their own suites —
 * so the assertions are about which row moved, what the report carries and what the
 * verdict became, not about a ruleset.
 */
describe("defaultExtraChecks — the three modules, wired", () => {
  const withCaps = {
    ...CLEAN,
    textFiles: files({
      "SKILL.md": "---\nallowed-tools: Bash, Read\n---\n\n# Widget\n",
      "package.json": JSON.stringify({ name: "widget", scripts: { postinstall: "node setup.js" } }),
    }),
    files: [{ path: "SKILL.md", size: 40 }, { path: "package.json", size: 80 }, { path: "bin/run", size: 20, executable: true }],
  };

  it("runs capabilities and injection, and leaves Socket unconfigured rather than unwired", async () => {
    const { verdict, report } = await scanArtifact(withCaps, { fetch: cleanOsv, extraChecks: defaultExtraChecks() });

    expect(verdict).toBe("pass");
    expect(statusOf(report, "capabilities")).not.toBe("unavailable");
    expect(statusOf(report, "injection")).toBe("pass");
    // §4.3: an inventory is on the report whenever its row ran, including the empty one.
    expect(report.capabilities?.tools.map((t) => t.name)).toEqual(["Bash", "Read"]);
    expect(report.capabilities?.install_runs).toBe(true);
    // The path list is the whole snapshot's, not just the decodable half: `bin/run` is a
    // thing that runs and it never decoded as text.
    expect(report.capabilities?.runs.some((r) => r.path === "bin/run")).toBe(true);
    expect(report.checked).toEqual(expect.arrayContaining(["capabilities", "injection"]));
    expect(report.checks.find((c) => c.id === "dep_behaviour")?.reason).toBe("socket unconfigured");
  });

  // §4.1: hidden-Unicode smuggling is one of the two things this module blocks on.
  it("fails a release over a tag-character payload in a SKILL.md", async () => {
    const smuggled = { ...withCaps, textFiles: files({ "SKILL.md": "# Widget\n\nDo the thing.\u{E0041}\u{E0042}\u{E0043}\n" }) };
    const { verdict, report } = await scanArtifact(smuggled, { fetch: cleanOsv, extraChecks: defaultExtraChecks() });

    expect(verdict).toBe("fail");
    expect(statusOf(report, "injection")).toBe("fail");
    // §4.4: the count is public through the row; the finding itself never is.
    expect(report.findings.filter((f) => f.check === "injection").every((f) => f.public === false)).toBe(true);
  });

  // §4.2: mirrored onto the report so a reader holding only the blob knows what it was.
  it("stamps the verdict on the report itself, on every path", async () => {
    const pass = await scanArtifact(CLEAN, { fetch: cleanOsv, extraChecks: defaultExtraChecks() });
    expect(pass.report.verdict).toBe("pass");

    const failing = await scanArtifact(
      { ...CLEAN, textFiles: files({ "deploy.sh": 'AWS_ACCESS_KEY_ID="AKIA2E0A8F3B244C9986"' }) },
      { fetch: cleanOsv, extraChecks: defaultExtraChecks() },
    );
    expect(failing.verdict).toBe("fail");
    expect(failing.report.verdict).toBe("fail");

    const down = vi.fn(async () => new Response("nope", { status: 503 }));
    const incomplete = await scanArtifact({ ...CLEAN, textFiles: files({ "package.json": '{"dependencies":{"lodash":"4.17.20"}}' }) }, { fetch: down });
    expect(incomplete.verdict).toBe("incomplete");
    expect(incomplete.report.verdict).toBe("incomplete");
  });
});

/**
 * §6.2 step 4, "one gate, one source". Socket's CVE alerts arrive with `props.ghsaId` /
 * `props.cveId` on them; OSV has already decided whether that advisory blocks, so its
 * copy is the one the buyer reads and Socket's duplicate is dropped.
 */
describe("Socket CVE de-duplication against OSV", () => {
  const withLodash = { ...CLEAN, textFiles: files({ "package.json": '{"dependencies":{"lodash":"4.17.20"}}' }) };

  /** One MODERATE OSV advisory on lodash, aliased to a CVE the way OSV really answers. */
  const osvWithAdvisory = vi.fn(async (url: string) => {
    if (url.includes("querybatch")) return new Response(JSON.stringify({ results: [{ vulns: [{ id: "GHSA-p6mc-m468-83gg" }] }] }), { status: 200 });
    return new Response(
      JSON.stringify({
        id: "GHSA-p6mc-m468-83gg",
        aliases: ["CVE-2020-8203"],
        summary: "Prototype pollution in zipObjectDeep",
        database_specific: { severity: "MODERATE" },
      }),
      { status: 200 },
    );
  });

  const socketFinding = (ids: string[], ruleId = "criticalCVE") => ({
    kind: "behaviour" as const,
    check: "dep_behaviour" as const,
    tier: "disclosed" as const,
    public: true,
    rule_id: ruleId,
    severity: "MODERATE" as const,
    description: `lodash 4.17.20 (direct) — has a known vulnerability ${ids.join(", ")}`,
    blocking: false,
    advisory_ids: ids,
    source: "socket.dev",
  });

  const socketReturning = (findings: ReturnType<typeof socketFinding>[]) => ({
    id: "dep_behaviour" as const,
    run: async ({ at }: { at: string }) => ({
      check: { id: "dep_behaviour" as const, tool: "socket.dev", tool_version: at.slice(0, 10), status: "findings" as const, at, findings: findings.length },
      findings,
    }),
  });

  it("drops a Socket CVE alert OSV already reported, by either id, and corrects the row", async () => {
    const { report } = await scanArtifact(withLodash, {
      fetch: osvWithAdvisory,
      // Matched on the alias, which is the harder half: OSV keyed on the GHSA.
      extraChecks: [socketReturning([socketFinding(["CVE-2020-8203"])])],
    });

    expect(report.findings.filter((f) => f.source === "socket.dev")).toEqual([]);
    expect(report.findings.filter((f) => f.check === "known_vulns")).toHaveLength(1);
    // The row cannot go on claiming a finding that is not in `findings[]`, and a row whose
    // every finding was a duplicate ran clean — it did run.
    expect(report.checks.find((c) => c.id === "dep_behaviour")).toMatchObject({ status: "pass", findings: 0 });
  });

  it("keeps a CVE Socket knows and OSV does not — disclosed, never blocking", async () => {
    const { verdict, report } = await scanArtifact(withLodash, {
      fetch: osvWithAdvisory,
      extraChecks: [socketReturning([socketFinding(["GHSA-zzzz-zzzz-zzzz"])])],
    });

    expect(verdict).toBe("pass");
    const kept = report.findings.filter((f) => f.source === "socket.dev");
    expect(kept).toHaveLength(1);
    expect(kept[0].blocking).toBe(false);
    expect(report.checks.find((c) => c.id === "dep_behaviour")).toMatchObject({ status: "findings", findings: 1 });
  });

  it("leaves a behaviour alert with no advisory id alone", async () => {
    const install = { ...socketFinding([], "installScripts"), advisory_ids: undefined };
    const { report } = await scanArtifact(withLodash, { fetch: osvWithAdvisory, extraChecks: [socketReturning([install as never])] });
    expect(report.findings.filter((f) => f.rule_id === "installScripts")).toHaveLength(1);
  });
});

/**
 * §7's repair path, exported for the rescan cron: the three dependency rows over an
 * artifact we already hold, without re-running the secret scan or re-deciding a verdict.
 */
describe("dependencyChecks", () => {
  it("returns only the dependency rows, with the same findings scanArtifact would build", async () => {
    const at = "2026-09-14T04:00:00.000Z";
    const result = await dependencyChecks({ ...CLEAN, textFiles: files({ "package.json": '{"dependencies":{"lodash":"4.17.20"}}' }) }, { fetch: cleanOsv, at });

    expect(result.checks.map((c) => c.id)).toEqual(["known_vulns", "known_malware", "dep_behaviour"]);
    // Every row carries the refresh time the caller passed, not three of its own.
    expect(result.checks.every((c) => c.at === at)).toBe(true);
    expect(result.checks.find((c) => c.id === "dep_behaviour")?.reason).toBe("socket unconfigured");
    expect(result.packages).toBe(1);
    expect(result.error).toBeUndefined();
  });

  it("records an OSV outage as a reason on both rows rather than throwing", async () => {
    const down = vi.fn(async () => new Response("nope", { status: 503 }));
    const result = await dependencyChecks({ ...CLEAN, textFiles: files({ "package.json": '{"dependencies":{"lodash":"4.17.20"}}' }) }, { fetch: down });

    expect(result.error).toBeTruthy();
    for (const id of ["known_vulns", "known_malware"] as const) {
      expect(result.checks.find((c) => c.id === id)).toMatchObject({ status: "unavailable", reason: "osv unreachable" });
    }
  });

  /**
   * The three levers §7's rescan needs, which the rescan used to have its own copy of the
   * whole function to get (deleted 13 Sep 2026). The merge policy that reads these rows —
   * "an `unavailable` answer never erases the row we had" — is the rescan's, and is tested
   * in lib/scan/rescan.test.ts.
   */
  describe("the socket lever", () => {
    const DEPS = { token: "sktsec_test_value_only", orgSlug: "x402-git", pollDelaysMs: [0] as const, now: () => Date.parse(AT) };
    const AT = "2026-09-14T04:00:00.000Z";
    const WITH_BYTES = {
      ...CLEAN,
      textFiles: files({ "package.json": '{"dependencies":{"lodash":"4.17.20"}}' }),
      artifactBytes: new Uint8Array([1, 2, 3]),
      listingId: "lst_1",
      version: "1.0.0",
    };

    /** Socket's endpoints, scripted by method. `stream` answers the poll for the NDJSON. */
    function socket(options: { stream?: () => Response } = {}) {
      const calls: { method: string; path: string }[] = [];
      const impl = vi.fn(async (url: string, init?: RequestInit) => {
        const path = url.slice(SOCKET_BASE_URL.length);
        calls.push({ method: init?.method ?? "GET", path });
        if (path === "/quota") return new Response(JSON.stringify({ quota: 500, maxQuota: 500 }), { status: 200 });
        if (init?.method === "POST") return new Response(JSON.stringify({ id: "fullscan_new" }), { status: 201 });
        if (init?.method === "DELETE") return new Response(null, { status: 204 });
        return (options.stream ?? (() => ndjson()))();
      });
      return { impl, calls };
    }

    const ndjson = () =>
      new Response('{"type":"npm","name":"lodash","version":"4.17.20","direct":true,"alerts":[{"type":"installScripts"}]}\n', {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      });

    it("runs OSV alone on `false`, and says the row was skipped rather than unreachable", async () => {
      const s = socket();
      const result = await dependencyChecks(WITH_BYTES, { fetch: cleanOsv, at: AT, socket: false });

      expect(s.impl).not.toHaveBeenCalled();
      expect(result.checks.find((c) => c.id === "dep_behaviour")).toMatchObject({ status: "unavailable", reason: SOCKET_SKIPPED, at: AT });
      expect(result.checks.find((c) => c.id === "known_vulns")?.status).toBe("pass");
      expect(result.socketResumed).toBe(false);
    });

    it("finishes a scan from its stored id — one GET and a delete, no upload", async () => {
      const s = socket();
      const result = await dependencyChecks(WITH_BYTES, { fetch: cleanOsv, at: AT, socket: { ...DEPS, fetch: s.impl, resumeScanId: "fullscan_waiting" } });

      expect(s.calls.map((c) => c.method)).toEqual(["GET", "DELETE"]);
      expect(s.calls.every((c) => c.path.includes("fullscan_waiting"))).toBe(true);
      expect(result.socketResumed).toBe(true);
      expect(result.checks.find((c) => c.id === "dep_behaviour")).toMatchObject({ status: "findings", findings: 1 });
    });

    it("re-uploads when the stored scan is gone, and does not when Socket merely has no budget", async () => {
      // 404: the scan Socket had is not there any more, and seven units is the right price
      // for an answer. The fresh scan is quota, create, poll, delete.
      const gone = socket({ stream: () => new Response("nope", { status: 404 }) });
      let first = true;
      gone.impl.mockImplementation(async (url: string, init?: RequestInit) => {
        const path = url.slice(SOCKET_BASE_URL.length);
        gone.calls.push({ method: init?.method ?? "GET", path });
        if (path === "/quota") return new Response(JSON.stringify({ quota: 500, maxQuota: 500 }), { status: 200 });
        if (init?.method === "POST") return new Response(JSON.stringify({ id: "fullscan_new" }), { status: 201 });
        if (init?.method === "DELETE") return new Response(null, { status: 204 });
        if (first) {
          first = false;
          return new Response("nope", { status: 404 });
        }
        return ndjson();
      });
      const reupload = await dependencyChecks(WITH_BYTES, { fetch: cleanOsv, at: AT, socket: { ...DEPS, fetch: gone.impl, resumeScanId: "fullscan_waiting" } });
      expect(gone.calls.filter((c) => c.method === "POST")).toHaveLength(1);
      expect(reupload.socketResumed).toBe(false);
      expect(reupload.checks.find((c) => c.id === "dep_behaviour")?.status).toBe("findings");

      // 429: an answer, not a lost scan. Spending seven units on the archive is exactly what
      // the budget has no room for, so the row is the gap and the caller decides.
      const broke = socket({ stream: () => new Response("nope", { status: 429 }) });
      const skipped = await dependencyChecks(WITH_BYTES, { fetch: cleanOsv, at: AT, socket: { ...DEPS, fetch: broke.impl, resumeScanId: "fullscan_waiting" } });
      expect(broke.calls.filter((c) => c.method === "POST")).toHaveLength(0);
      expect(skipped.checks.find((c) => c.id === "dep_behaviour")).toMatchObject({ status: "unavailable", reason: "socket quota" });
    });

    /**
     * 14 Sep 2026. The resume fallback asked `reason !== "socket error"`, and the same day
     * the failure table started naming the status — `socket error (404: Full scan not
     * found)` — that equality quietly stopped being true, so a scan Socket no longer had
     * was never re-uploaded and the row stayed `unavailable` for ever. It is a `startsWith`
     * now, and this is the body the live API actually sends.
     */
    it("re-uploads on a `socket error` reason that carries the status and the vendor's words", async () => {
      const gone = socket();
      let first = true;
      gone.impl.mockImplementation(async (url: string, init?: RequestInit) => {
        const path = url.slice(SOCKET_BASE_URL.length);
        gone.calls.push({ method: init?.method ?? "GET", path });
        if (path === "/quota") return new Response(JSON.stringify({ quota: 500, maxQuota: 500 }), { status: 200 });
        if (init?.method === "POST") return new Response(JSON.stringify({ id: "fullscan_new" }), { status: 201 });
        if (init?.method === "DELETE") return new Response(null, { status: 204 });
        if (first) {
          first = false;
          return new Response(JSON.stringify({ error: { message: "Full scan not found", details: null } }), { status: 404, headers: { "content-type": "application/json" } });
        }
        return ndjson();
      });

      const result = await dependencyChecks(WITH_BYTES, { fetch: cleanOsv, at: AT, socket: { ...DEPS, fetch: gone.impl, resumeScanId: "fullscan_waiting" } });

      expect(gone.calls.filter((c) => c.method === "POST")).toHaveLength(1);
      expect(result.socketResumed).toBe(false);
      expect(result.checks.find((c) => c.id === "dep_behaviour")).toMatchObject({ status: "findings", findings: 1 });
    });

    it("de-duplicates Socket's CVE against OSV's, and corrects the row, on this path too", async () => {
      const osv = vi.fn(async (url: string) =>
        url.includes("querybatch")
          ? new Response(JSON.stringify({ results: [{ vulns: [{ id: "GHSA-p6mc-m468-83gg" }] }] }), { status: 200 })
          : new Response(JSON.stringify({ id: "GHSA-p6mc-m468-83gg", summary: "Prototype pollution", database_specific: { severity: "MODERATE" } }), { status: 200 }),
      );
      const withCve = () =>
        new Response('{"type":"npm","name":"lodash","version":"4.17.20","alerts":[{"type":"cve","props":{"ghsaId":"GHSA-p6mc-m468-83gg"}}]}\n', {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        });
      const s = socket({ stream: withCve });
      const result = await dependencyChecks(WITH_BYTES, { fetch: osv, at: AT, socket: { ...DEPS, fetch: s.impl } });

      expect(result.findings.filter((f) => (f.advisory_ids ?? []).includes("GHSA-p6mc-m468-83gg"))).toHaveLength(1);
      expect(result.findings.find((f) => f.source === "socket.dev")).toBeUndefined();
      expect(result.checks.find((c) => c.id === "dep_behaviour")).toMatchObject({ status: "pass", findings: 0 });
    });
  });
});

describe("revokeApiKeyByHash (FR-4, FR-57, §14.7)", () => {
  let mock: ReturnType<typeof makeMockDb>;
  const key = `x4c_live_${"Zz9Yy8Xx".repeat(4)}`;

  beforeEach(() => {
    mock = makeMockDb({
      creator: [{ id: "c1", handle: "adrian", onboarded_via: "api", payout_address: "0x1", terms_version: "v1" }],
      // FR-54: keys live in `api_key`, one live agent row plus this creator's web session.
      api_key: [
        { id: "k1", creator_id: "c1", kind: "agent", hash: hashApiKey(key) },
        { id: "k2", creator_id: "c1", kind: "session", hash: hashApiKey("x4s_live_session"), expires_at: new Date(Date.now() + 86_400_000).toISOString() },
      ],
    });
    setDb(mock.client as unknown as Db);
  });
  afterEach(() => resetDb());

  it("marks the row revoked in place, and takes the creator's web sessions with it", async () => {
    const revoked = await revokeApiKeyByHash(hashApiKey(key));
    expect(revoked).toEqual(["c1"]);

    const rows = mock.rows("api_key");
    // The hash is untouched — the old `revoked:<reason>:<ms>:<hash>` trick died with the
    // NOT NULL UNIQUE column it worked around.
    expect(rows.find((r) => r.id === "k1")?.hash).toBe(hashApiKey(key));
    expect(rows.find((r) => r.id === "k1")?.revoked_reason).toBe("found_in_repository");
    expect(rows.find((r) => r.id === "k2")?.revoked_reason).toBe("agent_key_compromised");
  });

  it("is a no-op for a key that is not ours", async () => {
    expect(await revokeApiKeyByHash(hashApiKey("x4c_live_notours"))).toEqual([]);
  });

  it("revokes a leaked session key end to end through the scan, and spares the agent key (FR-60, FR-57)", async () => {
    const sessionKey = `x4s_live_${"S1e2s3S4".repeat(4)}`;
    mock.rows("api_key").push({
      id: "k3",
      creator_id: "c1",
      kind: "session",
      hash: hashApiKey(sessionKey),
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });

    // No `revokeApiKey` seam here: the default wiring hashes what the scanner matched and
    // writes `revoked_at`, so this exercises the FR-60 pattern and FR-4 revocation together.
    const { verdict, report } = await scanArtifact({ ...CLEAN, textFiles: files({ ".env": `X402GIT_KEY=${sessionKey}` }) }, { fetch: cleanOsv });

    expect(verdict).toBe("fail");
    expect(report.revoked_creator_ids).toEqual(["c1"]);
    const rows = mock.rows("api_key");
    expect(rows.find((r) => r.id === "k3")?.revoked_reason).toBe("found_in_repository");
    // The cascade runs one way only: a leaked session key is not a reason to break agents.
    expect(rows.find((r) => r.id === "k1")?.revoked_at ?? null).toBe(null);
  });
});
