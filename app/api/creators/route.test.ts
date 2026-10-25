import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { issueChallenge } from "@/lib/auth/challenge";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { notifyAdmin } from "@/lib/notify";
import { resetScreeningCache } from "@/lib/screening";
import { makeMockDb } from "@/lib/test/mock-db";
import { POST } from "./route";

vi.mock("@/lib/notify", () => ({ notifyAdmin: vi.fn(async () => ({ delivered: true })) }));

const account = privateKeyToAccount(generatePrivateKey());
let mock: ReturnType<typeof makeMockDb>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  resetScreeningCache();
  // The Idempotency-Key replay seals the API key under this (lib/idempotency.ts).
  process.env.SESSION_SECRET = "test-session-secret-0123456789abcdef";
  resetEnv();
  vi.mocked(notifyAdmin).mockClear();
  // FR-38 screening: an empty list, fetched once, so no test touches the network.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
});

afterEach(() => {
  resetDb();
  vi.unstubAllGlobals();
  resetScreeningCache();
  delete process.env.RAIL_B_INVITE_CODES;
  delete process.env.SESSION_SECRET;
  resetEnv();
});

async function proof(signer = account, address = account.address) {
  const challenge = await issueChallenge(address, "address_proof");
  return { nonce: challenge.nonce, signature: await signer.signMessage({ message: challenge.message }) };
}

function post(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("https://x402git.com/api/creators", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 250) + 1}`, ...headers },
    body: JSON.stringify(body),
  });
}

async function validBody(overrides: Record<string, unknown> = {}) {
  return {
    handle: "a1b2c3",
    payout_address: account.address,
    address_proof: await proof(),
    accepted_terms_version: "2026-09-16",
    ...overrides,
  };
}

describe("POST /api/creators (FR-2)", () => {
  it("registers and returns the api key once, with the fee and holdback", async () => {
    const res = await POST(post(await validBody()));
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.api_key).toMatch(/^x4c_live_[0-9A-Za-z]{32}$/);
    expect(body.platform_fee_bps).toBe(1000);
    expect(body.holdback_days).toBe(7);
    expect(body.handle).toBe("a1b2c3");
    expect(body.payout_address).toBe(account.address);
    expect(body.api_key_scopes).toEqual(["listings:write", "earnings:read"]);
  });

  it("stores only the hash of the key, in its own row, and the address lowercased", async () => {
    const res = await POST(post(await validBody()));
    const { api_key } = await res.json();

    const creator = mock.rows("creator")[0];
    expect(JSON.stringify(creator)).not.toContain(api_key);
    expect(creator.payout_address).toBe(account.address.toLowerCase());
    expect(creator.onboarded_via).toBe("api");
    expect(creator.wallet_mode).toBe("linked");

    // FR-54: one live `agent` row, hash only, no expiry.
    const keys = mock.rows("api_key");
    expect(keys).toHaveLength(1);
    expect(keys[0].creator_id).toBe(creator.id);
    expect(keys[0].kind).toBe("agent");
    expect(keys[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(keys[0].expires_at).toBeNull();
    expect(keys[0].revoked_at).toBeNull();
    expect(JSON.stringify(keys[0])).not.toContain(api_key);
  });

  it("rejects an unproved payout address", async () => {
    const body = await validBody();
    const other = privateKeyToAccount(generatePrivateKey());
    const challenge = await issueChallenge(account.address, "address_proof");
    body.address_proof = { nonce: challenge.nonce, signature: await other.signMessage({ message: challenge.message }) };

    const res = await POST(post(body));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("payout_address_unverified");
    expect(mock.rows("creator")).toHaveLength(0);
  });

  it("rejects a reused challenge: registration is single-use too", async () => {
    const body = await validBody();
    await POST(post(body));
    const res = await POST(post({ ...body, handle: "different" }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("payout_address_unverified");
  });

  it("rejects a stale terms version (FR-6)", async () => {
    const res = await POST(post(await validBody({ accepted_terms_version: "2020-01-01" })));
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.code).toBe("terms_version_stale");
    expect(body.details.current).toBe("2026-09-16");
  });

  it("requires an invite code when codes are configured (D2c)", async () => {
    process.env.RAIL_B_INVITE_CODES = "letmein,alsofine";
    resetEnv();

    const withoutCode = await POST(post(await validBody()));
    expect(withoutCode.status).toBe(403);
    expect((await withoutCode.json()).code).toBe("invite_required");

    const wrongCode = await POST(post(await validBody({ invite_code: "nope" })));
    expect((await wrongCode.json()).code).toBe("invite_required");

    const rightCode = await POST(post(await validBody({ invite_code: "alsofine" })));
    expect(rightCode.status).toBe(201);
  });

  it("does not gate on an invite code when none are configured", async () => {
    expect((await POST(post(await validBody()))).status).toBe(201);
  });

  it("screens the payout address at bind and refuses a sanctioned one (FR-38)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([account.address.toLowerCase()]), { status: 200 })));
    resetScreeningCache();

    const res = await POST(post(await validBody()));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("sanctioned_counterparty");
    expect(mock.rows("creator")).toHaveLength(0);
    expect(mock.rows("screening")[0]).toMatchObject({ context: "bind", hit: true });
  });

  it("replays the identical 201 for a repeated Idempotency-Key (FR-2)", async () => {
    const body = await validBody();
    const first = await POST(post(body, { "idempotency-key": "abc-123" }));
    const firstBody = await first.json();

    const second = await POST(post(body, { "idempotency-key": "abc-123" }));
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual(firstBody);
    expect(second.headers.get("idempotency-replayed")).toBe("true");
    expect(mock.rows("creator")).toHaveLength(1);
  });

  it("never stores the key it replays in the clear (RED-TEAM-2026-09-21.md DB-1)", async () => {
    const res = await POST(post(await validBody(), { "idempotency-key": "abc-123" }));
    const { api_key } = await res.json();

    const stored = JSON.stringify(mock.rows("idempotency"));
    expect(mock.rows("idempotency")).toHaveLength(1);
    expect(stored).not.toContain(api_key);
    expect(mock.rows("idempotency")[0].response).not.toHaveProperty("api_key");
  });

  it("tells the operator a creator joined on the api rail, with no key and no address (ADMIN-NOTIFICATIONS.md)", async () => {
    const res = await POST(post(await validBody()));
    const { creator_id, api_key } = await res.json();

    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(notifyAdmin).toHaveBeenCalledWith({ kind: "creator_joined", via: "api", handle: "a1b2c3", creatorId: creator_id, walletMode: "linked" });
    // FR-40: neither the key that was just minted nor the payout address travels.
    const event = JSON.stringify(vi.mocked(notifyAdmin).mock.calls[0][0]);
    expect(event).not.toContain(api_key);
    expect(event).not.toContain(account.address.toLowerCase());
  });

  it("does not buzz twice for a replayed Idempotency-Key: the registration happened once", async () => {
    const body = await validBody();
    await POST(post(body, { "idempotency-key": "abc-123" }));
    expect(notifyAdmin).toHaveBeenCalledTimes(1);

    await POST(post(body, { "idempotency-key": "abc-123" }));
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
  });

  it("does not notify a registration that never happened", async () => {
    // A stale terms version (FR-6): nothing was written, so there is nothing to announce.
    await POST(post(await validBody({ accepted_terms_version: "2020-01-01" })));
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  it("refuses the same Idempotency-Key with a different body", async () => {
    const body = await validBody();
    await POST(post(body, { "idempotency-key": "abc-123" }));

    const res = await POST(post(await validBody({ handle: "other1" }), { "idempotency-key": "abc-123" }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_request");
  });

  it("rejects a duplicate handle (FR-3)", async () => {
    await POST(post(await validBody()));

    const second = privateKeyToAccount(generatePrivateKey());
    const challenge = await issueChallenge(second.address, "address_proof");
    const res = await POST(
      post({
        handle: "a1b2c3",
        payout_address: second.address,
        address_proof: { nonce: challenge.nonce, signature: await second.signMessage({ message: challenge.message }) },
        accepted_terms_version: "2026-09-16",
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).details).toEqual({ field: "handle" });
  });

  it("rejects a malformed body with the issues in details", async () => {
    const res = await POST(post({ handle: "NOT-A-HANDLE" }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("invalid_request");
    expect(body.details.issues.length).toBeGreaterThan(0);
  });

  it("rate limits registration to 5/hour/IP (§9)", async () => {
    const ip = { "x-forwarded-for": "203.0.113.9" };
    for (let i = 0; i < 5; i++) {
      await POST(post(await validBody({ handle: `handle-${i}` }), ip));
    }
    const res = await POST(post(await validBody({ handle: "handle-x" }), ip));
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe("rate_limited");
  });
});
