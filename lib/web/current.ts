/**
 * lib/web/current.ts — reading the session inside a server component.
 *
 * Kept apart from `lib/web/session.ts` so the crypto stays testable without pulling in
 * `next/headers`, which only exists inside a request.
 */

import { cookies } from "next/headers";
import { resolveBearer } from "@/lib/auth/api-key";
import type { CreatorRow } from "@/lib/db/types";
import { openSession, SESSION_COOKIE, type SessionData } from "./session";

export async function currentSession(): Promise<SessionData | null> {
  const store = await cookies();
  return openSession(store.get(SESSION_COOKIE)?.value);
}

/**
 * The session, or null, for a page that only wants to know which word to print in the
 * footer — and that is also rendered outside a request.
 *
 * `cookies()` throws when there is no request context, which is exactly the situation
 * `app/[owner]/[slug]/page.test.ts` renders the manifest page in: it awaits the server
 * component directly and asserts on the markup. A page that reads the session only to
 * choose between "Sign in" and "Sign out" should not become untestable for it, and
 * should not 500 for it either. Anything that *gates* on identity — a draft listing, the
 * dashboard — uses `currentSession` and lets the throw happen.
 */
export async function optionalSession(): Promise<SessionData | null> {
  try {
    return await currentSession();
  } catch {
    return null;
  }
}

export type CurrentCreator = { session: SessionData; creator: CreatorRow };

/**
 * FR-56, and the one rule every web guard shares: the cookie's key must resolve to a
 * **live `session` row belonging to the creator the cookie names**.
 *
 * Three refusals in one check, and each of them matters on its own:
 *
 * - *No row, revoked, or expired* — `resolveBearer` says null. This is what makes
 *   signing out (FR-57) kill a captured cookie, and it is what replaced the epoch
 *   counter: a revocable row per session is the record the stateless cookie never had.
 * - *`kind` is not `session`* — a cookie minted before D14 carries a plaintext **agent**
 *   key. It authenticates fine at the API, and must not ride the web paths here, where
 *   sign-out would never revoke it ("PRD Session Keys.md" §7, deploy note).
 * - *The row belongs to somebody else* — a cookie that pairs one creator's id with
 *   another's key resolves to neither.
 *
 * Returns null rather than a stale session when the creator row is gone, too, so a
 * deleted account cannot leave a dashboard half-rendered. `resolveBearer` returns the
 * creator, so this is the only read the guard needs.
 */
export async function creatorForSession(session: SessionData | null): Promise<CurrentCreator | null> {
  if (!session?.creatorId || !session.apiKey) return null;
  const resolved = await resolveBearer(session.apiKey);
  if (!resolved) return null;
  if (resolved.row.kind !== "session" || resolved.row.creator_id !== session.creatorId) return null;
  return { session, creator: resolved.creator };
}

/** The signed-in creator, or null. */
export async function currentCreator(): Promise<CurrentCreator | null> {
  return creatorForSession(await currentSession());
}

/** `/api/auth/github?next=<path>` — where an unauthenticated page sends the reader. */
export function signInPath(next = "/dashboard"): string {
  return `/api/auth/github?next=${encodeURIComponent(next)}`;
}
