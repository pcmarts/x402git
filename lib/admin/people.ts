/**
 * lib/admin/people.ts — who the administrators are, and how that list changes.
 *
 * Two lists, and the split is the point (migration 20260907000000):
 *
 * - **Root** is `ADMIN_GITHUB_LOGINS`, in the deployment's environment. It cannot be
 *   granted or revoked from inside the app, so it is the way back in when the table has
 *   gone wrong — an administrator you granted revoking you, or a grant you regret. It is
 *   *recovery*, not anti-lockout: nobody can revoke themselves, so the table can never
 *   be emptied by clicking. **When it is unset there is no way back that does not need a
 *   deploy**, and `/admin/people` says so rather than leaving it implied.
 * - **Granted** is the `admin` table, written by an existing admin from `/admin/people`.
 *
 * Reads fail *safe rather than open*: if the table cannot be read — most likely because
 * the migration has not run on this deployment yet — the granted list is empty and the
 * root list still admits its own. That is a strictly smaller set of admins, never a
 * larger one, so a database that cannot answer this question can never accidentally let
 * somebody in. It is the opposite default from `lib/ops/switches.ts`, for the opposite
 * reason.
 *
 * Nothing here is deleted. Revoking writes `revoked_at`, the same way `api_key` does, so
 * the table answers who was let in, by whom, when, and when they were let go.
 */

import { db } from "@/lib/db";
import type { AdminRow } from "@/lib/db/types";
import { adminGithubLogins } from "@/lib/env";
import { notifyAdmin } from "@/lib/notify";

export type { AdminRow };

/** A row as the page renders it: the record, plus the two things only policy knows. */
export type AdminPerson = {
  login: string;
  /** In `ADMIN_GITHUB_LOGINS`. Cannot be revoked here, and has no row to show. */
  root: boolean;
  live: boolean;
  row: AdminRow | null;
};

/**
 * GitHub's own rule for a username: alphanumerics and single inner hyphens, 1–39 long.
 * Checked before anything is written so a typo becomes a message rather than a row that
 * can never match a real sign-in.
 */
const LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/;

/**
 * Trim, lowercase, strip a leading `@` or a `github.com/` prefix, then validate.
 * Returns null for anything that is not a GitHub login — pasting a profile URL is the
 * likely input and is worth accepting; pasting an email is not.
 */
export function normaliseLogin(input: string | null | undefined): string | null {
  let value = String(input ?? "").trim().toLowerCase();
  value = value.replace(/^https?:\/\/(?:www\.)?github\.com\//, "");
  value = value.replace(/^@/, "").replace(/\/+$/, "");
  return LOGIN.test(value) ? value : null;
}

/** The immutable root list, lowercased. */
export function rootLogins(): string[] {
  return adminGithubLogins();
}

export function isRoot(login: string): boolean {
  return rootLogins().includes(login.toLowerCase());
}

/** Every row in the table, newest grant first. Empty when the table is unreadable. */
export async function adminRows(): Promise<AdminRow[]> {
  try {
    const { data, error } = await db().from("admin").select("*").order("granted_at", { ascending: false });
    if (error) throw error;
    return (data as AdminRow[] | null) ?? [];
  } catch (e) {
    // Fail safe, loudly: no granted admins rather than an unguarded page.
    console.warn("[admin] could not read the admin table; only ADMIN_GITHUB_LOGINS applies:", e instanceof Error ? e.message : String(e));
    return [];
  }
}

/**
 * The logins allowed in right now — root plus every unrevoked row. This is the one
 * function the guard calls.
 */
export async function activeAdminLogins(): Promise<Set<string>> {
  const set = new Set(rootLogins());
  for (const row of await adminRows()) {
    if (!row.revoked_at) set.add(row.github_login.toLowerCase());
  }
  return set;
}

/**
 * The roster the page renders: root logins first (they are the ones that survive a
 * mistake), then granted rows, then revoked ones. A root login that *also* has a row
 * appears once, marked root, because that is the fact that decides what can be done to it.
 */
export function rosterOf(rows: readonly AdminRow[], roots: readonly string[]): AdminPerson[] {
  const byLogin = new Map(rows.map((r) => [r.github_login.toLowerCase(), r]));
  const seen = new Set<string>();
  const out: AdminPerson[] = [];

  for (const login of [...roots].sort()) {
    seen.add(login);
    out.push({ login, root: true, live: true, row: byLogin.get(login) ?? null });
  }
  for (const row of rows) {
    const login = row.github_login.toLowerCase();
    if (seen.has(login)) continue;
    seen.add(login);
    out.push({ login, root: false, live: !row.revoked_at, row });
  }

  // Live before revoked; within each group the order above already holds.
  return [...out.filter((p) => p.live), ...out.filter((p) => !p.live)];
}

export type GrantResult = { ok: true; login: string } | { ok: false; message: string };

/**
 * Let somebody in.
 *
 * Re-granting somebody who is **already live is a no-op**, not a rewrite. The upsert used
 * to fire unconditionally, which quietly replaced `granted_by`, `granted_at` and `note` —
 * destroying the record of who actually let them in and when, which is the whole reason
 * this table keeps those columns. Re-granting somebody who was *revoked* does write, and
 * should: that is a new grant and the new stamp is the true one.
 */
export async function grantAdmin(input: string, by: string, note: string | null): Promise<GrantResult> {
  const login = normaliseLogin(input);
  if (!login) return { ok: false, message: "That is not a GitHub username. Use the login, not an email or a display name." };

  if (isRoot(login)) {
    return { ok: false, message: `${login} is an administrator through ADMIN_GITHUB_LOGINS already, and that list is not editable here.` };
  }

  const existing = (await adminRows()).find((r) => r.github_login.toLowerCase() === login);
  if (existing && !existing.revoked_at) {
    return { ok: false, message: `${login} is already an administrator${existing.granted_by ? `, added by ${existing.granted_by}` : ""}.` };
  }

  const { error } = await db()
    .from("admin")
    .upsert(
      {
        github_login: login,
        note: note && note.length > 0 ? note : null,
        granted_by: by,
        granted_at: new Date().toISOString(),
        // An upsert over a previously revoked row is a re-grant, so the revocation is
        // cleared. The row keeps its identity; the history it loses is one revocation,
        // which the new `granted_at` records the end of anyway.
        revoked_at: null,
        revoked_by: null,
      },
      { onConflict: "github_login" },
    );
  if (error) return { ok: false, message: `Could not save that: ${error.message}` };

  // A change to who can act is itself an operator action (14 Sep 2026). Only here, on the
  // path that wrote: a refused re-grant changed nothing and is not news. The `admin` table
  // is the audit record for this one, so there is no `auditError` to carry.
  await notifyAdmin({ kind: "admin_action", action: "admin_granted", by, via: "admin", subject: login, reason: note ?? null });

  return { ok: true, login };
}

export type RevokeResult = { ok: true; login: string } | { ok: false; message: string };

/**
 * Is there a way back in that the app itself cannot take away?
 *
 * Precisely: is `ADMIN_GITHUB_LOGINS` set. When it is not, every administrator is an
 * ordinary row and any one of them can revoke any other. That is not a *lockout* risk —
 * nobody can revoke themselves, so the person clicking always survives — but it is a
 * **takeover** risk with no recovery: an administrator you granted can revoke you, and
 * the only way back is a deploy. `/admin/people` says so when this is false.
 */
export function hasRootRecovery(): boolean {
  return rootLogins().length > 0;
}

/**
 * Take somebody's access away. Two refusals, both of them about not being able to lock
 * the door from the inside with the key still in it:
 *
 * - **A root login cannot be revoked here.** It is not in this table's gift; the way to
 *   remove one is to edit the deployment's environment.
 * - **You cannot revoke yourself.** Not because it would be unrecoverable — root is what
 *   makes it recoverable — but because it is never the thing somebody meant to click,
 *   and the recovery costs a deploy.
 */
export async function revokeAdmin(input: string, by: string): Promise<RevokeResult> {
  const login = normaliseLogin(input);
  if (!login) return { ok: false, message: "That is not a GitHub username." };

  // A root login may *also* carry a live table row (the migration seeds one). Refusing
  // outright and saying "edit the variable" would be wrong in that case: the env edit
  // alone leaves the row, and the row alone still admits them. So the row is revoked and
  // the message says plainly that it was not enough on its own.
  if (isRoot(login)) {
    const row = (await adminRows()).find((r) => r.github_login.toLowerCase() === login && !r.revoked_at);
    if (!row) {
      return { ok: false, message: `${login} is an administrator through ADMIN_GITHUB_LOGINS. Remove them from that variable and redeploy.` };
    }
    const { error: rowError } = await db()
      .from("admin")
      .update({ revoked_at: new Date().toISOString(), revoked_by: by })
      .eq("github_login", login)
      .is("revoked_at", null);
    if (rowError) return { ok: false, message: `Could not save that: ${rowError.message}` };
    // `ok: false`, but a row *was* revoked, so this one posts — with the caveat in the
    // reason, because "Admin revoked" on its own would read as more than happened.
    await notifyAdmin({
      kind: "admin_action",
      action: "admin_revoked",
      by,
      via: "admin",
      subject: login,
      reason: "granted row only — still an administrator through ADMIN_GITHUB_LOGINS",
    });
    return {
      ok: false,
      message: `Removed ${login}'s granted row, but they are still an administrator through ADMIN_GITHUB_LOGINS. Remove them from that variable and redeploy to finish.`,
    };
  }
  if (login === by.toLowerCase()) {
    return { ok: false, message: "You cannot revoke your own access. Ask another administrator, or edit ADMIN_GITHUB_LOGINS." };
  }

  // Belt and braces over the self-check above: the actor always survives their own
  // revoke, so this cannot trigger today — but it is the invariant that matters ("there
  // is always at least one administrator"), and stating it here means a future caller
  // that skips the self-check cannot empty the table.
  const live = await activeAdminLogins();
  if (live.size <= 1 && live.has(login)) {
    return { ok: false, message: `${login} is the only administrator. Add another before revoking this one.` };
  }

  const { data, error } = await db()
    .from("admin")
    .update({ revoked_at: new Date().toISOString(), revoked_by: by })
    .eq("github_login", login)
    .is("revoked_at", null)
    .select("github_login");
  if (error) return { ok: false, message: `Could not save that: ${error.message}` };
  if (!data || data.length === 0) return { ok: false, message: `${login} is not an administrator.` };

  await notifyAdmin({ kind: "admin_action", action: "admin_revoked", by, via: "admin", subject: login, reason: null });

  return { ok: true, login };
}
