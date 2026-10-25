/**
 * lib/scan/rescan.test.ts — "PRD Trust Report.md" §7.
 *
 * Everything is injected: the artifact reader, OSV's fetch, Socket's fetch (fed by the
 * NDJSON fixtures beside lib/scan/socket.test.ts), the event writer and the FR-41 webhook.
 * Nothing here reaches a network, and in particular nothing calls Socket for real — the
 * quota is 500 units an hour and a test suite would eat it.
 */

import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_FILES, RepoTooLargeError } from "@/lib/analysis";
import { type Db, resetDb, setDb } from "@/lib/db";
import { makeMockDb } from "@/lib/test/mock-db";
import { ScanInfo } from "@/lib/schemas/manifest";
import { TarLimitError, writeTar } from "@/lib/tar";
import { seedListing } from "@/lib/test/fixtures";
import { writeZip } from "@/lib/zip";
import { readArtifactEntries } from "./archive";
import { OSV_BATCH_URL, OSV_VULN_URL } from "./osv";
import type { ScanReport, ScanReportV1 } from "./report";
import { SOCKET_BASE_URL } from "./socket";
import {
  RESCAN_RELEASE_BUDGET_MS,
  type RescanDeps,
  listingIdByPath,
  rescanQueues,
  readArtifactTextFiles,
  rescanRelease,
  runRescan,
  withRefreshedScan,
} from "./rescan";

const socketFixture = (name: string) => readFileSync(new URL(`./fixtures/socket/${name}.ndjson`, import.meta.url), "utf8");

const SOCKET = { token: "sktsec_test_value_only", orgSlug: "x402-git", pollDelaysMs: [0, 0, 0, 0, 0] as const };
const NOW = Date.parse("2026-09-13T04:00:00.000Z");

let mock: ReturnType<typeof makeMockDb>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
});

afterEach(() => {
  resetDb();
  vi.restoreAllMocks();
});

// --- the artifact ---------------------------------------------------------------

const DEFAULT_FILES = { "package.json": JSON.stringify({ dependencies: { esbuild: "0.21.5" } }) };

/** A real zip, packed the way `snapshot()` packs one: one wrapper dir, POSIX paths. */
function artifact(files: Record<string, string> = DEFAULT_FILES): Uint8Array {
  const enc = new TextEncoder();
  return writeZip([
    { path: "humanizer-1.0.0", type: "directory" },
    ...Object.entries(files).map(([path, text]) => ({ path: `humanizer-1.0.0/${path}`, body: enc.encode(text) })),
  ]);
}

/**
 * The same tree in the format the platform wrote before DECISIONS 2026-08-30 ("Zip, not
 * tar.gz"): a gzipped ustar with the same `<slug>-<version>/` wrapper. The three
 * `examples/*` releases in production are these bytes.
 */
function tarball(files: Record<string, string> = DEFAULT_FILES): Uint8Array {
  const enc = new TextEncoder();
  return new Uint8Array(
    gzipSync(
      Buffer.from(
        writeTar([
          { path: "humanizer-1.0.0", type: "directory" },
          ...Object.entries(files).map(([path, text]) => ({ path: `humanizer-1.0.0/${path}`, body: enc.encode(text) })),
        ]),
      ),
    ),
  );
}

// --- the transports --------------------------------------------------------------

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ndjson = (text: string) => new Response(text, { status: 200, headers: { "content-type": "application/x-ndjson" } });

type OsvHit = { id: string; severity?: string; aliases?: string[]; summary?: string };

/** OSV's two endpoints, from a list of advisory ids to return for every package queried. */
function osvFetch(hits: OsvHit[]) {
  const calls: string[] = [];
  /** The `querybatch` request bodies, so a test can assert *which* packages were asked about. */
  const bodies: string[] = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url === OSV_BATCH_URL) {
      bodies.push(String(init?.body));
      const body = JSON.parse(String(init?.body)) as { queries: unknown[] };
      return json({ results: body.queries.map(() => ({ vulns: hits.map((h) => ({ id: h.id })) })) });
    }
    if (url.startsWith(OSV_VULN_URL)) {
      const id = decodeURIComponent(url.slice(OSV_VULN_URL.length + 1));
      const hit = hits.find((h) => h.id === id);
      return json({
        summary: hit?.summary ?? `about ${id}`,
        aliases: hit?.aliases ?? [],
        database_specific: hit?.severity ? { severity: hit.severity } : {},
      });
    }
    throw new Error(`unscripted osv call: ${url}`);
  });
  return { impl, calls, bodies };
}

/** Socket's endpoints. `quota` is answered from a number; the rest is scripted by path. */
function socketFetch(options: { quota?: number; maxQuota?: number; scan?: string; scanId?: string } = {}) {
  const calls: { url: string; method: string }[] = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET" });
    const path = url.slice(SOCKET_BASE_URL.length);
    if (path === "/quota") return json({ quota: options.quota ?? 500, maxQuota: options.maxQuota ?? 500, nextWindowRefresh: null });
    if (init?.method === "POST") return json({ id: options.scanId ?? "fullscan_new" }, 201);
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return ndjson(options.scan ?? socketFixture("full-scan"));
  });
  return { impl, calls };
}

// --- the rows ---------------------------------------------------------------------

/** The pre-13-Sep-2026 shape. `normalizeReport` is what lifts it; the rescan must not care. */
const V1_REPORT: ScanReportV1 = {
  scanner_version: "2026.08.1",
  scanned_at: "2026-04-01T09:00:00.000Z",
  findings: [
    { kind: "secret", rule_id: "generic-api-key", severity: "CRITICAL", description: "an api key", path: "src/a.ts", line: 3, blocking: false },
    { kind: "vulnerability", rule_id: "GHSA-stale", severity: "MODERATE", description: "left-pad@1.0.0 (npm): old news", blocking: false },
  ],
  counts: { secrets: 1, vulnerabilities: 1, blocking: 0 },
  checked: ["secrets", "size_limits", "dependency_cves"],
  // One, and it matters: the weaker-package-set guard (§7) refuses to rewrite the OSV rows
  // when a rescan asks about materially fewer packages than the stored report did, and
  // `artifact()` ships exactly one dependency. A fixture that claimed three would be
  // testing the guard by accident in every case below.
  packages_scanned: 1,
};

function seedRelease(patch: Record<string, unknown> = {}, listingPatch: Parameters<typeof seedListing>[1] = {}) {
  const seeded = seedListing(mock, { releases: [{ version: "1.0.0" }], ...listingPatch });
  const row = mock.rows("release").find((r) => r.id === seeded.latest.id)!;
  Object.assign(row, {
    scan_report: V1_REPORT,
    manifest: { version: "1.0.0", computed: { artifact_class: "Harness", scan: { verdict: "pass", scanner_version: "2026.08.1", at: V1_REPORT.scanned_at } } },
    ...patch,
  });
  return { seeded, row };
}

const reportOf = (id: string) => mock.rows("release").find((r) => r.id === id)!.scan_report as ScanReport;
const checkOf = (report: ScanReport, id: string) => report.checks.find((c) => c.id === id)!;

// --- readArtifactTextFiles ---------------------------------------------------------

describe("readArtifactTextFiles", () => {
  it("strips the wrapper directory and keeps only the manifests", async () => {
    const bytes = artifact({
      "package.json": "{}",
      "go.mod": "module example.com/x",
      "src/index.ts": "export const a = 1;",
      "node_modules/left-pad/package.json": "{}",
    });
    const { textFiles, fileCount } = await readArtifactTextFiles(bytes);
    expect([...textFiles.keys()].sort()).toEqual(["go.mod", "node_modules/left-pad/package.json", "package.json"]);
    // `packagesFromFiles` is what drops the vendored copy, by path — which only works
    // because the wrapper directory came off first.
    expect(fileCount).toBe(4);
  });

  /**
   * 13 Sep 2026. This is a decompressor pointed at an object in Storage, and it inflated
   * every entry eagerly with no caps at all while the tar reader beside it has taken
   * `maxEntries`/`maxBytes` since it was written. The caps are `MAX_FILES` and
   * `MAX_EXTRACTED_BYTES`, the §6 pair, and they are read off the central directory — so a
   * hostile archive is refused before a byte of it is decompressed, and the caller sees the
   * `TarLimitError` its `artifact unreadable` branch already handles.
   */
  it("refuses an archive over the entry cap rather than inflating it", async () => {
    const files = Object.fromEntries(Array.from({ length: MAX_FILES + 1 }, (_, i) => [`f${i}.txt`, "x"]));
    await expect(readArtifactTextFiles(artifact(files))).rejects.toThrow(TarLimitError);

    // …and the rescan turns that into a skip, not a crashed run.
    const { row } = seedRelease();
    return expect(
      rescanRelease(row as never, { fetch: osvFetch([]).impl, readArtifact: async () => artifact(files), now: () => NOW }),
    ).resolves.toMatchObject({ status: "skipped", reason: expect.stringMatching(/artifact unreadable: .*entries/) });
  });

  it("decodes as the snapshot does: UTF-16 by its mark, and the NUL left in for the injection check (SCAN-1)", async () => {
    const bytes = writeZip([
      { path: "humanizer-1.0.0", type: "directory" },
      { path: "humanizer-1.0.0/requirements.txt", body: new Uint8Array(Buffer.from("﻿requests==2.31.0\n", "utf16le")) },
      { path: "humanizer-1.0.0/package.json", body: new TextEncoder().encode('\u0000{"name":"x"}') },
    ]);
    const { textFiles } = await readArtifactTextFiles(bytes);
    expect(textFiles.get("requirements.txt")).toBe("requests==2.31.0\n");
    expect(textFiles.get("package.json")).toBe('\u0000{"name":"x"}');
  });

  it("reads the whole archive only when asked, for §7's `check failed` repair path", async () => {
    const bytes = artifact({ "package.json": "{}", "SKILL.md": "# Widget\n" });
    expect([...(await readArtifactTextFiles(bytes)).textFiles.keys()]).toEqual(["package.json"]);
    expect([...(await readArtifactTextFiles(bytes, { manifestsOnly: false })).textFiles.keys()].sort()).toEqual(["SKILL.md", "package.json"]);
  });

  /**
   * The second defect the 14 Sep 2026 backfill turned up. The three `examples/*` releases
   * were cut on 30 Aug 2026, hours before DECISIONS 2026-08-30 chose zip, and are stored as
   * `<listing>/<version>/<sha>.tar.gz`; the reader knew only about zips and every one of
   * them came back `artifact unreadable: zip: end of central directory not found`. The
   * format is read off the first bytes, so the same manifests come out of either era's
   * artifact and the wrapper directory comes off both.
   */
  it("reads a pre-zip tar.gz artifact and returns what the zip returns", async () => {
    const files = { "package.json": "{}", "go.mod": "module example.com/x", "src/index.ts": "export const a = 1;" };
    const asZip = await readArtifactTextFiles(artifact(files));
    const asTarball = await readArtifactTextFiles(tarball(files));

    expect([...asTarball.textFiles.entries()].sort()).toEqual([...asZip.textFiles.entries()].sort());
    expect(asTarball.fileCount).toBe(asZip.fileCount);
    // And the whole-archive read, which on a tar cannot skip the inflate but does skip the
    // decode, is the same set of words as the zip's.
    expect([...(await readArtifactTextFiles(tarball(files), { manifestsOnly: false })).textFiles.keys()].sort()).toEqual([
      "go.mod",
      "package.json",
      "src/index.ts",
    ]);
  });

  it("refuses a tar.gz that expands past the cap, chunk by chunk rather than after the fact", async () => {
    const files = Object.fromEntries(Array.from({ length: MAX_FILES + 1 }, (_, i) => [`f${i}.txt`, "x"]));
    await expect(readArtifactTextFiles(tarball(files))).rejects.toThrow(TarLimitError);

    // A zip bomb is refused off the central directory, before a byte is inflated; a gzip
    // one has to be refused *while* it decompresses, which is `gunzipCapped`'s running
    // counter and its `RepoTooLargeError`. The cap is `MAX_EXTRACTED_BYTES` in the reader
    // above and a handful of bytes here, so the assertion costs a kilobyte rather than
    // 200 MB of zeroes.
    await expect(readArtifactEntries(tarball({ "a.txt": "x".repeat(4096) }), { maxBytes: 64 })).rejects.toThrow(RepoTooLargeError);
  });

  it("refuses an object that is neither a zip nor a gzip", async () => {
    await expect(readArtifactTextFiles(new TextEncoder().encode("not an archive at all"))).rejects.toThrow(/not a zip or a gzip/);
  });
});

// --- (i) a v1 report is lifted, and only the three rows move -----------------------

describe("rescanRelease", () => {
  it("lifts a v1 report and rewrites the three dependency rows, leaving the rest alone", async () => {
    const { seeded, row } = seedRelease();
    const osv = osvFetch([{ id: "GHSA-fresh", severity: "MODERATE" }]);
    const socket = socketFetch();

    const result = await rescanRelease(row as never, {
      fetch: osv.impl,
      socket: { ...SOCKET, fetch: socket.impl, now: () => NOW },
      readArtifact: async () => artifact(),
      now: () => NOW,
    });

    expect(result).toMatchObject({ status: "rescanned", compromised: false, osvRan: true, socketRan: true });

    const report = reportOf(seeded.latest.id);
    expect(report.version).toBe(2);
    expect(report.advisories_refreshed_at).toBe(new Date(NOW).toISOString());

    // Untouched: same status, same cut-time `at`, same findings.
    for (const id of ["secrets", "limits", "capabilities", "injection"]) {
      expect([id, checkOf(report, id).at]).toEqual([id, V1_REPORT.scanned_at]);
    }
    expect(checkOf(report, "capabilities").reason).toBe("predates scanner 2026.09");
    expect(report.findings.filter((f) => f.check === "secrets")).toHaveLength(1);

    // Rewritten: today's `at`, today's answers, and the stale CVE is gone.
    for (const id of ["known_vulns", "known_malware", "dep_behaviour"]) {
      expect([id, checkOf(report, id).at]).toEqual([id, new Date(NOW).toISOString()]);
    }
    expect(report.findings.some((f) => f.rule_id === "GHSA-stale")).toBe(false);
    expect(report.findings.some((f) => f.rule_id === "GHSA-fresh")).toBe(true);
    expect(checkOf(report, "dep_behaviour").status).not.toBe("unavailable");
    expect(report.checked).toContain("dep_behaviour");

    // §12: the verdict did not move, at either level.
    expect(mock.rows("release").find((r) => r.id === seeded.latest.id)!.scan).toBe("pass");
    expect(report.scanned_at).toBe(V1_REPORT.scanned_at);
    expect(report.scanner_version).toBe("2026.08.1");

    // The manifest republishes the public half and keeps the cut-time three.
    const scan = (mock.rows("release").find((r) => r.id === seeded.latest.id)!.manifest as any).computed.scan;
    expect(scan).toMatchObject({ verdict: "pass", scanner_version: "2026.08.1", at: V1_REPORT.scanned_at, advisories_refreshed_at: new Date(NOW).toISOString() });
    expect(scan.checks).toHaveLength(7);
    expect(scan.findings.some((f: { check: string }) => f.check === "secrets")).toBe(false);
    // FR-37: the block the manifest publishes still has to be the block the schema says.
    // `manifestFor` drops a manifest that will not parse, whole — a rescan that wrote an
    // invalid `computed.scan` would take the file tree and the README down with it.
    expect(ScanInfo.safeParse(scan).success).toBe(true);
    expect(scan.checks.every((c: Record<string, unknown>) => !("socket_scan_id" in c))).toBe(true);
  });

  it("shows an advisory OSV and Socket both know exactly once, and corrects the row's count", async () => {
    const { seeded, row } = seedRelease();
    // The `lodash` `cve` alert in the fixture carries this ghsaId; OSV reports it too.
    const osv = osvFetch([{ id: "GHSA-35jh-r3h4-6jhm", severity: "MODERATE" }]);

    await rescanRelease(row as never, {
      fetch: osv.impl,
      socket: { ...SOCKET, fetch: socketFetch().impl, now: () => NOW },
      readArtifact: async () => artifact(),
      now: () => NOW,
    });

    const report = reportOf(seeded.latest.id);
    const byId = report.findings.filter((f) => (f.advisory_ids ?? []).includes("GHSA-35jh-r3h4-6jhm"));
    expect(byId).toHaveLength(1);
    expect(byId[0].source).toBe("osv.dev");
    const dep = checkOf(report, "dep_behaviour");
    expect(dep.findings).toBe(report.findings.filter((f) => f.check === "dep_behaviour").length);
  });

  // --- (ii) the repair path: finish the scan we already paid for -------------------

  it("finishes a `socket processing` row from its stored id instead of re-uploading", async () => {
    const processing: ScanReport = {
      version: 2,
      verdict: "pass",
      scanner_version: "2026.09.1",
      scanned_at: "2026-09-06T09:00:00.000Z",
      checks: [
        { id: "secrets", tool: "x402git/secrets", tool_version: "2026.09.1", status: "pass", at: "2026-09-06T09:00:00.000Z", findings: 0 },
        { id: "dep_behaviour", tool: "socket.dev", tool_version: "2026-09-06", status: "unavailable", at: "2026-09-06T09:00:00.000Z", findings: 0, reason: "socket processing", socket_scan_id: "fullscan_waiting" },
      ],
      findings: [],
      counts: { secrets: 0, vulnerabilities: 0, blocking: 0, disclosed: 0, review: 0 },
      checked: ["secrets"],
      packages_scanned: 1,
    };
    const { seeded, row } = seedRelease({ scan_report: processing });
    const osv = osvFetch([]);
    const socket = socketFetch();

    const result = await rescanRelease(row as never, {
      fetch: osv.impl,
      socket: { ...SOCKET, fetch: socket.impl, now: () => NOW },
      readArtifact: async () => artifact(),
      now: () => NOW,
    });

    expect(result.socketResumed).toBe(true);
    // One GET for the stream and one DELETE for the finished scan. No quota check, no
    // create, no multipart upload: the id is why it was stored (§7, 1 unit not 7).
    expect(socket.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(socket.calls.map((c) => c.method)).toEqual(["GET", "DELETE"]);
    expect(checkOf(reportOf(seeded.latest.id), "dep_behaviour").status).toBe("findings");
  });

  // --- (iii) a dependency that is now malware --------------------------------------

  it("raises release_compromised and the FR-41 webhook when a passing release goes MAL-, and leaves the verdict alone", async () => {
    const { seeded, row } = seedRelease();
    const osv = osvFetch([{ id: "MAL-2026-1188", aliases: ["GHSA-mal-mal-mal"], summary: "exfiltrates env vars on install" }]);
    const socket = socketFetch();
    const recordEvent = vi.fn(async () => {});
    const sendWebhook = vi.fn(async () => ({ delivered: true }));

    const result = await rescanRelease(row as never, {
      fetch: osv.impl,
      socket: { ...SOCKET, fetch: socket.impl, now: () => NOW },
      readArtifact: async () => artifact(),
      recordEvent,
      sendWebhook,
      now: () => NOW,
    });

    expect(result.compromised).toBe(true);
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "release_compromised",
        listingId: seeded.listingId,
        props: expect.objectContaining({ version: "1.0.0", verdict: "pass", advisory_ids: expect.arrayContaining(["MAL-2026-1188"]) }),
      }),
    );
    expect(sendWebhook).toHaveBeenCalledWith({ event: "release.compromised", listingId: seeded.listingId, version: "1.0.0", code: "dependency_malware" });

    // §7 / §10 Q2: a notice, not an action. Nothing about the release changed but its
    // disclosures — the verdict is terminal and the listing keeps selling.
    const stored = mock.rows("release").find((r) => r.id === seeded.latest.id)!;
    expect(stored.scan).toBe("pass");
    expect((stored.scan_report as ScanReport).verdict).toBeUndefined();
    expect(checkOf(stored.scan_report as ScanReport, "known_malware").status).toBe("fail");
    expect(mock.rows("listing").find((l) => l.id === seeded.listingId)!.retired_at).toBeNull();
  });

  it("does not re-raise the notice on the next night, while the same malware is still there", async () => {
    const { row } = seedRelease();
    const deps = (recordEvent: ReturnType<typeof vi.fn>) => ({
      fetch: osvFetch([{ id: "MAL-2026-1188" }]).impl,
      socket: { ...SOCKET, fetch: socketFetch().impl, now: () => NOW },
      readArtifact: async () => artifact(),
      recordEvent,
      sendWebhook: vi.fn(async () => ({ delivered: true })),
      now: () => NOW,
    });

    expect((await rescanRelease(row as never, deps(vi.fn(async () => {})) as never)).compromised).toBe(true);
    const second = vi.fn(async () => {});
    // The row now carries the finding, so the state did not change and nothing is raised.
    const again = await rescanRelease(mock.rows("release").find((r) => r.id === row.id)! as never, deps(second) as never);
    expect(again.compromised).toBe(false);
    expect(second).not.toHaveBeenCalled();
  });


  // --- (vi) the package set the rescan asks about (finding 1, 13 Sep 2026) -----------

  /**
   * The cut asks GitHub's resolver and stores the answer on the manifest; the rescan used
   * to ask `packagesFromFiles`, which parses `package-lock.json` and four other basenames
   * and has never read a `pnpm-lock.yaml`. A pnpm repo cut at 300 packages was therefore
   * re-read at a handful of versionless ranges, came back clean, and the disclosures the
   * cut had published disappeared — a `pass`, not an outage, so none of §7's "a gap never
   * erases a disclosure" machinery saw it. The stored SBOM is the same question, so it is
   * the one asked again.
   */
  it("asks OSV about the SBOM the cut stored, not the manifests it can parse back out of the zip", async () => {
    const dependencies = Array.from({ length: 12 }, (_, i) => ({ name: `@scope/pkg-${i}`, version: `1.0.${i}`, ecosystem: "npm" }));
    const { seeded, row } = seedRelease({
      manifest: { version: "1.0.0", computed: { artifact_class: "Harness", dependencies, scan: { verdict: "pass", scanner_version: "2026.09.1", at: V1_REPORT.scanned_at } } },
      scan_report: { ...V1_REPORT, packages_scanned: 12 },
    });
    const osv = osvFetch([]);

    // A pnpm lockfile is exactly the case: Socket resolves it, our own parser does not.
    await rescanRelease(row as never, {
      fetch: osv.impl,
      socket: { ...SOCKET, fetch: socketFetch().impl, now: () => NOW },
      readArtifact: async () => artifact({ "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" }),
      now: () => NOW,
    });

    const queried = JSON.parse(String(osv.bodies[0])) as { queries: { package: { name: string } }[] };
    // `dedupePackages` sorts, so the comparison does too — what is under test is the set.
    expect(queried.queries.map((q) => q.package.name).sort()).toEqual(dependencies.map((d) => d.name).sort());
    expect(reportOf(seeded.latest.id).packages_scanned).toBe(12);
  });

  /**
   * And the backstop for a manifest too old to carry the SBOM: a run that asked about
   * materially fewer packages than the stored report did has not learned that the missing
   * ones are clean — it did not ask — so it does not get to rewrite rows that say they are
   * not. The old rows and their findings stay, and the run says why in one line.
   */
  it("refuses to rewrite the OSV rows from a weaker package set, and keeps the disclosures", async () => {
    const at = "2026-09-01T09:00:00.000Z";
    const stored: ScanReport = {
      version: 2,
      scanner_version: "2026.09.1",
      scanned_at: at,
      checks: [
        { id: "known_vulns", tool: "osv.dev", tool_version: "2026-09-01", status: "findings", at, findings: 2, packages: 300 },
        { id: "known_malware", tool: "osv.dev/MAL", tool_version: "2026-09-01", status: "pass", at, findings: 0, packages: 300 },
        { id: "dep_behaviour", tool: "socket.dev", tool_version: "2026-09-01", status: "unavailable", at, findings: 0, reason: "socket quota" },
      ],
      findings: [
        { kind: "vulnerability", check: "known_vulns", tier: "disclosed", public: true, rule_id: "GHSA-moderate-one", severity: "MODERATE", description: "one", blocking: false },
        { kind: "vulnerability", check: "known_vulns", tier: "disclosed", public: true, rule_id: "GHSA-moderate-two", severity: "MODERATE", description: "two", blocking: false },
      ],
      counts: { secrets: 0, vulnerabilities: 2, blocking: 0, disclosed: 2, review: 0 },
      checked: ["known_vulns", "known_malware"],
      packages_scanned: 300,
    };
    const { seeded, row } = seedRelease({ scan_report: stored });

    const result = await rescanRelease(row as never, {
      // Clean, which is the dangerous answer: one package, no advisories, `pass`.
      fetch: osvFetch([]).impl,
      socket: { ...SOCKET, fetch: socketFetch().impl, now: () => NOW },
      readArtifact: async () => artifact(),
      now: () => NOW,
    });

    expect(result).toMatchObject({ status: "rescanned", osvRan: false, socketRan: true });
    expect(result.reason).toMatch(/^skipped: weaker package set \(1 packages this run against 300/);

    const report = reportOf(seeded.latest.id);
    expect(report.findings.filter((f) => f.check === "known_vulns").map((f) => f.rule_id).sort()).toEqual(["GHSA-moderate-one", "GHSA-moderate-two"]);
    expect(checkOf(report, "known_vulns")).toMatchObject({ status: "findings", at, packages: 300 });
    expect(report.packages_scanned).toBe(300);
    // Socket is not OSV's package set and is refreshed regardless.
    expect(checkOf(report, "dep_behaviour").at).toBe(new Date(NOW).toISOString());
  });

  // --- (vii) a second piece of malware, on a release that already had one (finding 6) --

  /**
   * `already` was a boolean over the previous report, so the first `MAL-` record a release
   * ever carried silenced every one after it. Night 1 fires for `pkg-a`; night 8 a second
   * dependency turns out to be malware and nothing happens at all, because something was
   * already there. The transition test is now over identities, and the notice names only
   * what is new.
   */
  it("fires again for a package the last notice did not name, and names only that one", async () => {
    const { row, seeded } = seedRelease();
    const night = async (ids: string[], recordEvent: RescanDeps["recordEvent"]) => {
      const current = mock.rows("release").find((r) => r.id === row.id)!;
      return rescanRelease(current as never, {
        fetch: osvFetch(ids.map((id) => ({ id }))).impl,
        socket: { ...SOCKET, fetch: socketFetch().impl, now: () => NOW },
        readArtifact: async () => artifact(),
        recordEvent,
        sendWebhook: vi.fn(async () => ({ delivered: true })),
        now: () => NOW,
      });
    };

    // Night 1: `MAL-2026-1188` on the one dependency this artifact has.
    const first = vi.fn(async () => {});
    expect((await night(["MAL-2026-1188"], first)).compromised).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);

    // Night 2: the same record, still there. A nightly duplicate would teach the recipient
    // to ignore the one that matters.
    const second = vi.fn(async () => {});
    expect((await night(["MAL-2026-1188"], second)).compromised).toBe(false);
    expect(second).not.toHaveBeenCalled();

    // Night 8: a second advisory on the same release. This is the notice that was lost.
    const eighth = vi.fn(async () => {});
    expect((await night(["MAL-2026-1188", "MAL-2026-2400"], eighth)).compromised).toBe(true);
    expect(eighth).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "release_compromised",
        listingId: seeded.listingId,
        props: expect.objectContaining({ advisory_ids: ["MAL-2026-2400"] }),
      }),
    );
    // Both are on the report; only the new one is in the payload.
    expect(reportOf(seeded.latest.id).findings.filter((f) => f.rule_id.startsWith("MAL-"))).toHaveLength(2);
  });

  // --- (viii) the two pure checks §7 can simply re-run (finding 7) ---------------------

  it("re-runs a `capabilities` or `injection` row whose module threw, over the same bytes", async () => {
    const at = "2026-09-01T09:00:00.000Z";
    const brokeAtCut: ScanReport = {
      version: 2,
      scanner_version: "2026.09.1",
      scanned_at: at,
      checks: [
        { id: "secrets", tool: "x402git/secrets", tool_version: "2026.09.1", status: "pass", at, findings: 0 },
        { id: "known_vulns", tool: "osv.dev", tool_version: "2026-09-01", status: "pass", at, findings: 0, packages: 1 },
        { id: "dep_behaviour", tool: "socket.dev", tool_version: "2026-09-01", status: "pass", at, findings: 0 },
        { id: "capabilities", tool: "x402git/caps", tool_version: "2026.09.1", status: "unavailable", at, findings: 0, reason: "check failed: Cannot read properties of undefined" },
        { id: "injection", tool: "x402git/inject", tool_version: "2026.09.1", status: "unavailable", at, findings: 0, reason: "check failed: Cannot read properties of undefined" },
      ],
      findings: [],
      counts: { secrets: 0, vulnerabilities: 0, blocking: 0, disclosed: 0, review: 0 },
      checked: ["secrets", "known_vulns", "dep_behaviour"],
      packages_scanned: 1,
    };
    const { seeded, row } = seedRelease({ scan_report: brokeAtCut });

    const result = await rescanRelease(row as never, {
      fetch: osvFetch([]).impl,
      socket: { ...SOCKET, fetch: socketFetch().impl, now: () => NOW },
      // The words, not the manifests: this is the one path that reads the whole archive.
      readArtifact: async () =>
        artifact({
          "package.json": JSON.stringify({ dependencies: { esbuild: "0.21.5" }, scripts: { postinstall: "node setup.js" } }),
          "SKILL.md": "---\nallowed-tools: Bash, Read\n---\n\n# Widget\n",
        }),
      now: () => NOW,
    });

    expect(result.status).toBe("rescanned");
    const report = reportOf(seeded.latest.id);
    for (const id of ["capabilities", "injection"]) {
      expect([id, checkOf(report, id).status]).not.toEqual([id, "unavailable"]);
      expect([id, checkOf(report, id).at]).toEqual([id, new Date(NOW).toISOString()]);
      expect([id, checkOf(report, id).reason]).toEqual([id, undefined]);
    }
    // §4.3's inventory is back, which is the point: a listing whose "what it can do" block
    // has been blank since the day it was cut is the complaint §1 is about.
    expect(report.capabilities?.tools.map((t) => t.name)).toEqual(["Bash", "Read"]);
    expect(report.capabilities?.install_runs).toBe(true);
    expect(report.checked).toEqual(expect.arrayContaining(["capabilities", "injection"]));
  });

  // --- (ix) the public counts block (finding 9) ---------------------------------------

  /**
   * The cut writes `{blocking, disclosed, review}` (`manifestScan`, lib/release); the
   * rescan wrote `report.counts` whole, so the first time the cron touched a manifest it
   * grew `secrets` and `vulnerabilities` — two keys the schema does not have, one of which
   * announces on public JSON the existence of the secret whose path §4.4 is careful never
   * to print. One helper now, shared by both writers.
   */
  it("republishes exactly the three public counts onto the manifest", async () => {
    const { seeded, row } = seedRelease();

    await rescanRelease(row as never, {
      fetch: osvFetch([{ id: "GHSA-fresh", severity: "MODERATE" }]).impl,
      socket: { ...SOCKET, fetch: socketFetch().impl, now: () => NOW },
      readArtifact: async () => artifact(),
      now: () => NOW,
    });

    const scan = (mock.rows("release").find((r) => r.id === seeded.latest.id)!.manifest as any).computed.scan;
    expect(Object.keys(scan.counts).sort()).toEqual(["blocking", "disclosed", "review"]);
    expect(ScanInfo.safeParse(scan).success).toBe(true);
    // The report keeps its own five — those are the creator's numbers and never leave.
    expect(Object.keys(reportOf(seeded.latest.id).counts).sort()).toEqual(["blocking", "disclosed", "review", "secrets", "vulnerabilities"]);
  });
  // --- (v) nothing to read ----------------------------------------------------------

  it("skips a release whose bytes were deleted with its failed cut", async () => {
    const { row } = seedRelease({ storage_path: null, scan: "fail" });
    const readArtifact = vi.fn(async () => artifact());

    const result = await rescanRelease(row as never, { readArtifact, now: () => NOW });
    expect(result).toMatchObject({ status: "skipped", reason: "no artifact bytes" });
    expect(readArtifact).not.toHaveBeenCalled();
  });

  it("keeps the dependency rows it has when OSV is unreachable, rather than publishing an empty one", async () => {
    const v2: ScanReport = {
      version: 2,
      scanner_version: "2026.09.1",
      scanned_at: "2026-09-01T09:00:00.000Z",
      checks: [
        { id: "known_vulns", tool: "osv.dev", tool_version: "2026-09-01", status: "findings", at: "2026-09-01T09:00:00.000Z", findings: 1, packages: 4 },
        { id: "dep_behaviour", tool: "socket.dev", tool_version: "2026-09-01", status: "pass", at: "2026-09-01T09:00:00.000Z", findings: 0 },
      ],
      findings: [
        { kind: "vulnerability", check: "known_vulns", tier: "disclosed", public: true, rule_id: "GHSA-known", severity: "MODERATE", description: "a real one", blocking: false },
      ],
      counts: { secrets: 0, vulnerabilities: 1, blocking: 0, disclosed: 1, review: 0 },
      checked: ["known_vulns", "dep_behaviour"],
      packages_scanned: 4,
    };
    const { seeded, row } = seedRelease({ scan_report: v2 });
    const socket = socketFetch();

    const result = await rescanRelease(row as never, {
      fetch: vi.fn(async () => {
        throw new Error("osv is down");
      }),
      socket: { ...SOCKET, fetch: socket.impl, now: () => NOW },
      readArtifact: async () => artifact(),
      now: () => NOW,
    });

    expect(result).toMatchObject({ status: "rescanned", osvRan: false, socketRan: true });
    const report = reportOf(seeded.latest.id);
    expect(report.findings.some((f) => f.rule_id === "GHSA-known")).toBe(true);
    expect(checkOf(report, "known_vulns").at).toBe("2026-09-01T09:00:00.000Z");
    expect(report.osv_error).toContain("osv is down");
  });

  /**
   * The first defect the 14 Sep 2026 backfill turned up.
   * `pcmarts/crypto-balanced-portolio-builder` declares no dependencies at all, Socket's
   * archive endpoint answers `400 no supported manifest files`, and the failure table read
   * that as `unavailable · socket error` — so the merge policy above did the right thing
   * with the wrong input, kept the old `predates scanner 2026.09` row, and left a listing
   * that has nothing to disclose looking like one nobody has ever scanned. A 400 that says
   * there is nothing to analyse is an answer, and an answer replaces a predates row.
   */
  it("replaces a predates row with a pass when Socket says there are no dependency manifests", async () => {
    const { seeded, row } = seedRelease();
    const socket = vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.slice(SOCKET_BASE_URL.length);
      if (path === "/quota") return json({ quota: 500, maxQuota: 500, nextWindowRefresh: null });
      if (init?.method === "POST") return json({ error: { message: "No supported manifest files were found in the uploaded archive.", details: null } }, 400);
      throw new Error(`unscripted socket call: ${init?.method ?? "GET"} ${path}`);
    });

    const result = await rescanRelease(row as never, {
      fetch: osvFetch([]).impl,
      socket: { ...SOCKET, fetch: socket, now: () => NOW },
      readArtifact: async () => artifact({ "README.md": "# a portfolio builder, and no manifests\n" }),
      now: () => NOW,
    });

    expect(result).toMatchObject({ status: "rescanned", socketRan: true });
    // Nothing about it went into the run's notes as a vendor gap, because it is not one.
    expect((result.notes ?? []).some((n) => n.includes("dep_behaviour not refreshed"))).toBe(false);

    const dep = checkOf(reportOf(seeded.latest.id), "dep_behaviour");
    expect(dep).toMatchObject({ status: "pass", findings: 0, packages: 0, reason: "no dependency manifests", at: new Date(NOW).toISOString() });
    expect(dep.socket_scan_id).toBeUndefined();
    expect(reportOf(seeded.latest.id).checked).toContain("dep_behaviour");
    // And the page says so in words rather than in a nought (lib/web/manifest-view.ts).
    const scan = (mock.rows("release").find((r) => r.id === seeded.latest.id)!.manifest as any).computed.scan;
    expect(ScanInfo.safeParse(scan).success).toBe(true);
    expect(scan.checks.find((c: { id: string }) => c.id === "dep_behaviour")).toMatchObject({ status: "pass", packages: 0, reason: "no dependency manifests" });
  });
});

// --- the queues ---------------------------------------------------------------------

describe("rescanQueues", () => {
  it("queues an unavailable Socket row as a repair and a fresh one as a weekly refresh", async () => {
    const stale = (at: string): ScanReport => ({
      version: 2,
      scanner_version: "2026.09.1",
      scanned_at: at,
      checks: [{ id: "dep_behaviour", tool: "socket.dev", tool_version: at.slice(0, 10), status: "pass", at, findings: 0 }],
      findings: [],
      counts: { secrets: 0, vulnerabilities: 0, blocking: 0, disclosed: 0, review: 0 },
      checked: ["dep_behaviour"],
      packages_scanned: 1,
    });

    const broken = seedRelease({}, { slug: "broken" }); // v1 → `dep_behaviour` unavailable
    const fresh = seedRelease({ scan_report: stale("2026-09-12T09:00:00.000Z") }, { slug: "fresh" });
    const week = seedRelease({ scan_report: stale("2026-08-01T09:00:00.000Z") }, { slug: "week" });
    const retired = seedRelease({ scan_report: stale("2026-09-12T09:00:00.000Z") }, { slug: "gone", retired: true });

    const queue = await rescanQueues(NOW);
    const byId = new Map(queue.map((c) => [c.release.id, c]));

    expect(byId.get(broken.row.id)?.queue).toBe("repair");
    expect(byId.get(fresh.row.id)).toMatchObject({ queue: "refresh", socketDue: false });
    expect(byId.get(week.row.id)).toMatchObject({ queue: "refresh", socketDue: true });
    // A retired listing is not live, so its latest passing release is not refreshed.
    expect(byId.has(retired.row.id)).toBe(false);
    // Repairs come first, and inside a queue the oldest goes first so nothing starves.
    expect(queue[0].queue).toBe("repair");
    expect(queue.findIndex((c) => c.release.id === week.row.id)).toBeLessThan(queue.findIndex((c) => c.release.id === fresh.row.id));
  });

  /**
   * The other half of the repair queue (13 Sep 2026). A `capabilities` or `injection` row
   * that is `unavailable` because its module *threw* is a bug of ours over bytes that have
   * not changed — the one kind of gap a rescan can close without a vendor — so it is
   * queued even when Socket has nothing owing, and it does not spend a Socket unit to do it.
   */
  it("queues a release whose pure checks threw, without owing Socket a call", async () => {
    const at = "2026-09-12T09:00:00.000Z";
    const withFailedCheck: ScanReport = {
      version: 2,
      scanner_version: "2026.09.1",
      scanned_at: at,
      checks: [
        { id: "dep_behaviour", tool: "socket.dev", tool_version: "2026-09-12", status: "pass", at, findings: 0 },
        { id: "injection", tool: "x402git/inject", tool_version: "2026.09.1", status: "unavailable", at, findings: 0, reason: "check failed: boom" },
      ],
      findings: [],
      counts: { secrets: 0, vulnerabilities: 0, blocking: 0, disclosed: 0, review: 0 },
      checked: ["dep_behaviour"],
      packages_scanned: 1,
    };
    const broken = seedRelease({ scan_report: withFailedCheck }, { slug: "threw" });

    const queued = (await rescanQueues(NOW)).find((c) => c.release.id === broken.row.id);
    // A repair, because there is something to repair — and `socketDue: false`, because the
    // Socket row is fresh and re-uploading an archive would be seven units for nothing.
    expect(queued).toMatchObject({ queue: "repair", socketDue: false });
  });

  /** A row that says `predates scanner 2026.09` is not a bug; there is nothing to re-run. */
  it("does not queue a pure row that is unavailable for any other reason", async () => {
    const at = "2026-09-12T09:00:00.000Z";
    const predates: ScanReport = {
      version: 2,
      scanner_version: "2026.09.1",
      scanned_at: at,
      checks: [
        { id: "dep_behaviour", tool: "socket.dev", tool_version: "2026-09-12", status: "pass", at, findings: 0 },
        { id: "injection", tool: "x402git/inject", tool_version: "2026.08.1", status: "unavailable", at, findings: 0, reason: "predates scanner 2026.09" },
      ],
      findings: [],
      counts: { secrets: 0, vulnerabilities: 0, blocking: 0, disclosed: 0, review: 0 },
      checked: ["dep_behaviour"],
      packages_scanned: 1,
    };
    const old = seedRelease({ scan_report: predates }, { slug: "old" });
    expect((await rescanQueues(NOW)).find((c) => c.release.id === old.row.id)?.queue).toBe("refresh");
  });
});

// --- (iv) the quota floor ------------------------------------------------------------

describe("runRescan", () => {
  it("stops spending Socket units under 20% of the window and keeps refreshing OSV", async () => {
    const { seeded } = seedRelease();
    const osv = osvFetch([{ id: "GHSA-fresh", severity: "LOW" }]);
    const socket = socketFetch({ quota: 40, maxQuota: 500 });

    const summary = await runRescan({
      fetch: osv.impl,
      socket: { ...SOCKET, fetch: socket.impl, now: () => NOW },
      readArtifact: async () => artifact(),
      now: () => NOW,
    });

    expect(summary.repaired).toBe(1);
    expect(summary.socket_skipped).toBe(1);
    expect(summary.notes.join(" ")).toMatch(/Socket quota is under 20%/);
    // Quota was read (free) and nothing else was spent.
    expect(socket.calls.map((c) => c.url)).toEqual([`${SOCKET_BASE_URL}/quota`]);
    // OSV still ran, and the report says when.
    const report = reportOf(seeded.latest.id);
    expect(report.findings.some((f) => f.rule_id === "GHSA-fresh")).toBe(true);
    expect(report.advisories_refreshed_at).toBe(new Date(NOW).toISOString());
    expect(checkOf(report, "dep_behaviour").status).toBe("unavailable");
  });

  it("stops on the wall-clock budget and says the rest resumes tomorrow", async () => {
    seedRelease({}, { slug: "one" });
    seedRelease({}, { slug: "two" });
    let clock = NOW;
    const summary = await runRescan({
      fetch: osvFetch([]).impl,
      socket: { ...SOCKET, fetch: socketFetch().impl, now: () => NOW },
      readArtifact: async () => artifact(),
      // Every read of the clock is a second later, so the second candidate is past budget.
      now: () => (clock += 1000),
      budgetMs: 1,
    });
    expect(summary.queued).toBe(2);
    expect(summary.notes.join(" ")).toMatch(/resumes tomorrow/);
  });

  it("says so, rather than pretending, when Socket is not configured", async () => {
    seedRelease();
    const summary = await runRescan({ fetch: osvFetch([]).impl, readArtifact: async () => artifact(), now: () => NOW });
    expect(summary.notes.join(" ")).toMatch(/SOCKET_TOKEN_VALUE/);
    expect(summary.socket_skipped).toBe(1);
    expect(summary.repaired).toBe(1);
  });

  /**
   * §7's per-release share of the run (13 Sep 2026). The budget was read *between*
   * releases only, so at 249 s of 250 the loop happily began a release that could take
   * another ninety and `maxDuration` killed the handler mid-write. A release is now started
   * only when the budget has room for a whole one of them.
   */
  it("reserves a whole release's budget before starting another, and says what is left", async () => {
    seedRelease({}, { slug: "one" });
    seedRelease({}, { slug: "two" });
    seedRelease({}, { slug: "three" });

    let clock = NOW;
    const summary = await runRescan({
      fetch: osvFetch([]).impl,
      socket: { ...SOCKET, fetch: socketFetch().impl, now: () => NOW },
      // Each release costs 30 s of wall clock, charged when its bytes are read.
      readArtifact: async () => {
        clock += 30_000;
        return artifact();
      },
      now: () => clock,
      // Room for one release and most of a second — but not for a *whole* second one, and
      // that is the test: the old rule (`elapsed > budget`) started it at 30 s of 70.
      budgetMs: RESCAN_RELEASE_BUDGET_MS + 25_000,
    });

    expect(summary.queued).toBe(3);
    expect(summary.repaired).toBe(1);
    expect(summary.notes.join(" ")).toMatch(/Stopped after 30s with 2 releases still queued; resumes tomorrow\./);
  });

  /**
   * And the deadline the release itself is given. The vendor here is not broken, only slow;
   * with no per-release deadline it would poll its whole table and take the night's budget
   * with it. It stops, the row keeps its id, and §7 finishes it tomorrow for one unit.
   */
  it("cuts a slow Socket off at the release's own deadline rather than polling out the night", async () => {
    seedRelease();
    let clock = NOW;

    // Not broken, only slow: every request takes the whole ceiling it was handed — 10 s,
    // or whatever is left of the release's deadline when that is less, which is where a
    // real `AbortSignal.timeout` would fire. Nothing here refuses, so nothing but the
    // deadline stops it.
    let deadline = Number.POSITIVE_INFINITY;
    const socket = vi.fn(async (url: string, init?: RequestInit) => {
      clock += Math.max(0, Math.min(10_000, deadline - clock));
      const path = url.slice(SOCKET_BASE_URL.length);
      if (path === "/quota") return json({ quota: 500, maxQuota: 500, nextWindowRefresh: null });
      if (init?.method === "POST") return json({ id: "fullscan_slow" }, 201);
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return json({ status: "processing" }, 202);
    });

    await runRescan({
      fetch: osvFetch([]).impl,
      // Five poll slots, as the deps in this file always hand over. Three are ever used,
      // and the third only because a request may start with more than a second left.
      socket: { ...SOCKET, fetch: socket, now: () => clock },
      readArtifact: async () => {
        // The release's own deadline, as `runRescan` computes it a line before this call.
        deadline = clock + RESCAN_RELEASE_BUDGET_MS;
        return artifact();
      },
      now: () => clock,
    });

    const methods = socket.mock.calls.map(([url, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${String(url).slice(SOCKET_BASE_URL.length).split("?")[0]}`);
    expect(methods).toEqual([
      "GET /quota",
      "GET /quota",
      "POST /orgs/x402-git/full-scans/archive",
      "GET /orgs/x402-git/full-scans/fullscan_slow",
      "GET /orgs/x402-git/full-scans/fullscan_slow",
      "GET /orgs/x402-git/full-scans/fullscan_slow",
    ]);
    // Three polls of the five it was offered, and not a millisecond past the deadline.
    // Without one this vendor answers all five and takes 70 s of the night with it.
    expect(methods.filter((m) => m.startsWith("GET /orgs"))).toHaveLength(3);
    expect(clock).toBeLessThanOrEqual(deadline);
    // And nothing was deleted: the scan is the one §7 finishes tomorrow from its stored id.
    expect(methods.some((m) => m.startsWith("DELETE"))).toBe(false);
  });

  /**
   * FR-41 delivery is best effort and returns *why* rather than throwing — which is only
   * useful if somebody reads it. The result was dropped on the floor until 13 Sep 2026, so
   * a creator whose endpoint had been 500ing for a month looked exactly like a creator who
   * had been told.
   */
  it("puts a webhook that did not deliver into the run's summary", async () => {
    const { seeded } = seedRelease();
    const sendWebhook = vi.fn(async () => ({ delivered: false, reason: "http_500", status: 500 }));

    const summary = await runRescan({
      fetch: osvFetch([{ id: "MAL-2026-1188" }]).impl,
      socket: { ...SOCKET, fetch: socketFetch().impl, now: () => NOW },
      readArtifact: async () => artifact(),
      recordEvent: vi.fn(async () => {}),
      sendWebhook,
      now: () => NOW,
    });

    expect(summary.compromised).toBe(1);
    expect(sendWebhook).toHaveBeenCalledTimes(1);
    expect(summary.notes.join(" ")).toContain(`${seeded.listingId} v1.0.0: release.compromised webhook not delivered: http_500`);
  });
});

// --- the backfill (§7, 14 Sep 2026) ------------------------------------------------------

/**
 * A live listing as it actually looks the morning after the trust report shipped: the OSV
 * rows refreshed by last night's cron, Socket fresh well inside its week, and the two checks
 * the old scanner never had still saying `predates scanner 2026.09`. This is the row the
 * nightly is right to leave alone and the backfill exists to finish.
 */
const YESTERDAY = "2026-09-12T04:00:00.000Z";
const CUT = "2026-04-01T09:00:00.000Z";

function predatesReport(): ScanReport {
  const predates = "predates scanner 2026.09";
  return {
    version: 2,
    scanner_version: "2026.08.1",
    scanned_at: CUT,
    checks: [
      { id: "secrets", tool: "x402git/secrets", tool_version: "2026.08.1", status: "pass", at: CUT, findings: 0 },
      { id: "limits", tool: "x402git/limits", tool_version: "2026.08.1", status: "pass", at: CUT, findings: 0 },
      { id: "known_vulns", tool: "osv.dev", tool_version: "2026-09-12", status: "pass", at: YESTERDAY, findings: 0, packages: 1 },
      { id: "known_malware", tool: "osv.dev/MAL", tool_version: "2026-09-12", status: "pass", at: YESTERDAY, findings: 0, packages: 1 },
      { id: "dep_behaviour", tool: "socket.dev", tool_version: "2026-09-12", status: "pass", at: YESTERDAY, findings: 0 },
      { id: "capabilities", tool: "x402git/caps", tool_version: "2026.08.1", status: "unavailable", at: CUT, findings: 0, reason: predates },
      { id: "injection", tool: "x402git/inject", tool_version: "2026.08.1", status: "unavailable", at: CUT, findings: 0, reason: predates },
    ],
    findings: [],
    counts: { secrets: 0, vulnerabilities: 0, blocking: 0, disclosed: 0, review: 0 },
    checked: ["secrets", "limits", "known_vulns", "known_malware", "dep_behaviour"],
    packages_scanned: 1,
    advisories_refreshed_at: YESTERDAY,
  };
}

/** A SKILL.md that declares two tools and a package.json that runs at install. */
const SKILL_ARTIFACT = {
  "package.json": JSON.stringify({ dependencies: { esbuild: "0.21.5" }, scripts: { postinstall: "node setup.js" } }),
  "SKILL.md": "---\nallowed-tools: Bash, Read\n---\n\n# Widget\n",
};

describe("backfill", () => {
  it("re-runs a `predates` capabilities and injection row over the stored bytes, and still never touches the verdict", async () => {
    const { seeded, row } = seedRelease({ scan_report: predatesReport() });

    const result = await rescanRelease(row as never, {
      fetch: osvFetch([]).impl,
      socket: { ...SOCKET, fetch: socketFetch().impl, now: () => NOW },
      readArtifact: async () => artifact(SKILL_ARTIFACT),
      backfill: true,
      now: () => NOW,
    });

    expect(result.status).toBe("rescanned");
    const report = reportOf(seeded.latest.id);
    for (const id of ["capabilities", "injection"]) {
      expect([id, checkOf(report, id).status]).not.toEqual([id, "unavailable"]);
      expect([id, checkOf(report, id).at]).toEqual([id, new Date(NOW).toISOString()]);
      expect([id, checkOf(report, id).reason]).toEqual([id, undefined]);
    }
    // §4.3's inventory, on a listing that has been selling with a blank one since April.
    expect(report.capabilities?.tools.map((t) => t.name)).toEqual(["Bash", "Read"]);
    expect(report.capabilities?.install_runs).toBe(true);
    expect(report.checked).toEqual(expect.arrayContaining(["capabilities", "injection"]));

    // §12, and this is the run with the most reason to forget it: the audit is new, the
    // verdict is the cut's, and `scanned_at` still says April.
    expect(mock.rows("release").find((r) => r.id === seeded.latest.id)!.scan).toBe("pass");
    expect(report.verdict).toBeUndefined();
    expect(report.scanned_at).toBe(CUT);
    expect(report.scanner_version).toBe("2026.08.1");
    expect(checkOf(report, "secrets").at).toBe(CUT);
    expect(report.advisories_refreshed_at).toBe(new Date(NOW).toISOString());
  });

  it("calls Socket on a row refreshed yesterday, because the weekly cadence is a cron's rule and not an operator's", async () => {
    const { seeded } = seedRelease({ scan_report: predatesReport() });
    const socket = socketFetch();

    const summary = await runRescan({
      mode: "backfill",
      fetch: osvFetch([]).impl,
      socket: { ...SOCKET, fetch: socket.impl, now: () => NOW },
      readArtifact: async () => artifact(SKILL_ARTIFACT),
      now: () => NOW,
    });

    expect(summary).toMatchObject({ mode: "backfill", queued: 1, refreshed: 1, socket_skipped: 0 });
    // The archive went up: this is a full scan, not a resume and not a skip.
    expect(socket.calls.some((c) => c.method === "POST")).toBe(true);
    expect(checkOf(reportOf(seeded.latest.id), "dep_behaviour").at).toBe(new Date(NOW).toISOString());
  });

  /**
   * The regression this mode is bracketed by. Everything above must stay unavailable to the
   * nightly: a `predates` row is not a bug to retry, and a Socket row one day old is not
   * worth seven units — the cron that runs every night over every live listing is exactly
   * where those two rules pay for themselves.
   */
  it("leaves both alone on the nightly, which still refreshes OSV and spends nothing", async () => {
    const { seeded } = seedRelease({ scan_report: predatesReport() });
    const socket = socketFetch();

    const summary = await runRescan({
      fetch: osvFetch([{ id: "GHSA-fresh", severity: "MODERATE" }]).impl,
      socket: { ...SOCKET, fetch: socket.impl, now: () => NOW },
      readArtifact: async () => artifact(SKILL_ARTIFACT),
      now: () => NOW,
    });

    expect(summary).toMatchObject({ mode: "nightly", queued: 1, refreshed: 1, repaired: 0 });
    // Not one call, not even the free quota read: the row is inside its week.
    expect(socket.calls).toEqual([]);

    const report = reportOf(seeded.latest.id);
    for (const id of ["capabilities", "injection"]) {
      expect([id, checkOf(report, id)]).toMatchObject([id, { status: "unavailable", reason: "predates scanner 2026.09", at: CUT }]);
    }
    expect(report.capabilities).toBeUndefined();
    expect(checkOf(report, "dep_behaviour").at).toBe(YESTERDAY);
    // And OSV, which is free, ran as it does every night.
    expect(report.findings.some((f) => f.rule_id === "GHSA-fresh")).toBe(true);
    expect(report.advisories_refreshed_at).toBe(new Date(NOW).toISOString());
  });

  /**
   * §7 / §10 Q2, widened. A hidden Unicode tag run in a `SKILL.md` is `tier: "blocking"` at
   * cut time — the release would not have shipped — so finding one on a release that *did*
   * ship is the same sentence as finding malware in its dependencies, and gets the same
   * notice. The verdict does not move and nothing is paused; a human decides.
   */
  it("raises release_compromised for a blocking injection finding on a passing release, once, with rule ids and no path in the webhook", async () => {
    const smuggled = { "package.json": "{}", "SKILL.md": "Read this.\u{E0041}\u{E0042}" };
    const { seeded, row } = seedRelease({ scan_report: predatesReport() });
    const deps = (recordEvent: RescanDeps["recordEvent"], sendWebhook: RescanDeps["sendWebhook"]) => ({
      fetch: osvFetch([]).impl,
      socket: { ...SOCKET, fetch: socketFetch().impl, now: () => NOW },
      readArtifact: async () => artifact(smuggled),
      backfill: true,
      recordEvent,
      sendWebhook,
      now: () => NOW,
    });

    const recordEvent = vi.fn(async () => {});
    const sendWebhook = vi.fn(async () => ({ delivered: true }));
    const result = await rescanRelease(row as never, deps(recordEvent, sendWebhook) as never);

    expect(result.compromised).toBe(true);
    // The event is ours, so it names the file — a smuggling notice with no path in it is a
    // notice nobody can act on.
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "release_compromised",
        listingId: seeded.listingId,
        props: expect.objectContaining({
          verdict: "pass",
          rules: [{ rule_id: "hidden-unicode-tags", path: "SKILL.md" }],
          sources: ["injection"],
          advisory_ids: [],
        }),
      }),
    );
    // §4.4: the webhook leaves the building, over the open internet, to a creator-supplied
    // URL. Rule ids in `code`, and the exact-object match is the assertion that no path
    // rode along with them.
    expect(sendWebhook).toHaveBeenCalledWith({
      event: "release.compromised",
      listingId: seeded.listingId,
      version: "1.0.0",
      code: "instruction_smuggling:hidden-unicode-tags",
    });

    const stored = mock.rows("release").find((r) => r.id === seeded.latest.id)!;
    expect(stored.scan).toBe("pass");
    expect(checkOf(stored.scan_report as ScanReport, "injection").status).toBe("fail");
    // §4.4 again: the count is public, the finding is not, so the manifest gains a `fail`
    // row and no text anybody could follow.
    const scan = (stored.manifest as any).computed.scan;
    expect(scan.findings.some((f: { check: string }) => f.check === "injection")).toBe(false);
    expect(scan.checks.find((c: { id: string }) => c.id === "injection")).toMatchObject({ status: "fail", findings: 1 });

    // Once. The row now carries the finding, so the identity is not new and the second run
    // says nothing — the same transition rule the `MAL-` half has.
    const again = vi.fn(async () => {});
    const second = await rescanRelease(mock.rows("release").find((r) => r.id === row.id)! as never, deps(again, vi.fn(async () => ({ delivered: true }))) as never);
    expect(second.compromised).toBe(false);
    expect(again).not.toHaveBeenCalled();
  });

  it("takes one listing when it is named, and every live listing when it is not", async () => {
    const one = seedRelease({ scan_report: predatesReport() }, { owner: "adrian", slug: "humanizer" });
    seedRelease({ scan_report: predatesReport() }, { owner: "billie", slug: "other" });
    seedRelease({ scan_report: predatesReport() }, { owner: "cass", slug: "gone", retired: true });

    const run = (listingId?: string) =>
      runRescan({
        mode: "backfill",
        ...(listingId ? { listingId } : {}),
        fetch: osvFetch([]).impl,
        socket: { ...SOCKET, fetch: socketFetch().impl, now: () => NOW },
        readArtifact: async () => artifact(SKILL_ARTIFACT),
        now: () => NOW,
      });

    // Named: exactly that listing's latest passing release, and the rows it produced.
    const single = await run(one.seeded.listingId);
    expect(single.queued).toBe(1);
    expect(single.public_checks).toMatchObject({ release_id: one.seeded.latest.id, version: "1.0.0" });
    expect(single.public_checks?.checks.map((c) => c.id)).toContain("capabilities");
    // §4.4: this body is printed in somebody's terminal.
    expect(single.public_checks?.checks.every((c) => !("socket_scan_id" in c))).toBe(true);

    // Unnamed: every live listing, and the retired one is not one of them.
    expect((await run()).queued).toBe(2);
    expect(await listingIdByPath("adrian/humanizer")).toBe(one.seeded.listingId);
    expect(await listingIdByPath("adrian/nothing")).toBeNull();
    expect(await listingIdByPath("nobody/humanizer")).toBeNull();
    expect(await listingIdByPath("humanizer")).toBeNull();
  });
});

// --- the manifest block ----------------------------------------------------------------

describe("withRefreshedScan", () => {
  it("leaves a manifest that has no computed.scan block exactly as it was", () => {
    const manifest = { version: "1.0.0", computed: { artifact_class: "Prompt" } };
    expect(withRefreshedScan(manifest, { checks: [], findings: [] } as unknown as ScanReport)).toBe(manifest);
    expect(withRefreshedScan(null, {} as ScanReport)).toBeNull();
  });

  /**
   * The `examples/*` manifests are from 30 Aug 2026 and their `computed.scan` is three keys
   * — `verdict`, `scanner_version`, `at` — with no `checks` at all, because the block
   * predates report v2 (`/api/label/examples/humanizer` still shows exactly that). The
   * backfill has to *grow* one onto them rather than skip them, and the spread is what does
   * it: the cut-time three survive untouched and the whole public block lands beside them.
   */
  it("writes the full block onto a manifest whose scan block predates `checks` entirely", () => {
    const manifest = { version: "1.0.0", computed: { scan: { verdict: "pass", scanner_version: "2026.08.1", at: "2026-08-30T12:00:00.000Z" } } };
    const report = {
      version: 2,
      checks: [{ id: "dep_behaviour", tool: "socket.dev", tool_version: "2026-09-14", status: "pass", at: "2026-09-14T04:00:00.000Z", findings: 0, packages: 0, reason: "no dependency manifests", socket_scan_id: "fullscan_secret" }],
      findings: [],
      counts: { secrets: 0, vulnerabilities: 0, blocking: 0, disclosed: 0, review: 0 },
      advisories_refreshed_at: "2026-09-14T04:00:00.000Z",
    } as unknown as ScanReport;

    const scan = (withRefreshedScan(manifest, report) as any).computed.scan;
    // The cut-time three are still the cut's.
    expect(scan).toMatchObject({ verdict: "pass", scanner_version: "2026.08.1", at: "2026-08-30T12:00:00.000Z" });
    // And the block a manifest of that era has never had is there now, schema-valid, with
    // the vendor scan id stripped (§4.4).
    expect(scan.checks).toEqual([
      { id: "dep_behaviour", tool: "socket.dev", tool_version: "2026-09-14", status: "pass", at: "2026-09-14T04:00:00.000Z", findings: 0, packages: 0, reason: "no dependency manifests" },
    ]);
    expect(scan.findings).toEqual([]);
    expect(scan.counts).toEqual({ blocking: 0, disclosed: 0, review: 0 });
    expect(scan.advisories_refreshed_at).toBe("2026-09-14T04:00:00.000Z");
    expect(ScanInfo.safeParse(scan).success).toBe(true);
  });

  // 14 Sep 2026: the first backfill published seventeen capability findings and a
  // `capabilities` of null, so the page said "listed below" over an empty inventory.
  it("republishes the capability inventory itself, not only its findings", () => {
    const manifest = { version: "1.0.0", computed: { scan: { verdict: "pass", scanner_version: "2026.08.1", at: "2026-09-01T00:00:00.000Z" } } };
    const capabilities = { tools: [], runs: [], hosts: [], env: [], install_runs: false, summary: "No tools, no hosts, no environment variables, nothing runs at install." };
    const report = { version: 2, checks: [], findings: [], counts: { secrets: 0, vulnerabilities: 0, blocking: 0, disclosed: 0, review: 0 }, capabilities } as unknown as ScanReport;
    const scan = (withRefreshedScan(manifest, report) as any).computed.scan;
    expect(scan.capabilities).toEqual(capabilities);
    expect(scan.at).toBe("2026-09-01T00:00:00.000Z");
    // And a report without one leaves the key absent rather than null.
    const bare = (withRefreshedScan(manifest, { ...report, capabilities: undefined } as ScanReport) as any).computed.scan;
    expect("capabilities" in bare).toBe(false);
  });

  /**
   * §4.4, amended 14 Sep 2026. The backfill that put 1,209 findings on one manifest is the
   * run that has to take them back off, so the fold has to reach this writer and not only
   * the cut-time one — `manifestScan` in lib/release/index.ts is the other half.
   */
  it("republishes the transitive dependency findings folded, one row per rule", () => {
    const manifest = { version: "1.0.0", computed: { scan: { verdict: "pass", scanner_version: "2026.09.1", at: "2026-09-01T00:00:00.000Z" } } };
    const behaviour = (name: string, direct: boolean) => ({
      kind: "behaviour",
      check: "dep_behaviour",
      tier: "disclosed",
      public: true,
      rule_id: "envVars",
      severity: "UNKNOWN",
      description: `${name} — reads environment variables`,
      blocking: false,
      package: { ecosystem: "npm", name, version: "2.0.0", direct, dev: false },
    });
    const findings = [behaviour("dotenv", true), ...Array.from({ length: 364 }, (_, i) => behaviour(`t-${i}`, false))];
    const report = {
      version: 2,
      checks: [],
      findings,
      counts: { secrets: 0, vulnerabilities: 0, blocking: 0, disclosed: 365, review: 0 },
    } as unknown as ScanReport;

    const scan = (withRefreshedScan(manifest, report) as any).computed.scan;
    expect(scan.findings).toHaveLength(2);
    expect(scan.findings[0].package.name).toBe("dotenv");
    expect(scan.findings[1]).toMatchObject({ rule_id: "envVars", description: "envVars in 364 transitive packages", aggregate: { packages: 364 } });
    // The counts are the scan's own and the fold does not touch them.
    expect(scan.counts).toEqual({ blocking: 0, disclosed: 365, review: 0 });
  });
});
