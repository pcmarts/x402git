import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { issueChallenge } from "@/lib/auth/challenge";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { makeMockDb } from "@/lib/test/mock-db";
import { ctx, OTHER_API_KEY, req, seedCreator, seedListing, seedPurchase, seedRelease } from "@/lib/test/listings-fixtures";

const hosted = vi.hoisted(() => ({ deleteHostedRepo: vi.fn(async () => undefined) }));
vi.mock("@/lib/github/hosted", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github/hosted")>()),
  ...hosted,
}));
vi.mock("@/lib/github/installations", () => ({ installationAccount: vi.fn(), resolveRepo: vi.fn(), repoById: vi.fn() }));
vi.mock("@/lib/release", () => ({ cutRelease: vi.fn() }));

const { DELETE } = await import("./route");

const account = privateKeyToAccount(generatePrivateKey());

let mock: ReturnType<typeof makeMockDb>;
let creator: Record<string, any>;
let listing: Record<string, any>;

async function stepUp() {
  const challenge = await issueChallenge(account.address, "step_up");
  return { nonce: challenge.nonce, signature: await account.signMessage({ message: challenge.message }) };
}

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  creator = seedCreator(mock, { payout_address: account.address.toLowerCase() });
  listing = seedListing(mock, creator, { slug: "humanizer", source: "hosted", hosted_org: "x402git-hosted-01", github_repo_id: "987654", deploy_key_id: "5150" });
});

afterEach(() => {
  resetDb();
  vi.clearAllMocks();
  resetEnv();
});

describe("DELETE /api/listings/:id/repo (FR-44)", () => {
  it("deletes the repo and its deploy key", async () => {
    const res = await DELETE(req("/x", { method: "DELETE", body: { step_up: await stepUp() } }), ctx(listing.id));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.repo_deleted).toBe(true);
    expect(hosted.deleteHostedRepo).toHaveBeenCalledWith({ owner: "x402git-hosted-01", repo: "a1b2c3--humanizer" }, "5150");

    const row = mock.rows("listing")[0];
    expect(row.github_repo_id).toBeNull();
    expect(row.deploy_key_id).toBeNull();
    expect(row.hosted_org).toBeNull();
  });

  it("retains a release somebody bought and deletes one nobody did (FR-46)", async () => {
    const sold = seedRelease(mock, listing, { version: "1.0.0", storage_path: "a1b2c3/humanizer/1.0.0.zip" });
    const unsold = seedRelease(mock, listing, { version: "1.1.0", storage_path: "a1b2c3/humanizer/1.1.0.zip" });
    seedPurchase(mock, listing, sold);

    const res = await DELETE(req("/x", { method: "DELETE", body: { step_up: await stepUp() } }), ctx(listing.id));
    const body = await res.json();

    expect(body.releases_retained).toBe(1);
    expect(body.releases_deleted).toBe(1);

    const remaining = mock.rows("release").map((r) => r.id);
    expect(remaining).toContain(sold.id);
    expect(remaining).not.toContain(unsold.id);
  });

  it("keeps every release once one purchase is stamped all_versions (FR-16, FR-46)", async () => {
    // A $0-update purchase is lifetime, irrevocably, and §12's access check grants that
    // holder release N for every N. Deleting the versions they never bought a row for
    // would take versions they own — the one thing FR-46 forbids.
    const bought = seedRelease(mock, listing, { version: "1.0.0" });
    const later = seedRelease(mock, listing, { version: "1.1.0" });
    const laterStill = seedRelease(mock, listing, { version: "1.2.0" });
    seedPurchase(mock, listing, bought, { all_versions: true });

    const res = await DELETE(req("/x", { method: "DELETE", body: { step_up: await stepUp() } }), ctx(listing.id));
    const body = await res.json();

    expect(body.releases_retained).toBe(3);
    expect(body.releases_deleted).toBe(0);
    expect(mock.rows("release").map((r) => r.id)).toEqual(expect.arrayContaining([bought.id, later.id, laterStill.id]));
  });

  it("keeps a bought release even when the listing is retired: the buyer still owns it", async () => {
    const retired = seedListing(mock, creator, {
      slug: "gone",
      source: "hosted",
      hosted_org: "x402git-hosted-01",
      github_repo_id: "5",
      published_at: "2026-01-01T00:00:00.000Z",
      retired_at: "2026-02-01T00:00:00.000Z",
    });
    const sold = seedRelease(mock, retired, { version: "2.0.0" });
    seedPurchase(mock, retired, sold);

    const res = await DELETE(req("/x", { method: "DELETE", body: { step_up: await stepUp() } }), ctx(retired.id));
    expect(res.status).toBe(200);
    expect((await res.json()).releases_retained).toBe(1);
    expect(mock.rows("release").map((r) => r.id)).toContain(sold.id);
  });

  it("requires step-up (FR-5)", async () => {
    const res = await DELETE(req("/x", { method: "DELETE", body: {} }), ctx(listing.id));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("step_up_required");
    expect(hosted.deleteHostedRepo).not.toHaveBeenCalled();
  });

  it("rejects a signature from a wallet that is not the bound payout address", async () => {
    const impostor = privateKeyToAccount(generatePrivateKey());
    const challenge = await issueChallenge(account.address, "step_up");
    const signature = await impostor.signMessage({ message: challenge.message });

    const res = await DELETE(req("/x", { method: "DELETE", body: { step_up: { nonce: challenge.nonce, signature } } }), ctx(listing.id));
    expect(res.status).toBe(403);
    expect(hosted.deleteHostedRepo).not.toHaveBeenCalled();
    expect(mock.rows("listing")[0].github_repo_id).toBe("987654");
  });

  it("refuses a Rail A listing: that repository is not ours to delete", async () => {
    const railA = seedListing(mock, creator, { slug: "own-repo", source: "github" });

    const res = await DELETE(req("/x", { method: "DELETE", body: { step_up: await stepUp() } }), ctx(railA.id));
    expect(res.status).toBe(400);
    expect(hosted.deleteHostedRepo).not.toHaveBeenCalled();
  });

  it("404s someone else's listing without burning the nonce", async () => {
    const other = seedCreator(mock, { handle: "someone" }, OTHER_API_KEY);
    const theirs = seedListing(mock, other, { slug: "not-yours", source: "hosted", hosted_org: "x402git-hosted-01", github_repo_id: "6" });

    const res = await DELETE(req("/x", { method: "DELETE", body: { step_up: await stepUp() } }), ctx(theirs.id));
    expect(res.status).toBe(404);
    expect(mock.rows("challenge")[0].used_at).toBeNull();
    expect(hosted.deleteHostedRepo).not.toHaveBeenCalled();
  });

  it("records the outcome as an event", async () => {
    seedRelease(mock, listing);
    await DELETE(req("/x", { method: "DELETE", body: { step_up: await stepUp() } }), ctx(listing.id));

    const event = mock.rows("event").find((e) => e.name === "listing_repo_deleted");
    expect(event).toBeDefined();
    // FR-61: `key_kind` rides in the same props blob every mutation event carries.
    expect(event?.props).toEqual({ releases_deleted: 1, releases_retained: 0, key_kind: "agent" });
  });
});
