/**
 * FR-58's other half: rotating the agent key from the dashboard breaks agents, and only
 * agents. The session rows come out byte-identical — the browser doing the rotating, and
 * the one on the creator's other laptop, both keep working. Before D14 the epoch bump in
 * this handler signed both of them out.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashApiKey } from "@/lib/auth/api-key";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { makeMockDb } from "@/lib/test/mock-db";
import { KEY_BOX_COOKIE, newSession, openBox, sealSession, SESSION_COOKIE, sessionExpiresAt } from "@/lib/web/session";
import { POST } from "./route";

const CREATOR_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_KEY = `x4s_live_${"S1e2s3S4i5O6n7K8e9Y0a1B2c3D4e5F6"}`;
const OTHER_LAPTOP = `x4s_live_${"L1a2p3T4o5P6t7H8i9S0o1T2h3E4r5X6"}`;
const OLD_AGENT = `x4c_live_${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6"}`;

let mock: ReturnType<typeof makeMockDb>;

function key(kind: "agent" | "session", plaintext: string) {
  mock.rows("api_key").push({
    id: crypto.randomUUID(),
    creator_id: CREATOR_ID,
    kind,
    hash: hashApiKey(plaintext),
    scopes: ["listings:write", "earnings:read"],
    created_at: new Date().toISOString(),
    expires_at: kind === "session" ? sessionExpiresAt() : null,
    revoked_at: null,
    revoked_reason: null,
    last_used_at: null,
  });
}

function post(apiKey: string | undefined = SESSION_KEY): Request {
  const session = newSession({ github: { id: 4242, login: "adrian" }, creatorId: CREATOR_ID, handle: "adrian", apiKey });
  return new Request("https://x402git.com/dashboard/key/rotate", {
    method: "POST",
    headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(sealSession(session))}` },
  });
}

/**
 * The session rows, minus `last_used_at` — the guard that just authenticated this POST
 * stamps it (FR-56, fire-and-forget), which is bookkeeping rather than a change to the
 * credential. Everything else must survive a rotation untouched.
 */
function sessionRows() {
  return mock.rows("api_key").filter((r) => r.kind === "session").map(({ last_used_at: _ignored, ...rest }) => rest);
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = "https://x402git.com";
  process.env.SESSION_SECRET = "test-session-secret";
  resetEnv();
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  mock.seed("creator", [{ id: CREATOR_ID, handle: "adrian", payout_address: "0x01", onboarded_via: "web", terms_version: "2026-08-29" }]);
  key("agent", OLD_AGENT);
  key("session", SESSION_KEY);
  key("session", OTHER_LAPTOP);
});

afterEach(() => {
  resetDb();
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.SESSION_SECRET;
  resetEnv();
});

describe("POST /dashboard/key/rotate (FR-4, FR-58)", () => {
  it("mints a new agent key and shows it once through the sealed box", async () => {
    const res = await POST(post());

    expect(res.status).toBe(303);
    const location = res.headers.get("location") as string;
    expect(new URL(location).pathname).toBe("/dashboard/key");
    // Never in the URL: it would end up in history, in a Referer and in an access log.
    expect(location).not.toContain("x4c_live_");

    const box = res.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${KEY_BOX_COOKIE}=`)) as string;
    const shown = openBox(decodeURIComponent(box.split(";")[0].slice(KEY_BOX_COOKIE.length + 1)));
    expect(shown).toMatch(/^x4c_live_[0-9A-Za-z]{32}$/);
    expect(shown).not.toBe(OLD_AGENT);
    expect(box).toContain("HttpOnly");
  });

  it("revokes the old agent key, leaving exactly one live agent row", async () => {
    await POST(post());

    const old = mock.rows("api_key").find((r) => r.hash === hashApiKey(OLD_AGENT));
    expect(old?.revoked_at).toBeTruthy();
    expect(old?.revoked_reason).toBe("rotated");
    expect(mock.rows("api_key").filter((r) => r.kind === "agent" && r.revoked_at === null)).toHaveLength(1);
  });

  it("leaves every session row intact and does not reseal the cookie", async () => {
    const before = sessionRows().map((r) => ({ ...r }));

    const res = await POST(post());

    expect(sessionRows()).toEqual(before);
    // No `Set-Cookie` for the session: this browser keeps the key it already has.
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
  });

  it("refuses a cookie whose key does not resolve to a live session row", async () => {
    const res = await POST(post(`x4s_live_${"N0t1A2K3e4Y5a6N7y8O9n0E1h2A3s4X5"}`));
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location") as string).pathname).toBe("/api/auth/github");
    expect(mock.rows("api_key").find((r) => r.hash === hashApiKey(OLD_AGENT))?.revoked_at).toBeNull();
  });

  it("refuses a cookie carrying an agent key (FR-56)", async () => {
    const res = await POST(post(OLD_AGENT));
    expect(new URL(res.headers.get("location") as string).pathname).toBe("/api/auth/github");
    expect(mock.rows("api_key").find((r) => r.hash === hashApiKey(OLD_AGENT))?.revoked_at).toBeNull();
  });
});
