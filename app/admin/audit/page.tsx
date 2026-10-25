/**
 * GET /admin/audit — what operators did, newest first.
 *
 * One timeline from two sources (lib/admin/audit.ts): operator events in the §10
 * `event` table — switches and takedowns, whether clicked here or typed into a script —
 * and the `admin` table's own grant and revoke stamps. The `Via` column is what tells a
 * click from a terminal, and it matters: a script row's `by` is an OS username, which is
 * a hint and not an identity.
 */

import type { Metadata } from "next";
import { AUDIT_LIMIT, loadAudit, type AuditEntry } from "@/lib/admin/audit";
import { requireAdmin } from "@/lib/admin/guard";
import { formatDate, formatDateTime } from "@/lib/web/manifest-view";

export const metadata: Metadata = { title: "Audit" };
export const dynamic = "force-dynamic";

export default async function AdminAuditPage() {
  await requireAdmin("/admin/audit");
  const { entries, truncated } = await loadAudit();

  return (
    <main>
      <h1>Audit</h1>

      <p className="written measure">
        Every kill-switch change and takedown, from this site or from the ops scripts, and every administrator granted or revoked. Rows
        from a script carry the username of the machine that ran it, not a GitHub login.
      </p>

      {truncated ? (
        <p className="written measure" data-status="warn">
          Showing the newest {AUDIT_LIMIT} operator events only. Older ones are still in the event table.
        </p>
      ) : null}

      {entries.length === 0 ? (
        <p className="written measure">Nothing yet. The first switch thrown or listing taken down will appear here.</p>
      ) : (
        <table className="feed">
          <caption>{`${entries.length} entr${entries.length === 1 ? "y" : "ies"} · newest first · times UTC`}</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Action</th>
              <th scope="col">Subject</th>
              <th scope="col" data-col="optional">
                By
              </th>
              <th scope="col" data-col="dense">
                Via
              </th>
              <th scope="col" data-col="dense">
                Detail
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, i) => (
              <AuditRow key={`${entry.at}:${entry.action}:${i}`} entry={entry} />
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  return (
    <tr>
      <td>
        {formatDate(entry.at)} <span data-col="optional">{formatDateTime(entry.at).slice(11, 16)}</span>
      </td>
      <td data-status={statusOf(entry.action)} data-lead="">
        {entry.action}
      </td>
      <td className="wrap">
        {entry.listingId ? (
          <a href={`/admin/listings/${entry.listingId}`}>{entry.subject ?? "listing"}</a>
        ) : (
          (entry.subject ?? <span className="muted">—</span>)
        )}
      </td>
      <td data-col="optional">{entry.by ?? <span className="muted">—</span>}</td>
      <td data-col="dense">{entry.via}</td>
      <td className="wrap muted" data-col="dense">
        {entry.detail || "—"}
      </td>
    </tr>
  );
}

/** Stopping something takes verdict ink; undoing a stop takes the accent; the rest is ink. */
function statusOf(action: string): string | undefined {
  if (action === "switch_paused" || action.startsWith("takedown_")) return "fail";
  if (action === "switch_resumed") return "pass";
  if (action === "admin_revoked") return "warn";
  return undefined;
}
