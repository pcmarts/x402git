/**
 * Stellar-only sign-up (JOURNEYS C2, BUILD H5, W2 test 12): a GitHub session plus a
 * SEP-53 proof from Freighter creates the creator with the `G…` as identity and Stellar
 * payout address, both keys minted; without the trustline nothing is written and the
 * reader is sent to the Freighter steps for that account.
 */

import { Keypair } from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueChallenge } from "@/lib/auth/challenge";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv, stellarRail } from "@/lib/env";
import { notifyAdmin } from "@/lib/notify";
import { resetScreeningCache } from "@/lib/screening";
import { makeMockDb } from "@/lib/test/mock-db";
import { clearStellarEnv, setStellarTestnetEnv } from "@/lib/test/stellar";
import { SESSION_COOKIE, newSession, openSession, sealSession } from "@/lib/web/session";

vi.mock("@/lib/notify", () => ({ notifyAdmin: vi.fn(async () => ({ delivered: true })) }));

const stellar = Keypair.random();
const G = stellar.publicKey();

let cookieJar = "";
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const match = new RegExp(`(?:^|; )${name}=([^;]*)`).exec(cookieJar);
      return match ? { name, value: decodeURIComponent(match[1]) } : undefined;
    },
  }),
}));

const { POST } = await import("./route");

let mock: ReturnType<typeof makeMockDb>;
let horizon: { status: number; body: unknown };

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = "https://x402git.com";
  process.env.SESSION_SECRET = "test-session-secret";
  process.env.TERMS_VERSION = "2026-09-16";
  setStellarTestnetEnv();
  resetEnv();
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  resetScreeningCache();
  vi.mocked(notifyAdmin).mockClear();
  horizon = { status: 200, body: { balances: [{ asset_type: "native", balance: "10.0000000" }] } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/accounts/")) return new Response(JSON.stringify(horizon.body), { status: horizon.status, headers: { "content-type": "application/json" } });
      return new Response("[]", { status: 200 });
    }),
  );
  cookieJar = `${SESSION_COOKIE}=${encodeURIComponent(sealSession(newSession({ github: { id: 4242, login: "orbit" } })))}`;
});

afterEach(() => {
  resetDb();
  vi.unstubAllGlobals();
  resetScreeningCache();
  for (const k of ["NEXT_PUBLIC_APP_URL", "SESSION_SECRET", "TERMS_VERSION"]) delete process.env[k];
  clearStellarEnv();
  resetEnv();
});

function withTrustline() {
  const asset = stellarRail()!.asset;
  horizon = {
    status: 200,
    body: { balances: [{ asset_type: "native", balance: "10.0000000" }, { asset_type: "credit_alphanum4", asset_code: asset.code, asset_issuer: asset.issuer, is_authorized: true, balance: "0" }] },
  };
}

async function bind(signer = stellar): Promise<Response> {
  const challenge = await issueChallenge(G, "address_proof");
  const form = new FormData();
  form.set("address", G);
  form.set("nonce", challenge.nonce);
  form.set("signature", signer.signMessage(challenge.message).toString("base64"));
  return POST(new Request("https://x402git.com/dashboard/wallet/bind", { method: "POST", body: form }));
}

function cookie(res: Response, name: string): string | undefined {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

describe("POST /dashboard/wallet/bind with Freighter (Stellar-only sign-up)", () => {
  it("creates the creator with the G… as identity and Stellar payout address, and signs them in", async () => {
    withTrustline();
    const res = await bind();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/dashboard/key");

    const creator = mock.rows("creator")[0];
    expect(creator).toMatchObject({ handle: "orbit", payout_address: G, stellar_payout_address: G, wallet_mode: "linked", onboarded_via: "web" });
    expect(creator.stellar_payout_meta).toMatchObject({ network: "stellar:testnet", address: G, trustline: { authorized: true } });
    expect(creator.stellar_payout_verified_at).toBeTruthy();
    // D14: both keys, and the session cookie names the new creator.
    expect(mock.rows("api_key").map((k) => k.kind).sort()).toEqual(["agent", "session"]);
    const session = openSession(decodeURIComponent(cookie(res, SESSION_COOKIE) ?? ""));
    expect(session?.creatorId).toBe(creator.id);
    expect(vi.mocked(notifyAdmin)).toHaveBeenCalledTimes(1);
  });

  it("without the trustline, writes nothing, spends no nonce, and sends the reader to the Freighter steps for that account", async () => {
    const res = await bind();
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("location") ?? "", "https://x402git.com");
    expect(location.pathname).toBe("/dashboard/wallet");
    expect(location.searchParams.get("trustline")).toBe(G);
    expect(mock.rows("creator")).toHaveLength(0);
    expect(mock.rows("api_key")).toHaveLength(0);
    // The signature was not consumed: adding the trustline and resubmitting is enough.
    expect(mock.rows("challenge")[0].used_at).toBeNull();
  });

  it("refuses a proof from another key with the trustline present, and writes nothing", async () => {
    withTrustline();
    const res = await bind(Keypair.random());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("error=");
    expect(mock.rows("creator")).toHaveLength(0);
  });
});
