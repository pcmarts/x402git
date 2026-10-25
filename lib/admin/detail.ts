/**
 * lib/admin/detail.ts — one listing, or one creator, all the way down.
 *
 * The feed and the roster answer "is anything wrong, across everyone". These answer the
 * question that follows a flag: *what, exactly?* Before them, a `scan failed` flag on
 * `/admin` led to the public manifest page, which is right to withhold the report, and
 * from there to `psql`. `release.scan_report` had no reader anywhere (docs/BACKLOG.md);
 * this is the first, and it is operator-only.
 *
 * Same rules as the rest of `lib/admin`:
 *
 * - **No buyer addresses.** Purchase reads select counts and amounts, never the column.
 * - **One chain** on every purchase and payout read.
 * - **No key material.** An `api_key` row is mapped field by field and `hash` is never
 *   copied out, so nothing downstream can print it.
 * - **Nothing writes.** The takedown is `lib/admin/controls.ts`.
 */

import { db } from "@/lib/db";
import type { ApiKeyRow, CreatorRow, EventRow, ListingRow, PayoutRow, PurchaseRow, ReleaseRow } from "@/lib/db/types";
import { toMicro } from "@/lib/db/types";
import { paymentChain } from "@/lib/env";
import { describeProps } from "@/lib/admin/activity";
import { normalizeReport, type ScanCheck, type ScanFinding } from "@/lib/scan/report";
import { statusOf, type ListingStatus } from "@/lib/web/loaders";

export const DETAIL_RELEASE_LIMIT = 100;
export const DETAIL_EVENT_LIMIT = 40;
export const DETAIL_PAYOUT_LIMIT = 50;
export const DETAIL_KEY_LIMIT = 50;
const DETAIL_READ_LIMIT = 20_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- pure ---------------------------------------------------------------------

export type ScanSummary = {
  findings: ScanFinding[];
  /**
   * §4.1's third tier, pulled out because it is the admin-alert class: a vendor's
   * model-derived flag (`gpt*`, `skill*`, `potentialVulnerability`) is never a verdict
   * and never blocks, so the *only* place it can be acted on is here. Buried in a list
   * sorted by severity it would sit under every LOW CVE on the page.
   */
  review: ScanFinding[];
  /** §4.2's rows, in the report's own order. Empty on a blob that carries none. */
  checks: ScanCheck[];
  /** Rows that could not run or did not finish — a gap an operator can chase (§4.1). */
  gaps: ScanCheck[];
  checked: string[];
  scannedAt: string | null;
  scannerVersion: string | null;
  /** §7: when the dependency rows were last re-read against the advisory feeds. */
  advisoriesRefreshedAt: string | null;
  osvError: string | null;
  /** `scan_report.error` — an analysis error that left the release `pending`. */
  error: string | null;
};

/**
 * `release.scan_report` is jsonb written by `scanArtifact`, and old rows predate most of
 * it. Read defensively at three levels: `normalizeReport` lifts a v1 blob to v2 (and is
 * wrapped, because it can throw on something that is neither), a malformed finding is
 * dropped rather than thrown on, and every field falls back to a null the page can render.
 *
 * Extended 13 Sep 2026 for "PRD Trust Report.md" §4.2: the check rows and the `review`
 * tier. An operator's question after a flag is *what, exactly?* — and for a review flag
 * it is *what did a classifier think, and is it right?*, which nothing on any page could
 * answer before.
 */
export function scanSummaryOf(report: unknown): ScanSummary {
  let lifted: ReturnType<typeof normalizeReport> = null;
  try {
    lifted = normalizeReport(report as Parameters<typeof normalizeReport>[0]);
  } catch {
    lifted = null;
  }

  const r = (report && typeof report === "object" ? report : {}) as Record<string, unknown>;
  const source = lifted ?? (r as unknown as { findings?: unknown; checks?: unknown });
  const findings = Array.isArray(source.findings)
    ? (source.findings as unknown[]).filter(
        (f): f is ScanFinding => !!f && typeof f === "object" && typeof (f as ScanFinding).rule_id === "string",
      )
    : [];
  // Blocking first, then by severity, so the reason a release failed is the top row.
  const rank: Record<string, number> = { CRITICAL: 0, HIGH: 1, MODERATE: 2, LOW: 3, UNKNOWN: 4 };
  findings.sort((a, b) => Number(b.blocking) - Number(a.blocking) || (rank[a.severity] ?? 5) - (rank[b.severity] ?? 5));

  const checks = Array.isArray(source.checks)
    ? (source.checks as unknown[]).filter((c): c is ScanCheck => !!c && typeof c === "object" && typeof (c as ScanCheck).id === "string")
    : [];

  return {
    findings,
    review: findings.filter((f) => f.tier === "review"),
    checks,
    gaps: checks.filter((c) => c.status === "unavailable" || c.status === "partial"),
    checked: lifted ? lifted.checked : Array.isArray(r.checked) ? (r.checked as unknown[]).map(String) : [],
    scannedAt: typeof r.scanned_at === "string" ? r.scanned_at : null,
    scannerVersion: lifted?.scanner_version ?? (typeof r.scanner_version === "string" ? r.scanner_version : null),
    advisoriesRefreshedAt: lifted?.advisories_refreshed_at ?? null,
    osvError: typeof r.osv_error === "string" ? r.osv_error : null,
    error: typeof r.error === "string" ? r.error : null,
  };
}

/** An `api_key` row without its hash. The type makes copying one out a compile error. */
export type AdminKey = Omit<ApiKeyRow, "hash" | "creator_id"> & { live: boolean };

export function keyOf(row: ApiKeyRow, now = Date.now()): AdminKey {
  const expired = row.expires_at ? Date.parse(row.expires_at) <= now : false;
  return {
    id: row.id,
    kind: row.kind,
    scopes: row.scopes ?? [],
    created_at: row.created_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    revoked_reason: row.revoked_reason,
    last_used_at: row.last_used_at,
    live: !row.revoked_at && !expired,
  };
}

export type SalesSummary = { sales: number; grossMicro: bigint; netMicro: bigint; revoked: number; owedMicro: bigint; heldMicro: bigint };

export function salesSummaryOf(
  rows: readonly Pick<PurchaseRow, "gross_micro" | "net_micro" | "revoked_at" | "payout_id" | "holdback_until">[],
  now = Date.now(),
): SalesSummary {
  const out: SalesSummary = { sales: 0, grossMicro: 0n, netMicro: 0n, revoked: 0, owedMicro: 0n, heldMicro: 0n };
  for (const row of rows) {
    if (row.revoked_at) {
      out.revoked += 1;
      continue;
    }
    out.sales += 1;
    const net = toMicro(row.net_micro);
    out.grossMicro += toMicro(row.gross_micro);
    out.netMicro += net;
    if (row.payout_id) continue;
    if (Date.parse(row.holdback_until) > now) out.heldMicro += net;
    else out.owedMicro += net;
  }
  return out;
}

export type DetailEvent = { id: string; name: string; at: string; source: string | null; detail: string };

function eventOf(row: EventRow): DetailEvent {
  return { id: String(row.id), name: row.name, at: row.at, source: row.source, detail: describeProps(row.props) };
}

// --- one listing --------------------------------------------------------------

export type ListingDetail = {
  listing: ListingRow;
  creator: Pick<CreatorRow, "id" | "handle">;
  status: ListingStatus;
  releases: ReleaseRow[];
  sellable: ReleaseRow | null;
  sales: SalesSummary;
  events: DetailEvent[];
  chainId: number;
};

export async function loadListingDetail(id: string, chainId = paymentChain().chainId): Promise<ListingDetail | null> {
  if (!UUID.test(id)) return null;

  const { data: listingData, error } = await db().from("listing").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!listingData) return null;
  const listing = listingData as ListingRow;

  const [creatorRes, releaseRes, purchaseRes, eventRes] = await Promise.all([
    db().from("creator").select("id, handle").eq("id", listing.creator_id).maybeSingle(),
    db().from("release").select("*").eq("listing_id", id).order("created_at", { ascending: false }).limit(DETAIL_RELEASE_LIMIT),
    db()
      .from("purchase")
      .select("gross_micro, net_micro, revoked_at, payout_id, holdback_until")
      .eq("listing_id", id)
      .eq("chain_id", chainId)
      .limit(DETAIL_READ_LIMIT),
    db()
      .from("event")
      .select("id, name, at, source, props")
      .eq("listing_id", id)
      .neq("name", "manifest_view")
      .order("at", { ascending: false })
      .limit(DETAIL_EVENT_LIMIT),
  ]);
  for (const res of [creatorRes, releaseRes, purchaseRes, eventRes]) if (res.error) throw res.error;

  const creator = creatorRes.data as { id: string; handle: string } | null;
  const releases = (releaseRes.data as ReleaseRow[] | null) ?? [];

  return {
    listing,
    creator: { id: listing.creator_id, handle: creator?.handle ?? "—" },
    status: statusOf(listing),
    releases,
    sellable: releases.find((r) => r.scan === "pass") ?? null,
    sales: salesSummaryOf((purchaseRes.data as PurchaseRow[] | null) ?? []),
    events: ((eventRes.data as EventRow[] | null) ?? []).map(eventOf),
    chainId,
  };
}

// --- one creator --------------------------------------------------------------

export type CreatorListing = { listing: ListingRow; status: ListingStatus; sales: number; grossMicro: bigint };

export type CreatorDetail = {
  creator: CreatorRow;
  listings: CreatorListing[];
  sales: SalesSummary;
  payouts: (Omit<PayoutRow, "amount_micro" | "gas_micro"> & { amountMicro: bigint; gasMicro: bigint })[];
  keys: AdminKey[];
  chainId: number;
};

export async function loadCreatorDetail(handle: string, chainId = paymentChain().chainId): Promise<CreatorDetail | null> {
  const wanted = handle.trim().toLowerCase();
  if (wanted.length === 0 || wanted.length > 64) return null;

  const { data: creatorData, error } = await db().from("creator").select("*").eq("handle", wanted).maybeSingle();
  if (error) throw error;
  if (!creatorData) return null;
  const creator = creatorData as CreatorRow;

  const [listingRes, payoutRes, keyRes] = await Promise.all([
    db().from("listing").select("*").eq("creator_id", creator.id).order("created_at", { ascending: false }).limit(DETAIL_READ_LIMIT),
    db()
      .from("payout")
      .select("*")
      .eq("creator_id", creator.id)
      .eq("chain_id", chainId)
      .order("created_at", { ascending: false })
      .limit(DETAIL_PAYOUT_LIMIT),
    db().from("api_key").select("*").eq("creator_id", creator.id).order("created_at", { ascending: false }).limit(DETAIL_KEY_LIMIT),
  ]);
  for (const res of [listingRes, payoutRes, keyRes]) if (res.error) throw res.error;

  const listings = (listingRes.data as ListingRow[] | null) ?? [];
  let purchases: (PurchaseRow & { listing_id: string })[] = [];
  if (listings.length > 0) {
    const { data, error: purchaseError } = await db()
      .from("purchase")
      .select("listing_id, gross_micro, net_micro, revoked_at, payout_id, holdback_until")
      .in(
        "listing_id",
        listings.map((l) => l.id),
      )
      .eq("chain_id", chainId)
      .limit(DETAIL_READ_LIMIT);
    if (purchaseError) throw purchaseError;
    purchases = (data as (PurchaseRow & { listing_id: string })[] | null) ?? [];
  }

  return {
    creator,
    listings: listings.map((listing) => {
      const mine = salesSummaryOf(purchases.filter((p) => p.listing_id === listing.id));
      return { listing, status: statusOf(listing), sales: mine.sales, grossMicro: mine.grossMicro };
    }),
    sales: salesSummaryOf(purchases),
    payouts: ((payoutRes.data as PayoutRow[] | null) ?? []).map(({ amount_micro, gas_micro, ...rest }) => ({
      ...rest,
      amountMicro: toMicro(amount_micro),
      gasMicro: toMicro(gas_micro ?? 0),
    })),
    keys: ((keyRes.data as ApiKeyRow[] | null) ?? []).map((row) => keyOf(row)),
    chainId,
  };
}
