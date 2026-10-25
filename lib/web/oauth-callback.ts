/**
 * lib/web/oauth-callback.ts — the body of `GET /api/auth/github/callback` (FR-1).
 *
 * It lives here rather than in the route file for one reason: `fetch` is a parameter,
 * so the state check and the identity resolution can be tested without a GitHub app,
 * a browser or a network. The route is a four-line wrapper.
 *
 * Order matters and is the order failures should surface in: state before code, code
 * before identity, identity before any write. The `state` comparison is constant-time
 * and the cookie is cleared on every outcome, so a captured `state` is single-use.
 */

import { NextResponse } from "next/server";
import { DEFAULT_SCOPES, insertApiKey } from "@/lib/auth/api-key";
import { appUrl, githubOAuthConfig } from "@/lib/env";
import { exchangeCode, fetchUser, GithubOAuthError } from "./github-oauth";
import { agentKeyFor, creatorByGithubUserId } from "./loaders";
import { safeReturnPath } from "./safe-redirect";
import {
  cookieOptions,
  decodeOAuthState,
  newSession,
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_SEC,
  sealSession,
  sessionExpiresAt,
  stateMatches,
} from "./session";

export type CallbackDeps = {
  fetchImpl?: typeof fetch;
};

/** Where an unfinished sign-in lands, with a sentence the reader can act on. */
function failed(base: string, reason: string): NextResponse {
  const url = new URL("/signin", base);
  url.searchParams.set("error", reason);
  const response = NextResponse.redirect(url, { status: 303 });
  response.cookies.delete(OAUTH_STATE_COOKIE);
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function completeGithubCallback(req: Request, deps: CallbackDeps = {}): Promise<NextResponse> {
  const base = appUrl();
  const url = new URL(req.url);
  const params = url.searchParams;

  const denied = params.get("error");
  if (denied) {
    return failed(base, params.get("error_description") ?? "GitHub declined the sign-in.");
  }

  // The state cookie is the whole CSRF defence on this route.
  const cookieValue = readCookie(req, OAUTH_STATE_COOKIE);
  const parked = decodeOAuthState(cookieValue);
  if (!parked) return failed(base, "The sign-in link expired. Start again.");
  if (!stateMatches(parked.state, params.get("state"))) {
    return failed(base, "That sign-in did not start here. Start again from this site.");
  }

  const code = params.get("code");
  if (!code) return failed(base, "GitHub returned no authorization code.");

  let token: string;
  let user: Awaited<ReturnType<typeof fetchUser>>;
  try {
    const { clientId, clientSecret } = githubOAuthConfig();
    token = await exchangeCode({
      clientId,
      clientSecret,
      code,
      redirectUri: `${base}/api/auth/github/callback`,
      fetchImpl: deps.fetchImpl,
    });
    user = await fetchUser(token, deps.fetchImpl);
  } catch (e) {
    return failed(base, e instanceof GithubOAuthError ? e.message : "GitHub did not complete the sign-in.");
  }

  const creator = await creatorByGithubUserId(user.id);

  // No creator row yet: `creator.payout_address` is NOT NULL and FR-26 pays only to the
  // bound address, so the identity waits in the cookie until a wallet is proved. Nothing
  // is minted for it — there is no creator to mint against, and the bind route (FR-55)
  // mints its session key when the row appears. The path asked for waits in the cookie too
  // (`SessionData.next`), so the detour through the wallet does not lose it.
  const destination = creator ? safeReturnPath(parked.next, "/dashboard") : "/dashboard/wallet";

  // FR-55: signing in as an existing creator mints this browser session its own key.
  // Same `now` for both, so the row's `expires_at` is the cookie's `exp` to the second —
  // a session key that outlived its cookie would be a credential nothing can see to
  // revoke, and one that died early would sign a live session out mid-click.
  //
  // Scopes come from the creator's live agent key, so a narrowed key narrows the
  // dashboard too; `DEFAULT_SCOPES` when there is no agent row — none created yet, or it
  // was revoked by a scan hit and never rotated.
  const now = new Date();
  let apiKey: string | undefined;
  if (creator) {
    const agent = await agentKeyFor(creator.id);
    const scopes = agent?.scopes?.length ? agent.scopes : DEFAULT_SCOPES;
    ({ key: apiKey } = await insertApiKey(creator.id, "session", scopes, sessionExpiresAt(now)));
  }

  const session = newSession(
    {
      github: { id: user.id, login: user.login, token },
      creatorId: creator?.id,
      handle: creator?.handle,
      apiKey,
      next: creator ? undefined : parked.next,
    },
    now,
  );

  const response = NextResponse.redirect(new URL(destination, base), { status: 303 });
  response.cookies.set(SESSION_COOKIE, sealSession(session), cookieOptions(SESSION_TTL_SEC, base));
  response.cookies.delete(OAUTH_STATE_COOKIE);
  response.headers.set("cache-control", "no-store");
  return response;
}

/** `Request` has no cookie jar; `NextRequest` does, but this function takes either. */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}
