/**
 * lib/analytics/vercel.ts — every §10 event, mirrored to Vercel Web Analytics as a
 * custom event (2026-09-13, founder: "make sure vercel has all the ones we currently
 * have").
 *
 * The `event` table stays the record. It holds exact amounts, listing ids and the
 * buyer column, and every admin page reads it. This copy exists so the same events sit
 * beside Vercel's page views, referrers and countries in one dashboard. So the rules
 * are about what may leave:
 *
 * - **Every event name goes.** An event not listed below still mirrors, with no
 *   properties, so a new `record()` call shows up in Vercel without anyone remembering.
 * - **Properties are an allow-list, at most two per event** — Vercel Pro's limit
 *   (docs: analytics/limits-and-pricing). Nothing identifying is ever on the list: no
 *   creator, listing, payout or quote id, no buyer address, no transaction hash, no
 *   amount, no free-text error or operator reason. What goes is the shape of the event
 *   — which surface, which kind, which verdict, which cause.
 * - **Only on Vercel.** `track` needs the request's headers, which Vercel's request
 *   context supplies inside a function; locally and in tests it would only log, so it
 *   is not called at all.
 * - **Never awaited into a caller's path, never thrown.** Same contract as `record`:
 *   analytics must not fail a paid request. Inside a Vercel function `track` hands its
 *   fetch to `waitUntil`, so the response is not held for it.
 */

import { track } from "@vercel/analytics/server";

type Value = string | number | boolean | null;

/** Vercel Pro allows two custom-data properties per event; Web Analytics Plus allows eight. */
export const MAX_PROPS = 2;

/**
 * Which props each event may send, in priority order. `source` is the purchase surface
 * (`web` / `api` / `mcp`), taken from the event's own column.
 */
const ALLOW: Record<string, readonly string[]> = {
  manifest_view: ["view", "bot"],
  "402_issued": ["kind", "source"],
  settled: ["kind", "source"],
  update_purchase: ["source"],
  free_grant: ["source", "recorded"],
  settle_failed: ["code", "source"],
  download: ["source", "refetch"],
  paused_block: ["switch", "rail"],
  cron_sweep: ["creators"],
  sweep: ["purchases"],
  sweep_skipped: ["reason"],
  sweep_failed: ["stage"],
  sweep_indeterminate: ["stage"],
  listing_created: ["source", "key_kind"],
  listing_published: ["source", "key_kind"],
  listing_retired: ["key_kind", "reason"],
  listing_repo_deleted: ["key_kind"],
  release_cut: ["scan", "licence"],
  release_failed: ["scan", "licence"],
  switch_paused: ["switch"],
  switch_resumed: ["switch"],
  // Deliberately no props: reconcile carries wallet balances (derived below instead),
  // payout_address_rebound carries a creator, release_scan_incomplete an upstream error
  // string, takedown_* an operator's reason and a listing ref. The `release_scan_*` alerts
  // ("PRD Trust Report.md" §4.1/§6.2) join them — a vendor's alert slugs are an unbounded
  // custom dimension and the operator reads them on /admin/activity, which has the rows.
};

/** The properties that may leave for this event, or undefined when none. Pure. */
export function vercelPropsFor(name: string, props?: Record<string, unknown> | null, source?: string | null): Record<string, Value> | undefined {
  if (name === "reconcile") {
    // The one useful fact in a reconcile row that is not a balance: did the books agree.
    const variance = props?.variance_micro;
    return variance === undefined ? undefined : { balanced: String(variance) === "0" };
  }

  const merged: Record<string, unknown> = { ...(props ?? {}), ...(source ? { source } : {}) };
  const out: Record<string, Value> = {};
  for (const key of (ALLOW[name] ?? []).slice(0, MAX_PROPS)) {
    const value = merged[key];
    if (value === null || typeof value === "boolean" || typeof value === "number") out[key] = value;
    else if (typeof value === "string") out[key] = value.slice(0, 255);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Fire-and-forget. A no-op anywhere but a Vercel deployment. */
export function mirrorToVercel(name: string, props?: Record<string, unknown> | null, source?: string | null): void {
  if (process.env.VERCEL !== "1") return;
  try {
    void track(name.slice(0, 255), vercelPropsFor(name, props, source)).catch(() => undefined);
  } catch {
    // `track` throws synchronously only on misuse; analytics never breaks a request.
  }
}
