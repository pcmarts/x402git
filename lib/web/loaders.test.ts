import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ListingRow } from "@/lib/db/types";

const github = vi.hoisted(() => ({ repoById: vi.fn() }));
vi.mock("@/lib/github/installations", () => github);

const { manifestFor, repoUrlFor } = await import("./loaders");

function listing(overrides: Partial<ListingRow> = {}): ListingRow {
  return { id: "l1", installation_id: "42", github_repo_id: "777", ...overrides } as ListingRow;
}

describe("repoUrlFor", () => {
  beforeEach(() => {
    github.repoById.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("resolves the repository by id, because §12 stores the id and not the name (FR-8)", async () => {
    github.repoById.mockResolvedValue({ repoId: 777, owner: "pcmarts", name: "portfolio-builder", private: true, defaultBranch: "main" });

    expect(await repoUrlFor(listing())).toBe("https://github.com/pcmarts/portfolio-builder");
    expect(github.repoById).toHaveBeenCalledWith("42", "777");
  });

  it("is null when GitHub refuses, so the page renders no link rather than a dead one", async () => {
    github.repoById.mockRejectedValue(new Error("404 Not Found"));

    expect(await repoUrlFor(listing())).toBeNull();
  });

  it("asks nothing of GitHub for a listing with no repository bound", async () => {
    expect(await repoUrlFor(listing({ installation_id: null, github_repo_id: null }))).toBeNull();
    expect(github.repoById).not.toHaveBeenCalled();
  });
});

/**
 * §4.4 on the reading side ("PRD Trust Report.md", 13 Sep 2026).
 *
 * `PublicScanFinding` now rejects a `secret` or `injection` finding rather than keeping its
 * `kind`, `path` and `line` — but `manifestFor` drops a manifest that will not parse
 * **whole**, so validating alone would have meant one mislabelled finding taking the file
 * tree, the README and the capability block off the page with it. The finding is filtered,
 * the rest of the manifest renders, and a §4.4 mistake costs one disclosure rather than a
 * listing.
 */
describe("manifestFor and the two kinds that are never public", () => {
  const bundle = {
    creator: { handle: "adrian" },
    listing: { slug: "humanizer", price_micro: "9000000", update_price_micro: "5000000", description: "Rewrites machine prose.", trigger_hint: null },
  } as unknown as Parameters<typeof manifestFor>[0];

  const release = (findings: unknown[]) =>
    ({
      version: "1.2.0",
      artifact_sha256: "b".repeat(64),
      created_at: "2026-08-21T00:00:00.000Z",
      manifest: {
        computed: {
          artifact_class: "Harness",
          component_inventory: [{ kind: "skill", count: 1 }],
          file_count: 18,
          dir_depth: 3,
          bytes_text: 225_280,
          bytes_binary: 67_584,
          languages: { Python: 68_000 },
          tree: [{ path: "README.md", size: 4_096, binary: false }],
          readme_html: "<h2>Install</h2>",
          dependencies: [{ name: "requests", ecosystem: "pypi", version: "2.31.0" }],
          licence: { spdx: "MIT", verdict: "pass" },
          scan: { verdict: "pass", scanner_version: "2026.09.1", at: "2026-08-21T10:00:00.000Z", counts: { blocking: 0, disclosed: 1, review: 0 }, findings },
          computed_at: "2026-08-28T16:20:00.000Z",
          analyzer_version: "0.1.0",
        },
      },
    }) as unknown as Parameters<typeof manifestFor>[1];

  const disclosed = {
    kind: "vulnerability",
    check: "known_vulns",
    tier: "disclosed",
    rule_id: "GHSA-1234-5678-90ab",
    severity: "MODERATE",
    description: "prototype pollution",
    package: { ecosystem: "npm", name: "lodash", version: "4.17.20" },
  };
  const secret = { kind: "secret", check: "secrets", tier: "blocking", rule_id: "anthropic-api-key", severity: "CRITICAL", description: "Anthropic API key", path: "src/leaked.py", line: 42 };
  const injection = { kind: "injection", check: "injection", tier: "blocking", rule_id: "hidden-unicode-tags", severity: "CRITICAL", description: "tag characters", path: "SKILL.md", line: 7 };

  it("parses a manifest carrying a secret finding, with that finding removed", () => {
    const manifest = manifestFor(bundle, release([disclosed, secret, injection]));

    expect(manifest).not.toBeNull();
    expect(manifest?.computed.scan.findings?.map((f) => f.rule_id)).toEqual(["GHSA-1234-5678-90ab"]);
    // Not merely absent from the findings list: absent from the bytes.
    expect(JSON.stringify(manifest)).not.toContain("src/leaked.py");
    // And the rest of the manifest is still there, which is the whole point.
    expect(manifest?.computed.tree).toHaveLength(1);
    expect(manifest?.computed.readme_html).toBe("<h2>Install</h2>");
  });

  it("leaves a manifest with nothing to filter exactly as it was", () => {
    expect(manifestFor(bundle, release([disclosed]))?.computed.scan.findings).toHaveLength(1);
  });
});
