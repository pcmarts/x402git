/**
 * GET /admin/people — who is allowed to read all of this, and how that changes.
 *
 * Two lists on one page, because the difference between them is the thing an operator
 * needs to understand before they touch either (migration 20260907000000):
 *
 * - **Root** comes from `ADMIN_GITHUB_LOGINS` and cannot be edited here. It is what
 *   makes every other row on this page safe to remove: no sequence of clicks, including
 *   revoking everybody else, can lock the door on the surface you would need to reopen
 *   it. The row says so rather than showing a disabled button, because a control that
 *   cannot work should not render (DESIGN.md).
 * - **Granted** rows are added and removed here, by an administrator, and are never
 *   deleted — a revoked row stays as the record of who was let in and when they were let
 *   go, exactly as `api_key` does.
 *
 * The grant form takes a GitHub login, which is the identity FR-1's OAuth proves. It is
 * not an invitation and sends nothing: the person becomes an administrator the next time
 * they sign in with that account.
 */

import type { Metadata } from "next";
import { Notice } from "@/app/_components/notice";
import { requireAdmin } from "@/lib/admin/guard";
import { adminRows, hasRootRecovery, rootLogins, rosterOf, type AdminPerson } from "@/lib/admin/people";
import { formatDateTime } from "@/lib/web/manifest-view";

export const metadata: Metadata = { title: "Admins" };
export const dynamic = "force-dynamic";

export default async function AdminPeoplePage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { ok, error } = await searchParams;
  const { login: me } = await requireAdmin("/admin/people");

  const roots = rootLogins();
  const roster = rosterOf(await adminRows(), roots);
  const live = roster.filter((p) => p.live);

  return (
    <main>
      <h1>Admins</h1>
      <Notice ok={ok} error={error} />

      <p className="written measure">
        An administrator can read every creator&rsquo;s listings, earnings and payout address. Access is by GitHub account: whoever you
        add here becomes an administrator the next time they sign in with that account. Nothing is sent to them.
      </p>

      {/* The one thing about this page that is not visible from the table: whether there
          is a way back in that the app cannot take away. Without a root list every
          administrator here is an ordinary row, and one you add can revoke you. */}
      {hasRootRecovery() ? null : (
        <p className="written measure" data-status="warn">
          <strong>No recovery account is configured.</strong> Every administrator below is an ordinary row, so anyone you add can revoke
          anyone else — including you — and the only way back in would be a deploy. Set <code>ADMIN_GITHUB_LOGINS</code> in the
          deployment&rsquo;s environment to a login the app cannot revoke.
        </p>
      )}

      <table className="feed">
        <caption>{`${live.length} administrator${live.length === 1 ? "" : "s"} · ${roots.length} from the environment · times UTC`}</caption>
        <thead>
          <tr>
            <th scope="col">GitHub</th>
            <th scope="col" data-col="optional">
              Source
            </th>
            <th scope="col" data-col="optional">
              Since
            </th>
            <th scope="col" data-col="dense">
              By
            </th>
            <th scope="col" data-col="dense">
              Note
            </th>
            <th scope="col">State</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {roster.map((person) => (
            <PersonRow key={person.login} person={person} me={me} />
          ))}
        </tbody>
      </table>

      <section>
        <h2>Add an administrator</h2>
        <form method="post" action="/admin/people/grant">
          <p className="field">
            <label htmlFor="login">GitHub username</label>
            <input
              id="login"
              name="login"
              type="text"
              required
              autoComplete="off"
              spellCheck={false}
              placeholder="octocat"
              // The same shape the server validates (`normaliseLogin`), so an obvious
              // typo is refused before the round trip rather than after it.
              pattern="[A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38}"
            />
            <small className="written">
              The GitHub login, not an email or a display name. A profile URL is fine — it will be trimmed to the username.
            </small>
          </p>
          <p className="field">
            <label htmlFor="note">Note</label>
            <input id="note" name="note" type="text" maxLength={200} autoComplete="off" placeholder="Why this person has access" />
            <small className="written">Optional, and for you. It is shown on this page and nowhere else.</small>
          </p>
          <p className="actions">
            <button type="submit" data-variant="primary">
              Add administrator
            </button>
          </p>
        </form>
      </section>
    </main>
  );
}

function PersonRow({ person, me }: { person: AdminPerson; me: string }) {
  const isMe = person.login === me;
  const row = person.row;

  return (
    <tr>
      <td className="wrap" data-lead="">
        <a href={`https://github.com/${person.login}`} target="_blank" rel="noreferrer">
          {person.login}
        </a>
        {isMe ? <span className="muted"> · you</span> : null}
      </td>
      <td data-col="optional" data-status={person.root ? "pass" : undefined}>
        {person.root ? "environment" : "granted"}
      </td>
      <td data-col="optional">{row?.granted_at ? formatDateTime(row.granted_at) : <span className="muted">—</span>}</td>
      <td data-col="dense">{row?.granted_by ?? <span className="muted">—</span>}</td>
      <td className="wrap written" data-col="dense">
        {row?.note ?? <span className="muted">—</span>}
      </td>
      <td data-status={person.live ? "pass" : "pending"}>
        {person.live ? "active" : `revoked${row?.revoked_by ? ` by ${row.revoked_by}` : ""}`}
      </td>
      <td className="wrap">
        {/* A control that cannot work does not render. A root login is not this table's
            to revoke, and revoking yourself is never what somebody meant to click — so
            both say why in place of a button rather than showing a disabled one. */}
        {person.root ? (
          <span className="muted">in ADMIN_GITHUB_LOGINS</span>
        ) : isMe ? (
          <span className="muted">not yourself</span>
        ) : person.live ? (
          <form method="post" action="/admin/people/revoke" className="repo-action">
            <input type="hidden" name="login" value={person.login} />
            <button type="submit">Revoke</button>
          </form>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
    </tr>
  );
}
