/**
 * lib/events.ts — the §10 analytics table, written fire-and-forget.
 *
 * An analytics insert must never fail a paid request: `record` swallows its own errors
 * and logs the name only.
 *
 * **Never put a buyer address in `props`.** FR-40 keeps buyer identity out of everything
 * a creator can read, and the dedicated `buyer_address` column — which the FR-29 ledger
 * view does not select — is the only place one belongs. This is a convention the callers
 * keep, not something this function can check: `props` also carries platform-owned
 * addresses (the reconcile job records the receiving address), so a blanket scrub would
 * destroy the one log that has to name it.
 */

import { mirrorToVercel } from "@/lib/analytics/vercel";
import { db } from "@/lib/db";
import type { PurchaseSource } from "@/lib/db/types";
import { paymentChain } from "@/lib/env";

/**
 * The chain this deployment takes payments on, stamped on every event it writes
 * (migration 20260914010000). Null rather than a throw on a misconfigured network: an
 * analytics row without a chain beats no row.
 */
export function recordedChainId(): number | null {
  try {
    return paymentChain().chainId;
  } catch {
    return null;
  }
}
import { notifyAdmin } from "@/lib/notify";

/**
 * The names worth spelling out. `(string & {})` keeps the union open — the table takes any
 * name — so this list is documentation and autocomplete, not a gate. **Append only**: more
 * than one person adds a name at a time, and a reordered union is a conflict for nothing.
 */
export type EventName =
  | "402_issued"
  | "settled"
  | "update_purchase"
  | "free_grant"
  | "download"
  | "sweep"
  | "sweep_skipped"
  | "reconcile"
  // "PRD Trust Report.md" §7, 13 Sep 2026. `cron_rescan` is the nightly re-read of the
  // dependency rows; `release_compromised` is the one thing it can find that is not a
  // disclosure — a passing release whose dependencies now carry an OSV `MAL-` record or a
  // Socket `malware` alert. The second is a notice, never an action: the verdict does not
  // move and nothing is revoked, and FR-39 is the human path that acts (§10 Q2).
  | "cron_rescan"
  | "release_compromised"
  // "PRD Trust Report.md" §4.1 and §6.2's failure table, 13 Sep 2026. Raised by
  // `lib/release/index.ts` after a cut, and read on /admin/activity.
  | "release_scan_review" //        a `review`-tier finding: shown, never a verdict, worth a look
  | "release_scan_socket_auth" //   Socket answered 401 — almost certainly a rotated token
  | "release_scan_socket_quota" //  Socket answered 403/429, or the 10% floor stopped the call
  | (string & {});

export type EventInput = {
  name: EventName;
  listingId?: string | null;
  buyerAddress?: string | null;
  source?: PurchaseSource | null;
  props?: Record<string, unknown>;
};

/**
 * The event names that are also admin alerts, with what the phone should say.
 *
 * "PRD Trust Report.md" §7 names these three as the ones a human has to act on, and they
 * already arrive here as event names — so this is the table, not a second notification
 * call site scattered through `lib/scan/**`. Every key is a member of the `EventName`
 * union above; add a name there and here in the same change, or the alert is a table
 * entry nothing ever hits. `release_scan_review` is deliberately absent: a `review`-tier
 * finding is shown on /admin/activity and is never a verdict, so it is not a 3am buzz.
 */
const ADMIN_ALERTS: Record<string, { severity: "error" | "alert"; message: string }> = {
  release_compromised: { severity: "error", message: "A passing release's dependencies now carry a malware record — FR-39 is the path that acts" },
  release_scan_socket_auth: { severity: "error", message: "Socket answered 401 — token probably rotated" },
  release_scan_socket_quota: { severity: "alert", message: "Socket answered 403/429 or the 10% floor stopped the call" },
};

/** An address-shaped string never travels to a Telegram channel (FR-40, lib/notify/index.ts). */
const ADDRESS_SHAPED = /^0x[0-9a-fA-F]{40}$/;

/**
 * The scalar half of `props`, for the alert body: `version`, `release_id`, `package`,
 * `status` — whatever the caller happened to record. Objects and arrays are dropped
 * because a notification is one line per fact, and anything address-shaped is dropped
 * because the channel is a third party's server.
 */
function alertDetails(props: Record<string, unknown> | undefined): Record<string, string | number | boolean> {
  const details: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(props ?? {})) {
    if (key === "buyer_address") continue;
    if (typeof value === "string" && !ADDRESS_SHAPED.test(value)) details[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") details[key] = value;
  }
  return details;
}

export async function record(event: EventInput): Promise<void> {
  try {
    const { error } = await db()
      .from("event")
      .insert({
        name: event.name,
        listing_id: event.listingId ?? null,
        buyer_address: event.buyerAddress ? event.buyerAddress.toLowerCase() : null,
        source: event.source ?? null,
        props: event.props ?? null,
        chain_id: recordedChainId(),
      });
    if (error) throw error;
  } catch (e) {
    console.warn(`[event] could not record ${event.name}:`, e instanceof Error ? e.message : String(e));
  }
  // The same event in Vercel Web Analytics, allow-listed props only (lib/analytics/vercel.ts).
  mirrorToVercel(event.name, event.props, event.source ?? null);

  // ADMIN-NOTIFICATIONS.md, 13 Sep 2026. Outside the try above on purpose: the alert is
  // about the malware record, not about whether the analytics row landed, and an insert
  // that failed is the moment an operator most needs to hear from us. `notifyAdmin` never
  // throws and never rejects, so `record` keeps its "never fails a paid request" promise.
  const alert = ADMIN_ALERTS[event.name];
  if (alert) {
    await notifyAdmin({
      kind: "error",
      where: event.name,
      code: event.name,
      severity: alert.severity,
      message: alert.message,
      listingId: event.listingId ?? null,
      details: alertDetails(event.props),
    });
  }
}
