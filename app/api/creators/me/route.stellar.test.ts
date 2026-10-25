/**
 * Binding a Stellar payout address through the API (JOURNEYS C3/C5, BUILD W2 tests 6–9,
 * 12; BATTLE-TEST finding 14): the trustline gate, step-up from the wallet bound now,
 * the SEP-53 proof from the new account, type-to-confirm, addition-now / change-in-48h,
 * and a Stellar-only creator's profile not 400ing.
 *
 * Most cases here authenticate with an agent key, which still steps up and types to
 * confirm for an addition. The 25 Oct 2026 decision (adding an empty rail from a
 * dashboard session key is the new wallet's proof alone; a change is unchanged) has its
 * own block at the end, with a session key.
 */

import { Keypair } from "@stellar/stellar-sdk";
import { NextRequest } from "next/server";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateApiKey } from "@/lib/auth/api-key";
import { SESSION_TTL_SEC } from "@/lib/web/session";
import { issueChallenge } from "@/lib/auth/challenge";
import { REBIND_DELAY_HOURS, rebindContext } from "@/lib/auth/step-up";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv, stellarRail } from "@/lib/env";
import { resetScreeningCache } from "@/lib/screening";
import { makeMockDb } from "@/lib/test/mock-db";
import { clearStellarEnv, setStellarTestnetEnv } from "@/lib/test/stellar";
import { GET, PATCH } from "./route";

const evm = privateKeyToAccount(generatePrivateKey());
const stellar = Keypair.random();
const other = Keypair.random();
const G = stellar.publicKey();
const CREATOR_ID = "11111111-1111-4111-8111-111111111111";

let mock: ReturnType<typeof makeMockDb>;
let apiKey: string;
/** What Horizon says about any account asked for: set per test. */
let horizon: { status: number; body: unknown };
/** Runs on every outbound fetch, before it answers: a test can change the row mid-request. */
let duringFetch: ((url: string) => void) | null;

const sep53 = (signer: Keypair, message: string) => signer.signMessage(message).toString("base64");

beforeEach(() => {
  setStellarTestnetEnv();
  resetEnv();
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  resetScreeningCache();
  horizon = { status: 200, body: { balances: [{ asset_type: "native", balance: "10.0000000" }] } };
  duringFetch = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      duringFetch?.(url);
      if (url.includes("/accounts/")) return new Response(JSON.stringify(horizon.body), { status: horizon.status, headers: { "content-type": "application/json" } });
      // FR-38 screening list: empty.
      return new Response("[]", { status: 200 });
    }),
  );

  const generated = generateApiKey("agent");
  apiKey = generated.key;
  mock.seed("api_key", [{ id: "aaaaaaaa-1111-4111-8111-111111111111", creator_id: CREATOR_ID, kind: "agent", hash: generated.hash }]);
});

afterEach(() => {
  resetDb();
  vi.unstubAllGlobals();
  resetScreeningCache();
  clearStellarEnv();
  resetEnv();
});

function seedCreator(over: Record<string, unknown> = {}) {
  mock.seed("creator", [{ id: CREATOR_ID, handle: "adrian", payout_address: evm.address.toLowerCase(), onboarded_via: "api", terms_version: "2026-08-29", ...over }]);
}

/** The authorised trustline in the configured asset, as Horizon reports it. */
function withTrustline() {
  const asset = stellarRail()!.asset;
  horizon = {
    status: 200,
    body: { balances: [{ asset_type: "native", balance: "10.0000000" }, { asset_type: "credit_alphanum4", asset_code: asset.code, asset_issuer: asset.issuer, is_authorized: true, balance: "0.0000000" }] },
  };
}

function request(method: string, body?: unknown, key = apiKey): NextRequest {
  return new NextRequest("https://x402git.com/api/creators/me", {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Step-up from the EVM identity, naming the incoming G… (FR-5 `rebindContext`). */
async function evmStepUp(to: string) {
  const challenge = await issueChallenge(evm.address, "step_up", rebindContext(to));
  return { nonce: challenge.nonce, signature: await evm.signMessage({ message: challenge.message }) };
}

/** The new account proving itself (C3 step 3). */
async function stellarProof(signer = stellar, address = G) {
  const challenge = await issueChallenge(address, "address_proof");
  return { nonce: challenge.nonce, signature: sep53(signer, challenge.message) };
}

describe("PATCH /api/creators/me — adding a Stellar payout address (C3)", () => {
  it("refuses an account without a trustline, naming the asset, and writes nothing", async () => {
    seedCreator();
    const res = await PATCH(request("PATCH", { stellar_payout_address: G, confirm_address: G.slice(-6), stellar_proof: await stellarProof(), step_up: await evmStepUp(G) }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("invalid_request");
    expect(body.details).toMatchObject({ reason: "no_trustline", asset: { code: stellarRail()!.asset.code, issuer: stellarRail()!.asset.issuer } });
    expect(body.message).toContain(`allow ${stellarRail()!.asset.code}`);
    expect(mock.rows("creator")[0].stellar_payout_address ?? null).toBeNull();
    expect(mock.rows("creator")[0].stellar_payout_meta ?? null).toBeNull();
  });

  it("binds immediately when the trustline exists: live now, no 48-hour wait for an addition", async () => {
    seedCreator();
    withTrustline();
    const res = await PATCH(request("PATCH", { stellar_payout_address: G, confirm_address: G.slice(-6), stellar_proof: await stellarProof(), step_up: await evmStepUp(G) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stellar_payout_address).toBe(G);
    expect(body.pending_stellar_payout_address).toBeNull();
    expect(body.stellar_rebind_effective_at).toBeNull();
    expect(body.effective_at).toBeNull();
    // The EVM identity is untouched.
    expect(body.payout_address).toBe(evm.address);

    const row = mock.rows("creator")[0];
    expect(row.stellar_payout_address).toBe(G);
    expect(row.stellar_payout_meta).toMatchObject({ network: "stellar:testnet", address: G, trustline: { authorized: true } });
    expect(row.stellar_payout_verified_at).toBeTruthy();
    // Both challenges are spent, and the SEP-53 one records its signer.
    expect(mock.rows("challenge").every((c) => c.used_at !== null)).toBe(true);
    expect(mock.rows("challenge").find((c) => c.address === G)?.signer).toBe(G);
  });

  // An agent key, so still true after 25 Oct 2026: only a dashboard session key adds a
  // rail on the new wallet's proof alone (the block at the end of this file).
  it("is step_up_required without a signature from the EVM wallet bound now (an agent key alone cannot add a destination)", async () => {
    seedCreator();
    withTrustline();
    const res = await PATCH(request("PATCH", { stellar_payout_address: G, confirm_address: G.slice(-6), stellar_proof: await stellarProof() }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("step_up_required");
    expect(body.details.sign_with).toBe(evm.address.toLowerCase());
    expect(mock.rows("creator")[0].stellar_payout_address ?? null).toBeNull();
  });

  it("refuses a step-up minted for a different new address (the signature names where the money goes)", async () => {
    seedCreator();
    withTrustline();
    const res = await PATCH(request("PATCH", { stellar_payout_address: G, confirm_address: G.slice(-6), stellar_proof: await stellarProof(), step_up: await evmStepUp(other.publicKey()) }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("step_up_required");
  });

  it("refuses a proof signed by another key (F4: the signer must be the address)", async () => {
    seedCreator();
    withTrustline();
    const res = await PATCH(request("PATCH", { stellar_payout_address: G, confirm_address: G.slice(-6), stellar_proof: await stellarProof(other), step_up: await evmStepUp(G) }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("payout_address_unverified");
    expect(mock.rows("creator")[0].stellar_payout_address ?? null).toBeNull();
  });

  it("refuses a confirm_address one character off, before spending any nonce (test 8)", async () => {
    seedCreator();
    withTrustline();
    const tail = G.slice(-6);
    const off = `${tail.slice(0, 5)}${tail.endsWith("A") ? "B" : "A"}`;
    const res = await PATCH(request("PATCH", { stellar_payout_address: G, confirm_address: off, stellar_proof: await stellarProof(), step_up: await evmStepUp(G) }));
    expect(res.status).toBe(400);
    expect((await res.json()).details).toMatchObject({ field: "confirm_address" });
    expect(mock.rows("challenge").every((c) => c.used_at === null)).toBe(true);
  });

  it("requires the Stellar account's own proof", async () => {
    seedCreator();
    withTrustline();
    const res = await PATCH(request("PATCH", { stellar_payout_address: G, confirm_address: G.slice(-6), step_up: await evmStepUp(G) }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("payout_address_unverified");
  });
});

describe("PATCH /api/creators/me — changing the Stellar payout address (C5)", () => {
  it("queues the change for 48 hours and keeps paying the current address until then", async () => {
    const current = other.publicKey();
    seedCreator({ stellar_payout_address: current });
    withTrustline();
    const before = Date.now();
    const res = await PATCH(request("PATCH", { stellar_payout_address: G, confirm_address: G, stellar_proof: await stellarProof(), step_up: await evmStepUp(G) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stellar_payout_address).toBe(current);
    expect(body.pending_stellar_payout_address).toBe(G);
    const effective = new Date(body.stellar_rebind_effective_at).getTime() - before;
    expect(effective).toBeGreaterThan((REBIND_DELAY_HOURS * 3600 - 5) * 1000);
    expect(effective).toBeLessThanOrEqual(REBIND_DELAY_HOURS * 3600 * 1000 + 1000);
    expect(body.effective_at).toBe(body.stellar_rebind_effective_at);
    expect(mock.rows("creator")[0]).toMatchObject({ stellar_payout_address: current, pending_stellar_payout_address: G });
  });

  it("a Stellar-only creator changing their address steps up with the bound G… (SEP-53) and waits 48 hours", async () => {
    const identity = other;
    seedCreator({ payout_address: identity.publicKey() });
    withTrustline();
    const stepUpChallenge = await issueChallenge(identity.publicKey(), "step_up", rebindContext(G));
    const stepUp = { nonce: stepUpChallenge.nonce, signature: sep53(identity, stepUpChallenge.message) };
    const res = await PATCH(request("PATCH", { stellar_payout_address: G, confirm_address: G.slice(-6), stellar_proof: await stellarProof(), step_up: stepUp }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payout_address).toBe(identity.publicKey());
    expect(body.pending_stellar_payout_address).toBe(G);
    expect(body.stellar_rebind_effective_at).not.toBeNull();
  });
});

describe("PATCH /api/creators/me — a Stellar-only creator adds an EVM address (C4)", () => {
  /** Step-up from the bound G…, naming the incoming 0x… (FR-5 `rebindContext`). */
  async function stellarStepUp(to: string) {
    const challenge = await issueChallenge(G, "step_up", rebindContext(to));
    return { nonce: challenge.nonce, signature: sep53(stellar, challenge.message) };
  }
  /** The new EVM address proving itself. */
  async function evmProof(account = evm) {
    const challenge = await issueChallenge(account.address, "address_proof");
    return { nonce: challenge.nonce, signature: await account.signMessage({ message: challenge.message }) };
  }

  it("is live at once: the 0x… becomes payout_address and the G… stays the Stellar payout address", async () => {
    seedCreator({ payout_address: G, stellar_payout_address: G });
    const res = await PATCH(request("PATCH", { payout_address: evm.address, payout_proof: await evmProof(), confirm_address: evm.address.slice(-6).toLowerCase(), step_up: await stellarStepUp(evm.address) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payout_address).toBe(evm.address);
    expect(body.pending_payout_address).toBeNull();
    expect(body.rebind_effective_at).toBeNull();
    expect(body.effective_at).toBeNull();
    expect(body.stellar_payout_address).toBe(G);
    expect(mock.rows("creator")[0]).toMatchObject({ payout_address: evm.address.toLowerCase(), stellar_payout_address: G });
    expect(mock.rows("challenge").every((c) => c.used_at !== null)).toBe(true);
  });

  it("keeps the G… on the Stellar rail when the row had no stellar_payout_address", async () => {
    seedCreator({ payout_address: G });
    const res = await PATCH(request("PATCH", { payout_address: evm.address, payout_proof: await evmProof(), confirm_address: evm.address, step_up: await stellarStepUp(evm.address) }));
    expect(res.status).toBe(200);
    expect(mock.rows("creator")[0]).toMatchObject({ payout_address: evm.address.toLowerCase(), stellar_payout_address: G });
  });

  it("refuses a proof signed by another EVM key, and writes nothing", async () => {
    seedCreator({ payout_address: G, stellar_payout_address: G });
    const stranger = privateKeyToAccount(generatePrivateKey());
    const challenge = await issueChallenge(evm.address, "address_proof");
    const forged = { nonce: challenge.nonce, signature: await stranger.signMessage({ message: challenge.message }) };
    const res = await PATCH(request("PATCH", { payout_address: evm.address, payout_proof: forged, confirm_address: evm.address.slice(-6), step_up: await stellarStepUp(evm.address) }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("payout_address_unverified");
    expect(mock.rows("creator")[0].payout_address).toBe(G);
  });

  it("refuses a confirm_address that does not match, before spending any nonce", async () => {
    seedCreator({ payout_address: G, stellar_payout_address: G });
    const res = await PATCH(request("PATCH", { payout_address: evm.address, payout_proof: await evmProof(), confirm_address: "zzzzzz", step_up: await stellarStepUp(evm.address) }));
    expect(res.status).toBe(400);
    expect((await res.json()).details).toMatchObject({ field: "confirm_address" });
    expect(mock.rows("challenge").every((c) => c.used_at === null || c.used_at === undefined)).toBe(true);
  });

  it("refuses payout_proof on an account whose identity is already EVM", async () => {
    seedCreator();
    const next = privateKeyToAccount(generatePrivateKey());
    const res = await PATCH(request("PATCH", { payout_address: next.address, payout_proof: await evmProof(next), confirm_address: next.address, step_up: await evmStepUp(next.address) }));
    expect(res.status).toBe(400);
    expect((await res.json()).details).toMatchObject({ field: "payout_proof" });
  });

  it("refuses moving an EVM account's payout_address to a G… (Base would vanish from every listing)", async () => {
    seedCreator();
    const res = await PATCH(request("PATCH", { payout_address: G, step_up: await evmStepUp(G) }));
    expect(res.status).toBe(400);
    expect((await res.json()).details).toMatchObject({ field: "payout_address" });
    expect(mock.rows("creator")[0].pending_payout_address ?? null).toBeNull();
  });
});

describe("PATCH /api/creators/me — adding an empty rail from a dashboard session is the new wallet's proof alone (25 Oct 2026)", () => {
  // The founder, 25 Oct 2026 ~21:30: adding a wallet is "connect the new wallet, sign
  // once, done". A change keeps the step-up and type-to-confirm (route.ts header).
  let sessionKey: string;

  beforeEach(() => {
    const generated = generateApiKey("session");
    sessionKey = generated.key;
    mock.rows("api_key").push({
      id: "bbbbbbbb-1111-4111-8111-111111111111",
      creator_id: CREATOR_ID,
      kind: "session",
      hash: generated.hash,
      scopes: ["listings:write", "earnings:read"],
      expires_at: new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString(),
      revoked_at: null,
    });
  });

  const fromSession = (body: unknown) => PATCH(request("PATCH", body, sessionKey));

  /** Step-up from the bound G…, naming the incoming 0x…. */
  async function stellarStepUp(to: string, signer = stellar) {
    const challenge = await issueChallenge(signer.publicKey(), "step_up", rebindContext(to));
    return { nonce: challenge.nonce, signature: sep53(signer, challenge.message) };
  }
  async function evmProof(account = evm) {
    const challenge = await issueChallenge(account.address, "address_proof");
    return { nonce: challenge.nonce, signature: await account.signMessage({ message: challenge.message }) };
  }

  it("adds Stellar to an EVM account with only stellar_proof: 200, live at once", async () => {
    seedCreator();
    withTrustline();
    const res = await fromSession({ stellar_payout_address: G, stellar_proof: await stellarProof() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stellar_payout_address).toBe(G);
    expect(body.pending_stellar_payout_address).toBeNull();
    expect(body.effective_at).toBeNull();
    expect(body.payout_address).toBe(evm.address);
    expect(mock.rows("creator")[0]).toMatchObject({ stellar_payout_address: G });
    // One signature: the only challenge is the proof, and it is spent.
    expect(mock.rows("challenge")).toHaveLength(1);
    expect(mock.rows("challenge")[0]).toMatchObject({ address: G, purpose: "address_proof" });
    expect(mock.rows("challenge")[0].used_at).not.toBeNull();
  });

  it("adds EVM to a Stellar-only account with only payout_proof: 200, the 0x… becomes the identity", async () => {
    seedCreator({ payout_address: G, stellar_payout_address: G });
    const res = await fromSession({ payout_address: evm.address, payout_proof: await evmProof() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payout_address).toBe(evm.address);
    expect(body.pending_payout_address).toBeNull();
    expect(body.effective_at).toBeNull();
    expect(body.stellar_payout_address).toBe(G);
    expect(mock.rows("creator")[0]).toMatchObject({ payout_address: evm.address.toLowerCase(), stellar_payout_address: G });
  });

  it("still takes step_up and confirm_address on an addition when they are sent (C3 and C4)", async () => {
    seedCreator();
    withTrustline();
    const c3 = await fromSession({ stellar_payout_address: G, stellar_proof: await stellarProof(), step_up: await evmStepUp(G), confirm_address: G.slice(-6) });
    expect(c3.status).toBe(200);
    expect(mock.rows("challenge").every((c) => c.used_at !== null)).toBe(true);

    mock.rows("creator").length = 0;
    seedCreator({ payout_address: G, stellar_payout_address: G });
    const c4 = await fromSession({ payout_address: evm.address, payout_proof: await evmProof(), step_up: await stellarStepUp(evm.address), confirm_address: evm.address.slice(-6) });
    expect(c4.status).toBe(200);
    expect(mock.rows("creator")[0].payout_address).toBe(evm.address.toLowerCase());
  });

  it("verifies a step_up sent on an addition: one naming another address is refused, and nothing is written", async () => {
    seedCreator();
    withTrustline();
    const res = await fromSession({ stellar_payout_address: G, stellar_proof: await stellarProof(), step_up: await evmStepUp(other.publicKey()) });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("step_up_required");
    expect(mock.rows("creator")[0].stellar_payout_address ?? null).toBeNull();
  });

  it("checks a confirm_address sent on an addition, before spending the proof", async () => {
    seedCreator({ payout_address: G, stellar_payout_address: G });
    const res = await fromSession({ payout_address: evm.address, payout_proof: await evmProof(), confirm_address: "zzzzzz" });
    expect(res.status).toBe(400);
    expect((await res.json()).details).toMatchObject({ field: "confirm_address" });
    expect(mock.rows("challenge").every((c) => (c.used_at ?? null) === null)).toBe(true);
  });

  it("still refuses to change an existing Stellar address without step_up (C5)", async () => {
    const current = other.publicKey();
    seedCreator({ stellar_payout_address: current });
    withTrustline();
    const res = await fromSession({ stellar_payout_address: G, stellar_proof: await stellarProof(), confirm_address: G });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("step_up_required");
    expect(mock.rows("creator")[0]).toMatchObject({ stellar_payout_address: current });
    expect(mock.rows("creator")[0].pending_stellar_payout_address ?? null).toBeNull();
  });

  it("still refuses to change a Stellar-only creator's G… without step_up: that rail is not empty", async () => {
    seedCreator({ payout_address: other.publicKey() });
    withTrustline();
    const res = await fromSession({ stellar_payout_address: G, stellar_proof: await stellarProof(), confirm_address: G });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("step_up_required");
    expect(mock.rows("creator")[0].pending_stellar_payout_address ?? null).toBeNull();
  });

  it("still refuses to change the EVM address without step_up (the 48-hour rebind)", async () => {
    seedCreator();
    const next = privateKeyToAccount(generatePrivateKey());
    const res = await fromSession({ payout_address: next.address });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("step_up_required");
    expect(mock.rows("creator")[0].pending_payout_address ?? null).toBeNull();
  });

  it("still requires confirm_address on a change, even with the step-up", async () => {
    seedCreator({ stellar_payout_address: other.publicKey() });
    withTrustline();
    const res = await fromSession({ stellar_payout_address: G, stellar_proof: await stellarProof(), step_up: await evmStepUp(G) });
    expect(res.status).toBe(400);
    expect((await res.json()).details).toMatchObject({ field: "confirm_address" });
  });

  it("an agent key still steps up to add EVM to a Stellar-only account", async () => {
    seedCreator({ payout_address: G, stellar_payout_address: G });
    const res = await PATCH(request("PATCH", { payout_address: evm.address, payout_proof: await evmProof(), confirm_address: evm.address }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("step_up_required");
    expect(mock.rows("creator")[0].payout_address).toBe(G);
  });

  it("an abuse-contact change riding on an addition still needs step_up (and so the confirm too)", async () => {
    seedCreator();
    withTrustline();
    const bare = await fromSession({ stellar_payout_address: G, stellar_proof: await stellarProof(), abuse_contact_email: "abuse@example.com" });
    expect(bare.status).toBe(400);
    expect((await bare.json()).details).toMatchObject({ field: "confirm_address" });
    const res = await fromSession({ stellar_payout_address: G, stellar_proof: await stellarProof(), confirm_address: G.slice(-6), abuse_contact_email: "abuse@example.com" });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("step_up_required");
    expect(mock.rows("creator")[0].stellar_payout_address ?? null).toBeNull();
  });

  it("never overwrites a Stellar address bound while the addition was in flight", async () => {
    seedCreator();
    withTrustline();
    const racer = other.publicKey();
    // Another request binds the rail while this one waits on Horizon.
    duringFetch = (url) => {
      if (url.includes("/accounts/")) mock.rows("creator")[0].stellar_payout_address = racer;
    };
    const res = await fromSession({ stellar_payout_address: G, stellar_proof: await stellarProof() });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_request");
    expect(mock.rows("creator")[0].stellar_payout_address).toBe(racer);
  });

  it("never overwrites an EVM address added while the addition was in flight", async () => {
    seedCreator({ payout_address: G, stellar_payout_address: G });
    const racer = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    // Another request adds EVM while this one is being screened.
    duringFetch = () => {
      mock.rows("creator")[0].payout_address = racer;
    };
    const res = await fromSession({ payout_address: evm.address, payout_proof: await evmProof() });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_request");
    expect(mock.rows("creator")[0].payout_address).toBe(racer);
  });
});

describe("GET /api/creators/me for a Stellar-only creator (test 12, finding 14)", () => {
  it("returns 200 with the G… as payout_address and the Stellar fields", async () => {
    seedCreator({ payout_address: G, stellar_payout_address: G, stellar_payout_verified_at: "2026-10-25T12:00:00.000Z" });
    const res = await GET(request("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payout_address).toBe(G);
    expect(body.stellar_payout_address).toBe(G);
    expect(body.pending_stellar_payout_address).toBeNull();
    expect(body.stellar_payout_verified_at).toBe("2026-10-25T12:00:00.000Z");
  });
});
