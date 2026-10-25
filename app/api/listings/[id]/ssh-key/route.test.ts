import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { issueChallenge } from "@/lib/auth/challenge";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { makeMockDb } from "@/lib/test/mock-db";
import { ctx, OTHER_API_KEY, req, seedCreator, seedListing } from "@/lib/test/listings-fixtures";

const hosted = vi.hoisted(() => ({ rotateDeployKey: vi.fn() }));
vi.mock("@/lib/github/hosted", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github/hosted")>()),
  ...hosted,
}));
vi.mock("@/lib/github/installations", () => ({ installationAccount: vi.fn(), resolveRepo: vi.fn(), repoById: vi.fn() }));
vi.mock("@/lib/release", () => ({ cutRelease: vi.fn() }));

const { PUT } = await import("./route");

const account = privateKeyToAccount(generatePrivateKey());
const NEW_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRotated agent@x402git";

let mock: ReturnType<typeof makeMockDb>;
let creator: Record<string, any>;
let listing: Record<string, any>;

/** A fresh, single-use signature from the bound payout address (FR-5, FR-20). */
async function stepUp() {
  const challenge = await issueChallenge(account.address, "step_up");
  return { nonce: challenge.nonce, signature: await account.signMessage({ message: challenge.message }) };
}

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  creator = seedCreator(mock, { payout_address: account.address.toLowerCase() });
  listing = seedListing(mock, creator, { slug: "humanizer", source: "hosted", hosted_org: "x402git-hosted-01", github_repo_id: "987654", deploy_key_id: "5150" });
  hosted.rotateDeployKey.mockResolvedValue(6200);
});

afterEach(() => {
  resetDb();
  vi.clearAllMocks();
  resetEnv();
});

describe("PUT /api/listings/:id/ssh-key (FR-7, FR-5, §14.6)", () => {
  it("rotates the key and stores the new id", async () => {
    const res = await PUT(req("/x", { method: "PUT", body: { ssh_public_key: NEW_KEY, step_up: await stepUp() } }), ctx(listing.id));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.deploy_key_id).toBe(6200);
    expect(body.fingerprint).toMatch(/^SHA256:/);

    expect(hosted.rotateDeployKey).toHaveBeenCalledWith({ owner: "x402git-hosted-01", repo: "a1b2c3--humanizer" }, "5150", NEW_KEY);
    expect(String(mock.rows("listing")[0].deploy_key_id)).toBe("6200");
  });

  it("requires step-up: a bearer key alone cannot swap the write credential (§14.7)", async () => {
    const res = await PUT(req("/x", { method: "PUT", body: { ssh_public_key: NEW_KEY } }), ctx(listing.id));
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.code).toBe("step_up_required");
    // The 403 tells the agent exactly how to satisfy it.
    expect(body.details.sign_with.toLowerCase()).toBe(account.address.toLowerCase());
    expect(body.details.how).toMatch(/\/api\/auth\/challenge/);
    expect(hosted.rotateDeployKey).not.toHaveBeenCalled();
  });

  it("rejects a step-up signed by some other wallet", async () => {
    const impostor = privateKeyToAccount(generatePrivateKey());
    const challenge = await issueChallenge(account.address, "step_up");
    const signature = await impostor.signMessage({ message: challenge.message });

    const res = await PUT(req("/x", { method: "PUT", body: { ssh_public_key: NEW_KEY, step_up: { nonce: challenge.nonce, signature } } }), ctx(listing.id));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("step_up_required");
    expect(hosted.rotateDeployKey).not.toHaveBeenCalled();
  });

  it("burns the nonce: the same signature cannot rotate the key twice", async () => {
    const proof = await stepUp();
    expect((await PUT(req("/x", { method: "PUT", body: { ssh_public_key: NEW_KEY, step_up: proof } }), ctx(listing.id))).status).toBe(200);

    const replay = await PUT(req("/x", { method: "PUT", body: { ssh_public_key: NEW_KEY, step_up: proof } }), ctx(listing.id));
    expect(replay.status).toBe(403);
  });

  it("checks ownership before step-up, so a wrong id does not burn a nonce", async () => {
    const other = seedCreator(mock, { handle: "someone" }, OTHER_API_KEY);
    const theirs = seedListing(mock, other, { slug: "not-yours", source: "hosted", hosted_org: "x402git-hosted-01", github_repo_id: "3" });
    const proof = await stepUp();

    const res = await PUT(req("/x", { method: "PUT", body: { ssh_public_key: NEW_KEY, step_up: proof } }), ctx(theirs.id));
    expect(res.status).toBe(404);
    expect(mock.rows("challenge")[0].used_at).toBeNull();

    // …and the same nonce still works on a listing that is actually yours.
    const retry = await PUT(req("/x", { method: "PUT", body: { ssh_public_key: NEW_KEY, step_up: proof } }), ctx(listing.id));
    expect(retry.status).toBe(200);
  });

  it("refuses a Rail A listing: deploy keys exist on hosted repos only", async () => {
    const railA = seedListing(mock, creator, { slug: "own-repo", source: "github" });

    const res = await PUT(req("/x", { method: "PUT", body: { ssh_public_key: NEW_KEY, step_up: await stepUp() } }), ctx(railA.id));
    expect(res.status).toBe(400);
    expect(hosted.rotateDeployKey).not.toHaveBeenCalled();
  });

  it("410s a retired listing", async () => {
    const gone = seedListing(mock, creator, { slug: "gone", source: "hosted", hosted_org: "x402git-hosted-01", github_repo_id: "4", retired_at: new Date().toISOString() });

    const res = await PUT(req("/x", { method: "PUT", body: { ssh_public_key: NEW_KEY, step_up: await stepUp() } }), ctx(gone.id));
    expect(res.status).toBe(410);
  });
});
