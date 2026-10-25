/**
 * POST /dashboard/wallet/bind — the account is created here (FR-1).
 *
 * Everything before this point is a cookie. This is the write: challenge consumed,
 * address screened, handle taken from the GitHub login, creator row inserted, and the
 * browser's session key minted (D14, FR-55) — sealed into the session cookie, never
 * shown, never mentioned.
 *
 * No agent key is minted here (25 Oct 2026, DECISIONS.md). Sign-up is wallet → repo
 * picker → price and details → publish; a creator who wants a key for a script makes one
 * from `/dashboard/key`, which is in the dashboard nav, and sees it there once.
 */

import { NextResponse } from "next/server";
import { stellarBindReason } from "@/lib/auth/stellar-binding";
import { appUrl } from "@/lib/env";
import { ApiError, handle } from "@/lib/errors";
import { currentSession, signInPath } from "@/lib/web/current";
import { back, seeOther } from "@/lib/web/dashboard";
import { createCreatorFromGithub } from "@/lib/web/onboard";
import { safeReturnPath } from "@/lib/web/safe-redirect";
import { cookieOptions, newSession, sealSession, SESSION_COOKIE, SESSION_TTL_SEC, sessionExpiresAt } from "@/lib/web/session";

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
    // A missing trustline (JOURNEYS C2 step 3) is checked before the nonce is spent, and
    // the page renders the Freighter steps and a Refresh for exactly this account.
    if (stellarBindReason(e) === "no_trustline") {
      const url = new URL("/dashboard/wallet", base);
      url.searchParams.set("trustline", address);
      return seeOther(url);
    }
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

  // On to the repo picker: the next thing after a wallet is choosing what to sell. The
  // path sign-in was parked on (`SessionData.next`) wins when it is somewhere real — the
  // picker with an installation id, for a creator who installed the App first — but the
  // dashboard root and the two detour pages are not destinations for a brand-new account.
  const parked = safeReturnPath(session.next, "/dashboard/new");
  const onward = /^\/dashboard(?:\/?(?:[?#]|$)|\/(?:wallet|key)(?:[/?#]|$))/.test(parked) ? "/dashboard/new" : parked;
  const url = new URL(onward, base);
  url.searchParams.set("ok", "Account created.");
  const response = NextResponse.redirect(url, { status: 303 });
  response.cookies.set(SESSION_COOKIE, sealSession(next), cookieOptions(SESSION_TTL_SEC, base));
  response.headers.set("cache-control", "no-store");
  return response;
});
