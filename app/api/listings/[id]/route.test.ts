import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { makeMockDb } from "@/lib/test/mock-db";
import { hashApiKey } from "@/lib/auth/api-key";
import { ctx, OTHER_API_KEY, req, seedApiKey, seedCreator, seedListing, seedRelease, TEST_SESSION_KEY } from "@/lib/test/listings-fixtures";

const hosted = vi.hoisted(() => ({ archiveHostedRepo: vi.fn(async () => undefined) }));
vi.mock("@/lib/github/hosted", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github/hosted")>()),
  ...hosted,
}));
vi.mock("@/lib/github/installations", () => ({ installationAccount: vi.fn(), resolveRepo: vi.fn(), repoById: vi.fn() }));
vi.mock("@/lib/release", () => ({ cutRelease: vi.fn() }));

const { DELETE, GET, PATCH } = await import("./route");

let mock: ReturnType<typeof makeMockDb>;
let creator: Record<string, any>;
let listing: Record<string, any>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  creator = seedCreator(mock);
  listing = seedListing(mock, creator);
});

afterEach(() => {
  resetDb();
  vi.clearAllMocks();
  resetEnv();
});

describe("GET /api/listings/:id (§7.2)", () => {
  it("returns status, licence, pricing and every endpoint", async () => {
    const res = await GET(req(`/api/listings/${listing.id}`), ctx(listing.id));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("draft");
    expect(body.owner).toBe("a1b2c3");
    expect(body.licence).toEqual({ verdict: null, spdx: null });
    expect(body.latest_release).toBeNull();
    expect(body.pricing.price_micro).toBe("9000000");
    expect(body.endpoints.version_endpoint).toBe("http://localhost:3000/api/v/a1b2c3/humanizer");
    expect(body.remote).toBeNull();
  });

  it("reports the newest passing release, with its manifest url (FR-9)", async () => {
    seedRelease(mock, listing, { version: "1.0.0", scan: "pass", created_at: "2026-01-01T00:00:00.000Z" });
    seedRelease(mock, listing, { version: "1.1.0", scan: "pass", created_at: "2026-02-01T00:00:00.000Z" });
    // Newer, but not sellable: "latest" is the newest release that passed.
    seedRelease(mock, listing, { version: "1.2.0", scan: "pending", created_at: "2026-03-01T00:00:00.000Z" });
    seedRelease(mock, listing, { version: "1.3.0", scan: "fail", created_at: "2026-04-01T00:00:00.000Z" });

    const body = await (await GET(req(`/api/listings/${listing.id}`), ctx(listing.id))).json();
    expect(body.latest_release.version).toBe("1.1.0");
    expect(body.latest_release.scan).toBe("pass");
    expect(body.latest_release.manifest_url).toBe("http://localhost:3000/api/label/a1b2c3/humanizer");
  });

  it("derives live and retired from the timestamps (FR-42)", async () => {
    const live = seedListing(mock, creator, { slug: "live-one", published_at: "2026-01-01T00:00:00.000Z" });
    const gone = seedListing(mock, creator, { slug: "gone", published_at: "2026-01-01T00:00:00.000Z", retired_at: "2026-02-01T00:00:00.000Z" });

    expect((await (await GET(req("/x"), ctx(live.id))).json()).status).toBe("live");
    expect((await (await GET(req("/x"), ctx(gone.id))).json()).status).toBe("retired");
  });

  it("gives a hosted listing its git remote and host key fingerprints", async () => {
    const hostedListing = seedListing(mock, creator, { slug: "agent-pack", source: "hosted", hosted_org: "x402git-hosted-01", github_repo_id: "987654" });

    const body = await (await GET(req("/x"), ctx(hostedListing.id))).json();
    expect(body.remote).toBe("git@github.com:x402git-hosted-01/a1b2c3--agent-pack.git");
    expect(body.default_branch).toBe("main");
    expect(body.ssh_host_key_fingerprints).toContain("SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU");
  });

  it("404s another creator's listing id rather than 403ing it", async () => {
    const other = seedCreator(mock, { handle: "someone" }, OTHER_API_KEY);
    const theirs = seedListing(mock, other, { slug: "not-yours" });

    const res = await GET(req("/x"), ctx(theirs.id));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("not_found");
  });

  it("404s an id that is not even a uuid", async () => {
    const res = await GET(req("/x"), ctx("../../etc/passwd"));
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/listings/:id (FR-12, FR-16)", () => {
  it("changes the price without rounding it", async () => {
    const res = await PATCH(req("/x", { method: "PATCH", body: { price_micro: "9000001" } }), ctx(listing.id));
    expect(res.status).toBe(200);
    expect((await res.json()).pricing.price_micro).toBe("9000001");
    expect(String(mock.rows("listing")[0].price_micro)).toBe("9000001");
  });

  it("accepts a $0 update price — lifetime access is celebrated, not blocked (D1)", async () => {
    const res = await PATCH(req("/x", { method: "PATCH", body: { update_price_micro: "0" } }), ctx(listing.id));
    expect(res.status).toBe(200);
    expect((await res.json()).pricing.update_price_micro).toBe("0");
  });

  it("rejects a price under the technical minimum but over zero (D2b)", async () => {
    const res = await PATCH(req("/x", { method: "PATCH", body: { price_micro: "1" } }), ctx(listing.id));
    expect(res.status).toBe(400);
    expect(String(mock.rows("listing")[0].price_micro)).toBe("9000000");
  });

  it("sets the description and trigger hint (FR-51)", async () => {
    const res = await PATCH(req("/x", { method: "PATCH", body: { description: "Rewrites AI prose.", trigger_hint: "when text sounds generated" } }), ctx(listing.id));
    const body = await res.json();
    expect(body.description).toBe("Rewrites AI prose.");
    expect(body.trigger_hint).toBe("when text sounds generated");
  });

  it("refuses an empty patch rather than reporting a change that did not happen", async () => {
    const res = await PATCH(req("/x", { method: "PATCH", body: {} }), ctx(listing.id));
    expect(res.status).toBe(400);
  });

  it("does not touch purchase rows: price changes are future-only (FR-16)", async () => {
    await PATCH(req("/x", { method: "PATCH", body: { price_micro: "19000000" } }), ctx(listing.id));
    expect(mock.rows("purchase")).toHaveLength(0);
  });

  it("410s a retired listing", async () => {
    const gone = seedListing(mock, creator, { slug: "gone", retired_at: new Date().toISOString() });
    const res = await PATCH(req("/x", { method: "PATCH", body: { price_micro: "19000000" } }), ctx(gone.id));
    expect(res.status).toBe(410);
    expect((await res.json()).code).toBe("retired");
  });

  it("403s a key without listings:write", async () => {
    mock.rows("api_key")[0].scopes = ["earnings:read"];
    const res = await PATCH(req("/x", { method: "PATCH", body: { price_micro: "0" } }), ctx(listing.id));
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/listings/:id — retire (FR-43)", () => {
  it("retires the listing and reports the timestamp", async () => {
    const res = await DELETE(req("/x", { method: "DELETE" }), ctx(listing.id));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("retired");
    expect(body.retired_at).toMatch(/^\d{4}-/);
    expect(mock.rows("listing")[0].retired_at).toBeTruthy();
  });

  it("archives the hosted repo rather than deleting it", async () => {
    const hostedListing = seedListing(mock, creator, { slug: "agent-pack", source: "hosted", hosted_org: "x402git-hosted-01", github_repo_id: "987654" });

    await DELETE(req("/x", { method: "DELETE" }), ctx(hostedListing.id));
    expect(hosted.archiveHostedRepo).toHaveBeenCalledWith({ owner: "x402git-hosted-01", repo: "a1b2c3--agent-pack" });
  });

  it("retires even when GitHub will not archive: the listing must stop selling either way", async () => {
    hosted.archiveHostedRepo.mockRejectedValueOnce(new Error("repository is already archived"));
    const hostedListing = seedListing(mock, creator, { slug: "agent-pack", source: "hosted", hosted_org: "x402git-hosted-01", github_repo_id: "987654" });

    const res = await DELETE(req("/x", { method: "DELETE" }), ctx(hostedListing.id));
    expect(res.status).toBe(200);
    expect(mock.rows("listing").find((l) => l.id === hostedListing.id)?.retired_at).toBeTruthy();
  });

  it("is terminal: a second retire is 410, not a second timestamp", async () => {
    await DELETE(req("/x", { method: "DELETE" }), ctx(listing.id));
    const first = mock.rows("listing")[0].retired_at;

    const res = await DELETE(req("/x", { method: "DELETE" }), ctx(listing.id));
    expect(res.status).toBe(410);
    expect(mock.rows("listing")[0].retired_at).toBe(first);
  });

  it("attributes the retirement to the kind of key that made the call (FR-61)", async () => {
    await DELETE(req("/x", { method: "DELETE" }), ctx(listing.id));
    expect(mock.rows("event").find((e) => e.name === "listing_retired")?.props).toMatchObject({ slug: "humanizer", key_kind: "agent" });

    // The same call on a browser session key. D9 says it is the same route; FR-61 says
    // the event should still be able to tell the two apart afterwards.
    seedApiKey(mock, creator.id, {
      kind: "session",
      hash: hashApiKey(TEST_SESSION_KEY),
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const second = seedListing(mock, creator, { slug: "second" });
    await DELETE(req("/x", { method: "DELETE", key: TEST_SESSION_KEY }), ctx(second.id));

    const events = mock.rows("event").filter((e) => e.name === "listing_retired");
    expect(events.map((e) => (e.props as { key_kind: string }).key_kind)).toEqual(["agent", "session"]);
  });

  it("leaves purchases and releases alone — holders keep what they own (FR-19, FR-46)", async () => {
    const release = seedRelease(mock, listing);
    await DELETE(req("/x", { method: "DELETE" }), ctx(listing.id));
    expect(mock.rows("release")).toHaveLength(1);
    expect(mock.rows("release")[0].id).toBe(release.id);
  });

  it("cannot retire someone else's listing", async () => {
    const other = seedCreator(mock, { handle: "someone" }, OTHER_API_KEY);
    const theirs = seedListing(mock, other, { slug: "not-yours" });

    const res = await DELETE(req("/x", { method: "DELETE" }), ctx(theirs.id));
    expect(res.status).toBe(404);
    expect(mock.rows("listing").find((l) => l.id === theirs.id)?.retired_at).toBeNull();
  });
});
