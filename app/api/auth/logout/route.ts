/**
 * POST /api/auth/logout — drop the session cookie *and revoke every session key*.
 *
 * POST rather than GET so a link in a README cannot sign someone out, and 303 so the
 * browser follows with a GET. Signing out on a shared machine has to be one click, so
 * this is the one action on the site that is destructive with no confirmation.
 *
 * The cookie is stateless, so clearing it locally never invalidated a captured copy.
 * What does is the row: since D14 the cookie carries this session's own `x4s_live_…`
 * key, and FR-57 revokes **all** of the creator's session keys in one write — this
 * browser's, another machine's, an attacker's. That is deliberately "everywhere at
 * once"; it is the property that makes signing out anywhere kill a stolen cookie. Agent
 * keys are untouched (FR-58): signing out is not a reason to break somebody's scripts.
 */

import { NextResponse } from "next/server";
import { revokeSessionKeys } from "@/lib/auth/api-key";
import { appUrl } from "@/lib/env";
import { handle } from "@/lib/errors";
import { readCookie } from "@/lib/web/oauth-callback";
import { openSession, SESSION_COOKIE } from "@/lib/web/session";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: Request) => {
  const base = appUrl();

  const session = openSession(readCookie(req, SESSION_COOKIE));
  if (session?.creatorId) {
    try {
      await revokeSessionKeys(session.creatorId, "signed_out");
    } catch (e) {
      // The local cookie still clears; a failed write must not keep someone signed in.
      console.warn("[logout] could not revoke the session keys:", e instanceof Error ? e.message : String(e));
    }
  }

  const response = NextResponse.redirect(new URL("/", base), { status: 303 });
  response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: base.startsWith("https://"), path: "/", maxAge: 0 });
  response.headers.set("cache-control", "no-store");
  return response;
});
