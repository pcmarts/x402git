/**
 * The FR-55 half of binding a wallet: one write creates the creator and mints both
 * kinds of key, and the two plaintexts go to two different places — the session key into
 * the sealed cookie, the agent key into the one-time box, neither into the URL.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { hashApiKey } from "@/lib/auth/api-key";
import { issueChallenge } from "@/lib/auth/challenge";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { resetScreeningCache } from "@/lib/screening";
import { makeMockDb } from "@/lib/test/mock-db";
import { notifyAdmin } from "@/lib/notify";
import { KEY_BOX_COOKIE, openBox, openSession, SESSION_COOKIE, newSession, sealSession } from "@/lib/web/session";

vi.mock("@/lib/notify", () => ({ notifyAdmin: vi.fn(async () => ({ delivered: true })) }));

const account = privateKeyToAccount(generatePrivateKey());

/** The route reads the incoming session through `next/headers`, which needs a request. */
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

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = "https://x402git.com";
  process.env.SESSION_SECRET = "test-session-secret";
  process.env.TERMS_VERSION = "2026-09-16";
  resetEnv();
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  resetScreeningCache();
  vi.mocked(notifyAdmin).mockClear();
  // FR-38 screening: an empty list, so no test touches the network.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
  cookieJar =`${SESSION_COOKIE}=${encodeURIComponent(sealSession(newSession({ github: { id: 4242, login: "adrian" } })))}`;
});

afterEach(() => {
  resetDb();
  vi.unstubAllGlobals();
  resetScreeningCache();
  for (const k of ["NEXT_PUBLIC_APP_URL", "SESSION_SECRET", "TERMS_VERSION"]) delete process.env[k];
  resetEnv();
});

async function bind(): Promise<Response> {
  const challenge = await issueChallenge(account.address, "address_proof");
  const form = new FormData();
  form.set("address", account.address);
  form.set("nonce", challenge.nonce);
  form.set("signature", await account.signMessage({ message: challenge.message }));
  return POST(new Request("https://x402git.com/dashboard/wallet/bind", { method: "POST", body: form }));
}

function cookie(res: Response, name: string): string | undefined {
  return res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.split(";")[0]
    .slice(name.length + 1);
}

describe("POST /dashboard/wallet/bind (FR-1, FR-55)", () => {
  it("mints an agent key and a session key, and only their hashes are stored", async () => {
    const res = await bind();
    expect(res.status).toBe(303);

    const rows = mock.rows("api_key");
    expect(rows.filter((r) => r.kind === "agent")).toHaveLength(1);
    expect(rows.filter((r) => r.kind === "session")).toHaveLength(1);
    expect(rows.every((r) => r.creator_id === mock.rows("creator")[0].id)).toBe(true);
    // The agent key never expires; the session key must (the table's CHECK, FR-56).
    expect(rows.find((r) => r.kind === "agent")?.expires_at).toBeNull();
    expect(rows.find((r) => r.kind === "session")?.expires_at).toBeTruthy();
  });

  it("seals the session key into the cookie, and the row's expiry is the cookie's", async () => {
    const res = await bind();
    const session = openSession(decodeURIComponent(cookie(res, SESSION_COOKIE) as string));

    expect(session?.apiKey).toMatch(/^x4s_live_[0-9A-Za-z]{32}$/);
    const row = mock.rows("api_key").find((r) => r.kind === "session");
    expect(row?.hash).toBe(hashApiKey(session?.apiKey as string));
    expect(Date.parse(row?.expires_at as string)).toBe((session?.exp as number) * 1000);
  });

  it("carries the agent key in the one-time box, and never in the URL", async () => {
    const res = await bind();
    const shown = openBox(decodeURIComponent(cookie(res, KEY_BOX_COOKIE) as string));

    expect(shown).toMatch(/^x4c_live_[0-9A-Za-z]{32}$/);
    expect(mock.rows("api_key").find((r) => r.kind === "agent")?.hash).toBe(hashApiKey(shown as string));

    const location = res.headers.get("location") as string;
    expect(new URL(location).pathname).toBe("/dashboard/key");
    expect(location).not.toContain("x4c_live_");
    expect(location).not.toContain("x4s_live_");
  });

  // The repo-picker detour: a creator who installed the App before they had an account
  // signs in on the way to /dashboard/new and is sent here first. The key page is the
  // next stop either way; the path they were headed for rides along as its way on.
  it("hands the key page the path sign-in was headed for", async () => {
    const parked = newSession({ github: { id: 4242, login: "adrian" }, next: "/dashboard/new" });
    cookieJar = `${SESSION_COOKIE}=${encodeURIComponent(sealSession(parked))}`;

    const location = new URL((await bind()).headers.get("location") as string);
    expect(location.pathname).toBe("/dashboard/key");
    expect(location.searchParams.get("next")).toBe("/dashboard/new");
    // Spent once bound: the new session does not carry it.
    expect(openSession(decodeURIComponent(cookie(await bind(), SESSION_COOKIE) ?? ""))?.next).toBeUndefined();
  });

  it("falls back to the dashboard when there is no path, or the path is this detour", async () => {
    const plain = new URL((await bind()).headers.get("location") as string);
    expect(plain.searchParams.get("next")).toBe("/dashboard");

    for (const next of ["/dashboard/wallet", "/dashboard/key?ok=x", "//evil.example"]) {
      mock = makeMockDb();
      setDb(mock.client as unknown as Db);
      cookieJar = `${SESSION_COOKIE}=${encodeURIComponent(sealSession(newSession({ github: { id: 4242, login: "adrian" }, next })))}`;
      const location = new URL((await bind()).headers.get("location") as string);
      expect(location.searchParams.get("next")).toBe("/dashboard");
    }
  });

  it("keeps both keys out of the cookies in the clear, and both cookies httpOnly", async () => {
    const res = await bind();
    const raw = res.headers.getSetCookie().join(" | ");

    expect(raw).not.toContain("x4c_live_");
    expect(raw).not.toContain("x4s_live_");
    expect(res.headers.getSetCookie().filter((c) => c.includes("HttpOnly"))).toHaveLength(2);
    // The box is short-lived: it exists to survive one redirect (FR-59).
    expect(res.headers.getSetCookie().find((c) => c.startsWith(`${KEY_BOX_COOKIE}=`))).toContain("Max-Age=300");
  });

  it("tells the operator a creator joined on the web rail, and names no address (ADMIN-NOTIFICATIONS.md)", async () => {
    await bind();

    const creator = mock.rows("creator")[0];
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(notifyAdmin).toHaveBeenCalledWith({ kind: "creator_joined", via: "web", handle: "adrian", creatorId: creator.id, walletMode: "linked" });
    // FR-40: the payout address is bound in this very request and still never travels.
    expect(JSON.stringify(vi.mocked(notifyAdmin).mock.calls[0][0])).not.toContain(account.address.toLowerCase());
  });
});
