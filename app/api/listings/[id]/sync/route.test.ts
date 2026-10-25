import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { makeMockDb } from "@/lib/test/mock-db";
import { ctx, OTHER_API_KEY, req, seedCreator, seedListing } from "@/lib/test/listings-fixtures";

vi.mock("@/lib/github/hosted", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github/hosted")>()),
  provisionHostedRepo: vi.fn(),
  archiveHostedRepo: vi.fn(),
  deleteHostedRepo: vi.fn(),
}));
vi.mock("@/lib/github/installations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github/installations")>()),
  installationAccount: vi.fn(),
  userOwnsInstallation: vi.fn(),
  userCanSellRepo: vi.fn(),
  resolveRepo: vi.fn(),
  repoById: vi.fn(),
}));

const release = vi.hoisted(() => ({ cutRelease: vi.fn() }));
vi.mock("@/lib/release", () => release);

const { POST } = await import("./route");

let mock: ReturnType<typeof makeMockDb>;
let creator: Record<string, any>;
let listing: Record<string, any>;

const cutReleaseRow = {
  id: "11111111-1111-4111-8111-111111111111",
  listing_id: "",
  version: "1.0.0",
  git_ref: "refs/tags/v1.0.0",
  commit_sha: "a".repeat(40),
  artifact_sha256: null,
  storage_path: null,
  size_bytes: null,
  scan: "pending",
  scan_report: null,
  scanner_version: null,
  manifest: null,
  changelog: null,
  diff_summary: null,
  price_micro_at_publish: "9000000",
  update_price_micro_at_publish: "5000000",
  analyzer_version: "0.1.0",
  created_at: "2026-08-29T12:00:00.000Z",
};

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  creator = seedCreator(mock);
  listing = seedListing(mock, creator);
  release.cutRelease.mockResolvedValue({ ok: true, release: { ...cutReleaseRow, listing_id: listing.id } });
});

afterEach(() => {
  resetDb();
  vi.clearAllMocks();
  resetEnv();
});

describe("POST /api/listings/:id/sync (FR-8.2)", () => {
  it("accepts with 202 and hands the pipeline the ref, version and notes", async () => {
    const res = await POST(req("/x", { method: "POST", body: { ref: "main", version: "1.0.0", notes: "first cut" } }), ctx(listing.id));
    expect(res.status).toBe(202);

    expect(release.cutRelease).toHaveBeenCalledWith({ listingId: listing.id, ref: "main", version: "1.0.0", notes: "first cut" });

    const body = await res.json();
    expect(body.version).toBe("1.0.0");
    expect(body.scan).toBe("pending");
    expect(body.git_ref).toBe("refs/tags/v1.0.0");
    expect(body.commit_sha).toBe("a".repeat(40));
  });

  it("takes an empty body: cut whatever the default branch is at", async () => {
    const res = await POST(req("/x", { method: "POST" }), ctx(listing.id));
    expect(res.status).toBe(202);
    expect(release.cutRelease).toHaveBeenCalledWith({ listingId: listing.id, ref: undefined, version: undefined, notes: undefined });
  });

  it("rejects a version that is not MAJOR.MINOR.PATCH (FR-9)", async () => {
    const res = await POST(req("/x", { method: "POST", body: { version: "v1.0" } }), ctx(listing.id));
    expect(res.status).toBe(400);
    expect(release.cutRelease).not.toHaveBeenCalled();
  });

  it("maps version_exists onto the catalogue (FR-9: re-tagging is not a new release)", async () => {
    release.cutRelease.mockResolvedValue({ ok: false, code: "version_exists", message: "1.0.0 already exists for this listing." });

    const res = await POST(req("/x", { method: "POST", body: { version: "1.0.0" } }), ctx(listing.id));
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.code).toBe("version_exists");
    expect(body.docs_url).toMatch(/#version_exists$/);
  });

  it("maps repo_too_large onto 413 (D2c: 200 MB, 20,000 files)", async () => {
    release.cutRelease.mockResolvedValue({ ok: false, code: "repo_too_large", message: "The repository exceeds 200 MB." });

    const res = await POST(req("/x", { method: "POST" }), ctx(listing.id));
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe("repo_too_large");
  });

  it("maps invalid_version onto a 400 naming the field", async () => {
    release.cutRelease.mockResolvedValue({ ok: false, code: "invalid_version", message: "`version` is required when the ref is untagged." });

    const res = await POST(req("/x", { method: "POST", body: { ref: "main" } }), ctx(listing.id));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("invalid_request");
    expect(body.details.field).toBe("version");
  });

  it("maps the pipeline's not_found onto a 404", async () => {
    release.cutRelease.mockResolvedValue({ ok: false, code: "not_found", message: "No such ref." });

    const res = await POST(req("/x", { method: "POST", body: { ref: "no-such-branch" } }), ctx(listing.id));
    expect(res.status).toBe(404);
  });

  it("maps repo_role_required onto the same 404 listing creation gives (AUTH-2)", async () => {
    release.cutRelease.mockResolvedValue({ ok: false, code: "repo_role_required", message: "ignored: the catalogue sentence is used" });

    const res = await POST(req("/x", { method: "POST" }), ctx(listing.id));
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.code).toBe("not_found");
    expect(body.message).toBe(
      "Selling a repository requires the admin or maintain role on it. GitHub did not confirm that role for your account on this repository.",
    );
    expect(body.details).toEqual({ required_role: ["admin", "maintain"] });
  });

  it("410s a retired listing before it reaches the pipeline", async () => {
    const gone = seedListing(mock, creator, { slug: "gone", retired_at: new Date().toISOString() });

    const res = await POST(req("/x", { method: "POST" }), ctx(gone.id));
    expect(res.status).toBe(410);
    expect(release.cutRelease).not.toHaveBeenCalled();
  });

  it("404s a listing whose repo has been deleted (FR-44)", async () => {
    const orphan = seedListing(mock, creator, { slug: "orphan", source: "hosted", github_repo_id: null });

    const res = await POST(req("/x", { method: "POST" }), ctx(orphan.id));
    expect(res.status).toBe(404);
    expect(release.cutRelease).not.toHaveBeenCalled();
  });

  it("404s someone else's listing, and never calls the pipeline for it", async () => {
    const other = seedCreator(mock, { handle: "someone" }, OTHER_API_KEY);
    const theirs = seedListing(mock, other, { slug: "not-yours" });

    const res = await POST(req("/x", { method: "POST" }), ctx(theirs.id));
    expect(res.status).toBe(404);
    expect(release.cutRelease).not.toHaveBeenCalled();
  });

  it("403s a key without listings:write", async () => {
    mock.rows("api_key")[0].scopes = ["earnings:read"];
    const res = await POST(req("/x", { method: "POST" }), ctx(listing.id));
    expect(res.status).toBe(403);
  });
});
