/**
 * GET /api/auth/github — FR-1, step one.
 *
 * Mints a CSRF `state`, parks it in a short-lived httpOnly cookie alongside the path to
 * come back to, and sends the reader to GitHub with scope `read:user`. Nothing else is
 * requested here: repository access comes from installing the App on one repo, which
 * happens later and separately (§7.1 step 1).
 */

import { NextResponse } from "next/server";
import { appUrl, githubOAuthConfig } from "@/lib/env";
import { handle } from "@/lib/errors";
import { authorizeUrl } from "@/lib/web/github-oauth";
import { safeReturnPath } from "@/lib/web/safe-redirect";
import { cookieOptions, encodeOAuthState, newState, OAUTH_STATE_COOKIE } from "@/lib/web/session";

export const dynamic = "force-dynamic";

/** Ten minutes is long enough for a GitHub login and short enough to be uninteresting. */
const STATE_TTL_SEC = 600;

export const GET = handle(async (req: Request) => {
  const { clientId } = githubOAuthConfig();
  // Only a same-site path: an open redirect through the sign-in link would be a gift.
  const next = safeReturnPath(new URL(req.url).searchParams.get("next"), "/dashboard");

  const state = newState();
  const base = appUrl();

  const response = NextResponse.redirect(
    authorizeUrl({ clientId, redirectUri: `${base}/api/auth/github/callback`, state }),
    { status: 302 },
  );
  response.cookies.set(OAUTH_STATE_COOKIE, encodeOAuthState(state, next), cookieOptions(STATE_TTL_SEC, base));
  response.headers.set("cache-control", "no-store");
  return response;
});
