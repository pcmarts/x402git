import { describe, expect, it, vi } from "vitest";
import { OSV_BATCH_URL, bandFor, cvss3BaseScore, dedupePackages, isMalwareAdvisory, packagesFromFiles, queryOsv, severityOf } from "./osv";

/** A fetch that answers `querybatch` from a script and `vulns/{id}` from a table. */
function fakeOsv(options: {
  batches?: { results: { vulns?: { id: string }[]; next_page_token?: string }[] }[];
  vulns?: Record<string, unknown>;
  fail?: boolean;
}) {
  const calls: { url: string; body?: unknown }[] = [];
  let batchIndex = 0;
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (options.fail) return new Response("nope", { status: 503 });
    if (url === OSV_BATCH_URL) {
      const body = options.batches?.[batchIndex++] ?? { results: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    const id = url.slice(url.lastIndexOf("/") + 1);
    const record = options.vulns?.[id];
    return record ? new Response(JSON.stringify(record), { status: 200 }) : new Response("{}", { status: 404 });
  });
  return { fetchImpl, calls };
}

describe("queryOsv (FR-35)", () => {
  it("maps a batch response back onto the packages that were queried", async () => {
    const { fetchImpl, calls } = fakeOsv({
      batches: [{ results: [{ vulns: [{ id: "GHSA-aaaa" }] }, {}, { vulns: [{ id: "GHSA-bbbb" }] }] }],
      vulns: {
        "GHSA-aaaa": { summary: "RCE", database_specific: { severity: "CRITICAL" } },
        "GHSA-bbbb": { summary: "Typo", database_specific: { severity: "LOW" } },
      },
    });

    const { vulnerabilities } = await queryOsv(
      [
        { name: "left-pad", ecosystem: "npm", version: "1.3.0" },
        { name: "requests", ecosystem: "PyPI", version: "2.31.0" },
        { name: "serde", ecosystem: "crates.io", version: "1.0.0" },
      ],
      fetchImpl,
    );

    // Packages are queried in a stable order (`ecosystem|name`), so result N is query N.
    expect((calls[0].body as any).queries.map((q: any) => q.package.name)).toEqual(["requests", "serde", "left-pad"]);
    expect(vulnerabilities).toEqual([
      { id: "GHSA-aaaa", package: "requests", ecosystem: "PyPI", version: "2.31.0", severity: "CRITICAL", summary: "RCE", cvss_score: undefined, malware: false },
      { id: "GHSA-bbbb", package: "left-pad", ecosystem: "npm", version: "1.3.0", severity: "LOW", summary: "Typo", cvss_score: undefined, malware: false },
    ]);
  });

  /**
   * "PRD Trust Report.md" §1(1): OSV ingests `ossf/malicious-packages` as `MAL-` records
   * and those carry no CVSS vector and no severity word. Before 13 Sep 2026 that made them
   * `UNKNOWN`, and `UNKNOWN` never blocks — a dependency OSV itself calls malware walked
   * through the gate. The id is the signal now, and the record's silence cannot undo it.
   */
  it("rates a MAL- record CRITICAL malware even though it states no severity (§6.1)", async () => {
    const { fetchImpl } = fakeOsv({
      batches: [{ results: [{ vulns: [{ id: "MAL-2024-1337" }] }] }],
      vulns: { "MAL-2024-1337": { summary: "Malicious code in evil-pkg", aliases: ["GHSA-mmmm-mmmm-mmmm"] } },
    });

    const { vulnerabilities } = await queryOsv([{ name: "evil-pkg", ecosystem: "npm", version: "9.9.9" }], fetchImpl);

    expect(vulnerabilities).toEqual([
      {
        id: "MAL-2024-1337",
        package: "evil-pkg",
        ecosystem: "npm",
        version: "9.9.9",
        severity: "CRITICAL",
        summary: "Malicious code in evil-pkg",
        cvss_score: undefined,
        malware: true,
        aliases: ["GHSA-mmmm-mmmm-mmmm"],
      },
    ]);
  });

  // The detail lookup 404s, is capped past 200 ids, or times out — none of which may
  // downgrade a malware record back to the severity that does not block.
  it("still rates a MAL- record CRITICAL when the detail lookup fails", async () => {
    const { fetchImpl } = fakeOsv({ batches: [{ results: [{ vulns: [{ id: "MAL-2026-0001" }] }] }] });
    const { vulnerabilities } = await queryOsv([{ name: "evil-pkg", ecosystem: "npm" }], fetchImpl);
    expect(vulnerabilities[0]).toMatchObject({ severity: "CRITICAL", malware: true });
  });

  // §6.2: Socket's `cve`/`criticalCVE` alerts are matched to OSV's findings by id, so the
  // aliases have to survive the round trip or the same advisory is shown twice.
  it("keeps the record's aliases so a Socket CVE alert can de-duplicate by id", async () => {
    const { fetchImpl } = fakeOsv({
      batches: [{ results: [{ vulns: [{ id: "GHSA-aaaa" }] }] }],
      vulns: { "GHSA-aaaa": { database_specific: { severity: "HIGH" }, aliases: ["CVE-2026-1111"] } },
    });
    const { vulnerabilities } = await queryOsv([{ name: "left-pad", ecosystem: "npm", version: "1.3.0" }], fetchImpl);
    expect(vulnerabilities[0].aliases).toEqual(["CVE-2026-1111"]);
  });

  it("keeps paging while a next_page_token is present, even on an empty page (§11.3)", async () => {
    const { fetchImpl, calls } = fakeOsv({
      batches: [
        // An empty result set *with* a token: more data exists, it just was not found
        // inside the server's time budget. Stopping here under-reports silently.
        { results: [{ next_page_token: "t1" }] },
        { results: [{ vulns: [{ id: "GHSA-late" }] }] },
      ],
      vulns: { "GHSA-late": { database_specific: { severity: "HIGH" } } },
    });

    const { vulnerabilities } = await queryOsv([{ name: "left-pad", ecosystem: "npm", version: "1.3.0" }], fetchImpl);

    expect(calls.filter((c) => c.url === OSV_BATCH_URL)).toHaveLength(2);
    expect((calls[1].body as any).queries[0].page_token).toBe("t1");
    expect(vulnerabilities).toEqual([
      expect.objectContaining({ id: "GHSA-late", severity: "HIGH", malware: false }),
    ]);
  });

  it("records an error rather than pretending there are no vulnerabilities", async () => {
    const { fetchImpl } = fakeOsv({ fail: true });
    const result = await queryOsv([{ name: "left-pad", ecosystem: "npm" }], fetchImpl);
    expect(result.vulnerabilities).toEqual([]);
    expect(result.error).toMatch(/503/);
  });

  // W3.2 (DC): a hung OSV is aborted by the AbortController timeout and surfaced as an
  // error, so the scan is recorded incomplete rather than hanging or pretending clean.
  it("times out a hung OSV via the AbortController and records the gap (W3.2)", async () => {
    const hung = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted by signal")));
      });
    const result = await queryOsv([{ name: "left-pad", ecosystem: "npm", version: "1.3.0" }], hung, 10);
    expect(result.vulnerabilities).toEqual([]);
    expect(result.error).toBeTruthy();
  });

  it("does not call the network when there is nothing to ask about", async () => {
    const { fetchImpl } = fakeOsv({});
    await queryOsv([], fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  /**
   * The wall clock, 13 Sep 2026. `querybatch` is the answer and is never truncated, but
   * the per-advisory detail lookups are one at a time, capped at 200, each with its own
   * timeout — 200 × 20 s is longer than any handler this runs inside. When the caller's
   * deadline is close the remaining ids keep their batch-level answer.
   *
   * The safety argument is the whole reason this is allowed to truncate: `UNKNOWN` is the
   * band DECISIONS 2026-08-29 says never blocks, so running out of time can only ever
   * *under*-report — and a `MAL-` record is promoted to CRITICAL from its **id**, which is
   * in the batch response, so the one finding that must not be missed cannot be.
   */
  it("stops looking up advisory detail at the caller's deadline, and still blocks on a MAL- id", async () => {
    const { fetchImpl, calls } = fakeOsv({
      batches: [{ results: [{ vulns: [{ id: "GHSA-first" }, { id: "MAL-2026-1188" }, { id: "GHSA-third" }] }] }],
      vulns: {
        "GHSA-first": { database_specific: { severity: "HIGH" }, summary: "read in time" },
        "GHSA-third": { database_specific: { severity: "CRITICAL" }, summary: "never read" },
      },
    });

    // Room for the batch and two lookups: the clock advances a whole timeout per call.
    const timeoutMs = 20_000;
    let clock = 1_000_000;
    const start = clock;
    const ticking = vi.fn(async (url: string, init?: RequestInit) => {
      clock += timeoutMs;
      return fetchImpl(url, init);
    });

    const { vulnerabilities, error } = await queryOsv([{ name: "left-pad", version: "1.0.0", ecosystem: "npm" }], ticking, timeoutMs, {
      deadlineMs: start + timeoutMs * 3,
      now: () => clock,
    });

    expect(error).toBeUndefined();
    // Two of the three ids were looked up; the third would not have fitted.
    expect(calls.filter((c) => c.url !== OSV_BATCH_URL)).toHaveLength(2);

    const byId = new Map(vulnerabilities.map((v) => [v.id, v]));
    expect(byId.get("GHSA-first")?.severity).toBe("HIGH");
    // Truncated: the band that does not block, never an invented one.
    expect(byId.get("GHSA-third")).toMatchObject({ severity: "UNKNOWN", malware: false });
    // And the id that matters is decided by the id.
    expect(byId.get("MAL-2026-1188")).toMatchObject({ severity: "CRITICAL", malware: true });
  });
});

describe("severity", () => {
  it("prefers the advisory's own word", () => {
    expect(severityOf({ database_specific: { severity: "HIGH" } }).severity).toBe("HIGH");
  });

  it("falls back to the CVSS vector", () => {
    const record = { severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }] };
    expect(severityOf(record)).toMatchObject({ severity: "CRITICAL", score: 9.8 });
  });

  it("is UNKNOWN when neither is present", () => {
    expect(severityOf({}).severity).toBe("UNKNOWN");
  });

  // GHSA says MODERATE; several CVE feeds say MEDIUM for the same band. Passing the raw
  // word through put a value outside `OsvSeverity` onto `ScanFinding.severity`.
  it("normalises MEDIUM onto MODERATE", () => {
    expect(severityOf({ database_specific: { severity: "MEDIUM" } }).severity).toBe("MODERATE");
    expect(severityOf({ database_specific: { severity: "moderate" } }).severity).toBe("MODERATE");
  });

  it("ignores a severity word it does not recognise and falls through", () => {
    const record = { database_specific: { severity: "SPICY" }, severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }] };
    expect(severityOf(record).severity).toBe("CRITICAL");
  });

  it("computes the published CVSS v3.1 base scores", () => {
    expect(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toBe(9.8);
    expect(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H")).toBe(7.5);
    expect(cvss3BaseScore("CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N")).toBe(1.8);
    expect(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N")).toBe(6.1);
    expect(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N")).toBe(0);
    expect(cvss3BaseScore("garbage")).toBeUndefined();
  });

  it("knows a malicious-packages id by its prefix, and nothing else", () => {
    expect(isMalwareAdvisory("MAL-2024-1337")).toBe(true);
    expect(isMalwareAdvisory("GHSA-mal-aaaa")).toBe(false);
    expect(isMalwareAdvisory("CVE-2024-MAL-1")).toBe(false);
  });

  it("bands a score", () => {
    expect(bandFor(9.8)).toBe("CRITICAL");
    expect(bandFor(7.5)).toBe("HIGH");
    expect(bandFor(5)).toBe("MODERATE");
    expect(bandFor(1.8)).toBe("LOW");
    expect(bandFor(0)).toBe("UNKNOWN");
  });
});

describe("package discovery from the tarball", () => {
  it("reads package.json, pinning only exact versions", () => {
    const packages = packagesFromFiles(
      new Map([["package.json", JSON.stringify({ dependencies: { "left-pad": "1.3.0" }, devDependencies: { vitest: "^4.1.0" } })]]),
    );
    expect(packages).toEqual([
      { name: "left-pad", ecosystem: "npm", version: "1.3.0" },
      { name: "vitest", ecosystem: "npm", version: undefined },
    ]);
  });

  it("reads a package-lock, which does pin", () => {
    const lock = JSON.stringify({ packages: { "": {}, "node_modules/left-pad": { version: "1.3.0" } } });
    expect(packagesFromFiles(new Map([["package-lock.json", lock]]))).toEqual([{ name: "left-pad", ecosystem: "npm", version: "1.3.0" }]);
  });

  it("reads requirements.txt, go.mod and Cargo.toml", () => {
    const packages = packagesFromFiles(
      new Map([
        ["requirements.txt", "# comment\nrequests==2.31.0\nflask[async]\n-r other.txt\n"],
        ["go.mod", "module example.com/m\n\ngo 1.22\n\nrequire (\n\tgithub.com/pkg/errors v0.9.1\n)\n"],
        ["Cargo.toml", '[package]\nname = "x"\n\n[dependencies]\nserde = "1.0.190"\ntokio = { version = "1.35.0", features = ["full"] }\n'],
      ]),
    );
    expect(packages).toEqual([
      { name: "github.com/pkg/errors", ecosystem: "Go", version: "0.9.1" },
      { name: "flask", ecosystem: "PyPI", version: undefined },
      { name: "requests", ecosystem: "PyPI", version: "2.31.0" },
      { name: "serde", ecosystem: "crates.io", version: "1.0.190" },
      { name: "tokio", ecosystem: "crates.io", version: "1.35.0" },
    ]);
  });

  it("ignores vendored trees and malformed manifests", () => {
    const packages = packagesFromFiles(
      new Map([
        ["node_modules/left-pad/package.json", JSON.stringify({ dependencies: { evil: "1.0.0" } })],
        ["package.json", "{ not json"],
      ]),
    );
    expect(packages).toEqual([]);
  });

  it("deduplicates and drops unidentifiable ecosystems", () => {
    expect(
      dedupePackages([
        { name: "a", ecosystem: "npm", version: "1.0.0" },
        { name: "a", ecosystem: "npm", version: "1.0.0" },
        { name: "b", ecosystem: "unknown" },
      ]),
    ).toEqual([{ name: "a", ecosystem: "npm", version: "1.0.0" }]);
  });

  /**
   * The 2026-09-01 defect, at its smallest. A versionless OSV query is not a narrower
   * question — it returns every advisory ever filed against the package — so keeping the
   * `package.json` range alongside the `package-lock.json` pin failed releases on
   * advisories against versions nobody was running, and no upgrade could ever clear it.
   */
  it("drops a versionless entry when the same package is pinned elsewhere", () => {
    expect(
      dedupePackages([
        { name: "vite", ecosystem: "npm", version: undefined },
        { name: "vite", ecosystem: "npm", version: "7.3.6" },
      ]),
    ).toEqual([{ name: "vite", ecosystem: "npm", version: "7.3.6" }]);
  });

  it("keeps the versionless entry when nothing pins that package", () => {
    expect(dedupePackages([{ name: "vite", ecosystem: "npm", version: undefined }])).toEqual([
      { name: "vite", ecosystem: "npm", version: undefined },
    ]);
  });

  // Same name, different ecosystem: a pinned `npm` package must not silence a PyPI one.
  it("does not let a pin in one ecosystem drop a versionless entry in another", () => {
    expect(
      dedupePackages([
        { name: "requests", ecosystem: "PyPI", version: undefined },
        { name: "requests", ecosystem: "npm", version: "2.0.0" },
      ]).map((p) => `${p.ecosystem}|${p.version ?? "-"}`),
    ).toEqual(["PyPI|-", "npm|2.0.0"]);
  });

  it("takes the lockfile pin over the package.json range for the same dependency", () => {
    const packages = packagesFromFiles(
      new Map([
        ["package.json", JSON.stringify({ dependencies: { vite: "^7.3.6", react: "^19.2.0" } })],
        [
          "package-lock.json",
          JSON.stringify({ packages: { "node_modules/vite": { version: "7.3.6" }, "node_modules/react": { version: "19.2.0" } } }),
        ],
      ]),
    );
    expect(packages).toEqual([
      { name: "react", ecosystem: "npm", version: "19.2.0" },
      { name: "vite", ecosystem: "npm", version: "7.3.6" },
    ]);
  });
});
