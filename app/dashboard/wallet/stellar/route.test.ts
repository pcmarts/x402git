/**
 * POST /dashboard/wallet/stellar, end to end through PATCH /api/creators/me with the
 * session's own key (D9, D14).
 *
 * 25 Oct 2026, ~21:30 (HackMeridian; the founder: "Do we need to have the stellar wallet
 * confirm? Feels needless."): adding a Stellar wallet to an account with none is
 * Freighter's proof alone, and the form sends nothing else. Changing one keeps the
 * sign-off from the wallet bound now and type-to-confirm, and this route says so before
 * any nonce is spent.
 */

import { Keypair } from "@stellar/stellar-sdk";
import { NextRequest } from "next/server";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH } from "@/app/api/creators/me/route";
import { generateApiKey } from "@/lib/auth/api-key";
import { issueChallenge } from "@/lib/auth/challenge";
import { rebindContext } from "@/lib/auth/step-up";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv, stellarRail } from "@/lib/env";
import { resetScreeningCache } from "@/lib/screening";
import { makeMockDb } from "@/lib/test/mock-db";
import { clearStellarEnv, setStellarTestnetEnv } from "@/lib/test/stellar";
import { SESSION_COOKIE, SESSION_TTL_SEC, newSession, sealSession } from "@/lib/web/session";
import { POST } from "./route";

const evm = privateKeyToAccount(generatePrivateKey());
const stellar = Keypair.random();
const G = stellar.publicKey();
const CURRENT = Keypair.random().publicKey();
const CREATOR_ID = "11111111-1111-4111-8111-111111111111";
const API = "https://x402git.com/api/creators/me";

let mock: ReturnType<typeof makeMockDb>;
let cookie: string;
/** The JSON bodies the route sent to PATCH /api/creators/me, in order. */
let patched: Record<string, unknown>[];

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = "https://x402git.com";
  process.env.SESSION_SECRET = "test-session-secret";
  setStellarTestnetEnv();
  resetEnv();
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  resetScreeningCache();
  patched = [];

  const asset = stellarRail()!.asset;
  const trustline = { balances: [{ asset_type: "native", balance: "10" }, { asset_type: "credit_alphanum4", asset_code: asset.code, asset_issuer: asset.issuer, is_authorized: true, balance: "0" }] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === API) {
        patched.push(JSON.parse(String(init?.body)));
        return PATCH(new NextRequest(url, init as ConstructorParameters<typeof NextRequest>[1]));
      }
      if (url.includes("/accounts/")) return new Response(JSON.stringify(trustline), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("[]", { status: 200 });
    }),
  );

  const session = generateApiKey("session");
  mock.seed("api_key", [
    { id: "bbbbbbbb-1111-4111-8111-111111111111", creator_id: CREATOR_ID, kind: "session", hash: session.hash, expires_at: new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString() },
  ]);
  cookie = `${SESSION_COOKIE}=${encodeURIComponent(sealSession(newSession({ github: { id: 4242, login: "adrian" }, creatorId: CREATOR_ID, handle: "adrian", apiKey: session.key })))}`;
});

afterEach(() => {
  resetDb();
  vi.unstubAllGlobals();
  resetScreeningCache();
  for (const k of ["NEXT_PUBLIC_APP_URL", "SESSION_SECRET"]) delete process.env[k];
  clearStellarEnv();
  resetEnv();
});

function seedCreator(over: Record<string, unknown> = {}) {
  mock.seed("creator", [{ id: CREATOR_ID, handle: "adrian", payout_address: evm.address.toLowerCase(), onboarded_via: "web", terms_version: "2026-08-29", ...over }]);
}

async function proof() {
  const challenge = await issueChallenge(G, "address_proof");
  return { proof_nonce: challenge.nonce, proof_signature: stellar.signMessage(challenge.message).toString("base64") };
}

function post(fields: Record<string, string>): Promise<Response> {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  return POST(new Request("https://x402git.com/dashboard/wallet/stellar", { method: "POST", body: form, headers: { cookie } }));
}

function outcome(res: Response): { ok: string | null; error: string | null } {
  const url = new URL(res.headers.get("location") ?? "");
  return { ok: url.searchParams.get("ok"), error: url.searchParams.get("error") };
}

describe("POST /dashboard/wallet/stellar — adding is Freighter's proof alone (25 Oct 2026)", () => {
  it("adds a Stellar wallet to an EVM account from one signature, and sends nothing else", async () => {
    seedCreator();
    const res = await post({ stellar_address: G, ...(await proof()) });
    expect(res.status).toBe(303);
    expect(outcome(res).ok).toMatch(/Stellar wallet added/);
    expect(Object.keys(patched[0]).sort()).toEqual(["stellar_payout_address", "stellar_proof"]);
    expect(mock.rows("creator")[0].stellar_payout_address).toBe(G);
  });

  it("sends a change without the sign-off back before the API is called or a nonce spent", async () => {
    seedCreator({ stellar_payout_address: CURRENT });
    const res = await post({ stellar_address: G, ...(await proof()), confirm_address: G.slice(-6) });
    expect(outcome(res).error).toMatch(/Sign with the wallet bound now/);
    expect(patched).toHaveLength(0);
    expect(mock.rows("challenge").every((c) => (c.used_at ?? null) === null)).toBe(true);
  });

  it("sends a change without the six characters back too", async () => {
    seedCreator({ stellar_payout_address: CURRENT });
    const res = await post({ stellar_address: G, ...(await proof()), step_up_nonce: "n", step_up_signature: "s" });
    expect(outcome(res).error).toMatch(/last six characters/);
    expect(patched).toHaveLength(0);
  });

  it("queues a change for 48 hours with the sign-off from the EVM wallet and the six characters", async () => {
    seedCreator({ stellar_payout_address: CURRENT });
    const stepUp = await issueChallenge(evm.address, "step_up", rebindContext(G));
    const res = await post({
      stellar_address: G,
      ...(await proof()),
      step_up_nonce: stepUp.nonce,
      step_up_signature: await evm.signMessage({ message: stepUp.message }),
      confirm_address: G.slice(-6),
    });
    expect(outcome(res).ok).toMatch(/Change queued/);
    expect(mock.rows("creator")[0]).toMatchObject({ stellar_payout_address: CURRENT, pending_stellar_payout_address: G });
  });
});
