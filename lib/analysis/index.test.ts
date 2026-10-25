import { describe, expect, it } from "vitest";
import { MAX_FILES, type OctokitLike, RepoTooLargeError, analyze, assertWithinCaps, composeComputed, classifySnapshot } from "./index";

const COMMIT = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

type Routes = Record<string, unknown>;

/** An Octokit that never touches the network and records what was asked for. */
function fakeOctokit(overrides: Routes = {}): OctokitLike & { calls: string[] } {
  const calls: string[] = [];
  const defaults: Routes = {
    "GET /repos/{owner}/{repo}": {
      default_branch: "main",
      size: 420,
      pushed_at: "2026-08-20T10:00:00Z",
      open_issues_count: 4,
      archived: false,
      private: true,
      description: "Does a thing.",
    },
    "GET /repos/{owner}/{repo}/commits/{ref}": { sha: COMMIT, commit: { message: "Release v1.2.0" } },
    "GET /repos/{owner}/{repo}/git/trees/{tree_sha}": {
      truncated: false,
      tree: [
        { type: "tree", path: "src", sha: "t1" },
        { type: "blob", path: "README.md", size: 900, sha: "b1" },
        { type: "blob", path: "LICENSE", size: 1100, sha: "b2" },
        { type: "blob", path: "src/index.ts", size: 2400, sha: "b3" },
        { type: "blob", path: "assets/logo.png", size: 51_200, sha: "b4" },
      ],
    },
    "GET /repos/{owner}/{repo}/languages": { TypeScript: 2400, Markdown: 900 },
    "GET /repos/{owner}/{repo}/readme": { path: "README.md", content: Buffer.from("# widget\n\nHello.").toString("base64") },
    "GET /repos/{owner}/{repo}/license": { license: { key: "mit", spdx_id: "MIT", name: "MIT License" } },
    "GET /repos/{owner}/{repo}/releases": [
      { tag_name: "v1.1.0", published_at: "2026-08-15T10:00:00Z", name: "1.1.0", body: "Second", draft: false },
      { tag_name: "v1.0.0", published_at: "2026-08-01T10:00:00Z", name: "1.0.0", body: "First", draft: false },
      { tag_name: "v0.9.0", published_at: "2026-07-18T10:00:00Z", name: "0.9.0", body: "Beta", draft: true },
    ],
    "GET /repos/{owner}/{repo}/dependency-graph/sbom": {
      sbom: {
        packages: [
          { name: "npm:left-pad", versionInfo: "1.3.0", externalRefs: [{ referenceType: "purl", referenceLocator: "pkg:npm/left-pad@1.3.0" }] },
          { name: "pip:requests", versionInfo: "2.31.0", externalRefs: [{ referenceType: "purl", referenceLocator: "pkg:pypi/requests@2.31.0" }] },
          { name: "com.github.o/r", versionInfo: "NOASSERTION", externalRefs: [] },
        ],
      },
    },
    "GET /repos/{owner}/{repo}/compare/{basehead}": {
      files: [
        { filename: "src/index.ts", status: "modified", additions: 40, deletions: 12 },
        { filename: "tests/new.test.ts", status: "added", additions: 30, deletions: 0 },
        { filename: "docs/old.md", status: "removed", additions: 0, deletions: 15 },
      ],
    },
    ...overrides,
  };

  return {
    calls,
    async request(route: string) {
      calls.push(route);
      const data = defaults[route];
      if (data === undefined) throw new Error(`404 ${route}`);
      if (data instanceof Error) throw data;
      return { data };
    },
  };
}

describe("analyze (PRD §6)", () => {
  it("builds the whole manifest from about eight REST calls, with no clone", async () => {
    const octokit = fakeOctokit();
    const analysis = await analyze(octokit, { owner: "octo", repo: "widget", ref: "v1.2.0", previousCommitSha: "prev" });

    // Eight documented calls plus the two that only fire on a release path.
    expect(octokit.calls.length).toBeLessThanOrEqual(10);
    expect(analysis.commit_sha).toBe(COMMIT);
    expect(analysis.file_count).toBe(4);
    expect(analysis.dir_depth).toBe(1);
    expect(analysis.languages).toEqual({ TypeScript: 2400, Markdown: 900 });
  });

  it("splits text from binary rather than reporting one size (§3.4)", async () => {
    const analysis = await analyze(fakeOctokit(), { owner: "octo", repo: "widget" });
    expect(analysis.bytes_text).toBe(900 + 1100 + 2400);
    expect(analysis.bytes_binary).toBe(51_200);
    expect(analysis.extensions).toMatchObject({ md: 1, ts: 1, png: 1, "(none)": 1 });
  });

  it("renders the README server-side and finds the licence", async () => {
    const analysis = await analyze(fakeOctokit(), { owner: "octo", repo: "widget" });
    expect(analysis.readme_html).toContain("<h2>widget</h2>");
    expect(analysis.licence_spdx).toBe("MIT");
    expect(analysis.has_licence_file).toBe(true);
  });

  it("skips the second commit lookup when the pipeline already resolved it", async () => {
    const octokit = fakeOctokit();
    await analyze(octokit, { owner: "octo", repo: "widget", resolvedCommitSha: COMMIT });
    expect(octokit.calls).not.toContain("GET /repos/{owner}/{repo}/commits/{ref}");
  });

  it("computes the diff summary from the compare API (FR-15)", async () => {
    const analysis = await analyze(fakeOctokit(), { owner: "octo", repo: "widget", previousCommitSha: "prev" });
    expect(analysis.diff_summary).toEqual({
      files_added: 1,
      files_changed: 1,
      files_removed: 1,
      additions: 70,
      deletions: 27,
      // `src/index.ts` is a source file, not an "other file" (FR-48).
      components_touched: ["source", "tests", "docs"],
    });
  });

  it("does not call compare when there is no previous release", async () => {
    const octokit = fakeOctokit();
    const analysis = await analyze(octokit, { owner: "octo", repo: "widget" });
    expect(analysis.diff_summary).toBeNull();
    expect(octokit.calls).not.toContain("GET /repos/{owner}/{repo}/compare/{basehead}");
  });

  it("maps SBOM packages onto OSV ecosystems and drops the unidentifiable", async () => {
    const analysis = await analyze(fakeOctokit(), { owner: "octo", repo: "widget" });
    expect(analysis.sbom.packages).toEqual([
      { name: "left-pad", version: "1.3.0", ecosystem: "npm", purl: "pkg:npm/left-pad@1.3.0" },
      { name: "requests", version: "2.31.0", ecosystem: "PyPI", purl: "pkg:pypi/requests@2.31.0" },
      { name: "com.github.o/r", version: undefined, ecosystem: "unknown", purl: undefined },
    ]);
  });

  it("ignores draft releases and computes a cadence sentence from the rest", async () => {
    const analysis = await analyze(fakeOctokit(), {
      owner: "octo",
      repo: "widget",
      priorReleaseDates: ["2026-07-18T10:00:00Z", "2026-07-04T10:00:00Z"],
    });
    expect(analysis.releases.map((r) => r.tag)).toEqual(["v1.1.0", "v1.0.0"]);
    expect(analysis.cadence.releases).toBe(4);
    expect(analysis.cadence.sentence).toMatch(/^Ships every ~14 days/);
  });

  it("survives every optional endpoint failing, and says which ones", async () => {
    const octokit = fakeOctokit({
      "GET /repos/{owner}/{repo}/readme": undefined,
      "GET /repos/{owner}/{repo}/license": undefined,
      "GET /repos/{owner}/{repo}/languages": undefined,
      "GET /repos/{owner}/{repo}/releases": undefined,
      "GET /repos/{owner}/{repo}/dependency-graph/sbom": undefined,
    });
    const analysis = await analyze(octokit, { owner: "octo", repo: "widget" });

    expect(analysis.readme_html).toBeNull();
    expect(analysis.licence_spdx).toBeNull();
    expect(analysis.sbom.packages).toEqual([]);
    expect(analysis.warnings).toEqual(
      expect.arrayContaining(["languages_unavailable", "readme_unavailable", "license_unavailable", "releases_unavailable", "sbom_unavailable"]),
    );
  });

  it("records tree truncation instead of silently under-reporting", async () => {
    const octokit = fakeOctokit({
      "GET /repos/{owner}/{repo}/git/trees/{tree_sha}": { truncated: true, tree: [{ type: "blob", path: "a.md", size: 1, sha: "x" }] },
    });
    const analysis = await analyze(octokit, { owner: "octo", repo: "widget" });
    expect(analysis.tree_truncated).toBe(true);
    expect(analysis.warnings).toContain("tree_truncated");
  });

  it("excludes .git from the tree", async () => {
    const octokit = fakeOctokit({
      "GET /repos/{owner}/{repo}/git/trees/{tree_sha}": {
        tree: [
          { type: "blob", path: ".git/config", size: 10, sha: "g1" },
          { type: "blob", path: "a.md", size: 10, sha: "g2" },
        ],
      },
    });
    const analysis = await analyze(octokit, { owner: "octo", repo: "widget" });
    expect(analysis.tree.map((b) => b.path)).toEqual(["a.md"]);
  });
});

describe("caps (§6, §9 repo_too_large)", () => {
  it("refuses a tree over the file cap before anything is downloaded", () => {
    const tree = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ path: `f${i}`, size: 1, sha: "x" }));
    expect(() => assertWithinCaps(tree)).toThrow(RepoTooLargeError);
  });

  it("refuses a tree over the byte cap", () => {
    expect(() => assertWithinCaps([{ path: "big", size: 300 * 1024 * 1024, sha: "x" }])).toThrow(/200/);
  });

  it("allows a tree at the cap", () => {
    expect(() => assertWithinCaps([{ path: "a", size: 200 * 1024 * 1024, sha: "x" }])).not.toThrow();
  });
});

describe("composeComputed (FR-52)", () => {
  it("stamps every computed block with when and by what", async () => {
    const analysis = await analyze(fakeOctokit(), { owner: "octo", repo: "widget", previousCommitSha: "prev" });
    const classification = classifySnapshot(["README.md", "SKILL.md", "scripts/a.py"], new Map([["SKILL.md", "Do the thing."]]));

    const computed = composeComputed({
      analysis,
      classification,
      licence: { spdx: "MIT", verdict: "pass" },
      scan: { verdict: "pass", scanner_version: "2026.08.1", at: "2026-08-29T12:00:00Z" },
      analyzerVersion: "0.1.0",
      computedAt: "2026-08-29T12:00:00Z",
    });

    expect(computed.computed_at).toBe("2026-08-29T12:00:00Z");
    expect(computed.analyzer_version).toBe("0.1.0");
    expect(computed.artifact_class).toBe("Pack");
    expect(computed.inventory_sentence).toBe("1 skill · 1 script · 1 doc");
    expect(computed.licence).toEqual({ spdx: "MIT", verdict: "pass" });
    expect(computed.tree.find((t) => t.path === "assets/logo.png")?.binary).toBe(true);
    expect(computed.dependencies).toHaveLength(3);
  });
});
