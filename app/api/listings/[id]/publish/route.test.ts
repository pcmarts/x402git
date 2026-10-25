import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { makeMockDb } from "@/lib/test/mock-db";
import { hashApiKey } from "@/lib/auth/api-key";
import { ctx, OTHER_API_KEY, req, seedApiKey, seedCreator, seedListing, seedRelease, TEST_SESSION_KEY } from "@/lib/test/listings-fixtures";

vi.mock("@/lib/github/hosted", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github/hosted")>()),
  provisionHostedRepo: vi.fn(),
  archiveHostedRepo: vi.fn(),
  deleteHostedRepo: vi.fn(),
  commitLicenceFile: vi.fn(),
  rotateDeployKey: vi.fn(),
}));
const github = vi.hoisted(() => ({ installationAccount: vi.fn(), resolveRepo: vi.fn(), repoById: vi.fn() }));
vi.mock("@/lib/github/installations", () => github);
vi.mock("@/lib/release", () => ({ cutRelease: vi.fn() }));

const { POST } = await import("./route");

let mock: ReturnType<typeof makeMockDb>;
let creator: Record<string, any>;

/** A listing that is ready in every respect; each test spoils exactly one thing. */
function readyListing(overrides: Record<string, any> = {}) {
  const listing = seedListing(mock, creator, {
    slug: "humanizer",
    description: "Rewrites AI prose so it reads as written.",
    trigger_hint: "when text sounds generated",
    licence_spdx: "MIT",
    licence_verdict: "pass",
    ...overrides,
  });
  return listing;
}

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  creator = seedCreator(mock);
  // FR-10: publish re-reads the repo's visibility. Private is the uninteresting case,
  // so it is the default and only the public-repo test overrides it.
  github.repoById.mockResolvedValue({ repoId: 777, owner: "adrian", name: "humanizer", private: true, defaultBranch: "main" });
});

afterEach(() => {
  resetDb();
  vi.clearAllMocks();
  resetEnv();
});

async function blockingFor(listing: Record<string, any>): Promise<string[]> {
  const res = await POST(req("/x", { method: "POST" }), ctx(listing.id));
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.code).toBe("listing_not_ready");
  return body.details.blocking;
}

describe("POST /api/listings/:id/publish (FR-42)", () => {
  it("goes live when there is a passing release, a licence and a description", async () => {
    const listing = readyListing();
    seedRelease(mock, listing, { scan: "pass" });

    const res = await POST(req("/x", { method: "POST" }), ctx(listing.id));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("live");
    expect(body.published_at).toMatch(/^\d{4}-/);
    expect(body.endpoints.url).toBe("http://localhost:3000/a1b2c3/humanizer");
    expect(mock.rows("listing")[0].published_at).toBeTruthy();
  });

  it("writes a listing_published event (§10) attributed to the key that published (FR-61)", async () => {
    const listing = readyListing();
    seedRelease(mock, listing, { scan: "pass" });

    await POST(req("/x", { method: "POST" }), ctx(listing.id));
    const event = mock.rows("event").find((e) => e.name === "listing_published");
    expect(event).toBeDefined();
    expect(event?.props).toMatchObject({ slug: "humanizer", key_kind: "agent" });
  });

  it("records key_kind: session when the dashboard published it (FR-61)", async () => {
    // Same route, same code — D9. Only the credential differs, and that is the whole
    // point of the attribution: "a human clicked Publish" versus "an agent did".
    seedApiKey(mock, creator.id, {
      kind: "session",
      hash: hashApiKey(TEST_SESSION_KEY),
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const listing = readyListing();
    seedRelease(mock, listing, { scan: "pass" });

    const res = await POST(req("/x", { method: "POST", key: TEST_SESSION_KEY }), ctx(listing.id));
    expect(res.status).toBe(200);
    expect(mock.rows("event").find((e) => e.name === "listing_published")?.props).toMatchObject({ key_kind: "session" });
  });

  it("blocks with no_release when nothing has been cut yet", async () => {
    expect(await blockingFor(readyListing())).toEqual(["no_release"]);
  });

  it("blocks with scan_pending while the scan has not passed (FR-35)", async () => {
    const listing = readyListing();
    seedRelease(mock, listing, { scan: "pending" });
    expect(await blockingFor(listing)).toEqual(["scan_pending"]);
  });

  // Amended 2026-09-01: this pinned `scan_pending`, which was the defect rather than the
  // requirement. `fail` is terminal (§12), so "the scan has not finished" tells an agent
  // to wait for something that will never happen and tells a creator there is nothing to
  // do yet — the one thing that is not true. The remedy is a new version.
  it("blocks with scan_failed when every release failed its scan — a failing release is never sellable", async () => {
    const listing = readyListing();
    seedRelease(mock, listing, { version: "1.0.0", scan: "fail" });
    expect(await blockingFor(listing)).toEqual(["scan_failed"]);
  });

  it("does not block when an older release passed and a newer one failed", async () => {
    const listing = readyListing();
    seedRelease(mock, listing, { version: "1.0.0", scan: "pass", created_at: "2026-01-01T00:00:00.000Z" });
    seedRelease(mock, listing, { version: "1.1.0", scan: "fail", created_at: "2026-02-01T00:00:00.000Z" });

    const res = await POST(req("/x", { method: "POST" }), ctx(listing.id));
    expect(res.status).toBe(200);
  });

  // 2026-09-02: the licence stopped blocking publish. These assert the inverse of what
  // they asserted before — a listing with no licence at all goes live.
  it("publishes with no licence verdict at all", async () => {
    const listing = readyListing({ licence_spdx: null, licence_verdict: null });
    seedRelease(mock, listing, { scan: "pass" });

    const res = await POST(req("/x", { method: "POST" }), ctx(listing.id));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("live");
  });

  it("publishes on a `block` verdict and a `manual` one alike", async () => {
    for (const verdict of ["block", "manual"]) {
      mock.reset();
      creator = seedCreator(mock);
      const listing = readyListing({ licence_verdict: verdict });
      seedRelease(mock, listing, { scan: "pass" });

      const res = await POST(req("/x", { method: "POST" }), ctx(listing.id));
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("live");
    }
  });

  it("blocks with description_missing when either half is absent (FR-51)", async () => {
    const noDescription = readyListing({ slug: "one", description: null });
    seedRelease(mock, noDescription, { scan: "pass" });
    expect(await blockingFor(noDescription)).toEqual(["description_missing"]);

    const noHint = readyListing({ slug: "two", trigger_hint: null });
    seedRelease(mock, noHint, { scan: "pass" });
    expect(await blockingFor(noHint)).toEqual(["description_missing"]);
  });

  it("reports every unmet requirement at once, not one 409 at a time", async () => {
    const listing = seedListing(mock, creator, { slug: "bare" });
    expect(await blockingFor(listing)).toEqual(["no_release", "description_missing"]);
  });

  it("blocks with public_repo when the repo was made public after it was listed (FR-10)", async () => {
    github.repoById.mockResolvedValue({ repoId: 777, owner: "adrian", name: "humanizer", private: false, defaultBranch: "main" });
    const listing = readyListing();
    seedRelease(mock, listing, { scan: "pass" });

    expect(await blockingFor(listing)).toEqual(["public_repo"]);
    expect(github.repoById).toHaveBeenCalledWith("42", "777");
  });

  it("does not ask GitHub about a Rail B listing: hosted repos are private by construction", async () => {
    const listing = readyListing({ source: "hosted", hosted_org: "x402git-hosted-01" });
    seedRelease(mock, listing, { scan: "pass" });

    const res = await POST(req("/x", { method: "POST" }), ctx(listing.id));
    expect(res.status).toBe(200);
    expect(github.repoById).not.toHaveBeenCalled();
  });

  it("fails open when GitHub cannot be reached: an unreachable repo is not a public one", async () => {
    github.repoById.mockRejectedValue(new Error("api.github.com is unreachable"));
    const listing = readyListing();
    seedRelease(mock, listing, { scan: "pass" });

    const res = await POST(req("/x", { method: "POST" }), ctx(listing.id));
    expect(res.status).toBe(200);
  });

  it("is idempotent: publishing a live listing is a 200, not an error", async () => {
    const listing = readyListing();
    seedRelease(mock, listing, { scan: "pass" });

    const first = await (await POST(req("/x", { method: "POST" }), ctx(listing.id))).json();
    const second = await POST(req("/x", { method: "POST" }), ctx(listing.id));
    expect(second.status).toBe(200);
    expect((await second.json()).published_at).toBe(first.published_at);
  });

  it("410s a retired listing: retire is terminal (FR-43)", async () => {
    const listing = readyListing({ published_at: "2026-01-01T00:00:00.000Z", retired_at: "2026-02-01T00:00:00.000Z" });
    seedRelease(mock, listing, { scan: "pass" });

    const res = await POST(req("/x", { method: "POST" }), ctx(listing.id));
    expect(res.status).toBe(410);
    expect((await res.json()).code).toBe("retired");
  });

  it("404s someone else's listing", async () => {
    const other = seedCreator(mock, { handle: "someone" }, OTHER_API_KEY);
    const theirs = seedListing(mock, other, { slug: "not-yours" });

    const res = await POST(req("/x", { method: "POST" }), ctx(theirs.id));
    expect(res.status).toBe(404);
  });

  it("403s a key without listings:write", async () => {
    mock.rows("api_key")[0].scopes = ["earnings:read"];
    const listing = readyListing();
    const res = await POST(req("/x", { method: "POST" }), ctx(listing.id));
    expect(res.status).toBe(403);
  });
});
