/**
 * POST /dashboard/wallet/evm, end to end through PATCH /api/creators/me with the
 * session's own key (D9, D14).
 *
 * 25 Oct 2026, ~21:30 (HackMeridian; the founder: "lets not have the confirm the last 6
 * digits of your evm wallet - a lot of hassle."): a Stellar-only creator adds an EVM
 * wallet with that wallet's own proof and nothing else — no Freighter sign-off, nothing
 * typed. A step-up sent by a form is passed through; a confirm is dropped (nothing is typed
 * since 23:30). Changing an EVM account's wallet (C5) is the new account's proof plus the
 * sign-off from the account bound now, and lands at once.
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
import { resetEnv } from "@/lib/env";
import { resetScreeningCache } from "@/lib/screening";
import { makeMockDb } from "@/lib/test/mock-db";
import { clearStellarEnv, setStellarTestnetEnv } from "@/lib/test/stellar";
import { SESSION_COOKIE, SESSION_TTL_SEC, newSession, sealSession } from "@/lib/web/session";
import { POST } from "./route";

const evm = privateKeyToAccount(generatePrivateKey());
const stellar = Keypair.random();
const G = stellar.publicKey();
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
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === API) {
        patched.push(JSON.parse(String(init?.body)));
        return PATCH(new NextRequest(url, init as ConstructorParameters<typeof NextRequest>[1]));
      }
      return new Response("[]", { status: 200 });
    }),
  );

  const session = generateApiKey("session");
  mock.seed("api_key", [
    { id: "bbbbbbbb-1111-4111-8111-111111111111", creator_id: CREATOR_ID, kind: "session", hash: session.hash, expires_at: new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString() },
  ]);
  mock.seed("creator", [{ id: CREATOR_ID, handle: "adrian", payout_address: G, stellar_payout_address: G, onboarded_via: "web", terms_version: "2026-08-29" }]);
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

async function proof() {
  const challenge = await issueChallenge(evm.address, "address_proof");
  return { evm_address: evm.address, proof_nonce: challenge.nonce, proof_signature: await evm.signMessage({ message: challenge.message }) };
}

function post(fields: Record<string, string>): Promise<Response> {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  return POST(new Request("https://x402git.com/dashboard/wallet/evm", { method: "POST", body: form, headers: { cookie } }));
}

function outcome(res: Response): { ok: string | null; error: string | null } {
  const url = new URL(res.headers.get("location") ?? "");
  return { ok: url.searchParams.get("ok"), error: url.searchParams.get("error") };
}

describe("POST /dashboard/wallet/evm — adding is the EVM wallet's proof alone (25 Oct 2026)", () => {
  it("adds an EVM wallet to a Stellar-only account from one signature, and sends nothing else", async () => {
    const res = await post(await proof());
    expect(res.status).toBe(303);
    expect(outcome(res).ok).toMatch(/EVM wallet added/);
    expect(Object.keys(patched[0]).sort()).toEqual(["payout_address", "payout_proof"]);
    expect(mock.rows("creator")[0]).toMatchObject({ payout_address: evm.address.toLowerCase(), stellar_payout_address: G });
  });

  it("without the proof, sends the reader back before calling the API", async () => {
    const res = await post({ evm_address: evm.address });
    expect(outcome(res).error).toMatch(/Connect your EVM wallet and sign first/);
    expect(patched).toHaveLength(0);
  });

  it("passes a step-up through when a form sends one, and drops a confirm", async () => {
    const stepUp = await issueChallenge(G, "step_up", rebindContext(evm.address));
    const res = await post({
      ...(await proof()),
      step_up_nonce: stepUp.nonce,
      step_up_signature: stellar.signMessage(stepUp.message).toString("base64"),
      confirm_address: "zzzzzz",
    });
    expect(Object.keys(patched[0]).sort()).toEqual(["payout_address", "payout_proof", "step_up"]);
    expect(outcome(res).ok).toMatch(/EVM wallet added/);
    expect(mock.rows("creator")[0].payout_address).toBe(evm.address.toLowerCase());
  });
});

describe("POST /dashboard/wallet/evm — changing an EVM account's wallet is two signatures and lands at once (25 Oct 2026, 23:30)", () => {
  const next = privateKeyToAccount(generatePrivateKey());

  beforeEach(() => {
    mock.rows("creator").length = 0;
    mock.seed("creator", [{ id: CREATOR_ID, handle: "adrian", payout_address: evm.address.toLowerCase(), onboarded_via: "web", terms_version: "2026-08-29" }]);
  });

  async function nextProof() {
    const challenge = await issueChallenge(next.address, "address_proof");
    return { evm_address: next.address, proof_nonce: challenge.nonce, proof_signature: await next.signMessage({ message: challenge.message }) };
  }

  it("without the sign-off from the wallet bound now, sends the reader back before the API is called", async () => {
    const res = await post(await nextProof());
    expect(outcome(res).error).toMatch(/Sign with the wallet bound now/);
    expect(patched).toHaveLength(0);
    expect(mock.rows("creator")[0].payout_address).toBe(evm.address.toLowerCase());
  });

  it("with the new account's proof and the current account's sign-off, the address changes now", async () => {
    const stepUp = await issueChallenge(evm.address, "step_up", rebindContext(next.address));
    const res = await post({ ...(await nextProof()), step_up_nonce: stepUp.nonce, step_up_signature: await evm.signMessage({ message: stepUp.message }) });
    expect(res.status).toBe(303);
    expect(outcome(res).ok).toMatch(/EVM wallet changed/);
    expect(Object.keys(patched[0]).sort()).toEqual(["payout_address", "payout_proof", "step_up"]);
    expect(mock.rows("creator")[0]).toMatchObject({ payout_address: next.address.toLowerCase(), pending_payout_address: null });
  });

  it("refuses a sign-off from some other key, and writes nothing", async () => {
    const stranger = privateKeyToAccount(generatePrivateKey());
    const stepUp = await issueChallenge(evm.address, "step_up", rebindContext(next.address));
    const res = await post({ ...(await nextProof()), step_up_nonce: stepUp.nonce, step_up_signature: await stranger.signMessage({ message: stepUp.message }) });
    expect(outcome(res).error).toBeTruthy();
    expect(mock.rows("creator")[0].payout_address).toBe(evm.address.toLowerCase());
  });
});
