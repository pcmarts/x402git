/**
 * lib/web/dashboard.test.ts — the web guard (FR-56) and the repo picker's pure parts.
 *
 * `isSellableRepo` and `sortRepoRows` are the whole of what `/dashboard/new` decides
 * on its own, and they are pure so those decisions can be pinned without a GitHub
 * account, a session or a render. What `isSellableRepo` protects is the *shape* of a
 * mistake: a public repo offered a button is a `422 public_repo` after the creator has
 * already chosen. What `sortRepoRows` protects is trust in the list — an order that is
 * not total reshuffles between two loads of the same data, and a picker that moves
 * under the cursor is one a creator has to re-read every time.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashApiKey } from "@/lib/auth/api-key";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { makeMockDb } from "@/lib/test/mock-db";
import { isSellableRepo, repoSort, repoUpdatedAt, requireActor, sortRepoRows } from "./dashboard";
import { newSession, sealSession, SESSION_COOKIE, sessionExpiresAt, type SessionData } from "./session";

const row = (name: string, updated?: string | null) => ({
  installationId: 42,
  account: "adrian",
  repo: { id: name.length, name, full_name: `adrian/${name}`, private: true, pushed_at: updated ?? null },
});

describe("isSellableRepo (FR-10, amended 2026-08-30 and 2026-09-01)", () => {
  it("is true for a private repository", () => {
    expect(isSellableRepo({ private: true })).toBe(true);
  });

  it("is false for a public one, which is listed but gets no button", () => {
    expect(isSellableRepo({ private: false })).toBe(false);
  });

  // `private` on the GitHub payload is a boolean, but the picker reads it straight off
  // a JSON response and a missing field must not read as "private by default".
  it("treats a missing `private` as not private", () => {
    expect(isSellableRepo({} as { private?: boolean })).toBe(false);
  });
});

describe("repoSort", () => {
  it("defaults to most-recently-updated", () => {
    expect(repoSort(undefined)).toBe("updated");
  });

  it("takes name when asked", () => {
    expect(repoSort("name")).toBe("name");
  });

  // The query string is user input; an unknown value is a default, not a 500.
  it("falls back to the default for anything it does not know", () => {
    expect(repoSort("size")).toBe("updated");
    expect(repoSort("")).toBe("updated");
  });
});

describe("repoUpdatedAt", () => {
  it("prefers the last push over the metadata timestamp", () => {
    expect(repoUpdatedAt({ pushed_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-30T00:00:00Z" })).toBe("2026-08-01T00:00:00Z");
  });

  it("falls back to updated_at when nothing has been pushed", () => {
    expect(repoUpdatedAt({ pushed_at: null, updated_at: "2026-08-30T00:00:00Z" })).toBe("2026-08-30T00:00:00Z");
  });

  it("is null when there is no date, rather than the epoch", () => {
    expect(repoUpdatedAt({})).toBeNull();
    expect(repoUpdatedAt({ pushed_at: "not a date" })).toBeNull();
  });
});

describe("sortRepoRows", () => {
  it("puts the most recently pushed repository first", () => {
    const rows = [row("a", "2026-01-01T00:00:00Z"), row("b", "2026-08-30T00:00:00Z"), row("c", "2026-05-01T00:00:00Z")];
    expect(sortRepoRows(rows, "updated").map((r) => r.repo.name)).toEqual(["b", "c", "a"]);
  });

  it("sorts by full name when asked, so orgs group together", () => {
    const rows = [row("zebra", "2026-08-30T00:00:00Z"), row("apple", "2026-01-01T00:00:00Z")];
    expect(sortRepoRows(rows, "name").map((r) => r.repo.name)).toEqual(["apple", "zebra"]);
  });

  it("sends undated repositories to the end rather than to 1970", () => {
    const rows = [row("undated", null), row("recent", "2026-08-30T00:00:00Z"), row("old", "2020-01-01T00:00:00Z")];
    expect(sortRepoRows(rows, "updated").map((r) => r.repo.name)).toEqual(["recent", "old", "undated"]);
  });

  // Two repos pushed in the same second must not swap places between two loads.
  it("breaks ties on name, so the order is total", () => {
    const same = "2026-08-30T00:00:00Z";
    const rows = [row("c", same), row("a", same), row("b", same)];
    expect(sortRepoRows(rows, "updated").map((r) => r.repo.name)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the list it was given", () => {
    const rows = [row("c", "2026-01-01T00:00:00Z"), row("a", "2026-08-30T00:00:00Z")];
    sortRepoRows(rows, "updated");
    expect(rows.map((r) => r.repo.name)).toEqual(["c", "a"]);
  });

  it("returns nothing for nothing, rather than throwing", () => {
    expect(sortRepoRows([], "updated")).toEqual([]);
  });
});

// --- requireActor (FR-56, FR-59) ---------------------------------------------

const CREATOR_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_KEY = `x4s_live_${"S1e2s3S4i5O6n7K8e9Y0a1B2c3D4e5F6"}`;
const AGENT_KEY = `x4c_live_${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6"}`;

let mock: ReturnType<typeof makeMockDb>;

/** A `Request` carrying a sealed cookie for the given session fields. */
function signedIn(overrides: Partial<Omit<SessionData, "iat" | "exp">> = {}): Request {
  const session = newSession({
    github: { id: 4242, login: "adrian" },
    creatorId: CREATOR_ID,
    handle: "adrian",
    apiKey: SESSION_KEY,
    ...overrides,
  });
  return new Request("https://x402git.com/dashboard/1/actions/save", {
    method: "POST",
    headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(sealSession(session))}` },
  });
}

function key(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  });
}

/** The `Location` of a guard that refused, or null when it let the caller through. */
function refusedTo(result: unknown): string | null {
  return result instanceof Response ? new URL(result.headers.get("location") as string).pathname : null;
}

describe("requireActor", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = "https://x402git.com";
    process.env.SESSION_SECRET = "test-session-secret";
    resetEnv();
    mock = makeMockDb();
    setDb(mock.client as unknown as Db);
    mock.seed("creator", [
      { id: CREATOR_ID, handle: "adrian", payout_address: "0x01", onboarded_via: "web", terms_version: "2026-08-29" },
      { id: OTHER_ID, handle: "blair", payout_address: "0x02", onboarded_via: "web", terms_version: "2026-08-29" },
    ]);
  });

  afterEach(() => {
    resetDb();
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.SESSION_SECRET;
    resetEnv();
  });

  it("returns the creator and the session key a form handler calls the API with", async () => {
    key();
    const actor = await requireActor(signedIn(), "/dashboard");

    expect(actor).not.toBeInstanceOf(Response);
    if (actor instanceof Response) return;
    expect(actor.creator.id).toBe(CREATOR_ID);
    expect(actor.creator.handle).toBe("adrian");
    expect(actor.apiKey).toBe(SESSION_KEY);
  });

  it("sends a request with no cookie at all to sign in", async () => {
    const bare = new Request("https://x402git.com/dashboard/1/actions/save", { method: "POST" });
    expect(refusedTo(await requireActor(bare, "/dashboard"))).toBe("/api/auth/github");
  });

  it("sends a GitHub session with no creator row to bind a wallet", async () => {
    const pre = new Request("https://x402git.com/x", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(sealSession(newSession({ github: { id: 7, login: "new" } })))}` },
    });
    expect(refusedTo(await requireActor(pre, "/dashboard"))).toBe("/dashboard/wallet");
  });

  // §10.6. A hand-built cookie carrying a perfectly valid *agent* key must not ride the
  // web paths: sign-out revokes session rows, and would never revoke that key.
  it("refuses a cookie carrying an agent key", async () => {
    mock.rows("api_key").push({
      id: crypto.randomUUID(),
      creator_id: CREATOR_ID,
      kind: "agent",
      hash: hashApiKey(AGENT_KEY),
      scopes: ["listings:write", "earnings:read"],
      created_at: new Date().toISOString(),
      expires_at: null,
      revoked_at: null,
      revoked_reason: null,
      last_used_at: null,
    });

    expect(refusedTo(await requireActor(signedIn({ apiKey: AGENT_KEY }), "/dashboard"))).toBe("/api/auth/github");
  });

  it("refuses a revoked session key (FR-57: signed out on another device)", async () => {
    key({ revoked_at: new Date().toISOString(), revoked_reason: "signed_out" });
    expect(refusedTo(await requireActor(signedIn(), "/dashboard"))).toBe("/api/auth/github");
  });

  it("refuses an expired session key, whatever the cookie claims", async () => {
    key({ expires_at: new Date(Date.now() - 1000).toISOString() });
    expect(refusedTo(await requireActor(signedIn(), "/dashboard"))).toBe("/api/auth/github");
  });

  it("refuses a key that belongs to a different creator than the cookie names", async () => {
    key({ creator_id: OTHER_ID });
    expect(refusedTo(await requireActor(signedIn(), "/dashboard"))).toBe("/api/auth/github");
  });

  it("refuses a key no row knows about", async () => {
    expect(refusedTo(await requireActor(signedIn(), "/dashboard"))).toBe("/api/auth/github");
  });

  // FR-59: the `/dashboard/key?next=` detour is gone. There is nothing on that page a
  // session whose key stopped resolving could fix, so every refusal is a sign-in.
  it("never sends anyone to /dashboard/key", async () => {
    key({ revoked_at: new Date().toISOString() });
    const refused = await requireActor(signedIn(), "/dashboard/7");
    expect(refused).toBeInstanceOf(Response);
    expect((refused as Response).headers.get("location")).not.toContain("/dashboard/key");
  });
});
