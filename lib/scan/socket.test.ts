import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  SOCKET_ALERTS,
  SOCKET_BASE_URL,
  SOCKET_TOOL,
  deleteSocketScan,
  mapSocketArtifacts,
  parseSocketNdjson,
  readSocketScan,
  socketAlertRule,
  socketConfigured,
  socketFullScan,
  socketQuota,
  socketSeverity,
} from "./socket";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/socket/${name}.ndjson`, import.meta.url), "utf8");

const TOKEN = "sktsec_test_value_only";
const HASH = "sktsec_test_hash_public_id";
const ORG = "x402-git";

const deps = (fetchImpl: ReturnType<typeof stub>["fetchImpl"]) => ({
  fetch: fetchImpl,
  token: TOKEN,
  orgSlug: ORG,
  // Five slots, no waiting: the delays are a budget, not behaviour under test.
  pollDelaysMs: [0, 0, 0, 0, 0],
  now: () => Date.parse("2026-09-13T10:12:00.000Z"),
});

const input = {
  archive: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]),
  listingId: "11111111-2222-3333-4444-555555555555",
  version: "1.2.0",
  commitSha: "0f2a1b3c4d5e6f708192a3b4c5d6e7f809a1b2c3",
  fileCount: 412,
};

/** A fetch that hands back scripted responses in order and records every call it saw. */
function stub(entries: (Response | Error)[]) {
  const script = [...entries];
  const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    calls.push({ url, method: init?.method ?? "GET", headers, body: init?.body });
    const next = script.shift();
    if (!next) throw new Error(`unscripted socket call: ${init?.method ?? "GET"} ${url}`);
    if (next instanceof Error) throw next;
    return next;
  });
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const quotaOk = (quota = 500, maxQuota = 500) => json({ quota, maxQuota, nextWindowRefresh: null });
const created = (id = "fullscan_abc123", extra: Record<string, unknown> = {}) => json({ id, ...extra }, 201);
const processing = () => json({ status: "processing" }, 202);
const ndjson = (text: string) => new Response(text, { status: 200, headers: { "content-type": "application/x-ndjson" } });

describe("SOCKET_ALERTS — the §6.2 table", () => {
  it("maps no slug twice", () => {
    // TypeScript rejects a duplicate key in the literal, but the source is the artefact a
    // reviewer edits, so the test reads the source rather than the object it produced.
    const source = readFileSync(new URL("./socket.ts", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("export const SOCKET_ALERTS"), source.indexOf("/** A slug the table has never heard of"));
    const keys = [...body.matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(60);
    expect(keys.length).toBe(new Set(keys).size);
  });

  it("carries every slug §6.2 names, in the tier §6.2 gives it", () => {
    expect(SOCKET_ALERTS.malware).toEqual({ tier: "blocking", severity: "CRITICAL", group: "malware" });

    const capability =
      "installScripts networkAccess shellAccess filesystemAccess envVars hasNativeCode usesEval dynamicRequire debugAccess telemetry obfuscatedFile highEntropyStrings urlStrings minifiedFile".split(
        " ",
      );
    const review =
      "gptMalware gptSecurity gptAnomaly potentialVulnerability didYouMean gptDidYouMean troll suspiciousStarActivity skillCommandInjection skillDataExfiltration skillHardcodedSecrets skillPreExecution skillPromptInjection skillToolChaining skillObfuscation skillResourceAbuse skillSupplyChain skillToolAbuse skillTransitiveTrust skillAutonomyAbuse skillDiscoveryAbuse".split(
        " ",
      );
    const hygiene =
      "deprecated unmaintained unstableOwnership newAuthor missingAuthor recentlyPublished gitDependency gitHubDependency httpDependency floatingDependency badSemverDependency missingLockfile shrinkwrap manifestConfusion unpopularPackage trivialPackage tooManyFiles unresolvedYarnDependency oversizedManifest unresolvedPomReference".split(
        " ",
      );
    const repo = "ghaContextToSink ghaArgToSink ghaEnvToSink ghaContextToEnv ghaContextToOutput ghaArgToEnv ghaArgToOutput".split(" ");
    const cve = "criticalCVE cve mediumCVE mildCVE".split(" ");

    for (const slug of capability) expect([slug, SOCKET_ALERTS[slug]]).toEqual([slug, { tier: "disclosed", group: "capability" }]);
    for (const slug of review) expect([slug, SOCKET_ALERTS[slug]]).toEqual([slug, { tier: "review", group: "review" }]);
    for (const slug of hygiene) expect([slug, SOCKET_ALERTS[slug]]).toEqual([slug, { tier: "disclosed", severity: "LOW", group: "hygiene" }]);
    for (const slug of repo) expect([slug, SOCKET_ALERTS[slug]]).toEqual([slug, { tier: "disclosed", severity: "MODERATE", group: "repo" }]);
    for (const slug of cve) expect([slug, SOCKET_ALERTS[slug]]).toEqual([slug, { tier: "dedupe_cve", group: "cve" }]);

    for (const slug of ["pendingScan", "notFound"]) expect(SOCKET_ALERTS[slug].tier).toBe("partial");
    for (const slug of ["policy", "generic", "socketUpgradeAvailable", "nonpermissiveLicense", "licenseException", "chromeExtensionPermissions"]) {
      expect([slug, SOCKET_ALERTS[slug].tier]).toEqual([slug, "ignore"]);
    }
  });

  it("ignores a licence or extension slug it has never seen, by family", () => {
    expect(socketAlertRule("licenseSomethingBrandNew").tier).toBe("ignore");
    expect(socketAlertRule("chromeExtensionNewThing").tier).toBe("ignore");
  });

  it("maps Socket's severity words onto ours, `middle` included", () => {
    expect(socketSeverity("critical")).toBe("CRITICAL");
    expect(socketSeverity("high")).toBe("HIGH");
    expect(socketSeverity("middle")).toBe("MODERATE");
    expect(socketSeverity("low")).toBe("LOW");
    expect(socketSeverity(undefined)).toBe("LOW");
  });
});

describe("mapSocketArtifacts", () => {
  it("makes one finding per (artifact, alert), skips the scores trailer and the ignored slugs", () => {
    const { findings, packages, partial } = mapSocketArtifacts(parseSocketNdjson(fixture("full-scan")));

    expect(packages).toBe(6); // the `_type: "scores"` line is not a package
    expect(partial).toBe(false);
    // `nonpermissiveLicense` on lodash is FR-11's business and produces nothing.
    expect(findings.map((f) => f.rule_id)).toEqual([
      "installScripts",
      "networkAccess",
      "minifiedFile",
      "deprecated",
      "cve",
      "gptMalware",
      "futureAlert",
      "ghaContextToSink",
    ]);
    expect(findings.every((f) => f.source === SOCKET_TOOL && f.check === "dep_behaviour" && f.public)).toBe(true);
    expect(findings.every((f) => f.blocking === false)).toBe(true);
  });

  it("writes the finding as one plain line, with the package, the direct/dev mark and a phrase", () => {
    const { findings } = mapSocketArtifacts(parseSocketNdjson(fixture("full-scan")));
    const byRule = (id: string) => findings.find((f) => f.rule_id === id)!;

    expect(byRule("installScripts").description).toBe("esbuild 0.21.5 (direct) — install scripts run when installed");
    expect(byRule("installScripts").package).toEqual({ ecosystem: "npm", name: "esbuild", version: "0.21.5", direct: true, dev: false });
    // The namespace is part of the name, and a dev-only package says so.
    expect(byRule("networkAccess").description).toBe("@types/node 22.5.0 (direct, dev only) — makes network requests at runtime");
    expect(byRule("networkAccess").package).toEqual({ ecosystem: "npm", name: "@types/node", version: "22.5.0", direct: true, dev: true });
    expect(byRule("deprecated").description).toBe("request 2.88.2 (transitive) — deprecated by its author");
  });

  it("keeps the tiers §4.1 assigns and the severities §6.2 fixes", () => {
    const { findings } = mapSocketArtifacts(parseSocketNdjson(fixture("full-scan")));
    const tier = (id: string) => findings.find((f) => f.rule_id === id)!;

    expect(tier("installScripts").tier).toBe("disclosed");
    expect(tier("installScripts").severity).toBe("MODERATE"); // Socket's `middle`
    expect(tier("deprecated").severity).toBe("LOW"); // hygiene is fixed at LOW
    expect(tier("ghaContextToSink").severity).toBe("MODERATE"); // repo-level is fixed
    // A classifier flag is shown, never a verdict, and never blocking.
    expect(tier("gptMalware")).toMatchObject({ tier: "review", blocking: false, kind: "behaviour" });
  });

  it("carries the advisory ids on a CVE alert so OSV can de-duplicate it by id", () => {
    const { findings } = mapSocketArtifacts(parseSocketNdjson(fixture("full-scan")));
    const cve = findings.find((f) => f.rule_id === "cve")!;

    expect(cve.advisory_ids).toEqual(["GHSA-35jh-r3h4-6jhm", "CVE-2021-23337"]);
    expect(cve.tier).toBe("disclosed");
    expect(cve.blocking).toBe(false); // OSV is the only source that fails a release
    expect(cve.description).toBe("lodash 4.17.20 (transitive) — has a known vulnerability GHSA-35jh-r3h4-6jhm, CVE-2021-23337");
  });

  it("discloses a slug the table has never seen, at LOW, under its own name", () => {
    const { findings } = mapSocketArtifacts(parseSocketNdjson(fixture("full-scan")));
    const unknown = findings.find((f) => f.rule_id === "futureAlert")!;

    expect(unknown).toMatchObject({ tier: "disclosed", severity: "LOW", blocking: false, kind: "behaviour" });
    expect(unknown.description).toBe("colours 1.4.1 (direct) — futureAlert");
  });

  it("makes a `malware` alert blocking and CRITICAL", () => {
    const { findings } = mapSocketArtifacts(parseSocketNdjson(fixture("malware")));
    const malware = findings.find((f) => f.rule_id === "malware")!;

    expect(malware).toMatchObject({ kind: "malware", tier: "blocking", severity: "CRITICAL", blocking: true, public: true });
    expect(malware.description).toBe("noblox.js-proxy 1.0.5 (transitive) — confirmed by Socket as malware");
  });

  it("reports `partial` for pendingScan / notFound and makes no finding of them", () => {
    const { findings, packages, partial } = mapSocketArtifacts(parseSocketNdjson(fixture("pending")));

    expect(partial).toBe(true);
    expect(packages).toBe(3);
    expect(findings.map((f) => f.rule_id)).toEqual(["installScripts"]);
  });
});

describe("socketFullScan — the §6.2 call sequence", () => {
  it("runs quota → create → poll → read → delete, and produces the row", async () => {
    const { fetchImpl, calls } = stub([quotaOk(), created("fullscan_abc123", { unmatchedFiles: ["deps.edn"] }), processing(), ndjson(fixture("full-scan")), json({ ok: true })]);

    const result = await socketFullScan(input, deps(fetchImpl));

    expect(calls.map((c) => `${c.method} ${c.url.replace(SOCKET_BASE_URL, "")}`)).toEqual([
      "GET /quota",
      `POST /orgs/x402-git/full-scans/archive?repo=${input.listingId}&branch=v1.2.0&integration_type=api&tmp=true&commit_hash=${input.commitSha}`,
      "GET /orgs/x402-git/full-scans/fullscan_abc123?include_scores=false&include_license_details=false",
      "GET /orgs/x402-git/full-scans/fullscan_abc123?include_scores=false&include_license_details=false",
      "DELETE /orgs/x402-git/full-scans/fullscan_abc123",
    ]);
    expect(calls.every((c) => c.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(calls[1].body).toBeInstanceOf(FormData);
    expect([...(calls[1].body as FormData).keys()]).toEqual(["file"]);
    expect(((calls[1].body as FormData).get("file") as File).name).toBe(`${input.listingId}-1.2.0.zip`);

    expect(result.check).toEqual({
      id: "dep_behaviour",
      tool: "socket.dev",
      tool_version: "2026-09-13",
      status: "findings",
      at: "2026-09-13T10:12:00.000Z",
      findings: 8,
      packages: 6,
      socket_scan_id: "fullscan_abc123",
    });
    expect(result.findings).toHaveLength(8);
    expect(result.unmatchedFiles).toEqual(["deps.edn"]);
  });

  it("sends the token and never the token hash", async () => {
    vi.stubEnv("SOCKET_TOKEN_VALUE", TOKEN);
    vi.stubEnv("SOCKET_TOKEN_HASH", HASH);
    vi.stubEnv("SOCKET_ORG_SLUG", ORG);
    try {
      expect(socketConfigured()).toBe(true);
      const { fetchImpl, calls } = stub([quotaOk(), created(), ndjson(fixture("full-scan")), json({ ok: true })]);

      // No `token`/`orgSlug` in deps: this is the environment path the pipeline uses.
      await socketFullScan(input, { fetch: fetchImpl, pollDelaysMs: [0, 0, 0, 0, 0] });

      const wire = JSON.stringify(calls.map((c) => ({ url: c.url, headers: c.headers })));
      expect(wire).toContain(TOKEN);
      expect(wire).not.toContain(HASH);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails the row on a `malware` alert, with the finding that did it", async () => {
    const { fetchImpl } = stub([quotaOk(), created("fullscan_mal"), ndjson(fixture("malware")), json({ ok: true })]);

    const { check, findings } = await socketFullScan(input, deps(fetchImpl));

    expect(check.status).toBe("fail");
    expect(check.packages).toBe(2);
    expect(findings.filter((f) => f.blocking)).toMatchObject([{ rule_id: "malware", severity: "CRITICAL", tier: "blocking" }]);
  });

  /**
   * A `partial` scan is the one thing §7's repair queue can finish for a single unit, and
   * on 13 Sep 2026 this line deleted it anyway: the condition was `status !== "unavailable"`,
   * so `partial` fell through to the delete while its id was stored on the row. Every night
   * afterwards the cron re-read an id Socket no longer had, got a 404, called it `socket
   * error` and re-uploaded the archive — seven units a night to finish a scan we had
   * already paid for and thrown away.
   */
  it("is `partial` when Socket has not finished analysing every package — and keeps the scan", async () => {
    const { fetchImpl, calls } = stub([quotaOk(), created("fullscan_pending"), ndjson(fixture("pending"))]);

    const { check } = await socketFullScan(input, deps(fetchImpl));

    expect(check).toMatchObject({ status: "partial", reason: "socket processing", packages: 3, socket_scan_id: "fullscan_pending", findings: 1 });
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "GET"]);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("passes when the stream is clean", async () => {
    const { fetchImpl } = stub([quotaOk(), created("fullscan_clean"), ndjson('{"type":"npm","name":"zod","version":"4.5.2","direct":true,"dev":false,"alerts":[]}\n{"_type":"scores"}\n'), json({ ok: true })]);

    const { check, findings } = await socketFullScan(input, deps(fetchImpl));

    expect(check).toMatchObject({ status: "pass", findings: 0, packages: 1 });
    expect(findings).toEqual([]);
  });

  it("skips the create when under a tenth of the quota window is left", async () => {
    const { fetchImpl, calls } = stub([quotaOk(40, 500)]);

    const { check } = await socketFullScan(input, deps(fetchImpl));

    expect(calls).toHaveLength(1); // nothing was created, so nothing was spent
    expect(check).toMatchObject({ status: "unavailable", reason: "socket quota", findings: 0 });
    expect(check.socket_scan_id).toBeUndefined();
  });

  it("keeps the scan id when the stream is still processing after every poll", async () => {
    const { fetchImpl, calls } = stub([quotaOk(), created("fullscan_slow"), processing(), processing(), processing(), processing(), processing()]);

    const { check } = await socketFullScan(input, deps(fetchImpl));

    expect(calls).toHaveLength(7); // quota + create + five polls; no delete on a bad read
    expect(check).toMatchObject({ status: "unavailable", reason: "socket processing", socket_scan_id: "fullscan_slow" });
  });

  it("uploads only the manifests when the snapshot is over Socket's 10,000-file limit", async () => {
    const { fetchImpl, calls } = stub([quotaOk(), created("fullscan_big"), ndjson(fixture("full-scan")), json({ ok: true })]);

    await socketFullScan(
      {
        ...input,
        fileCount: 12_400,
        manifestFiles: new Map([
          ["package.json", '{"name":"big"}'],
          ["packages/api/package-lock.json", "{}"],
        ]),
      },
      deps(fetchImpl),
    );

    expect(calls[1].url).toContain("/orgs/x402-git/full-scans?");
    expect(calls[1].url).not.toContain("/full-scans/archive");
    expect([...(calls[1].body as FormData).keys()]).toEqual(["package.json", "packages/api/package-lock.json"]);
  });

  it("still uploads the archive over 10,000 files when no manifests were handed over", async () => {
    const { fetchImpl, calls } = stub([quotaOk(), created(), ndjson(fixture("full-scan")), json({ ok: true })]);

    await socketFullScan({ ...input, fileCount: 12_400 }, deps(fetchImpl));

    expect(calls[1].url).toContain("/full-scans/archive");
  });

  it("omits `commit_hash` when the release has no commit sha", async () => {
    const { fetchImpl, calls } = stub([quotaOk(), created(), ndjson(fixture("full-scan")), json({ ok: true })]);

    await socketFullScan({ ...input, commitSha: undefined }, deps(fetchImpl));

    expect(calls[1].url).not.toContain("commit_hash");
  });

  /**
   * The wall clock, 13 Sep 2026. With `SOCKET_TIMEOUT_MS = 30_000` and five polls, quota +
   * create + 5 polls + delete is eight requests, and eight hung requests plus 60 s of poll
   * sleeps is 300 s — the whole of `cutRelease`'s `maxDuration`, spent on Socket, before
   * OSV has been asked a single question. The ceiling is now 10 s, there are three polls,
   * and a caller with less than that says so with `deadlineMs`.
   *
   * The vendor here answers every request just inside whatever budget it was given, which
   * is the shape that used to run away: nothing errors, nothing is refused, it is simply
   * slow. The scan stops inside the deadline with the row §7 knows how to finish.
   */
  it("stops inside the caller's deadline, keeping the id, when the vendor answers slowly", async () => {
    const start = Date.parse("2026-09-13T10:12:00.000Z");
    const deadlineMs = start + 45_000;
    let clock = start;

    const calls: string[] = [];
    const script = [quotaOk(), created("fullscan_slow"), processing(), processing(), processing(), processing(), processing()];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url.replace(SOCKET_BASE_URL, "")}`);
      // A hung vendor takes the whole of the ceiling it was handed — 10 s, or whatever is
      // left of the deadline when that is less — and then answers.
      clock += Math.max(0, Math.min(10_000, deadlineMs - clock) - 1);
      const next = script.shift();
      if (!next) throw new Error(`unscripted socket call: ${url}`);
      return next;
    });

    const { check, findings } = await socketFullScan(input, {
      fetch: fetchImpl,
      token: TOKEN,
      orgSlug: ORG,
      // The real table. The sleeps are not slept because the deadline closes first.
      pollDelaysMs: [0, 0, 0],
      now: () => clock,
      deadlineMs,
    });

    expect(clock).toBeLessThanOrEqual(deadlineMs);
    expect(check).toMatchObject({ status: "unavailable", reason: "socket processing", socket_scan_id: "fullscan_slow", findings: 0 });
    expect(findings).toEqual([]);
    // And it stopped rather than spending a unit it could not use: no delete, and fewer
    // requests than the poll table allows, because the budget ran out first.
    expect(calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);
    expect(calls.length).toBeLessThanOrEqual(5);
  });

  /**
   * The 400 that is not a failure at all (14 Sep 2026, §6.2). A 256 KB repository with no
   * `package.json`, no lockfile and no `requirements.txt` reaches the archive endpoint and
   * Socket says so; the row is a `pass` with nothing behind it, and the run that produced
   * it spent one unit and has nothing to poll or delete.
   */
  it("reads a 400 `no supported manifest files` as a pass with nothing in it, not as an outage", async () => {
    const { fetchImpl, calls } = stub([quotaOk(), json({ error: { message: "No supported manifest files were found in the uploaded archive.", details: null } }, 400)]);

    const { check, findings } = await socketFullScan(input, deps(fetchImpl));

    expect(check).toEqual({
      id: "dep_behaviour",
      tool: "socket.dev",
      tool_version: "2026-09-13",
      status: "pass",
      at: "2026-09-13T10:12:00.000Z",
      findings: 0,
      packages: 0,
      reason: "no dependency manifests",
    });
    expect(findings).toEqual([]);
    expect(check.socket_scan_id).toBeUndefined();
    // Quota and the create, and nothing else: there is no scan to poll and none to delete.
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
  });

  /**
   * The pre-zip artifact (14 Sep 2026). The three `examples/*` releases were cut hours
   * before DECISIONS 2026-08-30 chose zip and are gzip in Storage; Socket's archive
   * endpoint reads the filename, so a tarball announced as `….zip` is refused for being
   * exactly what it is. The format is sniffed off the bytes, not off the path.
   */
  it("uploads a pre-zip tar.gz artifact under a .tar.gz filename and application/gzip", async () => {
    const { fetchImpl, calls } = stub([quotaOk(), created(), ndjson(fixture("full-scan")), json({ ok: true })]);

    await socketFullScan({ ...input, archive: new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00]) }, deps(fetchImpl));

    const file = (calls[1].body as FormData).get("file") as File;
    expect(file.name).toBe(`${input.listingId}-1.2.0.tar.gz`);
    expect(file.type).toBe("application/gzip");
  });

  it("uploads a zip artifact as a zip, which is every artifact cut since 30 Aug 2026", async () => {
    const { fetchImpl, calls } = stub([quotaOk(), created(), ndjson(fixture("full-scan")), json({ ok: true })]);

    await socketFullScan(input, deps(fetchImpl));

    const file = (calls[1].body as FormData).get("file") as File;
    expect(file.name).toBe(`${input.listingId}-1.2.0.zip`);
    expect(file.type).toBe("application/zip");
  });

  it("survives a delete that fails — the read stands and the id is on the row", async () => {
    const { fetchImpl } = stub([quotaOk(), created("fullscan_undeletable"), ndjson(fixture("full-scan")), json({ error: { message: "nope" } }, 500)]);

    const { check } = await socketFullScan(input, deps(fetchImpl));

    expect(check).toMatchObject({ status: "findings", socket_scan_id: "fullscan_undeletable" });
  });
});

describe("socketFullScan — §6.2's failure table, and never an exception", () => {
  const cases: { name: string; script: (Response | Error)[]; reason: string }[] = [
    { name: "401 on the quota call", script: [json({ error: { message: "Unauthorized" } }, 401)], reason: "socket auth" },
    { name: "401 on the create", script: [quotaOk(), json({ error: { message: "Unauthorized" } }, 401)], reason: "socket auth" },
    { name: "403 on the create", script: [quotaOk(), json({ error: { message: "Forbidden" } }, 403)], reason: "socket quota" },
    { name: "429 on the create", script: [quotaOk(), json({ error: { message: "Too many" } }, 429, { "retry-after": "120" })], reason: "socket quota (retry after 120)" },
    { name: "5xx on the create", script: [quotaOk(), json({ error: { message: "boom" } }, 503)], reason: "socket error (503: boom)" },
    { name: "a 5xx with no body to read", script: [quotaOk(), new Response("", { status: 503 })], reason: "socket error (503)" },
    { name: "5xx on the read", script: [quotaOk(), created(), json({ error: { message: "boom" } }, 500)], reason: "socket error (500: boom)" },
    { name: "a 400 that is not about manifests", script: [quotaOk(), json({ error: { message: "branch is required", details: null } }, 400)], reason: "socket error (400: branch is required)" },
    {
      name: "404 on the read — the scan is gone, so the cron re-uploads",
      script: [quotaOk(), created(), json({ error: { message: "Full scan not found" } }, 404)],
      reason: "socket error (404: Full scan not found)",
    },
    { name: "a network failure", script: [quotaOk(), new TypeError("fetch failed")], reason: "socket error" },
    { name: "a create with no id", script: [quotaOk(), json({ warning: "no id here" }, 201)], reason: "socket error" },
    { name: "bad NDJSON", script: [quotaOk(), created(), ndjson('{"type":"npm","name":"ok"}\n{not json at all}\n')], reason: "socket error" },
  ];

  for (const { name, script, reason } of cases) {
    it(`records ${name} as unavailable · ${reason}`, async () => {
      const { fetchImpl } = stub(script);

      const { check, findings } = await socketFullScan(input, deps(fetchImpl));

      expect(check).toMatchObject({ id: "dep_behaviour", tool: SOCKET_TOOL, status: "unavailable", reason, findings: 0 });
      expect(findings).toEqual([]);
    });
  }

  /**
   * The suffix is new and the prefix is not allowed to be. `runSocket` (lib/scan/index.ts)
   * decides whether to re-upload an archive on `socket error`, `scanAlerts`
   * (lib/release/index.ts) raises its admin alerts on `socket auth` and `socket quota`, and
   * §7's repair queue looks for `socket processing` — all four by `startsWith`, all four
   * broken the moment a reason changes its first two words.
   */
  it("keeps the prefix every reader matches on, whatever it appends", async () => {
    const reasons: string[] = [];
    for (const script of [
      [json({ error: { message: "Unauthorized" } }, 401)],
      [quotaOk(), json({ error: { message: "Too many" } }, 429, { "retry-after": "120" })],
      [quotaOk(), json({ error: { message: "boom" } }, 500)],
    ]) {
      const { fetchImpl } = stub(script);
      reasons.push((await socketFullScan(input, deps(fetchImpl))).check.reason ?? "");
    }
    expect(reasons.map((r) => r.split(" ").slice(0, 2).join(" "))).toEqual(["socket auth", "socket quota", "socket error"]);
  });

  it("truncates a vendor message rather than printing a paragraph onto a listing page", async () => {
    const { fetchImpl } = stub([quotaOk(), json({ error: { message: `the vendor said ${"x".repeat(400)}` } }, 500)]);

    const reason = (await socketFullScan(input, deps(fetchImpl))).check.reason ?? "";

    expect(reason.startsWith("socket error (500: the vendor said xxx")).toBe(true);
    expect(reason.endsWith("…)")).toBe(true);
    expect(reason.length).toBeLessThan(120);
  });

  it("says `socket unconfigured` when the token or the org slug is missing", async () => {
    vi.stubEnv("SOCKET_TOKEN_VALUE", "");
    vi.stubEnv("SOCKET_ORG_SLUG", "");
    try {
      expect(socketConfigured()).toBe(false);
      const { fetchImpl, calls } = stub([]);

      const { check } = await socketFullScan(input, { fetch: fetchImpl });

      expect(calls).toHaveLength(0);
      expect(check).toMatchObject({ status: "unavailable", reason: "socket unconfigured" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("readSocketScan / deleteSocketScan / socketQuota — the §7 repair path", () => {
  it("finishes a `socket processing` row with one GET and no create", async () => {
    const { fetchImpl, calls } = stub([ndjson(fixture("full-scan"))]);

    const { check, findings } = await readSocketScan("fullscan_abc123", deps(fetchImpl));

    expect(calls.map((c) => `${c.method} ${c.url.replace(SOCKET_BASE_URL, "")}`)).toEqual([
      "GET /orgs/x402-git/full-scans/fullscan_abc123?include_scores=false&include_license_details=false",
    ]);
    expect(calls[0].headers.accept).toBe("application/x-ndjson");
    expect(check).toMatchObject({ status: "findings", findings: 8, packages: 6, socket_scan_id: "fullscan_abc123" });
    expect(findings).toHaveLength(8);
  });

  it("leaves the row processing, with its id, when Socket is still working", async () => {
    const { fetchImpl } = stub([processing()]);

    const { check } = await readSocketScan("fullscan_slow", deps(fetchImpl));

    expect(check).toMatchObject({ status: "unavailable", reason: "socket processing", socket_scan_id: "fullscan_slow" });
  });

  it("deletes a scan, and reports a failure rather than throwing", async () => {
    const ok = stub([json({ ok: true })]);
    expect(await deleteSocketScan("fullscan_abc123", deps(ok.fetchImpl))).toBe(true);
    expect(ok.calls[0].method).toBe("DELETE");

    const bad = stub([new TypeError("fetch failed")]);
    expect(await deleteSocketScan("fullscan_abc123", deps(bad.fetchImpl))).toBe(false);
  });

  it("reads the quota window, and tolerates the null refresh the live API returns", async () => {
    const { fetchImpl } = stub([json({ quota: 493, maxQuota: 500, nextWindowRefresh: null })]);

    expect(await socketQuota(deps(fetchImpl))).toEqual({ quota: 493, maxQuota: 500, nextWindowRefresh: null });

    const broken = stub([json({ error: { message: "Unauthorized" } }, 401)]);
    expect(await socketQuota(deps(broken.fetchImpl))).toBeNull();
  });
});
