import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { isApiError } from "@/lib/errors";
import { purgeExpiredIdempotency, recordIdempotent, replayIdempotent } from "@/lib/idempotency";
import { makeMockDb } from "@/lib/test/mock-db";

const ROUTE = "POST /api/creators";
const BODY = { handle: "a1b2c3" };
const RESPONSE = { creator_id: "c1", api_key: "x4c_live_abcdefghijklmnopqrstuvwxyz012345", handle: "a1b2c3" };

let mock: ReturnType<typeof makeMockDb>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  process.env.SESSION_SECRET = "test-session-secret-0123456789abcdef";
  resetEnv();
});

afterEach(() => {
  resetDb();
  delete process.env.SESSION_SECRET;
  resetEnv();
});

describe("idempotency (FR-2)", () => {
  it("replays the identical response, secret field included", async () => {
    await recordIdempotent(ROUTE, "k1", BODY, 201, RESPONSE, null, ["api_key"]);
    expect(await replayIdempotent(ROUTE, "k1", BODY)).toEqual({ status: 201, response: RESPONSE });
  });

  it("stores the secret field sealed, never in the clear (RED-TEAM-2026-09-21.md DB-1)", async () => {
    await recordIdempotent(ROUTE, "k1", BODY, 201, RESPONSE, null, ["api_key"]);
    const row = mock.rows("idempotency")[0];
    expect(JSON.stringify(row)).not.toContain(RESPONSE.api_key);
    expect(row.response).not.toHaveProperty("api_key");
    expect(row.response).toMatchObject({ creator_id: "c1", handle: "a1b2c3" });
  });

  it("stores a response with no secret fields as it is", async () => {
    await recordIdempotent(ROUTE, "k1", BODY, 200, { ok: true });
    expect(mock.rows("idempotency")[0].response).toEqual({ ok: true });
    expect(await replayIdempotent(ROUTE, "k1", BODY)).toEqual({ status: 200, response: { ok: true } });
  });

  it("refuses the replay, naming the way out, once SESSION_SECRET has rotated", async () => {
    await recordIdempotent(ROUTE, "k1", BODY, 201, RESPONSE, null, ["api_key"]);
    process.env.SESSION_SECRET = "a-different-session-secret-0123456789";
    resetEnv();

    const thrown = await replayIdempotent(ROUTE, "k1", BODY).catch((e) => e);
    expect(isApiError(thrown)).toBe(true);
    expect(String(thrown.message)).toContain("/api/auth/rotate-key");
    expect(JSON.stringify(thrown)).not.toContain(RESPONSE.api_key);
  });

  it("does not replay past 24 hours, and the purge deletes exactly those rows", async () => {
    await recordIdempotent(ROUTE, "old", BODY, 201, RESPONSE, null, ["api_key"]);
    await recordIdempotent(ROUTE, "new", BODY, 201, RESPONSE, null, ["api_key"]);
    const old = mock.rows("idempotency").find((r) => String(r.key).endsWith(":old"))!;
    old.created_at = new Date(Date.now() - 25 * 3600 * 1000).toISOString();

    expect(await replayIdempotent(ROUTE, "old", BODY)).toBeNull();
    expect(await purgeExpiredIdempotency()).toBe(1);
    expect(mock.rows("idempotency").map((r) => r.key)).toEqual([`${ROUTE}:new`]);
  });
});
