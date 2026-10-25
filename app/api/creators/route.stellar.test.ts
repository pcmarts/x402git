/** Headless registration with a Stellar identity (BUILD H5): SEP-53 proof, trustline gate, both Stellar columns written. */

import { Keypair } from "@stellar/stellar-sdk";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueChallenge } from "@/lib/auth/challenge";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv, stellarRail } from "@/lib/env";
import { notifyAdmin } from "@/lib/notify";
import { resetScreeningCache } from "@/lib/screening";
import { makeMockDb } from "@/lib/test/mock-db";
import { clearStellarEnv, setStellarTestnetEnv } from "@/lib/test/stellar";
import { POST } from "./route";

vi.mock("@/lib/notify", () => ({ notifyAdmin: vi.fn(async () => ({ delivered: true })) }));

const stellar = Keypair.random();
const G = stellar.publicKey();
let mock: ReturnType<typeof makeMockDb>;
let horizon: { status: number; body: unknown };

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  resetScreeningCache();
  process.env.SESSION_SECRET = "test-session-secret-0123456789abcdef";
  setStellarTestnetEnv();
  resetEnv();
  vi.mocked(notifyAdmin).mockClear();
  horizon = { status: 200, body: { balances: [{ asset_type: "native", balance: "10.0000000" }] } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/accounts/")) return new Response(JSON.stringify(horizon.body), { status: horizon.status, headers: { "content-type": "application/json" } });
      return new Response("[]", { status: 200 });
    }),
  );
});

afterEach(() => {
  resetDb();
  vi.unstubAllGlobals();
  resetScreeningCache();
  delete process.env.SESSION_SECRET;
  clearStellarEnv();
  resetEnv();
});

function withTrustline() {
  const asset = stellarRail()!.asset;
  horizon = { status: 200, body: { balances: [{ asset_type: "native", balance: "10" }, { asset_type: "credit_alphanum4", asset_code: asset.code, asset_issuer: asset.issuer, is_authorized: true, balance: "0" }] } };
}

async function body(signer = stellar) {
  const challenge = await issueChallenge(G, "address_proof");
  return {
    handle: "orbit",
    payout_address: G,
    address_proof: { nonce: challenge.nonce, signature: signer.signMessage(challenge.message).toString("base64") },
    accepted_terms_version: "2026-09-16",
  };
}

function post(payload: unknown): NextRequest {
  return new NextRequest("https://x402git.com/api/creators", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.42" },
    body: JSON.stringify(payload),
  });
}

describe("POST /api/creators with a Stellar account", () => {
  it("registers with the G… as identity and Stellar payout address when the trustline exists", async () => {
    withTrustline();
    const res = await POST(post(await body()));
    expect(res.status).toBe(201);
    const out = await res.json();
    expect(out.payout_address).toBe(G);
    expect(out.api_key).toMatch(/^x4c_live_/);
    const creator = mock.rows("creator")[0];
    expect(creator).toMatchObject({ payout_address: G, stellar_payout_address: G });
    expect(creator.stellar_payout_meta).toMatchObject({ trustline: { authorized: true } });
  });

  it("is invalid_request no_trustline without the trustline, spends no nonce and writes nothing", async () => {
    const res = await POST(post(await body()));
    expect(res.status).toBe(400);
    const out = await res.json();
    expect(out.code).toBe("invalid_request");
    expect(out.details).toMatchObject({ reason: "no_trustline" });
    expect(mock.rows("creator")).toHaveLength(0);
    expect(mock.rows("challenge")[0].used_at).toBeNull();
  });

  it("is payout_address_unverified for a proof from another key", async () => {
    withTrustline();
    const res = await POST(post(await body(Keypair.random())));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("payout_address_unverified");
    expect(mock.rows("creator")).toHaveLength(0);
  });
});
