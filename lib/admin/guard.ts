/**
 * lib/admin/guard.ts — who is allowed to look at everybody's listings.
 *
 * `/admin` is the only surface in the product that reads across creators. Nothing else
 * does: a dashboard page is scoped to `creator.id`, an API route is scoped by
 * `requireCreator`, and the manifest page is public precisely because it is one listing.
 * So this gate is not a variation on the dashboard's — it is a different kind of thing,
 * and it is written to be boring in the ways that matter.
 *
 * **The identity is a GitHub login**, the one FR-1's OAuth proved and the session cookie
 * carries. Not an `is_admin` column on `creator`: an operator is not necessarily a
 * seller, and requiring a bound payout address before somebody can look at a dashboard
 * is a strange thing to ask of the person looking because something appears wrong.
 *
 * **The allow-list is in two halves** (`lib/admin/people.ts`): the root list in
 * `ADMIN_GITHUB_LOGINS`, which the app cannot edit, and the `admin` table, which an
 * administrator edits from `/admin/people`. The root half exists so no sequence of
 * clicks can lock everybody out of the surface needed to undo it.
 *
 * **It fails closed.** `lib/ops/switches.ts` fails open, deliberately, because a switch
 * that cannot be read must never be the reason commerce stopped. This is the opposite
 * case and gets the opposite default: an unset root list and an unreadable table admit
 * nobody. There is no development escape hatch, because the database `next dev` points
 * at is the real one (docs/archive/E2E-REPORT.md).
 *
 * **A non-admin gets a 404, not a 403.** A 403 confirms the route exists and that the
 * reader is simply not on the list, which is an invitation. A signed-*out* reader is
 * sent to GitHub instead, because at that point nothing has been proven either way and
 * a sign-in loop is the honest answer — the route's existence is not the secret, the
 * data behind it is.
 *
 * **Signing out ends admin access too**, where it can. A session that carries a key
 * (FR-55) must still resolve to a live `session` row, which is the same FR-56 check
 * `lib/web/current.ts` makes and is what makes a captured cookie die at sign-out. A
 * session with no key at all is an admin who never bound a payout address, and there is
 * no row to check; that cookie is held to its own two-week expiry and its HMAC.
 */

import { notFound, redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { resolveBearer } from "@/lib/auth/api-key";
import { activeAdminLogins } from "@/lib/admin/people";
import { appUrl } from "@/lib/env";
import { currentSession, signInPath } from "@/lib/web/current";
import { readCookie } from "@/lib/web/oauth-callback";
import { openSession, SESSION_COOKIE, type SessionData } from "@/lib/web/session";

/**
 * Is this login on the list? Pure, so the policy can be tested without a request.
 * An empty list is a refusal, not a wildcard.
 */
export function isAdminLogin(login: string | null | undefined, allowed: Iterable<string>): boolean {
  const want = String(login ?? "").trim().toLowerCase();
  if (want.length === 0) return false;
  for (const a of allowed) {
    if (a.trim().toLowerCase() === want) return true;
  }
  return false;
}

/**
 * Is this `Origin` header one of ours? Absent is allowed — `curl` and some privacy
 * settings send none, and a cross-site browser POST always sends one. `null` (an opaque
 * origin, e.g. a sandboxed iframe) is refused.
 */
export function isSameOrigin(origin: string | null, allowed: readonly string[]): boolean {
  if (origin === null || origin === undefined) return true;
  for (const url of allowed) {
    try {
      if (new URL(url).origin === origin) return true;
    } catch {
      // An unparseable allowed URL admits nothing.
    }
  }
  return false;
}

export type Admin = { session: SessionData; login: string };

/**
 * The FR-56 half, shared by both entry points: a cookie whose key no longer resolves to
 * a live `session` row belonging to this creator has been signed out somewhere else.
 * True means the session is still good.
 */
async function sessionStillLive(session: SessionData): Promise<boolean> {
  if (!session.apiKey) return true;
  const resolved = await resolveBearer(session.apiKey);
  if (!resolved) return false;
  if (resolved.row.kind !== "session") return false;
  if (session.creatorId && resolved.row.creator_id !== session.creatorId) return false;
  return true;
}

/**
 * The admin behind this page request, or an exit. Signed out → GitHub; signed in and not
 * on the list → 404. Both `redirect` and `notFound` throw, so this never returns null.
 */
export async function requireAdmin(next = "/admin"): Promise<Admin> {
  const session = await currentSession();
  if (!session) redirect(signInPath(next));

  if (!isAdminLogin(session.github.login, await activeAdminLogins())) notFound();
  if (!(await sessionStillLive(session))) redirect(signInPath(next));

  return { session, login: session.github.login.toLowerCase() };
}

/**
 * The same gate for a form's route handler, which cannot `notFound()` — it returns a
 * `Response` the handler passes straight back, the shape `requireActor` uses. A refused
 * POST answers 404 for the same reason a refused GET does.
 */
export async function requireAdminRoute(req: Request, next = "/admin"): Promise<Admin | Response> {
  // Admin POSTs now pause commerce and take listings down, so the `SameSite=lax` cookie
  // is no longer the only thing between a cross-site form and a click. A browser always
  // sends `Origin` on a POST; one that names another site is refused like any stranger.
  if (!isSameOrigin(req.headers.get("origin"), [appUrl(), req.url])) {
    return new NextResponse("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  }
  const session = openSession(readCookie(req, SESSION_COOKIE));
  if (!session) return NextResponse.redirect(new URL(signInPath(next), req.url), { status: 303 });

  if (!isAdminLogin(session.github.login, await activeAdminLogins())) {
    return new NextResponse("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  }
  if (!(await sessionStillLive(session))) {
    return NextResponse.redirect(new URL(signInPath(next), req.url), { status: 303 });
  }

  return { session, login: session.github.login.toLowerCase() };
}
