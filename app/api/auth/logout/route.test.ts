/**
 * FR-57/FR-58, which are one requirement seen from two sides: signing out kills every
 * session key the creator has, and leaves the agent key alone. Clearing the cookie is
 * the visible half; the row write is the half that reaches a cookie somebody copied.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashApiKey } from "@/lib/auth/api-key";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { makeMockDb } from "@/lib/test/mock-db";
import { newSession, sealSession, SESSION_COOKIE } from "@/lib/web/session";
import { POST } from "./route";

const CREATOR_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const THIS_BROWSER = `x4s_live_${"S1e2s3S4i5O6n7K8e9Y0a1B2c3D4e5F6"}`;
const OTHER_LAPTOP = `x4s_live_${"L1a2p3T4o5P6t7H8i9S0o1T2h3E4r5X6"}`;
const AGENT = `x4c_live_${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6"}`;

let mock: ReturnType<typeof makeMockDb>;

function key(creatorId: string, kind: "agent" | "session", plaintext: string) {
  mock.rows("api_key").push({
    id: crypto.randomUUID(),
    creator_id: creatorId,
    kind,
    hash: hashApiKey(plaintext),
    scopes: ["listings:write", "earnings:read"],
    created_at: new Date().toISOString(),
    expires_at: kind === "session" ? new Date(Date.now() + 86_400_000).toISOString() : null,
    revoked_at: null,
    revoked_reason: null,
    last_used_at: null,
  });
}

function rows(creatorId: string, kind: "agent" | "session") {
  return mock.rows("api_key").filter((r) => r.creator_id === creatorId && r.kind === kind);
}

/** `null` builds the pre-creator session: a GitHub identity with nothing to revoke. */
function request(creatorId: string | null = CREATOR_ID): Request {
  const session = newSession({
    github: { id: 4242, login: "adrian" },
    creatorId: creatorId ?? undefined,
    apiKey: creatorId ? THIS_BROWSER : undefined,
  });
  return new Request("https://x402git.com/api/auth/logout", {
    method: "POST",
    headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(sealSession(session))}` },
  });
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = "https://x402git.com";
  process.env.SESSION_SECRET = "test-session-secret";
  resetEnv();
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  key(CREATOR_ID, "agent", AGENT);
  key(CREATOR_ID, "session", THIS_BROWSER);
  key(CREATOR_ID, "session", OTHER_LAPTOP);
  key(OTHER_ID, "session", `x4s_live_${"N1o2t3M4i5N6e7X8y9Z0a1B2c3D4e5F6"}`);
});

afterEach(() => {
  resetDb();
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.SESSION_SECRET;
  resetEnv();
});

describe("POST /api/auth/logout (FR-57)", () => {
  it("clears the cookie and redirects home", async () => {
    const res = await POST(request());

    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location") as string).pathname).toBe("/");
    const cleared = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    expect(cleared?.split(";")[0]).toBe(`${SESSION_COOKIE}=`);
    expect(cleared).toContain("Max-Age=0");
  });

  it("revokes every session key of the creator, not only the one presenting", async () => {
    // The point of "everywhere at once": the cookie on the other laptop — or a copy of
    // it in somebody else's hands — stops resolving the moment this returns.
    await POST(request());

    expect(rows(CREATOR_ID, "session")).toHaveLength(2);
    expect(rows(CREATOR_ID, "session").every((r) => r.revoked_at !== null)).toBe(true);
    expect(rows(CREATOR_ID, "session").every((r) => r.revoked_reason === "signed_out")).toBe(true);
  });

  it("leaves the agent key untouched — signing out is not a reason to break scripts (FR-58)", async () => {
    const before = rows(CREATOR_ID, "agent").map((r) => ({ ...r }));
    await POST(request());
    expect(rows(CREATOR_ID, "agent")).toEqual(before);
  });

  it("touches nobody else's rows", async () => {
    await POST(request());
    expect(rows(OTHER_ID, "session").every((r) => r.revoked_at === null)).toBe(true);
  });

  it("still clears the cookie for a session with no creator, and writes nothing", async () => {
    const res = await POST(request(null));
    expect(res.status).toBe(303);
    expect(mock.rows("api_key").every((r) => r.revoked_at === null)).toBe(true);
  });
});
