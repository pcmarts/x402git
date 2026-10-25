import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { setPublicGithub } from "@/lib/github/public";
import { makeMockDb } from "@/lib/test/mock-db";
import { stubPublicGithub } from "@/lib/test/public-github";
import { makeTarball } from "@/lib/test/tarball";

const COMMIT = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const PREVIOUS = "9876543210fedcba9876543210fedcba98765432";

/** What the fake repository contains for a given test. */
let repoFiles: Record<string, string> = {};
let requestImpl: ((route: string, params?: Record<string, unknown>) => Promise<{ data: unknown }>) | null = null;

vi.mock("@/lib/github/app", () => ({
  installationOctokit: vi.fn(async () => ({
    request: (route: string, params?: Record<string, unknown>) => requestImpl!(route, params),
  })),
  // `GET /user/{account_id}` is how AUTH-2's role check turns the creator's stored GitHub
  // id into the login it asks about; everything else the App JWT is asked answers `{}`.
  githubApp: vi.fn(() => ({
    octokit: { request: async (route: string) => ({ data: route === "GET /user/{account_id}" ? { login: "adrian" } : {} }) },
  })),
}));

const { cutRelease, changelogFor, manifestScan, scanAlerts, tagFromRef, versionFromRef } = await import("./index");

function defaultRequest(overrides: Record<string, unknown> = {}) {
  const table: Record<string, unknown> = {
    "GET /repositories/{repository_id}": { owner: { login: "octo" }, name: "widget" },
    "GET /user/{account_id}": { login: "adrian" },
    "GET /repos/{owner}/{repo}": { default_branch: "main", size: 12, pushed_at: "2026-08-20T10:00:00Z", open_issues_count: 1, private: true },
    "GET /repos/{owner}/{repo}/commits/{ref}": { sha: COMMIT, commit: { message: "Ship it\n\n**Full Changelog**: https://github.com/o/r/compare/a...b" } },
    "GET /repos/{owner}/{repo}/git/trees/{tree_sha}": {
      tree: [
        { type: "blob", path: "README.md", size: 900, sha: "1".repeat(40) },
        { type: "blob", path: "LICENSE", size: 1100, sha: "2".repeat(40) },
        { type: "blob", path: "src/index.ts", size: 2400, sha: "3".repeat(40) },
      ],
    },
    "GET /repos/{owner}/{repo}/languages": { TypeScript: 2400 },
    "GET /repos/{owner}/{repo}/readme": { path: "README.md", content: Buffer.from("# widget").toString("base64") },
    "GET /repos/{owner}/{repo}/license": { license: { key: "mit", spdx_id: "MIT" } },
    "GET /repos/{owner}/{repo}/releases": [{ tag_name: "v1.2.0", published_at: "2026-08-28T10:00:00Z", name: "1.2.0", body: "Adds the retry loop." }],
    "GET /repos/{owner}/{repo}/dependency-graph/sbom": { sbom: { packages: [] } },
    // AUTH-2: the creator administers the repo, so a Rail A snapshot may be taken.
    "GET /repos/{owner}/{repo}/collaborators/{username}/permission": { permission: "admin", role_name: "admin", user: { login: "adrian" } },
    ...overrides,
  };

  return async (route: string) => {
    if (route === "GET /repos/{owner}/{repo}/tarball/{ref}") return { data: makeTarball(repoFiles) };
    const data = table[route];
    if (data === undefined) throw new Error(`404 ${route}`);
    if (data instanceof Error) throw data;
    return { data };
  };
}

let mock: ReturnType<typeof makeMockDb>;

beforeEach(() => {
  repoFiles = {
    "README.md": "# widget\n\nDoes a thing.\n",
    "LICENSE": "MIT License\n\nCopyright (c) 2026 Adrian\n",
    "src/index.ts": "export const widget = () => 42;\n",
  };
  requestImpl = defaultRequest();
  mock = makeMockDb({
    creator: [{ id: "c1", handle: "adrian", onboarded_via: "api", payout_address: "0x1", terms_version: "v1", github_user_id: "1234" }],
    listing: [
      {
        id: "l1",
        creator_id: "c1",
        slug: "widget",
        source: "github",
        installation_id: "4242",
        github_repo_id: "999",
        price_micro: "9000000",
        update_price_micro: "5000000",
        description: "Does a thing.",
        trigger_hint: "when you need a widget",
      },
    ],
  });
  setDb(mock.client as unknown as Db);
  // OSV: no vulnerabilities, no network.
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 })));
});

afterEach(() => {
  resetDb();
  setPublicGithub(null);
  vi.unstubAllGlobals();
});

describe("version parsing (FR-9)", () => {
  it("strips a leading v from a tag ref", () => {
    expect(versionFromRef("refs/tags/v1.2.0")).toBe("1.2.0");
    expect(versionFromRef("v1.2.0")).toBe("1.2.0");
    expect(versionFromRef("1.2.0")).toBe("1.2.0");
  });

  it("refuses anything that is not MAJOR.MINOR.PATCH", () => {
    expect(versionFromRef("refs/heads/main")).toBeNull();
    expect(versionFromRef("refs/tags/v1.2")).toBeNull();
    expect(versionFromRef("refs/tags/release-2026")).toBeNull();
    expect(versionFromRef(undefined)).toBeNull();
  });

  it("returns the tag name from a full ref", () => {
    expect(tagFromRef("refs/tags/v1.2.0")).toBe("v1.2.0");
    expect(tagFromRef("main")).toBe("main");
  });
});

describe("cutRelease — happy path", () => {
  it("writes a passing release with a manifest, a stored artifact and a stamped price", async () => {
    const result = await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const release = result.release;
    expect(release.version).toBe("1.2.0");
    expect(release.git_ref).toBe("v1.2.0");
    expect(release.commit_sha).toBe(COMMIT);
    expect(release.scan).toBe("pass");
    expect(release.artifact_sha256).toMatch(/^[0-9a-f]{64}$/);
    // FR-15: the prices in force at publish, stamped and never re-read.
    expect(String(release.price_micro_at_publish)).toBe("9000000");
    expect(String(release.update_price_micro_at_publish)).toBe("5000000");
    // §6: the bytes that were scanned are the bytes that are stored.
    expect(release.storage_path).toBe(`l1/1.2.0/${release.artifact_sha256}.zip`);
    expect(mock.storage.get("artifacts")?.has(release.storage_path!)).toBe(true);
  });

  it("computes the manifest from the snapshot, not from creator input (FR-52)", async () => {
    const result = await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" });
    if (!result.ok) throw new Error("expected a release");

    const manifest = result.release.manifest as any;
    expect(manifest.channel).toBe("adrian/widget");
    expect(manifest.version).toBe("1.2.0");
    expect(manifest.artifact_sha256).toBe(result.release.artifact_sha256);
    expect(manifest.computed.analyzer_version).toBeTruthy();
    expect(manifest.computed.computed_at).toMatch(/^\d{4}-/);
    expect(manifest.computed.licence).toEqual({ spdx: "MIT", verdict: "pass" });
    expect(manifest.computed.originality.blobs_total).toBe(3);
    // Self-reported claims are namespaced so an agent can drop them in one line.
    expect(manifest.self_reported).toEqual({ description: "Does a thing.", trigger_hint: "when you need a widget" });
  });

  it("runs the licence gate on every cut (FR-11)", async () => {
    await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" });
    expect(mock.rows("listing")[0]).toMatchObject({ licence_spdx: "MIT", licence_verdict: "pass" });
  });

  it("stores the blob SHAs for the next release's originality check (FR-50)", async () => {
    await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" });
    const stored = mock.rows("release")[0].blob_shas as string[];
    expect(stored).toEqual(["1".repeat(40), "2".repeat(40), "3".repeat(40)]);
  });

  it("uses the release body as the changelog, boilerplate stripped (FR-15)", async () => {
    const result = await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" });
    if (!result.ok) throw new Error("expected a release");
    expect(result.release.changelog).toBe("Adds the retry loop.");
  });

  it("prefers creator-supplied notes to anything GitHub generated", async () => {
    const result = await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0", version: "1.2.0", notes: "Hand written." });
    if (!result.ok) throw new Error("expected a release");
    expect(result.release.changelog).toBe("Hand written.");
  });

  it("writes a release_cut event", async () => {
    await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" });
    const events = mock.rows("event");
    expect(events.map((e) => e.name)).toEqual(["release_cut"]);
    expect((events[0].props as any).scan).toBe("pass");
  });

  it("computes a diff summary against the previous release", async () => {
    mock.rows("release").push({
      id: "r0",
      listing_id: "l1",
      version: "1.1.0",
      git_ref: "v1.1.0",
      commit_sha: PREVIOUS,
      scan: "pass",
      price_micro_at_publish: "9000000",
      update_price_micro_at_publish: "5000000",
      created_at: "2026-08-01T00:00:00Z",
    });
    requestImpl = defaultRequest({
      "GET /repos/{owner}/{repo}/compare/{basehead}": {
        files: [{ filename: "src/index.ts", status: "modified", additions: 10, deletions: 2 }],
      },
    });

    const result = await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" });
    if (!result.ok) throw new Error("expected a release");
    expect(result.release.diff_summary).toMatchObject({ files_changed: 1, additions: 10, deletions: 2 });
  });
});

// AUTH-2 (RED-TEAM-2026-09-21): a role can be taken away after a listing exists, so every
// Rail A cut — webhook or sync — re-reads the creator's role before any bytes are taken.
describe("cutRelease — the creator's role on the repo (AUTH-2)", () => {
  const PERMISSION = "GET /repos/{owner}/{repo}/collaborators/{username}/permission";

  /** Record every route the installation token is asked for, on top of `table`. */
  function recording(overrides: Record<string, unknown>) {
    const routes: string[] = [];
    const inner = defaultRequest(overrides);
    requestImpl = async (route, params) => {
      routes.push(route);
      return inner(route);
    };
    return routes;
  }

  function expectNothingTaken(routes: string[]) {
    expect(routes).not.toContain("GET /repos/{owner}/{repo}/tarball/{ref}");
    expect(mock.rows("release")).toHaveLength(0);
    expect(mock.storage.get("artifacts")?.size ?? 0).toBe(0);
  }

  it("cuts for a maintainer", async () => {
    const routes = recording({ [PERMISSION]: { permission: "write", role_name: "maintain" } });
    expect((await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" })).ok).toBe(true);
    expect(routes).toContain(PERMISSION);
  });

  it("refuses a creator who now only has write, before the snapshot", async () => {
    const routes = recording({ [PERMISSION]: { permission: "write", role_name: "write" } });
    const result = await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" });
    expect(result).toMatchObject({ ok: false, code: "repo_role_required" });
    if (!result.ok) expect(result.message).toContain("admin or maintain");
    expectNothingTaken(routes);
  });

  it("refuses when GitHub answers 404 for the role, or does not answer", async () => {
    let routes = recording({ [PERMISSION]: Object.assign(new Error("Not Found"), { status: 404 }) });
    expect(await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" })).toMatchObject({ ok: false, code: "repo_role_required" });
    expectNothingTaken(routes);

    routes = recording({ [PERMISSION]: new TypeError("fetch failed") });
    expect(await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" })).toMatchObject({ ok: false, code: "repo_role_required" });
    expectNothingTaken(routes);
  });

  it("refuses a Rail A cut for a creator with no linked GitHub identity on a listing newer than the cutover", async () => {
    mock.rows("creator")[0].github_user_id = null;
    mock.rows("listing")[0].created_at = "2026-10-26T09:00:00Z";
    const routes = recording({});
    expect(await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" })).toMatchObject({ ok: false, code: "repo_role_required" });
    expect(routes).not.toContain(PERMISSION);
    expectNothingTaken(routes);
  });

  it("still cuts for a legacy headless creator with no identity on a listing older than the cutover, without asking GitHub", async () => {
    mock.rows("creator")[0].github_user_id = null;
    mock.rows("listing")[0].created_at = "2026-08-30T13:48:04Z";
    const routes = recording({});
    expect((await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" })).ok).toBe(true);
    expect(routes).not.toContain(PERMISSION);
    expect(routes).not.toContain("GET /user/{account_id}");
  });

  it("does not ask about a Rail B repo: it is ours, provisioned for the creator", async () => {
    mock.rows("listing")[0].source = "hosted";
    mock.rows("creator")[0].github_user_id = null;
    const routes = recording({ [PERMISSION]: new Error("must not be asked") });
    expect((await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" })).ok).toBe(true);
    expect(routes).not.toContain(PERMISSION);
  });
});

describe("cutRelease — refusals", () => {
  it("refuses a ref that is not a version, with no version supplied", async () => {
    const result = await cutRelease({ listingId: "l1", ref: "refs/heads/main" });
    expect(result).toMatchObject({ ok: false, code: "invalid_version" });
    expect(mock.rows("release")).toHaveLength(0);
  });

  it("refuses a second cut of the same version (FR-9)", async () => {
    const first = await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" });
    expect(first.ok).toBe(true);

    const second = await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" });
    expect(second).toMatchObject({ ok: false, code: "version_exists" });
    expect(mock.rows("release")).toHaveLength(1);
  });

  it("refuses an unknown listing", async () => {
    expect(await cutRelease({ listingId: "nope", ref: "refs/tags/v1.0.0" })).toMatchObject({ ok: false, code: "not_found" });
  });

  it("refuses a re-cut of a failed release: pass and fail are terminal (§12, FR-9)", async () => {
    repoFiles["deploy.sh"] = 'export AWS_ACCESS_KEY_ID="AKIA2E0A8F3B244C9986"';
    expect((await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" })).ok).toBe(true);
    expect(mock.rows("release")[0].scan).toBe("fail");

    delete repoFiles["deploy.sh"];
    const second = await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" });
    expect(second).toMatchObject({ ok: false, code: "version_exists" });
    expect(mock.rows("release")).toHaveLength(1);
    expect(mock.rows("release")[0].scan).toBe("fail");
  });

  /**
   * §12: "Analysis errors leave `pending` with `scan_report.error`; `sync` re-runs." A
   * `version_exists` on a pending row made that sentence unimplementable — the failed cut
   * could not be retried by sync, by GitHub's redelivery, or by anything else.
   */
  it("resumes a pending release rather than calling it version_exists (§12)", async () => {
    requestImpl = defaultRequest({ "GET /repos/{owner}/{repo}/git/trees/{tree_sha}": new Error("GitHub is down") });
    await expect(cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" })).rejects.toThrow(/GitHub is down/);
    expect(mock.rows("release")[0].scan).toBe("pending");
    const stuckId = mock.rows("release")[0].id;

    requestImpl = defaultRequest();
    const retry = await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" });

    expect(retry.ok).toBe(true);
    // One release per (listing, version), whatever number of attempts it took.
    expect(mock.rows("release")).toHaveLength(1);
    expect(mock.rows("release")[0].id).toBe(stuckId);
    expect(mock.rows("release")[0].scan).toBe("pass");
    expect(mock.rows("release")[0].scan_report).not.toHaveProperty("error");
    expect(mock.rows("release")[0].storage_path).toMatch(/\.zip$/);
  });

  it("does not diff a resumed release against itself (FR-15)", async () => {
    requestImpl = defaultRequest({ "GET /repos/{owner}/{repo}/git/trees/{tree_sha}": new Error("GitHub is down") });
    await expect(cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" })).rejects.toThrow();

    const compared: string[] = [];
    const base = defaultRequest();
    requestImpl = async (route, params) => {
      if (route === "GET /repos/{owner}/{repo}/compare/{basehead}") compared.push(String(params?.basehead));
      return base(route);
    };
    expect((await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" })).ok).toBe(true);
    expect(compared).toEqual([]);
  });
});

/**
 * FR-8.2, amended 2026-09-01. "Check for releases" sends no ref and no version, and before this it
 * answered `invalid_version` on every repository in the world — so a listing created after
 * its repo was tagged (no webhook: the tag predates the install) could never cut a release
 * at all. Reported from production on `pcmarts/Crypto-Balanced-Portolio-Builder`, tagged
 * v1.0.0, release log empty.
 */
describe("cutRelease — a bare sync discovers the tag (FR-8.2)", () => {
  const TAGS = "GET /repos/{owner}/{repo}/tags";

  it("cuts the repository's newest version tag when neither a ref nor a version is given", async () => {
    requestImpl = defaultRequest({ [TAGS]: [{ name: "v1.0.0" }, { name: "v1.2.0" }, { name: "nightly" }] });

    const result = await cutRelease({ listingId: "l1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.release.version).toBe("1.2.0");
    expect(result.release.git_ref).toBe("v1.2.0");
  });

  it("orders tags numerically, not as strings", async () => {
    requestImpl = defaultRequest({ [TAGS]: [{ name: "v1.9.0" }, { name: "v1.10.0" }] });

    const result = await cutRelease({ listingId: "l1" });
    if (!result.ok) throw new Error("expected a release");
    expect(result.release.version).toBe("1.10.0");
  });

  it("backfills the newest tag that has not been cut, rather than repeating version_exists", async () => {
    requestImpl = defaultRequest({ [TAGS]: [{ name: "v1.0.0" }, { name: "v1.2.0" }] });
    expect((await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" })).ok).toBe(true);

    const second = await cutRelease({ listingId: "l1" });
    if (!second.ok) throw new Error("expected a release");
    expect(second.release.version).toBe("1.0.0");
    expect(mock.rows("release")).toHaveLength(2);
  });

  it("still says version_exists once every tag has been cut", async () => {
    requestImpl = defaultRequest({ [TAGS]: [{ name: "v1.2.0" }] });
    expect((await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" })).ok).toBe(true);

    expect(await cutRelease({ listingId: "l1" })).toMatchObject({ ok: false, code: "version_exists" });
    expect(mock.rows("release")).toHaveLength(1);
  });

  it("names the repository when it carries no version tag at all", async () => {
    requestImpl = defaultRequest({ [TAGS]: [{ name: "nightly" }] });

    const result = await cutRelease({ listingId: "l1" });
    expect(result).toMatchObject({ ok: false, code: "invalid_version" });
    if (result.ok) return;
    expect(result.message).toContain("octo/widget");
    expect(mock.rows("release")).toHaveLength(0);
  });

  it("does not guess a tag when the caller named a ref: a branch head is not a release", async () => {
    requestImpl = defaultRequest({ [TAGS]: [{ name: "v1.2.0" }] });

    expect(await cutRelease({ listingId: "l1", ref: "refs/heads/main" })).toMatchObject({ ok: false, code: "invalid_version" });
    expect(mock.rows("release")).toHaveLength(0);
  });
});

/**
 * "PRD Trust Report.md" §4.2/§4.4 — the trust report as the manifest publishes it.
 *
 * The manifest is public JSON served to anyone (FR-49), so the two filters
 * (`publicChecks`, `publicFindings`) are load-bearing and not politeness. The two things
 * that must never be in it are a secret's path and line, and `socket_scan_id`, which
 * names a scan under our Socket org.
 */
describe("cutRelease — the trust report on the manifest", () => {
  it("publishes the per-check rows, the capability inventory and the three counts", async () => {
    repoFiles["SKILL.md"] = "---\nallowed-tools: Bash, Read\n---\n\n# Widget\n\nDoes a thing.\n";

    const result = await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" });
    if (!result.ok) throw new Error("expected a release");

    const scan = (result.release.manifest as any).computed.scan;
    expect(scan.verdict).toBe("pass");
    expect(scan.at).toBe((result.release.scan_report as any).scanned_at);
    // §4.2: one row per check on every report, ran or not — a gap is a row saying so.
    expect(scan.checks.map((c: any) => c.id)).toEqual([
      "secrets",
      "limits",
      "known_vulns",
      "known_malware",
      "dep_behaviour",
      "capabilities",
      "injection",
    ]);
    // §9 phases 2a/2b: the two own modules ran, Socket has no token in the test suite.
    expect(scan.checks.find((c: any) => c.id === "injection").status).toBe("pass");
    expect(scan.checks.find((c: any) => c.id === "dep_behaviour")).toMatchObject({ status: "unavailable", reason: "socket unconfigured" });
    // §4.3: the inventory, computed from the snapshot and never self-reported.
    expect(scan.capabilities.tools.map((t: any) => t.name)).toEqual(["Bash", "Read"]);
    // §4.1's three tiers as three numbers, for an agent that will not read the list. The
    // two disclosures are the tool declaration itself and SCAN-2's notice that the release
    // ships no dependency manifest — nothing here is ever a verdict.
    expect(scan.counts).toEqual({ blocking: 0, disclosed: 2, review: 0 });
    expect(scan.findings.map((f: any) => f.rule_id)).toContain("no-dependency-manifest");
    expect(scan.findings.every((f: any) => f.tier === "disclosed")).toBe(true);
  });

  it("never puts a secret or a Socket scan id on the manifest", async () => {
    repoFiles["deploy.sh"] = 'export AWS_ACCESS_KEY_ID="AKIA2E0A8F3B244C9986"';

    const result = await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" });
    if (!result.ok) throw new Error("expected a release");

    const manifest = JSON.stringify(result.release.manifest);
    expect(manifest).not.toContain("AKIA2E0A8F3B244C9986");
    expect(manifest).not.toContain("aws-access-key-id");
    expect(manifest).not.toContain("socket_scan_id");
    // The count is public, the finding is not: the row says the check failed and nothing
    // in `findings[]` says which file or line. The creator's own report carries both.
    // (`deploy.sh` does appear, as a capability — §4.4 publishes all of that block. What
    // must not appear is that the file is where the secret was.)
    const scan = (result.release.manifest as any).computed.scan;
    expect(scan.verdict).toBe("fail");
    expect(scan.checks.find((c: any) => c.id === "secrets")).toMatchObject({ status: "fail", findings: 1 });
    expect(scan.findings.some((f: any) => f.check === "secrets")).toBe(false);
    expect(scan.counts.blocking).toBe(1);
    // …and the whole report, secret and all, is still on the row behind the creator's key.
    expect((result.release.scan_report as any).findings[0].path).toBe("deploy.sh");
  });

  it("strips socket_scan_id and non-public findings from any report, not just this one", () => {
    const report = {
      version: 2 as const,
      verdict: "pass" as const,
      scanner_version: "2026.09.1",
      scanned_at: "2026-09-13T10:12:00.000Z",
      checks: [
        { id: "dep_behaviour" as const, tool: "socket.dev", tool_version: "2026-09-13", status: "findings" as const, at: "…", findings: 1, socket_scan_id: "fs_secret_id" },
      ],
      findings: [
        { kind: "secret" as const, check: "secrets" as const, tier: "blocking" as const, public: false, rule_id: "aws-access-key-id", severity: "CRITICAL" as const, description: "…", path: ".env", line: 3, blocking: true },
        { kind: "behaviour" as const, check: "dep_behaviour" as const, tier: "disclosed" as const, public: true, rule_id: "installScripts", severity: "LOW" as const, description: "esbuild 0.21.5 — install scripts run when installed", blocking: false },
      ],
      counts: { secrets: 1, vulnerabilities: 0, blocking: 1, disclosed: 1, review: 0 },
      checked: ["dep_behaviour"],
      packages_scanned: 63,
      advisories_refreshed_at: "2026-09-14T04:00:00.000Z",
    };

    const block = manifestScan("pass", report);
    expect(JSON.stringify(block)).not.toContain("fs_secret_id");
    expect(block.checks[0]).not.toHaveProperty("socket_scan_id");
    expect(block.findings.map((f) => f.rule_id)).toEqual(["installScripts"]);
    expect(block.counts).toEqual({ blocking: 1, disclosed: 1, review: 0 });
    // §7: the cron's refresh stamp rides along when there is one.
    expect(block.advisories_refreshed_at).toBe("2026-09-14T04:00:00.000Z");
  });

  /**
   * §4.4, amended 14 Sep 2026. The manifest is the thing an agent pays to fetch, so the
   * 418 identical `networkAccess` lines the first backfill published are the one part of
   * the report that does not go on it. The counts are untouched: `disclosed` is a fact
   * about the scan, not about the page.
   */
  it("folds the transitive dependency findings on the manifest, and only there", () => {
    const behaviour = (name: string, direct: boolean) => ({
      kind: "behaviour" as const,
      check: "dep_behaviour" as const,
      tier: "disclosed" as const,
      public: true,
      rule_id: "networkAccess",
      severity: "UNKNOWN" as const,
      description: `${name} — network access`,
      blocking: false,
      package: { ecosystem: "npm", name, version: "1.0.0", direct, dev: false },
    });
    const findings = [behaviour("axios", true), ...Array.from({ length: 300 }, (_, i) => behaviour(`t-${i}`, false))];
    const report = {
      version: 2 as const,
      scanner_version: "2026.09.1",
      scanned_at: "2026-09-14T10:12:00.000Z",
      checks: [{ id: "dep_behaviour" as const, tool: "socket.dev", tool_version: "2026-09-14", status: "findings" as const, at: "…", findings: 301, packages: 545 }],
      findings,
      counts: { secrets: 0, vulnerabilities: 0, blocking: 0, disclosed: 301, review: 0 },
      checked: ["dep_behaviour"],
      packages_scanned: 545,
    };

    const block = manifestScan("pass", report);
    expect(block.findings).toHaveLength(2);
    expect(block.findings[1]).toMatchObject({ description: "networkAccess in 300 transitive packages", aggregate: { packages: 300 } });
    expect(block.findings[1].aggregate?.examples).toHaveLength(3);
    // The tally is the scan's, not the page's: 301 were found and 301 is what is counted.
    expect(block.counts.disclosed).toBe(301);
    expect(report.findings).toHaveLength(301);
  });
});

/**
 * §4.1's review tier and §6.2's failure table, as the events an operator reads on
 * /admin/activity. None of these failed a release — that is the point — and each is
 * still something somebody has to look at.
 */
describe("scanAlerts", () => {
  const report = (over: Partial<Parameters<typeof scanAlerts>[1]>) =>
    ({
      version: 2,
      scanner_version: "2026.09.1",
      scanned_at: "2026-09-13T10:12:00.000Z",
      checks: [],
      findings: [],
      counts: { secrets: 0, vulnerabilities: 0, blocking: 0, disclosed: 0, review: 0 },
      checked: [],
      packages_scanned: 0,
      ...over,
    }) as Parameters<typeof scanAlerts>[1];

  it("raises one review alert naming the distinct rules, however many findings there were", () => {
    const flag = (rule_id: string) => ({
      kind: "behaviour" as const,
      check: "dep_behaviour" as const,
      tier: "review" as const,
      public: true,
      rule_id,
      severity: "MODERATE" as const,
      description: "…",
      blocking: false,
    });

    expect(scanAlerts("1.2.0", report({ findings: [flag("gptMalware"), flag("gptMalware"), flag("troll")] }))).toEqual([
      { name: "release_scan_review", props: { version: "1.2.0", count: 3, rule_ids: "gptMalware, troll" } },
    ]);
  });

  // 14 Sep 2026: fifty `gptAnomaly` flags off one backfill are one event with a count, and
  // the payload is rule ids — never the fifty package names, which is a Telegram line
  // nobody reads and a name we have no business broadcasting.
  it("raises one event for fifty flags, and names five rules at most", () => {
    const flag = (rule_id: string, name: string) => ({
      kind: "behaviour" as const,
      check: "dep_behaviour" as const,
      tier: "review" as const,
      public: true,
      rule_id,
      severity: "MODERATE" as const,
      description: `${name} — flagged`,
      blocking: false,
      package: { ecosystem: "npm", name, version: "1.0.0", direct: false, dev: false },
    });

    const fifty = Array.from({ length: 50 }, (_, i) => flag("gptAnomaly", `odd-${i}`));
    const alerts = scanAlerts("1.2.0", report({ findings: fifty }));
    expect(alerts).toEqual([{ name: "release_scan_review", props: { version: "1.2.0", count: 50, rule_ids: "gptAnomaly" } }]);
    expect(JSON.stringify(alerts)).not.toContain("odd-0");

    const many = ["a", "b", "c", "d", "e", "f", "g"].map((r, i) => flag(r, `p-${i}`));
    expect(scanAlerts("1.2.0", report({ findings: many }))[0].props.rule_ids).toBe("a, b, c, d, e +2 more");
  });

  it("tells a rotated token apart from an exhausted quota, and matches on the prefix", () => {
    const row = (reason: string) => ({ id: "dep_behaviour" as const, tool: "socket.dev", tool_version: "2026-09-13", status: "unavailable" as const, at: "…", findings: 0, reason });

    expect(scanAlerts("1.2.0", report({ checks: [row("socket auth")] }))[0].name).toBe("release_scan_socket_auth");
    // The quota reason carries Socket's `Retry-After` when it sent one.
    expect(scanAlerts("1.2.0", report({ checks: [row("socket quota (retry after 900)")] }))[0]).toMatchObject({
      name: "release_scan_socket_quota",
      props: { reason: "socket quota (retry after 900)" },
    });
    // A gap with no operator in it: the cron reads the stored id and nobody is paged.
    expect(scanAlerts("1.2.0", report({ checks: [row("socket processing")] }))).toEqual([]);
    expect(scanAlerts("1.2.0", report({}))).toEqual([]);
  });
});

describe("cutRelease — failure paths", () => {
  it("fails the scan on a hardcoded secret and deletes the snapshot after storing the report (FR-35)", async () => {
    repoFiles["deploy.sh"] = 'export AWS_ACCESS_KEY_ID="AKIA2E0A8F3B244C9986"';

    const result = await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = mock.rows("release")[0];
    expect(row.scan).toBe("fail");
    // The report is kept and bound to the hash; the bytes are not.
    expect(row.artifact_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.storage_path).toBeNull();
    expect(mock.storage.get("artifacts")?.size ?? 0).toBe(0);
    expect((row.scan_report as any).counts.blocking).toBe(1);
    expect(mock.rows("event").map((e) => e.name)).toEqual(["release_failed"]);
  });

  /**
   * SCAN-2, end to end: GitHub's SBOM endpoint takes no ref and answers for `main`, which is
   * clean; the tagged commit's lockfile pins a package with a `MAL-` record. The snapshot is
   * what is sold, so the snapshot is what OSV is asked about.
   */
  it("fails on malware pinned in the tagged commit's lockfile when the default branch's SBOM is clean (SCAN-2)", async () => {
    repoFiles["package-lock.json"] = JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/evil-pkg": { version: "6.6.6" } } });
    requestImpl = defaultRequest({
      "GET /repos/{owner}/{repo}/dependency-graph/sbom": {
        sbom: { packages: [{ name: "npm:evil-pkg", versionInfo: "1.0.0", externalRefs: [{ referenceType: "purl", referenceLocator: "pkg:npm/evil-pkg@1.0.0" }] }] },
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (!url.includes("querybatch")) return new Response(JSON.stringify({ summary: "Malicious code" }), { status: 200 });
        const { queries } = JSON.parse(String(init?.body)) as { queries: { package: { name: string }; version?: string }[] };
        const results = queries.map((q) => (q.package.name === "evil-pkg" && q.version === "6.6.6" ? { vulns: [{ id: "MAL-2026-4242" }] } : {}));
        return new Response(JSON.stringify({ results }), { status: 200 });
      }),
    );

    const result = await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" });
    expect(result.ok).toBe(true);

    const row = mock.rows("release")[0];
    expect(row.scan).toBe("fail");
    expect(row.storage_path).toBeNull();
    const malware = (row.scan_report as any).findings.find((f: any) => f.check === "known_malware");
    expect(malware).toMatchObject({ rule_id: "MAL-2026-4242", blocking: true, package: { name: "evil-pkg", version: "6.6.6" } });
  });

  it("leaves the release pending with scan_report.error when analysis throws (§12)", async () => {
    requestImpl = defaultRequest({ "GET /repos/{owner}/{repo}/git/trees/{tree_sha}": new Error("GitHub is down") });

    await expect(cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" })).rejects.toThrow(/GitHub is down/);

    const row = mock.rows("release")[0];
    expect(row.scan).toBe("pending");
    expect((row.scan_report as any).error).toMatch(/GitHub is down/);
    expect(row.storage_path).toBeUndefined();
    expect(mock.rows("event").map((e) => e.name)).toEqual(["release_failed"]);
  });

  it("returns repo_too_large rather than throwing when a cap is hit (§9)", async () => {
    const tree = Array.from({ length: 20_001 }, (_, i) => ({ type: "blob", path: `f${i}.txt`, size: 1, sha: String(i).padStart(40, "0") }));
    requestImpl = defaultRequest({ "GET /repos/{owner}/{repo}/git/trees/{tree_sha}": { tree } });

    const result = await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" });
    expect(result).toMatchObject({ ok: false, code: "repo_too_large" });
    expect(mock.rows("release")[0].scan).toBe("pending");
  });

  it("blocks the licence when the repo has none, and still records the release", async () => {
    delete repoFiles.LICENSE;
    requestImpl = defaultRequest({
      "GET /repos/{owner}/{repo}/license": new Error("404"),
      "GET /repos/{owner}/{repo}/git/trees/{tree_sha}": {
        tree: [{ type: "blob", path: "README.md", size: 900, sha: "1".repeat(40) }],
      },
    });

    const result = await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" });
    expect(result.ok).toBe(true);
    expect(mock.rows("listing")[0]).toMatchObject({ licence_verdict: "block", licence_spdx: null });
  });
});

describe("cutRelease — OSV incomplete (W3.2, DC)", () => {
  it("leaves the release pending with osv_error when OSV is unreachable, then a healthy sync passes it", async () => {
    // A dependency manifest so OSV is actually queried.
    repoFiles["package.json"] = '{"dependencies":{"left-pad":"1.3.0"}}';
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));

    const first = await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" });
    expect(first.ok).toBe(true);

    const row = mock.rows("release")[0];
    expect(row.scan).toBe("pending"); // not on sale — no passing badge over a check that did not run
    expect((row.scan_report as any).osv_error).toMatch(/503/);
    expect(mock.rows("event").map((e) => e.name)).toContain("release_scan_incomplete");

    // Retry (the creator's next push or a manual sync) with OSV healthy → passes.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: [{}] }), { status: 200 })));
    const retry = await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" });
    expect(retry.ok).toBe(true);
    expect(mock.rows("release")).toHaveLength(1);
    expect(mock.rows("release")[0].scan).toBe("pass");
    expect(mock.rows("release")[0].scan_report).not.toHaveProperty("osv_error");
  });
});

describe("cutRelease — idempotent artifact retry (W3.3)", () => {
  it("recovers when the release update fails after the upload, without an already-exists throw", async () => {
    // Inject a one-time failure into the finalizing release update (the one carrying
    // artifact_sha256), which runs *after* the artifact has been uploaded. This orphans the
    // object exactly as a mid-cut crash would.
    const realFrom = mock.client.from.bind(mock.client);
    let failOnce = true;
    mock.client.from = (table: string) => {
      const q = realFrom(table);
      if (table === "release") {
        const realUpdate = q.update.bind(q);
        q.update = (values: any) => {
          const uq = realUpdate(values);
          if (failOnce && values && Object.hasOwn(values, "artifact_sha256")) {
            failOnce = false;
            uq.then = (onF: any, onR: any) => Promise.reject(new Error("injected: release update failed after upload")).then(onF, onR);
          }
          return uq;
        };
      }
      return q;
    };

    await expect(cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" })).rejects.toThrow(/failed after upload/);
    // The artifact was uploaded before the failure — the object is now an orphan.
    expect((mock.storage.get("artifacts")?.size ?? 0)).toBe(1);
    expect(mock.rows("release")[0].scan).toBe("pending");

    // The re-pack is byte-identical, so putArtifact(upsert:true) overwrites the orphan
    // instead of throwing "already exists". The release reaches a terminal verdict.
    const retry = await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" });
    expect(retry.ok).toBe(true);
    expect(mock.rows("release")).toHaveLength(1);
    expect(mock.rows("release")[0].scan).toBe("pass");
    expect(mock.rows("release")[0].storage_path).toMatch(/\.zip$/);
  });
});

describe("cutRelease — per-release licence verdict (W3.5)", () => {
  it("stamps release.licence_verdict = 'pass' for a resale-compatible LICENSE", async () => {
    const result = await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" });
    expect(result.ok).toBe(true);
    expect(mock.rows("release")[0].licence_verdict).toBe("pass");
  });

  it("stamps release.licence_verdict = 'block' when the snapshot has no LICENSE (FR-36)", async () => {
    delete repoFiles.LICENSE;
    requestImpl = defaultRequest({
      "GET /repos/{owner}/{repo}/license": new Error("404"),
      "GET /repos/{owner}/{repo}/git/trees/{tree_sha}": {
        tree: [{ type: "blob", path: "README.md", size: 900, sha: "1".repeat(40) }],
      },
    });

    const result = await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" });
    expect(result.ok).toBe(true);
    expect(mock.rows("release")[0].licence_verdict).toBe("block");
  });
});

describe("changelogFor", () => {
  const analysis = { releases: [{ tag: "v1.2.0", published_at: null, name: null, body: "From the release page." }] } as any;

  it("prefers notes, then the release body, then the commit message", () => {
    expect(changelogFor("notes", analysis, "v1.2.0", "commit")).toBe("notes");
    expect(changelogFor(undefined, analysis, "v1.2.0", "commit")).toBe("From the release page.");
    expect(changelogFor(undefined, { releases: [] } as any, "v1.2.0", "commit message")).toBe("commit message");
    expect(changelogFor("   ", { releases: [] } as any, undefined, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Open releases (25 Oct 2026, HackMeridian): the promise is stamped at cut
// ---------------------------------------------------------------------------

describe("cutRelease — stamping the open-release promise (lib/release/open.ts)", () => {
  const PUBLIC = "https://github.com/octo/widget-public";
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

  function openListing(overrides: Record<string, unknown> = {}) {
    Object.assign(mock.rows("listing")[0], { open_release: true, public_repo_url: PUBLIC, next_opens_at: inDays(30), ...overrides });
  }

  it("stamps a pending promise with the date, the sold licence and four passing checks", async () => {
    openListing();
    const github = stubPublicGithub({ repos: { "octo/widget-public": { private: false } }, commits: { "octo/widget-public": [] } });
    setPublicGithub(github);

    const result = await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" });
    if (!result.ok) throw new Error(result.message);

    const release = result.release;
    expect(release.scan).toBe("pass");
    expect(release.promise_status).toBe("pending");
    expect(release.opens_at).toBe(mock.rows("listing")[0].next_opens_at);
    expect(release.open_licence_spdx).toBe("MIT");
    expect((release.open_eligibility as { id: string; ok: boolean }[]).map((c) => `${c.id}:${c.ok}`)).toEqual([
      "licence:true",
      "public_repo:true",
      "not_yet_public:true",
      "payout_address:true",
    ]);
    // The checks were made against the *public* repository and the *sold* commit.
    expect(github.calls).toEqual(["repos/octo/widget-public", `repos/octo/widget-public/commits/${COMMIT}`]);
    // The listing keeps a copy, so the dashboard can show the checks without a release in hand.
    expect(mock.rows("listing")[0].open_eligibility).toEqual(release.open_eligibility);
  });

  it("marks the release ineligible — and still sells it — when the commit is already public (H6)", async () => {
    openListing();
    setPublicGithub(stubPublicGithub({ repos: { "octo/widget-public": { private: false } }, commits: { "octo/widget-public": [COMMIT] } }));

    const result = await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" });
    if (!result.ok) throw new Error(result.message);

    expect(result.release.scan).toBe("pass");
    expect(result.release.storage_path).toBeTruthy();
    expect(result.release.promise_status).toBe("ineligible");
    const failing = (result.release.open_eligibility as { id: string; ok: boolean; detail: string }[]).filter((c) => !c.ok);
    expect(failing.map((c) => c.id)).toEqual(["not_yet_public"]);
    expect(failing[0].detail).toMatch(/already public/);
  });

  it("marks the release ineligible when the sold snapshot has no licence", async () => {
    openListing();
    repoFiles = { "README.md": "# widget\n", "src/index.ts": "export const widget = () => 42;\n" };
    requestImpl = defaultRequest({
      "GET /repos/{owner}/{repo}/license": new Error("404 no licence"),
      "GET /repos/{owner}/{repo}/git/trees/{tree_sha}": {
        tree: [
          { type: "blob", path: "README.md", size: 900, sha: "1".repeat(40) },
          { type: "blob", path: "src/index.ts", size: 2400, sha: "3".repeat(40) },
        ],
      },
    });
    setPublicGithub(stubPublicGithub({ repos: { "octo/widget-public": { private: false } } }));

    const result = await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" });
    if (!result.ok) throw new Error(result.message);

    expect(result.release.promise_status).toBe("ineligible");
    const failing = (result.release.open_eligibility as { id: string; ok: boolean }[]).filter((c) => !c.ok).map((c) => c.id);
    expect(failing).toContain("licence");
  });

  it("clamps a date the listing carries beyond the cap to 90 days after the cut", async () => {
    openListing({ next_opens_at: inDays(120) });
    setPublicGithub(stubPublicGithub({ repos: { "octo/widget-public": { private: false } } }));

    const result = await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" });
    if (!result.ok) throw new Error(result.message);

    const cap = new Date(result.release.created_at).getTime() + 90 * 86_400_000;
    expect(new Date(result.release.opens_at!).getTime()).toBe(cap);
    expect(result.release.promise_status).toBe("pending");
  });

  it("leaves every promise column empty on an ordinary listing and asks GitHub nothing", async () => {
    const github = stubPublicGithub();
    setPublicGithub(github);

    const result = await cutRelease({ listingId: "l1", ref: "refs/tags/v1.2.0" });
    if (!result.ok) throw new Error(result.message);

    expect(result.release.promise_status ?? null).toBeNull();
    expect(result.release.opens_at ?? null).toBeNull();
    expect(github.calls).toEqual([]);
  });
});
