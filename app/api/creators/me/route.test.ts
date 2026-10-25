import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { generateApiKey } from "@/lib/auth/api-key";
import { issueChallenge } from "@/lib/auth/challenge";
import { rebindContext } from "@/lib/auth/step-up";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetScreeningCache } from "@/lib/screening";
import { makeMockDb } from "@/lib/test/mock-db";
import { GET, PATCH } from "./route";

const account = privateKeyToAccount(generatePrivateKey());
const next = privateKeyToAccount(generatePrivateKey());

let mock: ReturnType<typeof makeMockDb>;
let apiKey: string;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  resetScreeningCache();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));

  const generated = generateApiKey("agent");
  apiKey = generated.key;
  mock.seed("creator", [
    {
      id: "11111111-1111-4111-8111-111111111111",
      handle: "adrian",
      payout_address: account.address.toLowerCase(),
      onboarded_via: "api",
      terms_version: "2026-08-29",
      abuse_contact_url: "https://old.example.com/abuse",
    },
  ]);
  // FR-54: the key is its own row, and its scopes are what the profile reports.
  mock.seed("api_key", [{ id: "aaaaaaaa-1111-4111-8111-111111111111", creator_id: "11111111-1111-4111-8111-111111111111", kind: "agent", hash: generated.hash }]);
});

afterEach(() => {
  resetDb();
  vi.unstubAllGlobals();
  resetScreeningCache();
});

async function stepUp(signer = account, address = account.address, context: string | null = null) {
  const challenge = await issueChallenge(address, "step_up", context);
  return { nonce: challenge.nonce, signature: await signer.signMessage({ message: challenge.message }) };
}

/** A rebind step-up: the challenge names the incoming address (FR-5). */
async function rebindStepUp(to: string, signer = account) {
  return stepUp(signer, account.address, rebindContext(to));
}

function request(method: string, body?: unknown, key = apiKey): NextRequest {
  return new NextRequest("https://x402git.com/api/creators/me", {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("GET /api/creators/me", () => {
  it("returns the profile without the api key", async () => {
    const res = await GET(request("GET"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.handle).toBe("adrian");
    expect(body.payout_address).toBe(account.address); // checksummed on the way out
    expect(body.platform_fee_bps).toBe(1000);
    expect(body.holdback_days).toBe(7);
    expect(JSON.stringify(body)).not.toContain(apiKey);
    expect(body.api_key).toBeUndefined();
  });

  it("is invalid_key without a bearer token", async () => {
    const res = await GET(new NextRequest("https://x402git.com/api/creators/me"));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("invalid_key");
  });
});

describe("PATCH /api/creators/me (FR-5)", () => {
  it("queues a payout address change for 48 hours instead of applying it", async () => {
    const before = Date.now();
    const res = await PATCH(request("PATCH", { payout_address: next.address, step_up: await rebindStepUp(next.address) }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.payout_address).toBe(account.address); // unchanged: sweeps keep going here
    expect(body.pending_payout_address).toBe(next.address);

    const delay = new Date(body.rebind_effective_at).getTime() - before;
    expect(delay).toBeGreaterThan(47 * 3600 * 1000);
    expect(delay).toBeLessThanOrEqual(48 * 3600 * 1000 + 5000);
  });

  it("refuses without a step-up signature", async () => {
    const res = await PATCH(request("PATCH", { payout_address: next.address }));
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.code).toBe("step_up_required");
    expect(body.details.sign_with).toBeTruthy();
    expect(mock.rows("creator")[0].pending_payout_address).toBeNull();
  });

  it("refuses a rebind whose challenge does not name the new address", async () => {
    // A generic step-up — phished for anything — must not be spendable as a rebind.
    const res = await PATCH(request("PATCH", { payout_address: next.address, step_up: await stepUp() }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("step_up_required");
    expect(mock.rows("creator")[0].pending_payout_address).toBeNull();
  });

  it("refuses a rebind challenge bound to a different incoming address", async () => {
    const other = privateKeyToAccount(generatePrivateKey());
    const res = await PATCH(request("PATCH", { payout_address: next.address, step_up: await rebindStepUp(other.address) }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("step_up_required");
    expect(mock.rows("creator")[0].pending_payout_address).toBeNull();
  });

  it("refuses a step-up signed by the new address rather than the bound one", async () => {
    const challenge = await issueChallenge(account.address, "step_up", rebindContext(next.address));
    const signature = await next.signMessage({ message: challenge.message });

    const res = await PATCH(request("PATCH", { payout_address: next.address, step_up: { nonce: challenge.nonce, signature } }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("step_up_required");
  });

  it("screens the incoming payout address before queueing it (FR-38)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([next.address.toLowerCase()]), { status: 200 })));
    resetScreeningCache();

    const res = await PATCH(request("PATCH", { payout_address: next.address, step_up: await rebindStepUp(next.address) }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("sanctioned_counterparty");
    expect(mock.rows("creator")[0].pending_payout_address).toBeNull();
  });

  it("queues an abuse-contact change for 48 hours, leaving the old contact live", async () => {
    const res = await PATCH(request("PATCH", { abuse_contact_url: "https://new.example.com/abuse", step_up: await stepUp() }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.abuse_contact_url).toBe("https://old.example.com/abuse");
    expect(body.pending_abuse_contact_url).toBe("https://new.example.com/abuse");
    expect(body.effective_at).toBeTruthy();
  });

  it("rejects an empty patch", async () => {
    const res = await PATCH(request("PATCH", { step_up: await stepUp() }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_request");
  });

  it("rejects rebinding to the address already bound", async () => {
    const res = await PATCH(request("PATCH", { payout_address: account.address, step_up: await rebindStepUp(account.address) }));
    expect(res.status).toBe(400);
  });

  it("is invalid_key before it is step_up_required", async () => {
    const res = await PATCH(request("PATCH", { payout_address: next.address }, "x4c_live_00000000000000000000000000000000"));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("invalid_key");
  });
});
