/**
 * lib/admin/activity.ts — the checkout funnel, and what is failing.
 *
 * Reads the §10 `event` table, which until now nothing read. Two questions:
 *
 * **Is it converting?** `402_issued` is "somebody asked what this costs and was told";
 * `settled` is "they paid". The ratio is the checkout conversion rate, and it is the
 * closest thing the product currently instruments to PRODUCT.md's stated hypothesis.
 *
 * **What is breaking?** `settle_failed` carries the facilitator's error code,
 * `paused_block` says a kill switch refused a request, and the `sweep_*` family says
 * money did not move. Grouped by cause, because "eleven failures" is a number and
 * "eleven `insufficient_funds`" is an instruction.
 *
 * ## The gap this page is honest about
 *
 * PRODUCT.md names the number that decides the whole product: *manifest views per
 * purchase* — "does a public manifest over a private repo convert where a sealed box
 * does not?" Until 2026-09-07 nothing recorded a manifest view, so that ratio could not
 * be computed at all. `app/[owner]/[slug]/page.tsx` now records `manifest_view`, which
 * means the number starts existing from that date forward and is **not** backfillable.
 * `viewsPerPurchase` is therefore null until views exist, and the page says why rather
 * than printing a ratio computed from a denominator that only started yesterday.
 *
 * Nothing here writes, and no buyer address is selected — the `event` table has a
 * `buyer_address` column and this module does not read it.
 */

import { db } from "@/lib/db";
import { paymentChain } from "@/lib/env";
import type { EventRow, PurchaseSource } from "@/lib/db/types";
import { inWindow, windowStart, type AdminWindow } from "@/lib/admin/window";

export const EVENT_LIMIT = 4000;
export const STREAM_LIMIT = 60;

/**
 * Manifest views are read separately from everything else, and this is why.
 *
 * `robots.txt` invites indexing, so `manifest_view` is expected to become the highest
 * volume event on the site by a wide margin. Read newest-first in one pool with the rest,
 * a day of crawling would push every `settled` and `settle_failed` row past
 * `EVENT_LIMIT` and the funnel would print `Paid 0` as though it were a fact. Splitting
 * the reads means crawl volume can only ever cost precision on the *view* count, never
 * on the money counts.
 */
export const VIEW_LIMIT = 20_000;

/**
 * When `manifest_view` started being recorded (`app/[owner]/[slug]/page.tsx`).
 *
 * The ratio it feeds is only meaningful over a window that lies entirely after this
 * moment: before it there are sales and no views, so any window reaching back further
 * divides a full count of purchases by a partial count of views and understates the
 * number PRODUCT.md says decides the product. Views cannot be backfilled, so the guard
 * is a date rather than a heuristic.
 *
 * Delete this and the check around it once every window the page offers starts after it
 * — from 2026-10-07 the 30-day window is safe, and `all` never will be.
 */
export const MANIFEST_VIEW_SINCE = Date.parse("2026-09-07T13:50:00.000Z");

/**
 * The events that mean something went wrong, and the prop that says what. Anything not
 * named here is not a failure — `sweep_skipped` is on the list because a skipped sweep
 * is a creator not being paid, whatever the reason turns out to be.
 *
 * The three `release_scan_*` rows joined it on 13 Sep 2026 with the trust report
 * ("PRD Trust Report.md" §4.1, §6.2). None of them failed a release — that is the point of
 * §4.1's third tier — but each is something an operator has to see: a model-derived flag
 * nobody has looked at, a Socket token that has been rotated out from under us, or a quota
 * window running out. Grouped by cause, they read as "four listings flagged `gptMalware`"
 * rather than as four rows.
 */
const FAILURE_CAUSE: Record<string, string> = {
  settle_failed: "code",
  paused_block: "switch",
  sweep_skipped: "reason",
  sweep_failed: "stage",
  sweep_indeterminate: "stage",
  release_scan_review: "rule_ids",
  release_scan_socket_auth: "reason",
  release_scan_socket_quota: "reason",
};

/**
 * A sentence per failure name, because the name is a slug and an operator reading
 * `/admin/activity` at speed should not have to expand it. Absent means the name says
 * enough on its own (`settle_failed` does).
 */
export const FAILURE_LABEL: Record<string, string> = {
  release_scan_review: "flagged for review by a vendor classifier — shown on the listing, never a verdict",
  release_scan_socket_auth: "Socket refused the token; dependency behaviour is going unchecked",
  release_scan_socket_quota: "Socket quota exhausted; the dependency-behaviour row was skipped",
};

export type Funnel = {
  /**
   * Manifest page renders by something that looks like a person or a prospective buyer.
   * Crawlers are excluded — robots.txt invites indexing on purpose, so counting them
   * would put Googlebot in the denominator of the product's central metric.
   */
  views: number;
  /** Renders by something that identified itself as a crawler. Reported, not counted. */
  botViews: number;
  /** 402s issued — a price was quoted. */
  issued: number;
  settled: number;
  failed: number;
  free: number;
  downloads: number;
  /** `settled / issued`, as a printed percentage. Null when nothing was quoted. */
  conversion: string | null;
  /** `views / settled`. Null until both exist — the number PRODUCT.md is waiting on. */
  viewsPerPurchase: string | null;
};

export type FailureGroup = {
  name: string;
  cause: string;
  count: number;
  lastAt: string;
  /** One line saying what the name means, where the name is not self-explanatory. */
  label?: string;
};

export type ActivityEvent = {
  id: string;
  name: string;
  at: string;
  listingId: string | null;
  slug: string | null;
  handle: string | null;
  source: PurchaseSource | null;
  /** A short rendering of `props`, already flattened — the page never walks raw JSON. */
  detail: string;
};

export type BySource = { source: string; issued: number; settled: number };

export type ActivityView = {
  funnel: Funnel;
  /** False while the window reaches back before views were instrumented. */
  viewsCoverWindow: boolean;
  /** True when the *view* read saturated. The money counts are unaffected either way. */
  viewsTruncated: boolean;
  failures: FailureGroup[];
  bySource: BySource[];
  stream: ActivityEvent[];
  /** Distinct listings that were viewed at all in the window. */
  listingsViewed: number;
  truncated: boolean;
};

// --- pure ---------------------------------------------------------------------

function pct(numerator: number, denominator: number): string | null {
  if (denominator === 0) return null;
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

/**
 * Does this window lie entirely inside the period where views were being recorded?
 * `all` never does — there are sales older than the instrumentation — and neither does
 * any window reaching back past `MANIFEST_VIEW_SINCE`.
 */
export function viewsCoverWindow(windowStartMs: number | null): boolean {
  return windowStartMs !== null && windowStartMs >= MANIFEST_VIEW_SINCE;
}

export function funnelFrom(events: readonly Pick<EventRow, "name" | "props">[], windowStartMs: number | null = null): Funnel {
  const count = (name: string) => events.filter((e) => e.name === name).length;

  // A view is a bot only when it says so. Events recorded before the flag existed have
  // no `bot` key and count as human, which is the right default: they predate crawler
  // traffic being separable and dropping them would understate the numerator.
  const viewEvents = events.filter((e) => e.name === "manifest_view");
  const botViews = viewEvents.filter((e) => (e.props as { bot?: unknown } | null)?.bot === true).length;
  const views = viewEvents.length - botViews;
  const issued = count("402_issued");
  const settled = count("settled");

  return {
    views,
    botViews,
    issued,
    settled,
    failed: count("settle_failed"),
    free: count("free_grant"),
    downloads: count("download"),
    conversion: pct(settled, issued),
    // Null rather than a number, in three different situations that must not be
    // confused: the window predates the instrumentation (the denominator is partial),
    // nothing has sold (the ratio is infinite), or nothing has been viewed. "We have not
    // measured this" and "nobody converts" are different answers.
    viewsPerPurchase: viewsCoverWindow(windowStartMs) && views > 0 && settled > 0 ? (views / settled).toFixed(1) : null,
  };
}

/**
 * Failures grouped by their own cause. Sorted by count, then most recent, so the top
 * row is the thing to fix.
 */
export function failuresFrom(events: readonly EventRow[]): FailureGroup[] {
  const groups = new Map<string, FailureGroup>();

  for (const event of events) {
    const causeKey = FAILURE_CAUSE[event.name];
    if (!causeKey) continue;
    const props = (event.props ?? {}) as Record<string, unknown>;
    const cause = String(props[causeKey] ?? "unknown");
    const key = `${event.name}:${cause}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (Date.parse(event.at) > Date.parse(existing.lastAt)) existing.lastAt = event.at;
    } else {
      groups.set(key, { name: event.name, cause, count: 1, lastAt: event.at, ...(FAILURE_LABEL[event.name] ? { label: FAILURE_LABEL[event.name] } : {}) });
    }
  }

  return [...groups.values()].sort((a, b) => b.count - a.count || Date.parse(b.lastAt) - Date.parse(a.lastAt));
}

/** Where the money is coming from: web, API or MCP. PRODUCT.md cares about the split. */
export function bySourceFrom(events: readonly EventRow[]): BySource[] {
  const out = new Map<string, BySource>();
  for (const event of events) {
    if (event.name !== "402_issued" && event.name !== "settled") continue;
    const source = event.source ?? "unknown";
    const row = out.get(source) ?? { source, issued: 0, settled: 0 };
    if (event.name === "402_issued") row.issued += 1;
    else row.settled += 1;
    out.set(source, row);
  }
  return [...out.values()].sort((a, b) => b.settled - a.settled || b.issued - a.issued);
}

/**
 * `props` as one short line. Keys are printed in the order the event wrote them, values
 * truncated, and anything that looks like an address is dropped — `props` is documented
 * as never carrying a buyer address (lib/events.ts) but this page is not the place to
 * find out that a caller broke the convention.
 */
export function describeProps(props: unknown): string {
  if (!props || typeof props !== "object") return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
    if (value === null || value === undefined || value === "") continue;
    let text = String(value);
    if (/^0x[0-9a-fA-F]{40}$/.test(text)) continue;
    if (text.length > 40) text = `${text.slice(0, 37)}…`;
    parts.push(`${key}=${text}`);
  }
  return parts.join(" ");
}

// --- the read -----------------------------------------------------------------

/**
 * `streamViews` decides whether manifest views appear in the *stream*. They are always
 * counted in the funnel; in the stream they are off by default, because a day of reading
 * is dozens of identical rows that push every settlement, sweep and reconcile below the
 * fold — the stream is where an operator looks for what happened, and a view is not news.
 */
export async function loadActivity(
  window: AdminWindow,
  limit = EVENT_LIMIT,
  opts: { streamViews?: boolean; chainId?: number } = {},
): Promise<ActivityView> {
  const start = windowStart(window);
  // One chain, like every money read (migration 20260914010000). An event with no chain
  // is an operator action from a script, and it lives on /admin/audit.
  const chainId = opts.chainId ?? paymentChain().chainId;

  // Everything except views. `neq` is what keeps crawl volume out of the money counts.
  let query = db()
    .from("event")
    .select("*")
    .eq("chain_id", chainId)
    .neq("name", "manifest_view")
    .order("at", { ascending: false })
    .limit(limit + 1);
  if (start !== null) query = query.gte("at", new Date(start).toISOString());

  let viewQuery = db()
    .from("event")
    .select("*")
    .eq("chain_id", chainId)
    .eq("name", "manifest_view")
    .order("at", { ascending: false })
    .limit(VIEW_LIMIT + 1);
  if (start !== null) viewQuery = viewQuery.gte("at", new Date(start).toISOString());

  const [{ data, error }, { data: viewData, error: viewError }] = await Promise.all([query, viewQuery]);
  if (error) throw error;
  if (viewError) throw viewError;

  const all = (data as EventRow[] | null) ?? [];
  const truncated = all.length > limit;
  // `.gte` already bounds the window server-side; `inWindow` is the belt-and-braces pass
  // the rest of `lib/admin` uses, and it also drops a row with an unparseable timestamp.
  const others = (truncated ? all.slice(0, limit) : all).filter((e) => inWindow(e.at, window));

  const allViews = (viewData as EventRow[] | null) ?? [];
  const viewsTruncated = allViews.length > VIEW_LIMIT;
  const views = (viewsTruncated ? allViews.slice(0, VIEW_LIMIT) : allViews).filter((e) => inWindow(e.at, window));

  const events = [...others, ...views];

  const listingIds = [...new Set(events.map((e) => e.listing_id).filter((id): id is string => Boolean(id)))];
  const listings = await listingIndex(listingIds);

  const viewed = new Set(
    events
      .filter((e) => e.name === "manifest_view" && e.listing_id && (e.props as { bot?: unknown } | null)?.bot !== true)
      .map((e) => e.listing_id),
  );

  // The stream is drawn from the money events and the views together, newest first —
  // it is the one place a view is worth seeing beside a settlement.
  const stream: ActivityEvent[] = [...(opts.streamViews ? events : others)]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, STREAM_LIMIT)
    .map((event) => {
    const meta = event.listing_id ? listings.get(event.listing_id) : undefined;
    return {
      id: String(event.id),
      name: event.name,
      at: event.at,
      listingId: event.listing_id,
      slug: meta?.slug ?? null,
      handle: meta?.handle ?? null,
      source: event.source,
      detail: describeProps(event.props),
      };
    });

  return {
    funnel: funnelFrom(events, start),
    viewsCoverWindow: viewsCoverWindow(start),
    viewsTruncated,
    failures: failuresFrom(events),
    bySource: bySourceFrom(events),
    stream,
    listingsViewed: viewed.size,
    truncated,
  };
}

async function listingIndex(ids: string[]): Promise<Map<string, { slug: string; handle: string }>> {
  if (ids.length === 0) return new Map();

  const { data: listingData, error: listingError } = await db().from("listing").select("id, slug, creator_id").in("id", ids);
  if (listingError) throw listingError;
  const listings = (listingData as { id: string; slug: string; creator_id: string }[] | null) ?? [];

  const creatorIds = [...new Set(listings.map((l) => l.creator_id))];
  const { data: creatorData, error: creatorError } = await db().from("creator").select("id, handle").in("id", creatorIds);
  if (creatorError) throw creatorError;
  const handles = new Map(((creatorData as { id: string; handle: string }[] | null) ?? []).map((c) => [c.id, c.handle]));

  return new Map(listings.map((l) => [l.id, { slug: l.slug, handle: handles.get(l.creator_id) ?? "—" }]));
}
