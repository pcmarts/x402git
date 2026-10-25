import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashApiKey } from "@/lib/auth/api-key";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { makeMockDb } from "@/lib/test/mock-db";
import { completeGithubCallback } from "./oauth-callback";
import { encodeOAuthState, OAUTH_STATE_COOKIE, openSession, SESSION_COOKIE } from "./session";

const STATE = "state-value-abcdefghijklmnop";
const CREATOR_ID = "11111111-1111-4111-8111-111111111111";

let mock: ReturnType<typeof makeMockDb>;

/** GitHub, mocked at the two calls the callback makes. */
function githubFetch(user: { id: number; login: string } = { id: 4242, login: "adrian" }, token = "gho_token") {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("login/oauth/access_token")) return Response.json({ access_token: token });
    if (url.includes("api.github.com/user")) return Response.json({ ...user, name: null });
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

function request(options: { state?: string | null; cookieState?: string | null; code?: string | null; error?: string } = {}): Request {
  const url = new URL("https://x402git.com/api/auth/github/callback");
  if (options.state !== null) url.searchParams.set("state", options.state ?? STATE);
  if (options.code !== null) url.searchParams.set("code", options.code ?? "the-code");
  if (options.error) url.searchParams.set("error", options.error);

  const headers = new Headers();
  if (options.cookieState !== null) {
    headers.set("cookie", `${OAUTH_STATE_COOKIE}=${encodeURIComponent(encodeOAuthState(options.cookieState ?? STATE, "/dashboard/new"))}`);
  }
  return new Request(url, { headers });
}

/** A creator on Rail A, with the live agent key row FR-55 reads scopes off. */
function seedCreator(agent: Record<string, unknown> = {}) {
  mock.seed("creator", [
    {
      id: CREATOR_ID,
      handle: "adrian",
      github_user_id: "4242",
      payout_address: "0x0000000000000000000000000000000000000001",
      onboarded_via: "web",
      terms_version: "2026-08-29",
    },
  ]);
  mock.seed("api_key", [
    {
      id: "aaaaaaaa-0000-4000-8000-000000000001",
      creator_id: CREATOR_ID,
      kind: "agent",
      hash: hashApiKey("x4c_live_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6"),
      scopes: ["listings:write", "earnings:read"],
      ...agent,
    },
  ]);
}

function location(res: Response): URL {
  return new URL(res.headers.get("location") as string);
}

function sessionCookie(res: Response): string | undefined {
  return res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.split(";")[0]
    .slice(SESSION_COOKIE.length + 1);
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = "https://x402git.com";
  process.env.GITHUB_OAUTH_CLIENT_ID = "client-id";
  process.env.GITHUB_OAUTH_CLIENT_SECRET = "client-secret";
  process.env.SESSION_SECRET = "test-session-secret";
  resetEnv();
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
});

afterEach(() => {
  resetDb();
  for (const key of ["NEXT_PUBLIC_APP_URL", "GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET", "SESSION_SECRET"]) {
    delete process.env[key];
  }
  resetEnv();
});

describe("the state check", () => {
  it("refuses a state that does not match the cookie, before touching GitHub", async () => {
    const fetchImpl = githubFetch();
    const res = await completeGithubCallback(request({ state: "not-the-one" }), { fetchImpl });

    expect(res.status).toBe(303);
    expect(location(res).pathname).toBe("/signin");
    expect(location(res).searchParams.get("error")).toContain("did not start here");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a callback with no state cookie at all", async () => {
    const fetchImpl = githubFetch();
    const res = await completeGithubCallback(request({ cookieState: null }), { fetchImpl });

    expect(location(res).searchParams.get("error")).toContain("expired");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a callback with no state parameter", async () => {
    const fetchImpl = githubFetch();
    const res = await completeGithubCallback(request({ state: null }), { fetchImpl });
    expect(location(res).pathname).toBe("/signin");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("clears the state cookie on failure, so a captured state is single use", async () => {
    const res = await completeGithubCallback(request({ state: "wrong" }), { fetchImpl: githubFetch() });
    const state = res.headers.getSetCookie().find((c) => c.startsWith(`${OAUTH_STATE_COOKIE}=`));
    expect(state?.split(";")[0]).toBe(`${OAUTH_STATE_COOKIE}=`);
  });

  it("passes GitHub's own refusal straight through", async () => {
    const res = await completeGithubCallback(request({ error: "access_denied" }), { fetchImpl: githubFetch() });
    expect(location(res).pathname).toBe("/signin");
  });

  it("refuses a matching state with no code", async () => {
    const fetchImpl = githubFetch();
    const res = await completeGithubCallback(request({ code: null }), { fetchImpl });
    expect(location(res).searchParams.get("error")).toContain("no authorization code");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("a successful callback", () => {
  it("sends a GitHub account with no creator row to bind a wallet first", async () => {
    const res = await completeGithubCallback(request(), { fetchImpl: githubFetch() });

    expect(res.status).toBe(303);
    // `creator.payout_address` is NOT NULL, so no row exists until an address is proved.
    expect(location(res).pathname).toBe("/dashboard/wallet");
    expect(mock.rows("creator")).toHaveLength(0);

    const session = openSession(sessionCookie(res));
    expect(session?.github).toEqual({ id: 4242, login: "adrian", token: "gho_token" });
    expect(session?.creatorId).toBeUndefined();
    // The path asked for survives the detour, for the bind route to hand on.
    expect(session?.next).toBe("/dashboard/new");
  });

  it("sends a known creator to the path they asked for", async () => {
    seedCreator();

    const res = await completeGithubCallback(request(), { fetchImpl: githubFetch() });

    expect(location(res).pathname).toBe("/dashboard/new");
    const session = openSession(sessionCookie(res));
    expect(session?.creatorId).toBe(CREATOR_ID);
    expect(session?.handle).toBe("adrian");
    expect(session?.next).toBeUndefined();
  });

  // FR-55. The spec calls this assertion out by name: before D14 a returning creator's
  // cookie carried no key at all, and the dashboard sent them to re-issue the one their
  // agents were holding.
  it("mints this browser session its own key and seals the plaintext into the cookie", async () => {
    seedCreator();

    const res = await completeGithubCallback(request(), { fetchImpl: githubFetch() });
    const session = openSession(sessionCookie(res));

    expect(session?.apiKey).toBeDefined();
    expect(session?.apiKey).toMatch(/^x4s_live_[0-9A-Za-z]{32}$/);

    const rows = mock.rows("api_key");
    expect(rows).toHaveLength(2); // the seeded agent key, plus the new session key
    const minted = rows.find((r) => r.kind === "session");
    expect(minted?.creator_id).toBe(CREATOR_ID);
    expect(minted?.hash).toBe(hashApiKey(session?.apiKey as string));
    expect(minted?.revoked_at).toBeNull();
    // FR-55: the row's expiry *is* the cookie's expiry.
    expect(Date.parse(minted?.expires_at as string)).toBe((session?.exp as number) * 1000);
    // The plaintext is in the cookie and nowhere else — not on the row, not in the URL.
    expect(sessionCookie(res)).not.toContain("x4s_live_");
    expect(res.headers.get("location")).not.toContain("x4s_live_");
  });

  it("carries the agent key's scopes onto the session key, so a narrowed key narrows the web", async () => {
    seedCreator({ scopes: ["listings:write"] });

    await completeGithubCallback(request(), { fetchImpl: githubFetch() });

    expect(mock.rows("api_key").find((r) => r.kind === "session")?.scopes).toEqual(["listings:write"]);
  });

  it("mints nothing for a GitHub account with no creator row yet", async () => {
    await completeGithubCallback(request(), { fetchImpl: githubFetch() });
    expect(mock.rows("api_key")).toHaveLength(0);
  });

  it("sets an httpOnly session cookie and drops the state cookie", async () => {
    const res = await completeGithubCallback(request(), { fetchImpl: githubFetch() });
    const cookies = res.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));

    expect(session).toContain("HttpOnly");
    expect(session).toContain("SameSite=lax");
    expect(session).toContain("Secure");
    // The state cookie comes back empty, which is what deleting one looks like on the wire.
    const state = cookies.find((c) => c.startsWith(`${OAUTH_STATE_COOKIE}=`));
    expect(state).toBeDefined();
    expect(state?.split(";")[0]).toBe(`${OAUTH_STATE_COOKIE}=`);
  });

  it("does not leave the GitHub token readable in the cookie", async () => {
    const res = await completeGithubCallback(request(), { fetchImpl: githubFetch() });
    expect(sessionCookie(res)).not.toContain("gho_token");
  });

  it("reports a token exchange GitHub rejects, rather than throwing", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ error: "bad_verification_code", error_description: "The code passed is incorrect or expired." }),
    ) as unknown as typeof fetch;

    const res = await completeGithubCallback(request(), { fetchImpl });
    expect(location(res).pathname).toBe("/signin");
    expect(location(res).searchParams.get("error")).toContain("incorrect or expired");
  });
});
