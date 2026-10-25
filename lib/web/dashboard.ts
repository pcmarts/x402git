/**
 * lib/web/dashboard.ts — the guard and the plumbing every dashboard surface shares.
 *
 * Two shapes of caller:
 *
 *   - a page, which wants the creator or a `redirect()` to sign-in;
 *   - a form's route handler, which wants the creator *and a bearer key*, because every
 *     mutation on the dashboard is an HTTP call to the same creator endpoint an agent
 *     would use (D9).
 *
 * Since D14 ("PRD Session Keys.md") that bearer key is the session's own `x4s_live_…`
 * key, minted silently at sign-in and revoked at sign-out — not the creator's agent key,
 * which the dashboard used to borrow out of the cookie. So there is no such thing as a
 * signed-in creator without a key to call with, and no surface here gates on one being
 * missing (FR-59). What can happen is that the key stops resolving — signed out
 * elsewhere, expired, revoked by a scan hit — and that is a sign-in, not a detour.
 */

import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import type { CreatorRow } from "@/lib/db/types";
import { appUrl } from "@/lib/env";
import { openSession, SESSION_COOKIE, type SessionData } from "./session";
import { readCookie } from "./oauth-callback";
import { creatorForSession, currentCreator, currentSession, signInPath } from "./current";

/**
 * The web form's ceilings for the two self-reported fields, deliberately far under the
 * API's 4000 and 500 (2026-08-31, founder: "aggressive character limits").
 *
 * They are a UI contract, not a rule — `PATCH /api/listings/:id` still takes the schema's
 * length, because D9 says the browser is one client of the API and not its gatekeeper.
 * What they buy is a description that survives being a card blurb, a listing tagline and
 * an OpenGraph line without being cut in three different places, and a trigger hint that
 * stays the one sentence an agent can act on.
 */
export const DESCRIPTION_LIMIT = 200;
export const TRIGGER_HINT_LIMIT = 120;

export type Dashboard = { session: SessionData; creator: CreatorRow };

/**
 * A signed-in creator, or a redirect out of here. Three outcomes, in the order they
 * happen: no session at all → GitHub; a session with a GitHub identity but no creator
 * row → bind a wallet; a creator → the page renders.
 */
export async function requireDashboard(next: string): Promise<Dashboard> {
  const current = await currentCreator();
  if (current) return current;

  const session = await currentSession();
  if (!session) redirect(signInPath(next));
  redirect("/dashboard/wallet");
}

export type Actor = { session: SessionData; creator: CreatorRow; apiKey: string };

/**
 * Resolve the creator behind a form POST. Returns a `NextResponse` instead of an actor
 * when the caller has to go somewhere else first — the route handler returns it as-is.
 *
 * `apiKey` is the plaintext bearer the handler then calls the API with: this session's
 * key, which `creatorForSession` has just proved is a live `session` row belonging to
 * this creator (FR-56). A cookie that fails that check is signed out, full stop; there
 * is no `/dashboard/key` detour any more, because there is nothing on that page a
 * failing session could fix.
 */
export async function requireActor(req: Request, returnTo: string): Promise<Actor | NextResponse> {
  const base = appUrl();
  const session = openSession(readCookie(req, SESSION_COOKIE));
  if (!session) return seeOther(new URL(signInPath(returnTo), base));
  if (!session.creatorId) return seeOther(new URL("/dashboard/wallet", base));

  const current = await creatorForSession(session);
  if (!current || !session.apiKey) return seeOther(new URL(signInPath(returnTo), base));

  return { session, creator: current.creator, apiKey: session.apiKey };
}

/**
 * FR-10 (amended 2026-08-30, and again on 2026-09-01): private repositories only — but
 * the picker now *lists* every granted repository and withholds the button on the public
 * ones, rather than hiding them.
 *
 * A pure predicate on purpose. It is the same rule `POST /api/listings` enforces against
 * GitHub, said one layer earlier so a creator never clicks a button the create call
 * would refuse with `public_repo` — but it is *only* the courtesy half. Nothing here is
 * a check: the request the button sends is one an agent could send by hand, and the
 * server reads the repository's visibility from GitHub either way.
 *
 * Showing the public rows costs nothing and answers the question hiding them provoked:
 * a creator who cannot find a repo in the list could not tell whether they had failed to
 * grant it or whether it was simply public. Now the row is there, greyed, saying which.
 */
export function isSellableRepo(repo: { private?: boolean }): boolean {
  return repo.private === true;
}

/** The two orders the picker offers. `updated` is the default — newest work first. */
export type RepoSort = "updated" | "name";

/** `?sort=` off the URL, narrowed. Anything else is the default rather than an error. */
export function repoSort(value: string | undefined): RepoSort {
  return value === "name" ? "name" : "updated";
}

/**
 * When GitHub last saw work on this repo. `pushed_at` first, `updated_at` as the
 * fallback, `null` when neither is present — a missing date is not "the epoch", and
 * sorting must not bury a repo for a field the payload happened not to carry.
 */
export function repoUpdatedAt(repo: { pushed_at?: string | null; updated_at?: string | null }): string | null {
  const raw = repo.pushed_at ?? repo.updated_at ?? null;
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : raw;
}

/**
 * The picker's order, as a pure function so it can be pinned without a GitHub account.
 *
 * Total and stable both ways: `updated` puts the most recent push first with undated
 * repos last, and *both* orders tie-break on `full_name`, so the list never reshuffles
 * between two loads of the same data. Sorting happens across installations — a creator
 * thinks in "the thing I was working on yesterday", not in which org owns it.
 */
export type SortableRepoRow = { repo: { full_name?: string; name: string; pushed_at?: string | null; updated_at?: string | null } };

export function sortRepoRows<T extends SortableRepoRow>(rows: readonly T[], sort: RepoSort): T[] {
  const byName = (a: T, b: T) => (a.repo.full_name ?? a.repo.name).localeCompare(b.repo.full_name ?? b.repo.name);
  if (sort === "name") return [...rows].sort(byName);

  return [...rows].sort((a, b) => {
    const at = repoUpdatedAt(a.repo);
    const bt = repoUpdatedAt(b.repo);
    if (at && bt) {
      const diff = Date.parse(bt) - Date.parse(at);
      if (diff !== 0) return diff;
    } else if (at !== bt) {
      return at ? -1 : 1;
    }
    return byName(a, b);
  });
}

/** 303, so the browser follows a form POST with a GET. */
export function seeOther(url: URL | string): NextResponse {
  const response = NextResponse.redirect(url, { status: 303 });
  response.headers.set("cache-control", "no-store");
  return response;
}

/**
 * Redirect back to a dashboard page carrying the outcome in the query string.
 *
 * Not a flash cookie: the URL survives a reload, is visible to `curl`, and needs no
 * session write on a GET. The message is the API's own message, so the page never
 * invents a friendlier version of what actually happened.
 */
export function back(path: string, outcome: { ok?: string; error?: string; blocking?: string[]; extra?: Record<string, string> } = {}): NextResponse {
  const url = new URL(path, appUrl());
  if (outcome.ok) url.searchParams.set("ok", outcome.ok);
  if (outcome.error) url.searchParams.set("error", outcome.error);
  if (outcome.blocking && outcome.blocking.length > 0) url.searchParams.set("blocking", outcome.blocking.join(","));
  // An instruction for the page rather than a message on it (`check=1`: run the release
  // check on arrival). The next `back()` does not carry it, so it never survives a reload.
  for (const [key, value] of Object.entries(outcome.extra ?? {})) url.searchParams.set(key, value);
  return seeOther(url);
}
