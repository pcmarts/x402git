import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { makeMockDb } from "@/lib/test/mock-db";
import { notifyAdmin } from "@/lib/notify";
import { ctx, OTHER_API_KEY, req, seedCreator, seedListing, TEST_API_KEY } from "@/lib/test/listings-fixtures";

vi.mock("@/lib/notify", () => ({ notifyAdmin: vi.fn(async () => ({ delivered: true })) }));

const hosted = vi.hoisted(() => ({
  provisionHostedRepo: vi.fn(),
  deleteHostedRepo: vi.fn(async () => undefined),
}));
vi.mock("@/lib/github/hosted", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github/hosted")>()),
  ...hosted,
}));

const github = vi.hoisted(() => ({
  installationAccount: vi.fn(),
  userOwnsInstallation: vi.fn(),
  userCanSellRepo: vi.fn(),
  resolveRepo: vi.fn(),
  repoById: vi.fn(),
}));
// The real module for its constants (the refusal message, the role list); every call to
// GitHub is a mock. `lib/github/installations.test.ts` covers what the role check reads.
vi.mock("@/lib/github/installations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github/installations")>()),
  ...github,
}));

vi.mock("@/lib/release", () => ({ cutRelease: vi.fn() }));

const { GET, POST } = await import("./route");

let mock: ReturnType<typeof makeMockDb>;
let creator: Record<string, any>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  creator = seedCreator(mock);

  hosted.provisionHostedRepo.mockResolvedValue({
    org: "x402git-hosted-01",
    name: "a1b2c3--humanizer",
    repoId: 987654,
    deployKeyId: 5150,
    remote: "git@github.com:x402git-hosted-01/a1b2c3--humanizer.git",
    defaultBranch: "main",
    installationId: 42,
    sshHostKeyFingerprints: ["SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU"],
  });
  github.resolveRepo.mockResolvedValue({ repoId: 777, owner: "adrian", name: "humanizer", private: true, defaultBranch: "main" });
  github.repoById.mockResolvedValue({ repoId: 777, owner: "adrian", name: "humanizer", private: true, defaultBranch: "main" });
  github.installationAccount.mockResolvedValue({ installationId: 42, accountId: 1234, accountLogin: "adrian", accountType: "User" });
  // The real check for a user-account installation: id equality against the creator.
  github.userOwnsInstallation.mockImplementation(async (githubUserId: string | number, account: { accountId: number | null }) => {
    return account.accountId !== null && String(account.accountId) === String(githubUserId);
  });
  // AUTH-2: the creator holds admin or maintain on the repo unless a test says otherwise.
  github.userCanSellRepo.mockResolvedValue(true);
});

afterEach(() => {
  resetDb();
  vi.clearAllMocks();
  delete process.env.RAIL_B_INVITE_CODES;
  resetEnv();
});

const railA = { slug: "humanizer", source: "github", installation_id: 42, github_repo_id: 777 };
const railB = { slug: "humanizer", source: "hosted", ssh_public_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample agent@x402git" };

describe("POST /api/listings — Rail A (FR-3, FR-8)", () => {
  it("creates a draft and returns the pricing block and every endpoint", async () => {
    const res = await POST(req("/api/listings", { method: "POST", body: railA }));
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.status).toBe("draft");
    expect(body.owner).toBe("a1b2c3");
    expect(body.slug).toBe("humanizer");
    // FR-13 / D2a: the anchoring context is on every listing response, defaults included.
    expect(body.pricing.price_micro).toBe("9000000");
    expect(body.pricing.update_price_micro).toBe("5000000");
    expect(body.pricing.presets.price).toEqual(["1000000", "5000000", "9000000", "19000000"]);
    expect(body.pricing.defaults.price_micro).toBe("9000000");
    expect(body.pricing.platform_fee_bps).toBe(1000);
    expect(body.endpoints.resource_endpoint).toBe("http://localhost:3000/api/r/a1b2c3/humanizer");
    expect(body.endpoints.label_endpoint).toBe("http://localhost:3000/api/label/a1b2c3/humanizer");
    expect(body.remote).toBeNull();
  });

  it("stores the repo by id, and never provisions anything", async () => {
    await POST(req("/api/listings", { method: "POST", body: railA }));

    const row = mock.rows("listing")[0];
    expect(row.source).toBe("github");
    expect(String(row.github_repo_id)).toBe("777");
    expect(String(row.installation_id)).toBe("42");
    expect(hosted.provisionHostedRepo).not.toHaveBeenCalled();
  });

  it('resolves `repo: "owner/name"` to a repo id (FR-8 matches on ids, never names)', async () => {
    const res = await POST(req("/api/listings", { method: "POST", body: { slug: "humanizer", source: "github", installation_id: 42, repo: "adrian/humanizer" } }));
    expect(res.status).toBe(201);
    expect(github.resolveRepo).toHaveBeenCalledWith(42, "adrian/humanizer");
    expect(String(mock.rows("listing")[0].github_repo_id)).toBe("777");
  });

  it("refuses Rail A outright when the creator has no linked GitHub identity", async () => {
    // The critical case: skipping the ownership check for a null github_user_id let a
    // headless creator bind any enumerable installation id — someone else's private repo.
    mock.rows("creator")[0].github_user_id = null;

    const res = await POST(req("/api/listings", { method: "POST", body: railA }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_request");
    expect(github.userOwnsInstallation).not.toHaveBeenCalled();
    expect(mock.rows("listing")).toHaveLength(0);
  });

  it("404s an installation that belongs to a different GitHub account", async () => {
    mock.rows("creator")[0].github_user_id = 9999;
    github.installationAccount.mockResolvedValue({ installationId: 42, accountId: 1234, accountLogin: "someone-else", accountType: "User" });

    const res = await POST(req("/api/listings", { method: "POST", body: railA }));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("not_found");
    expect(mock.rows("listing")).toHaveLength(0);
  });

  it("accepts an installation that does belong to the creator", async () => {
    mock.rows("creator")[0].github_user_id = 1234;
    const res = await POST(req("/api/listings", { method: "POST", body: railA }));
    expect(res.status).toBe(201);
  });

  it("refuses a public repository with 422 public_repo, and writes nothing (FR-10)", async () => {
    github.repoById.mockResolvedValue({ repoId: 777, owner: "adrian", name: "humanizer", private: false, defaultBranch: "main" });

    const res = await POST(req("/api/listings", { method: "POST", body: railA }));
    expect(res.status).toBe(422);

    const body = await res.json();
    expect(body.code).toBe("public_repo");
    expect(body.message).toBe("Only private repositories can be listed. Make the repository private and try again.");
    expect(body.details).toEqual({ repo: "adrian/humanizer", visibility: "public" });
    expect(mock.rows("listing")).toHaveLength(0);
  });

  it('refuses a public repository named as `repo: "owner/name"` too', async () => {
    github.resolveRepo.mockResolvedValue({ repoId: 777, owner: "adrian", name: "humanizer", private: false, defaultBranch: "main" });

    const res = await POST(req("/api/listings", { method: "POST", body: { slug: "humanizer", source: "github", installation_id: 42, repo: "adrian/humanizer" } }));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("public_repo");
    expect(mock.rows("listing")).toHaveLength(0);
  });

  it("reads the visibility from GitHub even when the caller sent a bare repo id", async () => {
    // The picker only offers private repos; `POST /api/listings` is reachable without it,
    // so the id in the body is a claim and the visibility is read, not taken on trust.
    await POST(req("/api/listings", { method: "POST", body: railA }));
    expect(github.repoById).toHaveBeenCalledWith(42, 777);
  });

  it("requires installation_id, and a repo id or name", async () => {
    const noInstall = await POST(req("/api/listings", { method: "POST", body: { slug: "humanizer", source: "github" } }));
    expect(noInstall.status).toBe(400);
    expect((await noInstall.json()).details.field).toBe("installation_id");

    const noRepo = await POST(req("/api/listings", { method: "POST", body: { slug: "humanizer", source: "github", installation_id: 42 } }));
    expect(noRepo.status).toBe(400);
    expect((await noRepo.json()).details.field).toBe("github_repo_id");
  });
});

// AUTH-2 (RED-TEAM-2026-09-21): an org installation proves membership, not permission to
// sell a particular repo. The role itself is read in `userCanSellRepo` (tested against a
// fake Octokit in lib/github/installations.test.ts); these pin the route's use of it.
describe("POST /api/listings — the creator's role on the repo (AUTH-2)", () => {
  const orgInstall = { installationId: 42, accountId: 99, accountLogin: "acme", accountType: "Organization" };
  const orgRepo = { repoId: 777, owner: "acme", name: "secret-sauce", private: true, defaultBranch: "main" };

  beforeEach(() => {
    // An active member of the org that installed the App: passes the installation check.
    github.installationAccount.mockResolvedValue(orgInstall);
    github.userOwnsInstallation.mockResolvedValue(true);
    github.repoById.mockResolvedValue(orgRepo);
    github.resolveRepo.mockResolvedValue(orgRepo);
  });

  async function refusal(res: Response) {
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("not_found");
    expect(body.message).toBe(
      "Selling a repository requires the admin or maintain role on it. GitHub did not confirm that role for your account on this repository.",
    );
    expect(body.details).toEqual({ required_role: ["admin", "maintain"] });
    expect(mock.rows("listing")).toHaveLength(0);
    return body;
  }

  it("lists the repo when the creator holds a selling role on it", async () => {
    const res = await POST(req("/api/listings", { method: "POST", body: railA }));
    expect(res.status).toBe(201);
    expect(github.userCanSellRepo).toHaveBeenCalledWith(42, "1234", { owner: "acme", name: "secret-sauce" });
  });

  it("refuses an org member without a selling role, and writes nothing", async () => {
    github.userCanSellRepo.mockResolvedValue(false);
    await refusal(await POST(req("/api/listings", { method: "POST", body: railA })));
  });

  it('checks a repo named as `repo: "owner/name"` the same way', async () => {
    github.userCanSellRepo.mockResolvedValue(false);
    const res = await POST(req("/api/listings", { method: "POST", body: { slug: "humanizer", source: "github", installation_id: 42, repo: "acme/secret-sauce" } }));
    await refusal(res);
    expect(github.userCanSellRepo).toHaveBeenCalledWith(42, "1234", { owner: "acme", name: "secret-sauce" });
  });

  it("answers a repo the installation cannot see with the very same 404: no existence oracle", async () => {
    github.repoById.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
    const unseen = await refusal(await POST(req("/api/listings", { method: "POST", body: railA })));

    github.repoById.mockResolvedValue(orgRepo);
    github.userCanSellRepo.mockResolvedValue(false);
    const unpermitted = await refusal(await POST(req("/api/listings", { method: "POST", body: railA })));

    expect(unseen).toEqual(unpermitted);
    expect(github.userCanSellRepo).toHaveBeenCalledTimes(1);
  });

  it("answers a GitHub outage while reading the repo with the same 404, not a 500", async () => {
    github.repoById.mockRejectedValue(new TypeError("fetch failed"));
    await refusal(await POST(req("/api/listings", { method: "POST", body: railA })));
  });

  it("does not reveal a repo's visibility to someone without a selling role", async () => {
    github.repoById.mockResolvedValue({ ...orgRepo, private: false });
    github.userCanSellRepo.mockResolvedValue(false);
    await refusal(await POST(req("/api/listings", { method: "POST", body: railA })));
  });

  it("checks the role on user installations too", async () => {
    github.installationAccount.mockResolvedValue({ installationId: 42, accountId: 1234, accountLogin: "adrian", accountType: "User" });
    github.userOwnsInstallation.mockResolvedValue(true);
    github.userCanSellRepo.mockResolvedValue(false);
    await refusal(await POST(req("/api/listings", { method: "POST", body: railA })));
  });
});

describe("POST /api/listings — Rail B (FR-7, §14.6)", () => {
  it("provisions a private repo and hands back the remote, branch and host keys", async () => {
    const res = await POST(req("/api/listings", { method: "POST", body: railB }));
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.remote).toBe("git@github.com:x402git-hosted-01/a1b2c3--humanizer.git");
    expect(body.default_branch).toBe("main");
    expect(body.ssh_host_key_fingerprints[0]).toMatch(/^SHA256:/);

    expect(hosted.provisionHostedRepo).toHaveBeenCalledWith({
      handle: "a1b2c3",
      slug: "humanizer",
      sshPublicKey: railB.ssh_public_key,
    });

    const row = mock.rows("listing")[0];
    expect(row.source).toBe("hosted");
    expect(row.hosted_org).toBe("x402git-hosted-01");
    expect(String(row.deploy_key_id)).toBe("5150");
    expect(String(row.github_repo_id)).toBe("987654");
  });

  it("refuses a hosted listing with no public key — there would be no way to push", async () => {
    const res = await POST(req("/api/listings", { method: "POST", body: { slug: "humanizer", source: "hosted" } }));
    expect(res.status).toBe(400);
    expect((await res.json()).details.field).toBe("ssh_public_key");
    expect(hosted.provisionHostedRepo).not.toHaveBeenCalled();
  });

  it("is invite-gated when invite codes are configured (D2c)", async () => {
    process.env.RAIL_B_INVITE_CODES = "alpha,beta";
    resetEnv();
    mock.rows("creator")[0].onboarded_via = "web";

    const res = await POST(req("/api/listings", { method: "POST", body: railB }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("invite_required");
    expect(hosted.provisionHostedRepo).not.toHaveBeenCalled();
  });

  it("lets an API-registered creator through the same gate", async () => {
    process.env.RAIL_B_INVITE_CODES = "alpha";
    resetEnv();
    const res = await POST(req("/api/listings", { method: "POST", body: railB }));
    expect(res.status).toBe(201);
  });

  it("turns GitHub's 422 on a reused deploy key into a 400 naming the field (§14.6)", async () => {
    // One public key, one repo. An agent with a single SSH key and two listings hits
    // this, and FR-33 says the answer is a catalogue error, not a bare 500.
    const { DeployKeyRejected } = await import("@/lib/github/hosted");
    hosted.provisionHostedRepo.mockRejectedValueOnce(new DeployKeyRejected("key is already in use"));

    const res = await POST(req("/api/listings", { method: "POST", body: railB }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("invalid_request");
    expect(body.details.field).toBe("ssh_public_key");
    expect(body.message).toContain("key is already in use");
    expect(mock.rows("listing")).toHaveLength(0);
  });

  it("removes the repo again when the row cannot be written", async () => {
    seedListing(mock, creator, { slug: "humanizer" });
    // The slug check catches this one first, so force the race: insert after the read.
    const res = await POST(req("/api/listings", { method: "POST", body: { ...railB, slug: "humanizer" } }));
    expect(res.status).toBe(400);
    expect(hosted.provisionHostedRepo).not.toHaveBeenCalled();
  });
});

describe("POST /api/listings — what the operator hears (ADMIN-NOTIFICATIONS.md)", () => {
  it("reports a linked (Rail A) listing with its price in micro-USDC", async () => {
    await POST(req("/api/listings", { method: "POST", body: railA }));

    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(notifyAdmin).toHaveBeenCalledWith({
      kind: "listing_created",
      listingId: mock.rows("listing")[0].id,
      handle: "a1b2c3",
      slug: "humanizer",
      rail: "linked",
      priceMicro: 9_000_000n,
    });
  });

  it("calls a hosted listing Rail B, and carries the price the caller asked for", async () => {
    await POST(req("/api/listings", { method: "POST", body: { ...railB, price_micro: "1500000" } }));

    expect(notifyAdmin).toHaveBeenCalledWith(expect.objectContaining({ kind: "listing_created", rail: "hosted", priceMicro: 1_500_000n }));
  });

  it("says nothing when the insert loses a race to the slug and the repo is rolled back", async () => {
    // The genuine race the 23505 branch exists for: the slug is free when it is checked
    // and taken by the time the row is written. A phantom "new listing" for a row that
    // was never committed — and a repo that has just been deleted — is worse than silence.
    hosted.provisionHostedRepo.mockImplementationOnce(async () => {
      seedListing(mock, creator, { slug: "humanizer" });
      return {
        org: "x402git-hosted-01",
        name: "a1b2c3--humanizer",
        repoId: 987654,
        deployKeyId: 5150,
        remote: "git@github.com:x402git-hosted-01/a1b2c3--humanizer.git",
        defaultBranch: "main",
        installationId: 42,
        sshHostKeyFingerprints: ["SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU"],
      };
    });

    const res = await POST(req("/api/listings", { method: "POST", body: railB }));
    expect(res.status).toBe(400);
    expect(hosted.deleteHostedRepo).toHaveBeenCalled();
    expect(notifyAdmin).not.toHaveBeenCalled();
  });
});

describe("POST /api/listings — slugs (FR-3)", () => {
  it("rejects the reserved words", async () => {
    for (const slug of ["api", "v", "r", "label"]) {
      const res = await POST(req("/api/listings", { method: "POST", body: { ...railA, slug } }));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("invalid_request");
    }
  });

  it("rejects a slug outside [a-z0-9-]{2,40}", async () => {
    for (const slug of ["A", "x", "Humanizer", "human_izer", "a".repeat(41), "human izer"]) {
      const res = await POST(req("/api/listings", { method: "POST", body: { ...railA, slug } }));
      expect(res.status).toBe(400);
    }
  });

  it("rejects a slug this creator already uses", async () => {
    seedListing(mock, creator, { slug: "humanizer" });
    const res = await POST(req("/api/listings", { method: "POST", body: railA }));
    expect(res.status).toBe(400);
    expect((await res.json()).details.retired).toBe(false);
  });

  it("never reuses a slug after retirement", async () => {
    seedListing(mock, creator, { slug: "humanizer", published_at: new Date().toISOString(), retired_at: new Date().toISOString() });
    const res = await POST(req("/api/listings", { method: "POST", body: railA }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.details.retired).toBe(true);
    expect(body.message).toMatch(/never reused/i);
  });

  it("lets a different creator use the same slug", async () => {
    const other = seedCreator(mock, { handle: "someone" }, OTHER_API_KEY);
    seedListing(mock, other, { slug: "humanizer" });

    const res = await POST(req("/api/listings", { method: "POST", body: railA }));
    expect(res.status).toBe(201);
  });
});

describe("POST /api/listings — caps and money (D2c, FR-12)", () => {
  it("caps unpublished listings at three", async () => {
    seedListing(mock, creator, { slug: "one" });
    seedListing(mock, creator, { slug: "two" });
    seedListing(mock, creator, { slug: "three" });

    const res = await POST(req("/api/listings", { method: "POST", body: railA }));
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.code).toBe("too_many_unpublished");
    expect(body.details.max).toBe(3);
  });

  it("does not count published or retired listings against the cap", async () => {
    const live = new Date().toISOString();
    seedListing(mock, creator, { slug: "one", published_at: live });
    seedListing(mock, creator, { slug: "two", published_at: live });
    seedListing(mock, creator, { slug: "three", retired_at: live });
    seedListing(mock, creator, { slug: "four" });

    const res = await POST(req("/api/listings", { method: "POST", body: railA }));
    expect(res.status).toBe(201);
  });

  it("never rounds an explicit price (FR-12)", async () => {
    const res = await POST(req("/api/listings", { method: "POST", body: { ...railA, price_micro: "9000001", update_price_micro: "1" } }));
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.pricing.price_micro).toBe("9000001");
    expect(body.pricing.update_price_micro).toBe("1");
    expect(String(mock.rows("listing")[0].price_micro)).toBe("9000001");
    expect(String(mock.rows("listing")[0].update_price_micro)).toBe("1");
  });

  it("rejects a $0 release but keeps $0 updates first-class (D1; 2026-08-31, founder)", async () => {
    const free = await POST(req("/api/listings", { method: "POST", body: { ...railA, price_micro: "0", update_price_micro: "0" } }));
    expect(free.status).toBe(400);
    const lifetime = await POST(req("/api/listings", { method: "POST", body: { ...railA, price_micro: "9000000", update_price_micro: "0" } }));
    expect(lifetime.status).toBe(201);
    expect((await lifetime.json()).pricing.update_price_micro).toBe("0");
  });

  it("rejects a price between zero and the technical minimum (D2b)", async () => {
    const res = await POST(req("/api/listings", { method: "POST", body: { ...railA, price_micro: "9999" } }));
    expect(res.status).toBe(400);
  });

  it("rejects a price that is not an integer string", async () => {
    for (const price_micro of [9000000, "9.5", "-1", "9_000_000"]) {
      const res = await POST(req("/api/listings", { method: "POST", body: { ...railA, price_micro } }));
      expect(res.status).toBe(400);
    }
  });

  it("writes a listing_created event (§10)", async () => {
    await POST(req("/api/listings", { method: "POST", body: railA }));
    const events = mock.rows("event");
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("listing_created");
    expect(events[0].listing_id).toBe(mock.rows("listing")[0].id);
    // FR-61: an agent key created this one, and the event says so.
    expect(events[0].props).toMatchObject({ slug: "humanizer", key_kind: "agent" });
  });
});

describe("POST /api/listings — auth", () => {
  it("401s without a key", async () => {
    const res = await POST(req("/api/listings", { method: "POST", body: railA, key: null }));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("invalid_key");
  });

  it("401s on a key that is not ours", async () => {
    const res = await POST(req("/api/listings", { method: "POST", body: railA, key: `x4c_live_${"z".repeat(32)}` }));
    expect(res.status).toBe(401);
  });

  it("403s a key without listings:write (FR-4)", async () => {
    mock.rows("api_key")[0].scopes = ["earnings:read"];
    const res = await POST(req("/api/listings", { method: "POST", body: railA }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("insufficient_scope");
  });
});

describe("GET /api/listings", () => {
  it("returns only this creator's listings, newest first", async () => {
    const other = seedCreator(mock, { handle: "someone" }, OTHER_API_KEY);
    seedListing(mock, creator, { slug: "older", created_at: "2026-01-01T00:00:00.000Z" });
    seedListing(mock, creator, { slug: "newer", created_at: "2026-06-01T00:00:00.000Z" });
    seedListing(mock, other, { slug: "not-yours" });

    const res = await GET(req("/api/listings"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.listings.map((l: { slug: string }) => l.slug)).toEqual(["newer", "older"]);
    expect(body.next_cursor).toBeNull();
  });

  it("carries the pricing block and the derived status on every row", async () => {
    seedListing(mock, creator, { slug: "live-one", published_at: new Date().toISOString(), price_micro: "19000000" });

    const [listing] = (await (await GET(req("/api/listings"))).json()).listings;
    expect(listing.status).toBe("live");
    expect(listing.pricing.price_micro).toBe("19000000");
    expect(listing.latest_release).toBeNull();
  });

  it("paginates with an opaque cursor", async () => {
    seedListing(mock, creator, { slug: "one", created_at: "2026-01-01T00:00:00.000Z" });
    seedListing(mock, creator, { slug: "two", created_at: "2026-02-01T00:00:00.000Z" });

    const first = await (await GET(req("/api/listings?limit=1"))).json();
    expect(first.listings).toHaveLength(1);
    expect(first.listings[0].slug).toBe("two");
    expect(first.next_cursor).toBeTruthy();

    const second = await (await GET(req(`/api/listings?limit=1&cursor=${encodeURIComponent(first.next_cursor)}`))).json();
    expect(second.listings[0].slug).toBe("one");
    expect(second.next_cursor).toBeNull();
  });

  it("400s a limit that is not a number rather than letting PostgREST 500", async () => {
    const res = await GET(req("/api/listings?limit=abc"));
    expect(res.status).toBe(400);
    expect((await res.json()).details.field).toBe("limit");
  });

  it("works with an earnings:read-only key: reading your own listings is not a write", async () => {
    mock.rows("api_key")[0].scopes = ["earnings:read"];
    const res = await GET(req("/api/listings"));
    expect(res.status).toBe(200);
  });
});

describe("the route context helper", () => {
  it("resolves params as a promise, as Next 16 requires", async () => {
    await expect(ctx("abc").params).resolves.toEqual({ id: "abc" });
    expect(TEST_API_KEY).toMatch(/^x4c_live_[0-9A-Za-z]{32}$/);
  });
});

// ---------------------------------------------------------------------------
// Open releases (25 Oct 2026, HackMeridian)
// ---------------------------------------------------------------------------

describe("POST /api/listings — creating an open release", () => {
  it("stores the promise on a private Rail A repo that opens into a different public one (H6)", async () => {
    const res = await POST(req("/api/listings", { method: "POST", body: { ...railA, open_release: true, public_repo_url: "https://github.com/adrian/humanizer-public", open_after_days: 30 } }));
    expect(res.status).toBe(201);
    const row = mock.rows("listing")[0];
    expect(row.open_release).toBe(true);
    expect(row.public_repo_url).toBe("https://github.com/adrian/humanizer-public");
    expect(row.open_after_days).toBe(30);
  });

  it("still refuses a public source repo: there is no 'already open' listing (JOURNEYS C2, BATTLE-TEST 21)", async () => {
    github.repoById.mockResolvedValue({ repoId: 777, owner: "adrian", name: "humanizer", private: false, defaultBranch: "main" });
    const res = await POST(req("/api/listings", { method: "POST", body: { ...railA, open_release: true, public_repo_url: "https://github.com/adrian/humanizer-public", open_after_days: 30 } }));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("public_repo");
  });

  it("refuses the repository being sold as the one it opens in", async () => {
    const res = await POST(req("/api/listings", { method: "POST", body: { ...railA, open_release: true, public_repo_url: "https://github.com/adrian/humanizer", open_after_days: 30 } }));
    expect(res.status).toBe(400);
    expect((await res.json()).details.field).toBe("public_repo_url");
    expect(mock.rows("listing")).toHaveLength(0);
  });

  it("refuses an open release missing its days or its repo, or with days out of range, and writes nothing", async () => {
    expect((await POST(req("/api/listings", { method: "POST", body: { ...railA, open_release: true, public_repo_url: "https://github.com/adrian/humanizer-public" } }))).status).toBe(400);
    expect((await POST(req("/api/listings", { method: "POST", body: { ...railA, open_release: true, open_after_days: 30 } }))).status).toBe(400);
    expect((await POST(req("/api/listings", { method: "POST", body: { ...railA, open_release: true, public_repo_url: "https://github.com/adrian/humanizer-public", open_after_days: 91 } }))).status).toBe(400);
    expect(mock.rows("listing")).toHaveLength(0);
  });

  it("rolls back a provisioned hosted repo when the open-release fields are refused", async () => {
    const res = await POST(req("/api/listings", { method: "POST", body: { ...railB, open_release: true, open_after_days: 30 } }));
    expect(res.status).toBe(400);
    expect(hosted.deleteHostedRepo).toHaveBeenCalledTimes(1);
    expect(mock.rows("listing")).toHaveLength(0);
  });
});
