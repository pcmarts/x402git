import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { makeMockDb } from "@/lib/test/mock-db";
import { hashApiKey } from "@/lib/auth/api-key";
import { ctx, OTHER_API_KEY, req, seedApiKey, seedCreator, seedListing, seedRelease, TEST_SESSION_KEY } from "@/lib/test/listings-fixtures";
import { repoById } from "@/lib/github/installations";

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

// ---------------------------------------------------------------------------
// Open releases (25 Oct 2026, HackMeridian; docs/HACKMERIDIAN-STRATEGY.md §6a)
// ---------------------------------------------------------------------------

describe("PATCH /api/listings/:id — the open-release promise", () => {
  const PUBLIC = "https://github.com/adrian/humanizer-public";
  const patch = (body: Record<string, unknown>, id = listing.id) => PATCH(req("/x", { method: "PATCH", body }), ctx(id));

  it("sets the switch, the public repo and the days, and echoes the standing offer with no date yet", async () => {
    const res = await patch({ open_release: true, public_repo_url: PUBLIC, open_after_days: 30 });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.open_release).toEqual({
      opens_at: null,
      open_after_days: 30,
      public_repo_url: PUBLIC,
      licence: null,
      status: "pending",
      opened_at: null,
      checked_at: null,
      evidence_url: null,
      checks: [],
    });
    const row = mock.rows("listing")[0];
    expect(row.open_release).toBe(true);
    expect(row.public_repo_url).toBe(PUBLIC);
    expect(row.open_after_days).toBe(30);
  });

  it("is null on an ordinary listing, and the fields never leak out of the block", async () => {
    const body = await (await GET(req("/x"), ctx(listing.id))).json();
    expect(body.open_release).toBeNull();
    expect(body).not.toHaveProperty("open_after_days");
  });

  it("refuses an open release with no public repo, naming the field", async () => {
    const res = await patch({ open_release: true, open_after_days: 10 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("invalid_request");
    expect(body.details.field).toBe("public_repo_url");
    expect(mock.rows("listing")[0].open_release).toBeUndefined();
  });

  it("refuses an open release with no number of days, naming the field", async () => {
    const res = await patch({ open_release: true, public_repo_url: PUBLIC });
    expect(res.status).toBe(400);
    expect((await res.json()).details.field).toBe("open_after_days");
  });

  it("refuses a public repo URL that is not https://github.com/owner/name", async () => {
    for (const bad of ["https://gitlab.com/o/r", "https://github.com/o", "https://github.com/o/r/tree/main", "github.com/o/r"]) {
      const res = await patch({ public_repo_url: bad });
      expect(res.status, bad).toBe(400);
    }
  });

  it("refuses days outside 1 to 90, or not a whole number", async () => {
    for (const bad of [0, 91, -1, 2.5, "30"]) {
      const res = await patch({ open_release: true, public_repo_url: PUBLIC, open_after_days: bad });
      expect(res.status, String(bad)).toBe(400);
    }
    expect(mock.rows("listing")[0].open_release).toBeUndefined();
  });

  it("takes the whole range, both ends", async () => {
    expect((await patch({ open_release: true, public_repo_url: PUBLIC, open_after_days: 1 })).status).toBe(200);
    expect((await patch({ open_after_days: 90 })).status).toBe(200);
    expect(mock.rows("listing")[0].open_after_days).toBe(90);
  });

  it("refuses the repository being sold as the place it opens (H6)", async () => {
    vi.mocked(repoById).mockResolvedValue({ repoId: 777, owner: "adrian", name: "humanizer", private: true, defaultBranch: "main" } as never);
    const res = await patch({ open_release: true, public_repo_url: "https://github.com/Adrian/Humanizer", open_after_days: 10 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.details.field).toBe("public_repo_url");
    expect(body.message).toMatch(/repository being sold/);
  });

  it("refuses the hosted repo as the place it opens, without asking GitHub", async () => {
    const hosted = seedListing(mock, creator, { slug: "agent-pack", source: "hosted", hosted_org: "x402git-hosted-01", github_repo_id: "987654" });
    const res = await patch({ open_release: true, public_repo_url: "https://github.com/x402git-hosted-01/a1b2c3--agent-pack", open_after_days: 10 }, hosted.id);
    expect(res.status).toBe(400);
    expect(vi.mocked(repoById)).not.toHaveBeenCalled();
  });

  it("lets the days go up as well as down: the rule is for future cuts, like a price (FR-16)", async () => {
    await patch({ open_release: true, public_repo_url: PUBLIC, open_after_days: 10 });
    const res = await patch({ open_after_days: 60 });
    expect(res.status).toBe(200);
    expect(mock.rows("listing")[0].open_after_days).toBe(60);
  });

  it("never touches a stamped release when the days change: a release already sold keeps its date", async () => {
    await patch({ open_release: true, public_repo_url: PUBLIC, open_after_days: 30 });
    const was = "2026-11-24T00:00:00.000Z";
    const pending = seedRelease(mock, listing, { version: "1.1.0", promise_status: "pending", opens_at: was });
    const kept = seedRelease(mock, listing, { version: "1.0.0", promise_status: "opened_on_time", opens_at: was });

    expect((await patch({ open_after_days: 5 })).status).toBe(200);
    expect((await patch({ open_after_days: 90 })).status).toBe(200);

    const rows = mock.rows("release");
    expect(rows.find((r) => r.id === pending.id)!.opens_at).toBe(was);
    expect(rows.find((r) => r.id === kept.id)!.opens_at).toBe(was);
  });

  it("lets the switch go off while the repo and the days stay, so turning it back on is one click", async () => {
    await patch({ open_release: true, public_repo_url: PUBLIC, open_after_days: 10 });
    const body = await (await patch({ open_release: false })).json();
    expect(body.open_release).toBeNull();
    expect(mock.rows("listing")[0].open_after_days).toBe(10);
    expect(mock.rows("listing")[0].public_repo_url).toBe(PUBLIC);
  });

  it("clears the days with an explicit null, and then refuses to switch on without them", async () => {
    await patch({ open_release: true, public_repo_url: PUBLIC, open_after_days: 10 });
    expect((await patch({ open_release: false, open_after_days: null })).status).toBe(200);
    expect(mock.rows("listing")[0].open_after_days).toBeNull();
    const res = await patch({ open_release: true });
    expect(res.status).toBe(400);
    expect((await res.json()).details.field).toBe("open_after_days");
  });

  it("does not ask GitHub about the sold repo for a price-only patch", async () => {
    await patch({ price_micro: "12000000" });
    expect(vi.mocked(repoById)).not.toHaveBeenCalled();
  });
});

describe("GET /api/listings/:id — the open-release block on a stamped release", () => {
  const PUBLIC = "https://github.com/adrian/humanizer-public";

  it("reads the promise off the release that sells, with its verdict and evidence", async () => {
    Object.assign(mock.rows("listing")[0], { open_release: true, public_repo_url: PUBLIC, open_after_days: 30 });
    seedRelease(mock, listing, {
      version: "1.1.0",
      promise_status: "opened_on_time",
      opens_at: "2026-10-20T00:00:00.000Z",
      open_licence_spdx: "MIT",
      opened_at: "2026-10-20T00:05:00.000Z",
      promise_checked_at: "2026-10-20T00:05:00.000Z",
      promise_evidence: { ref: "v1.1.0", html_url: "https://github.com/adrian/humanizer-public/commit/abc", licence: "MIT", checked_url: "https://api.github.com/x" },
      open_eligibility: [{ id: "licence", ok: true, detail: "MIT permits resale." }],
    });

    const body = await (await GET(req("/x"), ctx(listing.id))).json();
    expect(body.open_release).toEqual({
      opens_at: "2026-10-20T00:00:00.000Z",
      open_after_days: 30,
      public_repo_url: PUBLIC,
      licence: "MIT",
      status: "opened_on_time",
      opened_at: "2026-10-20T00:05:00.000Z",
      checked_at: "2026-10-20T00:05:00.000Z",
      evidence_url: "https://github.com/adrian/humanizer-public/commit/abc",
      checks: [{ id: "licence", ok: true, detail: "MIT permits resale." }],
    });
  });

  it("shows the standing offer, not the old release, when the release that sells predates the promise", async () => {
    Object.assign(mock.rows("listing")[0], { open_release: true, public_repo_url: PUBLIC, open_after_days: 30 });
    seedRelease(mock, listing, { version: "1.0.0", promise_status: null, opens_at: null });

    const body = await (await GET(req("/x"), ctx(listing.id))).json();
    expect(body.open_release.status).toBe("pending");
    expect(body.open_release.opens_at).toBeNull();
    expect(body.open_release.open_after_days).toBe(30);
    expect(body.latest_release.version).toBe("1.0.0");
  });
});
