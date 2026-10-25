/**
 * The dashboard mints the challenge for binding a payout address, and for a rebind. It
 * counts against the same limits as `GET /api/auth/challenge` and in the same way
 * (CORE-4, PAY-12): per (IP, address) under a per-IP cap, and a rebind's `step_up` in a
 * bucket of its own. Keyed on the address alone, anyone could mint challenges naming a
 * creator's bound address and block that creator's rebind.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hashApiKey } from "@/lib/auth/api-key";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { makeMockDb } from "@/lib/test/mock-db";
import { newSession, sealSession, SESSION_COOKIE, sessionExpiresAt } from "@/lib/web/session";
import { GET as publicChallenge } from "../../../api/auth/challenge/route";

/** The route reads the session through `next/headers`, which needs a request. */
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

const CREATOR_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_KEY = `x4s_live_${"S1e2s3S4i5O6n7K8e9Y0a1B2c3D4e5F6"}`;
const bound = privateKeyToAccount(generatePrivateKey());
const next = privateKeyToAccount(generatePrivateKey());
const IP = "203.0.113.61";

let mock: ReturnType<typeof makeMockDb>;

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = "https://x402git.com";
  process.env.SESSION_SECRET = "test-session-secret";
  resetEnv();
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  cookieJar = `${SESSION_COOKIE}=${encodeURIComponent(sealSession(newSession({ github: { id: 4242, login: "adrian" } })))}`;
});

afterEach(() => {
  resetDb();
  for (const k of ["NEXT_PUBLIC_APP_URL", "SESSION_SECRET"]) delete process.env[k];
  resetEnv();
});

/** A signed-in creator whose payout address is `bound`. */
function signInAsCreator() {
  mock.seed("creator", [
    { id: CREATOR_ID, handle: "adrian", payout_address: bound.address.toLowerCase(), onboarded_via: "web", terms_version: "2026-09-16" },
  ]);
  mock.rows("api_key").push({
    id: crypto.randomUUID(),
    creator_id: CREATOR_ID,
    kind: "session",
    hash: hashApiKey(SESSION_KEY),
    scopes: ["listings:write", "earnings:read"],
    created_at: new Date().toISOString(),
    expires_at: sessionExpiresAt(),
    revoked_at: null,
    revoked_reason: null,
    last_used_at: null,
  });
  const session = newSession({ github: { id: 4242, login: "adrian" }, creatorId: CREATOR_ID, handle: "adrian", apiKey: SESSION_KEY });
  cookieJar = `${SESSION_COOKIE}=${encodeURIComponent(sealSession(session))}`;
}

function post(fields: Record<string, string>, ip = IP): Promise<Response> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return POST(new Request("https://x402git.com/dashboard/wallet/challenge", { method: "POST", body: form, headers: { "x-real-ip": ip } }));
}

describe("POST /dashboard/wallet/challenge — rate limits (CORE-4, PAY-12)", () => {
  it("a first-time bind counts per (IP, address), never under the address alone", async () => {
    const res = await post({ address: bound.address });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("nonce=");

    const buckets = mock.rows("rate_limit").map((r) => r.bucket);
    expect(buckets).toContain(`challenge:ip:${IP}:address:${bound.address.toLowerCase()}`);
    expect(buckets).not.toContain(`challenge:${bound.address.toLowerCase()}`);
  });

  it("a rebind still gets its challenge after challenge minting for the bound address is spent, even from the same IP", async () => {
    signInAsCreator();
    const mint = () => new NextRequest(`https://x402git.com/api/auth/challenge?address=${bound.address}&purpose=address_proof`, { headers: { "x-real-ip": IP } });
    for (let i = 0; i < 31; i++) await publicChallenge(mint());
    expect((await publicChallenge(mint())).status).toBe(429);

    const res = await post({ new_address: next.address });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("nonce=");
    expect(mock.rows("challenge").at(-1)).toMatchObject({ purpose: "step_up", address: bound.address.toLowerCase() });
  });
});
