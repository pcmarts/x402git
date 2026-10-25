/**
 * lib/admin/audit.ts — what operators did, and who did it.
 *
 * Until 2026-09-13 every admin surface was read-only, so there was nothing to audit
 * except the `admin` table, which audits itself. Now `/admin/ops` can throw a kill
 * switch and `/admin/listings/:id` can take a listing down, and "who paused payments at
 * 3am" has to have an answer that is not somebody's memory.
 *
 * **The trail is the §10 `event` table, not a new one.** The takedown script already
 * writes `takedown_retired` and `takedown_revoked` there, so an admin action written
 * anywhere else would split one history into two places. Every action from the web adds
 * `props.by` (the GitHub login, taken from the session, never from the form) and
 * `props.via = "admin"`, so a script row and a click row are distinguishable and both
 * appear on `/admin/audit`.
 *
 * **Grants and revokes are read off the `admin` table** rather than duplicated as
 * events: its `granted_by` / `revoked_by` columns are already the record, and a second
 * copy is a copy that can disagree. They are merged into the same timeline on read.
 *
 * Writing an audit row is **not** fire-and-forget the way `record` is. An analytics
 * insert must never fail a paid request; an audit insert that silently fails leaves a
 * pause with no name on it. The action has already happened by then, so the failure is
 * returned to the caller and printed on the page rather than thrown.
 *
 * **Every action also buzzes the operator's phone** (14 Sep 2026, ADMIN-NOTIFICATIONS.md).
 * The trail answers "who paused payments at 3am" for whoever goes and looks; the
 * notification is what makes them look, and it is the only thing that reaches an operator
 * who was not the one clicking. It is never throttled, and it is sent whether or not the
 * insert landed — a failed row is precisely when the message is the whole record.
 */

import { mirrorToVercel } from "@/lib/analytics/vercel";
import { db } from "@/lib/db";
import { recordedChainId } from "@/lib/events";
import type { AdminRow, EventRow } from "@/lib/db/types";
import { notifyAdmin } from "@/lib/notify";
import { describeProps } from "@/lib/admin/activity";

/** Every event name an operator action can write, from the web or from a script. */
export const AUDIT_EVENTS = [
  "switch_paused",
  "switch_resumed",
  "takedown_retired",
  "takedown_revoked",
  "user_marked_test",
  "user_marked_real",
  // 16 Sep 2026: an operator downloaded a release's stored artifact without buying it.
  // Recorded before the URL is minted, and never shown to the creator (lib/admin/download.ts).
  "artifact_downloaded",
] as const;
export type AuditEventName = (typeof AUDIT_EVENTS)[number];

export const AUDIT_LIMIT = 300;

export type AuditEntry = {
  at: string;
  action: string;
  /** Login, OS username (scripts), or `migration:…`. Null when nothing recorded one. */
  by: string | null;
  /** `admin` for a click, `script` for a terminal, `table` for an admin grant row. */
  via: "admin" | "script" | "table";
  listingId: string | null;
  subject: string | null;
  detail: string;
};

/** Write one audit row. Returns an error message instead of throwing — see the note. */
export async function recordAdminAction(input: {
  name: AuditEventName;
  by: string;
  listingId?: string | null;
  props?: Record<string, unknown>;
}): Promise<string | null> {
  let auditError: string | null = null;
  try {
    const { error } = await db()
      .from("event")
      .insert({
        name: input.name,
        listing_id: input.listingId ?? null,
        chain_id: recordedChainId(),
        props: { ...input.props, by: input.by, via: "admin" },
      });
    if (error) throw error;
    // Mirrored without `by`: the allow-list sends a switch name at most, never who.
    mirrorToVercel(input.name, input.props);
  } catch (e) {
    auditError = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e);
    console.warn(`[admin] could not record audit event ${input.name}:`, auditError);
  }

  // ADMIN-NOTIFICATIONS.md, 14 Sep 2026. Outside the try on purpose, and on both paths:
  // the action has already happened either way, and a row that failed to save is the
  // moment the phone is the only record there is — so it goes out carrying `auditError`
  // rather than being skipped. `notifyAdmin` never throws, so this keeps the contract
  // above: `recordAdminAction` returns the error string and never throws.
  const props = input.props ?? {};
  await notifyAdmin({
    kind: "admin_action",
    action: input.name,
    by: input.by,
    via: "admin",
    // `switch` for the two switch actions, `ref` for the two takedowns — the same two
    // props `entryFromEvent` below lifts into `subject`, read the same defensive way.
    // A buyer wallet is named on /admin/audit but never in a message (FR-40, lib/notify).
    subject: str(props.switch) ?? str(props.ref) ?? (str(props.wallet) ? "a buyer wallet" : "—"),
    reason: str(props.reason),
    listingId: input.listingId ?? null,
    auditError,
  });

  return auditError;
}

/** A prop is whatever the caller put there; only a string is worth printing. */
function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// --- pure ---------------------------------------------------------------------

export function entryFromEvent(event: Pick<EventRow, "name" | "at" | "listing_id" | "props">): AuditEntry {
  const props = { ...((event.props ?? {}) as Record<string, unknown>) };
  const by = typeof props.by === "string" ? props.by : null;
  const via = props.via === "admin" ? "admin" : "script";
  const subject = str(props.switch) ?? str(props.ref) ?? str(props.wallet);
  delete props.by;
  delete props.via;
  delete props.switch;
  delete props.ref;
  delete props.wallet;
  return { at: event.at, action: event.name, by, via, listingId: event.listing_id, subject, detail: describeProps(props) };
}

/** A grant row is one entry; a revoked grant row is two. */
export function entriesFromAdminRows(rows: readonly AdminRow[]): AuditEntry[] {
  const out: AuditEntry[] = [];
  for (const row of rows) {
    out.push({
      at: row.granted_at,
      action: "admin_granted",
      by: row.granted_by,
      via: "table",
      listingId: null,
      subject: row.github_login,
      detail: row.note ? `note=${row.note.length > 40 ? `${row.note.slice(0, 37)}…` : row.note}` : "",
    });
    if (row.revoked_at) {
      out.push({ at: row.revoked_at, action: "admin_revoked", by: row.revoked_by, via: "table", listingId: null, subject: row.github_login, detail: "" });
    }
  }
  return out;
}

/** Newest first; an unparseable timestamp sinks to the bottom rather than floating up. */
export function sortAudit(entries: readonly AuditEntry[]): AuditEntry[] {
  const t = (iso: string) => {
    const n = Date.parse(iso);
    return Number.isNaN(n) ? -Infinity : n;
  };
  return [...entries].sort((a, b) => t(b.at) - t(a.at));
}

// --- the read -----------------------------------------------------------------

export type AuditView = { entries: AuditEntry[]; truncated: boolean };

export async function loadAudit(limit = AUDIT_LIMIT): Promise<AuditView> {
  const [{ data, error }, { data: adminData, error: adminError }] = await Promise.all([
    db()
      .from("event")
      .select("name, at, listing_id, props")
      .in("name", [...AUDIT_EVENTS])
      .order("at", { ascending: false })
      .limit(limit + 1),
    db().from("admin").select("*"),
  ]);
  if (error) throw error;
  if (adminError) console.warn("[admin] could not read the admin table for the audit log:", adminError.message);

  const events = (data as EventRow[] | null) ?? [];
  const truncated = events.length > limit;
  const entries = [
    ...(truncated ? events.slice(0, limit) : events).map(entryFromEvent),
    ...entriesFromAdminRows((adminData as AdminRow[] | null) ?? []),
  ];
  return { entries: sortAudit(entries), truncated };
}
