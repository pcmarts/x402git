import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { generateApiKey, hashApiKey } from "@/lib/auth/api-key";
import { issueChallenge } from "@/lib/auth/challenge";
import { type Db, resetDb, setDb } from "@/lib/db";
import { makeMockDb } from "@/lib/test/mock-db";
import { GET } from "../challenge/route";
import { POST } from "./route";

const account = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());

const ADRIAN = "22222222-2222-4222-8222-222222222222";
const BLAIR = "33333333-3333-4333-8333-333333333333";

let mock: ReturnType<typeof makeMockDb>;
let oldHash: string;

/** The live agent row for a creator, or undefined once it has been rotated away. */
function liveAgent(creatorId: string) {
  return mock.rows("api_key").find((r) => r.creator_id === creatorId && r.kind === "agent" && r.revoked_at === null);
}

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  oldHash = generateApiKey("agent").hash;
  mock.seed("creator", [
    {
      id: ADRIAN,
      handle: "adrian",
      payout_address: account.address.toLowerCase(),
      onboarded_via: "api",
      terms_version: "2026-08-29",
    },
  ]);
  // FR-54: the key lives in `api_key`. A session row alongside it proves FR-58.
  mock.seed("api_key", [
    { id: "aaaaaaaa-0000-4000-8000-000000000001", creator_id: ADRIAN, kind: "agent", hash: oldHash, scopes: ["listings:write"] },
    {
      id: "aaaaaaaa-0000-4000-8000-000000000002",
      creator_id: ADRIAN,
      kind: "session",
      hash: generateApiKey("session").hash,
      scopes: ["listings:write"],
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    },
  ]);
});
afterEach(() => resetDb());

async function signed(signer = account, address = account.address, handle = "adrian") {
  const challenge = await issueChallenge(address, "rotate_key");
  return { handle, address, nonce: challenge.nonce, signature: await signer.signMessage({ message: challenge.message }) };
}

function post(body: unknown, ip?: string): NextRequest {
  return new NextRequest("https://x402git.com/api/auth/rotate-key", {
    method: "POST",
    headers: { "content-type": "application/json", ...(ip ? { "x-real-ip": ip } : {}) },
    body: JSON.stringify(body),
  });
}

function mint(address: string, purpose: string, ip: string): NextRequest {
  return new NextRequest(`https://x402git.com/api/auth/challenge?address=${address}&purpose=${purpose}`, { headers: { "x-real-ip": ip } });
}

describe("POST /api/auth/rotate-key (FR-4)", () => {
  it("issues a new key on a valid signature, with no bearer token at all", async () => {
    const res = await POST(post(await signed()));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.api_key).toMatch(/^x4c_live_[0-9A-Za-z]{32}$/);
    expect(body.handle).toBe("adrian");
    expect(body.api_key_scopes).toEqual(["listings:write"]);
  });

  it("revokes the old key immediately, leaving exactly one live agent row", async () => {
    const res = await POST(post(await signed()));
    const { api_key } = await res.json();

    const live = liveAgent(ADRIAN);
    expect(live?.hash).toBe(hashApiKey(api_key));

    const old = mock.rows("api_key").find((r) => r.hash === oldHash);
    expect(old?.revoked_at).toBeTruthy();
    expect(old?.revoked_reason).toBe("rotated");
    expect(mock.rows("api_key").filter((r) => r.creator_id === ADRIAN && r.kind === "agent" && r.revoked_at === null)).toHaveLength(1);
  });

  it("does not touch the creator's session keys (FR-58: rotation is not a sign-out)", async () => {
    const before = mock.rows("api_key").filter((r) => r.kind === "session").map((r) => ({ ...r }));

    await POST(post(await signed()));

    const after = mock.rows("api_key").filter((r) => r.kind === "session");
    expect(after).toEqual(before);
    expect(after.every((r) => r.revoked_at === null)).toBe(true);
  });

  it("refuses a signature from an address that is not the bound one", async () => {
    const challenge = await issueChallenge(account.address, "rotate_key");
    const signature = await stranger.signMessage({ message: challenge.message });

    const res = await POST(post({ handle: "adrian", address: account.address, nonce: challenge.nonce, signature }));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("invalid_signature");
    expect(liveAgent(ADRIAN)?.hash).toBe(oldHash);
  });

  it("refuses a replayed challenge", async () => {
    const body = await signed();
    await POST(post(body));
    const res = await POST(post(body));
    expect(res.status).toBe(401);
  });

  it("verifies the signature before it looks the address up, so it is not an oracle", async () => {
    const unknown = await signed(stranger, stranger.address);
    const res = await POST(post(unknown));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("not_found");
  });

  it("rejects a malformed body", async () => {
    const res = await POST(post({ address: "0x1", nonce: "x", signature: "y" }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_request");
  });

  it("is unambiguous even when another creator shares the payout address (W2.5)", async () => {
    // A second creator, different handle, same bound address (allowed — W3.8).
    const secondHash = generateApiKey("agent").hash;
    mock.rows("creator").push({
      id: BLAIR,
      handle: "blair",
      payout_address: account.address.toLowerCase(),
      onboarded_via: "api",
      terms_version: "2026-08-29",
    });
    mock.rows("api_key").push({
      id: "aaaaaaaa-0000-4000-8000-000000000003",
      creator_id: BLAIR,
      kind: "agent",
      hash: secondHash,
      scopes: ["listings:write"],
      created_at: new Date().toISOString(),
      expires_at: null,
      revoked_at: null,
      revoked_reason: null,
      last_used_at: null,
    });

    const res = await POST(post(await signed(account, account.address, "blair")));
    expect(res.status).toBe(200);
    expect((await res.json()).handle).toBe("blair");

    // Only blair's key rotated; adrian's is untouched.
    expect(liveAgent(ADRIAN)?.hash).toBe(oldHash);
    expect(liveAgent(BLAIR)?.hash).not.toBe(secondHash);
  });
});

describe("POST /api/auth/rotate-key — nobody can lock a creator out (PAY-12)", () => {
  const ATTACKER = "198.51.100.21";
  const CREATOR = "203.0.113.77";

  it("still rotates after a stranger has used up the challenge quota for the creator's address", async () => {
    // The attack in RED-TEAM-2026-09-21.md: mint challenges naming the creator's address
    // until the shared bucket is empty. Neither the creator's own IP nor the rotate_key
    // bucket is spent by it.
    for (let i = 0; i < 31; i++) await GET(mint(account.address, "address_proof", ATTACKER));
    expect((await GET(mint(account.address, "address_proof", ATTACKER))).status).toBe(429);

    const minted = await GET(mint(account.address, "rotate_key", CREATOR));
    expect(minted.status).toBe(200);
    const { nonce, message } = await minted.json();
    const signature = await account.signMessage({ message });

    const res = await POST(post({ handle: "adrian", address: account.address, nonce, signature }, CREATOR));
    expect(res.status).toBe(200);
    expect(liveAgent(ADRIAN)?.hash).not.toBe(oldHash);
  });

  it("still rotates from the same IP once ordinary challenge minting is spent, because rotate_key has its own bucket", async () => {
    for (let i = 0; i < 31; i++) await GET(mint(account.address, "wallet_ownership", CREATOR));
    expect((await GET(mint(account.address, "wallet_ownership", CREATOR))).status).toBe(429);

    const res = await POST(post(await signed(), CREATOR));
    expect(res.status).toBe(200);
  });

  it("is itself limited per (IP, address), and only for the IP that spent it", async () => {
    const bogus = (i: number | string) => ({ handle: "adrian", address: account.address, nonce: `not-a-real-nonce-${i}`, signature: "0xabcd" });
    for (let i = 0; i < 30; i++) expect((await POST(post(bogus(i), ATTACKER))).status).toBe(401);
    expect((await POST(post(bogus("x"), ATTACKER))).status).toBe(429);

    expect((await POST(post(await signed(), CREATOR))).status).toBe(200);
  });
});
