import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { makeMockDb } from "@/lib/test/mock-db";
import {
  AGENT_KEY_PREFIX,
  apiKeyFrom,
  generateApiKey,
  hashApiKey,
  hashesEqual,
  insertApiKey,
  looksLikeApiKey,
  requireCreator,
  resolveBearer,
  revokeApiKeyByHash,
  revokeSessionKeys,
  rotateAgentKey,
  SESSION_KEY_PREFIX,
} from "./api-key";

let mock: ReturnType<typeof makeMockDb>;

const CREATOR = { id: "c1", handle: "adrian", payout_address: "0xabc", onboarded_via: "api", terms_version: "2026-08-29" };

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
});
afterEach(() => resetDb());

function request(authorization?: string): Request {
  return new Request("https://x402git.com/api/creators/me", { headers: authorization ? { authorization } : {} });
}

/** A creator with whatever key rows the case needs. */
function seedCreator(): void {
  mock.seed("creator", [CREATOR]);
}

const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();
const anHourAgo = () => new Date(Date.now() - 3_600_000).toISOString();

describe("generateApiKey", () => {
  it("mints an agent key as x4c_live_ plus 32 base62 characters (FR-4, the secret-scanning prefix)", () => {
    const { key } = generateApiKey("agent");
    expect(key.startsWith(AGENT_KEY_PREFIX)).toBe(true);
    expect(key.length).toBe(AGENT_KEY_PREFIX.length + 32);
    expect(looksLikeApiKey(key)).toBe(true);
  });

  it("mints a session key as x4s_live_ plus 32 base62 characters (FR-60)", () => {
    const { key } = generateApiKey("session");
    expect(key.startsWith(SESSION_KEY_PREFIX)).toBe(true);
    expect(key.length).toBe(SESSION_KEY_PREFIX.length + 32);
    expect(looksLikeApiKey(key)).toBe(true);
  });

  it("rejects anything that is not one of the two prefixes at the right length", () => {
    expect(looksLikeApiKey("x4c_live_short")).toBe(false);
    expect(looksLikeApiKey(`x4x_live_${"a".repeat(32)}`)).toBe(false);
    // The session *cookie* shares the `x4s` stem and must never look like a key (FR-60).
    expect(looksLikeApiKey("x4s.payload.mac")).toBe(false);
  });

  it("returns a sha256 hash of the plaintext, and only the hash is ever stored", () => {
    const { key, hash } = generateApiKey("agent");
    expect(hash).toBe(hashApiKey(key));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(key);
  });

  it("does not repeat", () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey("agent").key));
    expect(keys.size).toBe(200);
  });

  it("uses the whole base62 alphabet without bias towards the low characters", () => {
    const chars = new Set(Array.from({ length: 200 }, () => generateApiKey("agent").key.slice(AGENT_KEY_PREFIX.length)).join(""));
    expect(chars.size).toBeGreaterThan(55);
  });
});

describe("hashesEqual", () => {
  it("compares equal hashes and rejects different ones", () => {
    const { hash } = generateApiKey("agent");
    expect(hashesEqual(hash, hash)).toBe(true);
    expect(hashesEqual(hash, generateApiKey("agent").hash)).toBe(false);
  });

  it("is false for an empty or malformed input rather than throwing", () => {
    expect(hashesEqual("", "")).toBe(false);
  });
});

describe("apiKeyFrom", () => {
  it("reads `Bearer <key>` and a bare key", () => {
    const { key } = generateApiKey("agent");
    expect(apiKeyFrom(request(`Bearer ${key}`))).toBe(key);
    expect(apiKeyFrom(request(key))).toBe(key);
    expect(apiKeyFrom(request())).toBeNull();
  });
});

describe("insertApiKey (FR-54)", () => {
  it("stores the hash and returns the plaintext exactly once", async () => {
    seedCreator();
    const { key, row } = await insertApiKey("c1", "agent");

    expect(row.hash).toBe(hashApiKey(key));
    expect(JSON.stringify(mock.rows("api_key"))).not.toContain(key);
    expect(row.scopes).toEqual(["listings:write", "earnings:read"]);
    expect(row.expires_at).toBeNull();
  });

  it("refuses a session key with no expiry — the table CHECK, enforced early", async () => {
    seedCreator();
    await expect(insertApiKey("c1", "session", ["listings:write"], null)).rejects.toBeInstanceOf(TypeError);
  });
});

describe("resolveBearer (FR-56)", () => {
  it("returns the row and its creator for a live key", async () => {
    seedCreator();
    const { key } = await insertApiKey("c1", "agent");

    const resolved = await resolveBearer(key);
    expect(resolved?.creator.handle).toBe("adrian");
    expect(resolved?.row.kind).toBe("agent");
  });

  it("is null for a revoked row", async () => {
    seedCreator();
    const { key, row } = await insertApiKey("c1", "agent");
    await revokeApiKeyByHash(row.hash, "rotated");

    expect(await resolveBearer(key)).toBeNull();
  });

  it("is null for an expired session key, whatever the cookie believes", async () => {
    seedCreator();
    const live = await insertApiKey("c1", "session", ["listings:write"], inAnHour());
    const dead = await insertApiKey("c1", "session", ["listings:write"], anHourAgo());

    expect(await resolveBearer(live.key)).not.toBeNull();
    expect(await resolveBearer(dead.key)).toBeNull();
  });

  it("is null for an unknown key and for a row whose creator is gone", async () => {
    const { key } = generateApiKey("agent");
    expect(await resolveBearer(key)).toBeNull();

    const orphan = await insertApiKey("c-gone", "agent");
    expect(await resolveBearer(orphan.key)).toBeNull();
  });
});

describe("requireCreator", () => {
  it("returns the creator the key hashes to, carrying the row's kind and scopes (FR-61)", async () => {
    seedCreator();
    const { key, row } = await insertApiKey("c1", "agent");

    const creator = await requireCreator(request(`Bearer ${key}`), "listings:write");
    expect(creator.handle).toBe("adrian");
    expect(creator.apiKey).toEqual({ id: row.id, kind: "agent", scopes: ["listings:write", "earnings:read"] });
  });

  it("accepts a session key on the same endpoints (D9, FR-56)", async () => {
    seedCreator();
    const { key } = await insertApiKey("c1", "session", ["listings:write", "earnings:read"], inAnHour());

    const creator = await requireCreator(request(`Bearer ${key}`), "listings:write");
    expect(creator.apiKey.kind).toBe("session");
  });

  it("is invalid_key when the header is missing, malformed, unknown, revoked or expired", async () => {
    seedCreator();
    await expect(requireCreator(request())).rejects.toMatchObject({ code: "invalid_key", status: 401 });
    await expect(requireCreator(request("Bearer nope"))).rejects.toMatchObject({ code: "invalid_key" });
    await expect(requireCreator(request(`Bearer ${generateApiKey("agent").key}`))).rejects.toMatchObject({ code: "invalid_key" });

    const expired = await insertApiKey("c1", "session", ["listings:write"], anHourAgo());
    await expect(requireCreator(request(`Bearer ${expired.key}`))).rejects.toMatchObject({ code: "invalid_key" });
  });

  it("is insufficient_scope when the key lacks the scope the route needs", async () => {
    seedCreator();
    const { key } = await insertApiKey("c1", "agent", ["earnings:read"]);

    await expect(requireCreator(request(`Bearer ${key}`), "listings:write")).rejects.toMatchObject({ code: "insufficient_scope", status: 403 });
    await expect(requireCreator(request(`Bearer ${key}`), "earnings:read")).resolves.toMatchObject({ handle: "adrian" });
  });

  it("never reveals whether a well-formed key exists by the error it returns", async () => {
    const unknown = await requireCreator(request(`Bearer ${generateApiKey("agent").key}`)).catch((e) => e);
    const malformed = await requireCreator(request("Bearer x4c_live_short")).catch((e) => e);
    expect(unknown.code).toBe(malformed.code);
    expect(unknown.message).toBe(malformed.message);
  });
});

describe("rotateAgentKey (FR-58)", () => {
  it("revokes the old agent row and the old plaintext stops resolving", async () => {
    seedCreator();
    const old = await insertApiKey("c1", "agent", ["listings:write"]);

    const rotated = await rotateAgentKey("c1");
    expect(rotated.key).not.toBe(old.key);
    expect(await resolveBearer(old.key)).toBeNull();
    expect((await resolveBearer(rotated.key))?.row.kind).toBe("agent");

    const previous = mock.rows("api_key").find((r) => r.id === old.row.id);
    expect(previous?.revoked_reason).toBe("rotated");
    expect(previous?.revoked_at).toBeTruthy();
  });

  it("carries the old row's scopes over, and falls back to the defaults with no old row", async () => {
    seedCreator();
    await insertApiKey("c1", "agent", ["earnings:read"]);
    expect((await rotateAgentKey("c1")).row.scopes).toEqual(["earnings:read"]);

    mock.seed("creator", [{ ...CREATOR, id: "c2", handle: "blair" }]);
    expect((await rotateAgentKey("c2")).row.scopes).toEqual(["listings:write", "earnings:read"]);
  });

  it("leaves the creator's session keys alone — rotation is not a sign-out", async () => {
    seedCreator();
    await insertApiKey("c1", "agent");
    const session = await insertApiKey("c1", "session", ["listings:write"], inAnHour());

    await rotateAgentKey("c1");
    expect(await resolveBearer(session.key)).not.toBeNull();
  });
});

describe("revokeApiKeyByHash (FR-4, FR-57, §14.7)", () => {
  it("marks the row revoked in place — no hash rewriting — and reports the creator", async () => {
    seedCreator();
    const { key, row } = await insertApiKey("c1", "agent");

    expect(await revokeApiKeyByHash(hashApiKey(key))).toEqual(["c1"]);

    const stored = mock.rows("api_key").find((r) => r.id === row.id);
    expect(stored?.hash).toBe(hashApiKey(key)); // the `revoked:` prefix trick is gone
    expect(stored?.revoked_reason).toBe("found_in_repository");
    expect(await resolveBearer(key)).toBeNull();
  });

  it("also revokes that creator's session keys when the scan hits their agent key", async () => {
    seedCreator();
    const agent = await insertApiKey("c1", "agent");
    const session = await insertApiKey("c1", "session", ["listings:write"], inAnHour());

    await revokeApiKeyByHash(agent.row.hash);

    const stored = mock.rows("api_key").find((r) => r.id === session.row.id);
    expect(stored?.revoked_reason).toBe("agent_key_compromised");
    expect(await resolveBearer(session.key)).toBeNull();
  });

  it("does not touch another creator's session keys", async () => {
    seedCreator();
    mock.seed("creator", [CREATOR, { ...CREATOR, id: "c2", handle: "blair" }]);
    const agent = await insertApiKey("c1", "agent");
    const other = await insertApiKey("c2", "session", ["listings:write"], inAnHour());

    await revokeApiKeyByHash(agent.row.hash);
    expect(await resolveBearer(other.key)).not.toBeNull();
  });

  it("is idempotent: a second hit revokes nothing and reports nothing", async () => {
    seedCreator();
    const { row } = await insertApiKey("c1", "agent");

    await revokeApiKeyByHash(row.hash);
    const first = mock.rows("api_key").find((r) => r.id === row.id)?.revoked_at;
    expect(await revokeApiKeyByHash(row.hash)).toEqual([]);
    expect(mock.rows("api_key").find((r) => r.id === row.id)?.revoked_at).toBe(first);
  });

  it("is a no-op for a key that is not ours", async () => {
    expect(await revokeApiKeyByHash(hashApiKey("x4c_live_notours"))).toEqual([]);
  });
});

describe("revokeSessionKeys (FR-57)", () => {
  it("revokes every live session key of the creator and nothing else", async () => {
    seedCreator();
    mock.seed("creator", [CREATOR, { ...CREATOR, id: "c2", handle: "blair" }]);
    const agent = await insertApiKey("c1", "agent");
    const one = await insertApiKey("c1", "session", ["listings:write"], inAnHour());
    const two = await insertApiKey("c1", "session", ["listings:write"], inAnHour());
    const elsewhere = await insertApiKey("c2", "session", ["listings:write"], inAnHour());

    await revokeSessionKeys("c1", "signed_out");

    expect(await resolveBearer(one.key)).toBeNull();
    expect(await resolveBearer(two.key)).toBeNull();
    expect(await resolveBearer(agent.key)).not.toBeNull();
    expect(await resolveBearer(elsewhere.key)).not.toBeNull();
    expect(mock.rows("api_key").find((r) => r.id === one.row.id)?.revoked_reason).toBe("signed_out");
  });
});
