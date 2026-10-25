import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { makeMockDb } from "@/lib/test/mock-db";
import { GET } from "./route";

let mock: ReturnType<typeof makeMockDb>;

function release(overrides: Record<string, unknown>) {
  return {
    listing_id: "l1",
    git_ref: "v1.0.0",
    commit_sha: "a".repeat(40),
    artifact_sha256: "b".repeat(64),
    scan: "pass",
    scanner_version: "2026.08.1",
    analyzer_version: "0.1.0",
    changelog: "Adds the retry loop.",
    diff_summary: { files_added: 1, files_changed: 2, files_removed: 0, additions: 40, deletions: 3, components_touched: ["scripts"] },
    price_micro_at_publish: "9000000",
    update_price_micro_at_publish: "5000000",
    storage_path: "l1/1.0.0/secret.zip",
    scan_report: { findings: [], counts: { blocking: 0 } },
    ...overrides,
  };
}

function get(owner: string, slug: string, query = ""): [NextRequest, { params: Promise<{ owner: string; slug: string }> }] {
  const req = new NextRequest(`https://x402git.com/api/v/${owner}/${slug}/releases${query}`, {
    headers: { "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 250) + 1}` },
  });
  return [req, { params: Promise.resolve({ owner, slug }) }];
}

beforeEach(() => {
  mock = makeMockDb({
    creator: [{ id: "c1", handle: "adrian", onboarded_via: "api", payout_address: "0x1", terms_version: "v1" }],
    listing: [{ id: "l1", creator_id: "c1", slug: "widget", source: "github" }],
    release: [
      release({ id: "r1", version: "1.0.0", created_at: "2026-08-01T00:00:00Z" }),
      release({ id: "r2", version: "1.1.0", git_ref: "v1.1.0", created_at: "2026-08-10T00:00:00Z" }),
      release({ id: "r3", version: "1.2.0", git_ref: "v1.2.0", created_at: "2026-08-20T00:00:00Z", scan: "fail" }),
    ],
  });
  setDb(mock.client as unknown as Db);
});

afterEach(() => resetDb());

describe("GET /api/v/:owner/:slug/releases (FR-15)", () => {
  it("returns every release, newest first, with no credential", async () => {
    const res = await GET(...get("adrian", "widget"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.owner).toBe("adrian");
    expect(body.slug).toBe("widget");
    expect(body.releases.map((r: { version: string }) => r.version)).toEqual(["1.2.0", "1.1.0", "1.0.0"]);
    expect(body.next_cursor).toBeNull();
  });

  it("carries the full FR-15 entry: changelog, diff, verdict and the prices in force", async () => {
    const res = await GET(...get("adrian", "widget"));
    const entry = (await res.json()).releases[1];

    expect(entry).toEqual({
      version: "1.1.0",
      tag: "v1.1.0",
      commit_sha: "a".repeat(40),
      artifact_sha256: "b".repeat(64),
      published_at: "2026-08-10T00:00:00.000Z",
      changelog: "Adds the retry loop.",
      diff_summary: { files_added: 1, files_changed: 2, files_removed: 0, additions: 40, deletions: 3, components_touched: ["scripts"] },
      scan: "pass",
      scanner_version: "2026.08.1",
      analyzer_version: "0.1.0",
      price_micro: "9000000",
      update_price_micro: "5000000",
    });
  });

  it("publishes failing releases too — the creator cannot delete an entry", async () => {
    const body = await (await GET(...get("adrian", "widget"))).json();
    expect(body.releases[0]).toMatchObject({ version: "1.2.0", scan: "fail" });
  });

  it("never leaks the storage path or the scan report's detail", async () => {
    const text = await (await GET(...get("adrian", "widget"))).text();
    expect(text).not.toContain("storage_path");
    expect(text).not.toContain("secret.zip");
    expect(text).not.toContain("scan_report");
  });

  it("keeps serving a retired listing's log (FR-43)", async () => {
    mock.rows("listing")[0].retired_at = "2026-08-25T00:00:00Z";
    const res = await GET(...get("adrian", "widget"));
    expect(res.status).toBe(200);
    expect((await res.json()).releases).toHaveLength(3);
  });

  it("404s an unknown owner or slug", async () => {
    expect((await GET(...get("nobody", "widget"))).status).toBe(404);
    expect((await GET(...get("adrian", "nothing"))).status).toBe(404);
    expect((await (await GET(...get("adrian", "nothing"))).json()).code).toBe("not_found");
  });

  it("returns an empty log for a listing with no releases", async () => {
    mock.tables.release = [];
    const body = await (await GET(...get("adrian", "widget"))).json();
    expect(body.releases).toEqual([]);
  });

  it("pages by cursor", async () => {
    for (let i = 0; i < 60; i++) {
      const createdAt = new Date(Date.UTC(2026, 8, 1) + i * 86_400_000).toISOString();
      mock.rows("release").push(release({ id: `x${i}`, version: `2.0.${i}`, created_at: createdAt }));
    }

    const first = await (await GET(...get("adrian", "widget"))).json();
    expect(first.releases).toHaveLength(50);
    expect(first.next_cursor).toBeTruthy();

    const second = await (await GET(...get("adrian", "widget", `?cursor=${encodeURIComponent(first.next_cursor)}`))).json();
    expect(second.releases.length).toBe(13);
    expect(second.next_cursor).toBeNull();

    const versions = new Set([...first.releases, ...second.releases].map((r: { version: string }) => r.version));
    expect(versions.size).toBe(63);
  });

  it("ignores a malformed cursor rather than failing the request", async () => {
    const res = await GET(...get("adrian", "widget", "?cursor=not-a-cursor"));
    expect(res.status).toBe(200);
    expect((await res.json()).releases).toHaveLength(3);
  });

  it("is publicly cacheable (§9)", async () => {
    const res = await GET(...get("adrian", "widget"));
    expect(res.headers.get("cache-control")).toContain("public");
  });
});
