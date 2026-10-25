/**
 * POST /dashboard/wallet/bind — the account is created here (FR-1).
 *
 * Everything before this point is a cookie. This is the write: challenge consumed,
 * address screened, handle taken from the GitHub login, creator row inserted, and both
 * keys minted (D14, FR-55) — because binding a wallet is the one moment that is both
 * "this account now exists" and "a human is sitting in front of it".
 *
 * The two keys go to two different places, and the difference is the whole point:
 *
 *   session  x4s_live_…  sealed into the session cookie. Never shown, never mentioned.
 *   agent    x4c_live_…  shown once on /dashboard/key, then only its hash exists.
 *
 * The agent key travels there in its own sealed one-time cookie (`sealBox`), not in the
 * query string: a redirect URL ends up in browser history, in the Referer of every asset
 * the next page loads, and in any log in front of us. Five minutes, httpOnly, encrypted.
 */

import { NextResponse } from "next/server";
import { appUrl } from "@/lib/env";
import { ApiError, handle } from "@/lib/errors";
import { currentSession, signInPath } from "@/lib/web/current";
import { back, seeOther } from "@/lib/web/dashboard";
import { createCreatorFromGithub } from "@/lib/web/onboard";
import { safeReturnPath } from "@/lib/web/safe-redirect";
import {
  cookieOptions,
  KEY_BOX_COOKIE,
  KEY_BOX_TTL_SEC,
  newSession,
  sealBox,
  sealSession,
  SESSION_COOKIE,
  SESSION_TTL_SEC,
  sessionExpiresAt,
} from "@/lib/web/session";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: Request) => {
  const base = appUrl();
  const session = await currentSession();
  if (!session) return seeOther(new URL(signInPath("/dashboard/wallet"), base));
  if (session.creatorId) return back("/dashboard/wallet", { error: "This account already has a payout address. Use the change form." });

  const form = await req.formData();
  const address = String(form.get("address") ?? "").trim();
  const nonce = String(form.get("nonce") ?? "").trim();
  const signature = String(form.get("signature") ?? "").trim();
  if (!address || !nonce || !signature) {
    return back("/dashboard/wallet", { error: "Paste the signature before submitting." });
  }

  // One `now` for the row and for the cookie: FR-55 wants the session key's `expires_at`
  // to *be* the cookie's `exp`, and computing them from the same instant is the only way
  // that stays true without a comment asking someone to keep two numbers in step.
  const now = new Date();

  let created: Awaited<ReturnType<typeof createCreatorFromGithub>>;
  try {
    created = await createCreatorFromGithub({
      github: session.github,
      address,
      nonce,
      signature,
      sessionExpiresAt: sessionExpiresAt(now),
    });
  } catch (e) {
    // A burnt nonce cannot be retried, so send them back to the first step, not the second.
    return back("/dashboard/wallet", {
      error: e instanceof ApiError ? e.message : "That address could not be bound. Start again with a fresh challenge.",
    });
  }

  const next = newSession(
    {
      github: session.github,
      creatorId: created.creator.id,
      handle: created.creator.handle,
      apiKey: created.sessionKey,
    },
    now,
  );

  // Straight to the key page rather than to /dashboard: the agent key is on screen for
  // one page load and never again, so the page that shows it is the one to land on.
  const url = new URL("/dashboard/key", base);
  // The notice sits on a row with the ordinary Copy, which takes the sentence, so the
  // sentence points at the key rather than claiming to be it (2026-09-21, founder):
  // the key is a section below, and it now carries a Copy of its own.
  url.searchParams.set("ok", "Account created. Your agent key is below, and this is the only load that shows it. Copy it there.");
  // And the way on from there: the path sign-in was headed for before it detoured through
  // the wallet (`SessionData.next`) — the repo picker, for a creator who installed the App
  // before they had an account. The wallet and key pages are the detour, not a destination.
  const onward = safeReturnPath(session.next, "/dashboard");
  url.searchParams.set("next", /^\/dashboard\/(wallet|key)(?:[/?#]|$)/.test(onward) ? "/dashboard" : onward);
  const response = NextResponse.redirect(url, { status: 303 });
  response.cookies.set(SESSION_COOKIE, sealSession(next), cookieOptions(SESSION_TTL_SEC, base));
  response.cookies.set(KEY_BOX_COOKIE, sealBox(created.agentKey, now), cookieOptions(KEY_BOX_TTL_SEC, base));
  response.headers.set("cache-control", "no-store");
  return response;
});
