/**
 * lib/web/loaders.ts — the read path for every server-rendered page.
 *
 * D9 says the web app is a client of the API, and it is: every *mutation* the dashboard
 * performs is an HTTP call to `/api/listings/…` with the session's bearer key (see
 * `lib/web/api-client.ts`). Reads are different. A page that fetched its own API over
 * HTTP would pay a second cold start, a second TLS handshake and a second round of JSON
 * on every render of the one page whose whole point is that it is fast and complete in
 * the HTML (§14.1). So reads go straight to the database, through these loaders, typed
 * on the row types — and they return exactly the shapes the API's zod schemas define,
 * so the two paths cannot drift into disagreeing about what a listing is.
 *
 * Nothing here writes. Nothing here decides entitlement or money — that is
 * `lib/core/access.ts`, and no page calls it.
 */

import { db } from "@/lib/db";
import type { ApiKeyRow, CreatorRow, ListingRow, PurchaseRow, ReleaseRow } from "@/lib/db/types";
import { toMicro } from "@/lib/db/types";
import { appUrl, holdbackDays, paymentChain, platformFeeBps } from "@/lib/env";
import { earningsFor } from "@/lib/payouts/ledger";
import { micro, RESERVED_HANDLES } from "@/lib/schemas/common";
import { Manifest, type ManifestOutput } from "@/lib/schemas";
import { languageMix } from "@/lib/web/manifest-view";

export type ListingStatus = "draft" | "live" | "retired";

export function statusOf(listing: ListingRow): ListingStatus {
  if (listing.retired_at) return "retired";
  return listing.published_at ? "live" : "draft";
}

export type Endpoints = {
  url: string;
  label_endpoint: string;
  version_endpoint: string;
  releases_endpoint: string;
  resource_endpoint: string;
};

export function endpointsFor(owner: string, slug: string): Endpoints {
  const base = appUrl();
  return {
    url: `${base}/${owner}/${slug}`,
    label_endpoint: `${base}/api/label/${owner}/${slug}`,
    version_endpoint: `${base}/api/v/${owner}/${slug}`,
    releases_endpoint: `${base}/api/v/${owner}/${slug}/releases`,
    resource_endpoint: `${base}/api/r/${owner}/${slug}`,
  };
}

// --- creators ----------------------------------------------------------------

export async function creatorByHandle(handle: string): Promise<CreatorRow | null> {
  const { data, error } = await db().from("creator").select("*").eq("handle", handle.toLowerCase()).maybeSingle();
  if (error) throw error;
  return (data as CreatorRow | null) ?? null;
}

export async function creatorById(id: string): Promise<CreatorRow | null> {
  const { data, error } = await db().from("creator").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as CreatorRow | null) ?? null;
}

/** FR-1: the GitHub account is the identity on Rail A, and the id never changes. */
export async function creatorByGithubUserId(githubUserId: number | string): Promise<CreatorRow | null> {
  const { data, error } = await db().from("creator").select("*").eq("github_user_id", String(githubUserId)).maybeSingle();
  if (error) throw error;
  return (data as CreatorRow | null) ?? null;
}

/**
 * FR-54: the creator's live `agent` key row — the one `/dashboard/key` describes and
 * Rotate replaces. Null when there is none, which is a real state: a scan hit (FR-35)
 * revokes the agent key and nothing mints a replacement until the creator asks.
 *
 * The row never carries a plaintext key, only its hash, so nothing here can leak one.
 * What the page reads off it is `created_at`, `last_used_at` and `scopes`.
 *
 * `api_key_one_live_agent` makes "live agent row" at most one, so `maybeSingle()` is
 * safe rather than optimistic.
 */
export async function agentKeyFor(creatorId: string): Promise<ApiKeyRow | null> {
  const { data, error } = await db()
    .from("api_key")
    .select("*")
    .eq("creator_id", creatorId)
    .eq("kind", "agent")
    .is("revoked_at", null)
    .maybeSingle();
  if (error) throw error;
  return (data as ApiKeyRow | null) ?? null;
}

/**
 * The exact bytes a wallet must sign, read back by nonce.
 *
 * The wallet page is two round trips with JavaScript off — ask for the address, then
 * show the challenge — so the message has to be recoverable on the second render. It is
 * not re-derived: `challengeMessage()` embeds the expiry, and a message recomputed a
 * second later would not be the one stored.
 */
export async function challengeByNonce(nonce: string): Promise<{ message: string; address: string; expires_at: string } | null> {
  const { data, error } = await db().from("challenge").select("*").eq("nonce", nonce).maybeSingle();
  if (error) throw error;
  const row = data as { message: string; address: string; expires_at: string; used_at: string | null } | null;
  if (!row || row.used_at) return null;
  return { message: row.message, address: row.address, expires_at: row.expires_at };
}

// --- listings ----------------------------------------------------------------

export type ListingBundle = {
  creator: CreatorRow;
  listing: ListingRow;
  status: ListingStatus;
  /** FR-9: newest release with `scan = pass`. Null while nothing has passed yet. */
  latest: ReleaseRow | null;
  /** Every passing release, newest first. FR-15: the creator cannot delete an entry. */
  releases: ReleaseRow[];
  endpoints: Endpoints;
};

export async function loadListingByPath(owner: string, slug: string): Promise<ListingBundle | null> {
  const creator = await creatorByHandle(owner);
  if (!creator) return null;

  const { data, error } = await db().from("listing").select("*").eq("creator_id", creator.id).eq("slug", slug).maybeSingle();
  if (error) throw error;
  const listing = data as ListingRow | null;
  if (!listing) return null;

  return bundleFor(creator, listing);
}

export async function loadListingById(id: string): Promise<ListingBundle | null> {
  const { data, error } = await db().from("listing").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  const listing = data as ListingRow | null;
  if (!listing) return null;

  const creator = await creatorById(listing.creator_id);
  if (!creator) return null;
  return bundleFor(creator, listing);
}

async function bundleFor(creator: CreatorRow, listing: ListingRow): Promise<ListingBundle> {
  const releases = await releasesFor(listing.id);
  return {
    creator,
    listing,
    status: statusOf(listing),
    latest: releases.find((r) => r.scan === "pass") ?? null,
    releases,
    endpoints: endpointsFor(creator.handle, listing.slug),
  };
}

/** Newest first. Failed releases stay in the log — a gap would be the interesting part. */
export async function releasesFor(listingId: string): Promise<ReleaseRow[]> {
  const { data, error } = await db().from("release").select("*").eq("listing_id", listingId).order("created_at", { ascending: false });
  if (error) throw error;
  return (data as ReleaseRow[] | null) ?? [];
}

/**
 * `https://github.com/owner/name` for a listing's repository, or null.
 *
 * §12 stores the repo *id*, never its name (FR-8: a rename must not lose the listing),
 * so the only way to a URL a person can open is to ask GitHub what that id is called
 * right now. One installation-scoped read per render of one dashboard page.
 *
 * **Null on every failure**, and the caller renders nothing rather than a dead link:
 * an uninstalled App, a deleted repo and a network blip all answer the same way, and a
 * `github.com/undefined/undefined` on a creator's own dashboard is worse than a page
 * with one fewer link on it.
 */
export async function repoUrlFor(listing: ListingRow): Promise<string | null> {
  if (!listing.installation_id || !listing.github_repo_id) return null;
  try {
    // Imported here rather than at the top of the file: every server-rendered page in
    // the product loads this module, and only this function needs the App SDK behind it.
    const { repoById } = await import("@/lib/github/installations");
    const repo = await repoById(listing.installation_id, listing.github_repo_id);
    if (!repo.owner || !repo.name) return null;
    return `https://github.com/${repo.owner}/${repo.name}`;
  } catch (e) {
    console.warn("[loaders] could not resolve the repository URL for listing %s: %s", listing.id, e instanceof Error ? e.message : String(e));
    return null;
  }
}

export type DashboardListing = {
  listing: ListingRow;
  status: ListingStatus;
  latest: ReleaseRow | null;
  /** The newest release of any verdict, so a fresh `fail` is visible on the dashboard. */
  newest: ReleaseRow | null;
  /** Non-revoked purchases of any kind, and what the creator kept from them (FR-29). */
  sales: number;
  netMicro: bigint;
};

/** The dashboard table. Two queries, not one per row. */
export async function listingsForCreator(creatorId: string): Promise<DashboardListing[]> {
  const { data, error } = await db().from("listing").select("*").eq("creator_id", creatorId).order("created_at", { ascending: false });
  if (error) throw error;
  const listings = (data as ListingRow[] | null) ?? [];
  if (listings.length === 0) return [];

  const { data: releaseData, error: releaseError } = await db()
    .from("release")
    .select("*")
    .in(
      "listing_id",
      listings.map((l) => l.id),
    )
    .order("created_at", { ascending: false });
  if (releaseError) throw releaseError;
  const releases = (releaseData as ReleaseRow[] | null) ?? [];

  const { data: purchaseData, error: purchaseError } = await db()
    .from("purchase")
    .select("listing_id, net_micro, revoked_at")
    .in(
      "listing_id",
      listings.map((l) => l.id),
    )
    .is("revoked_at", null);
  if (purchaseError) throw purchaseError;
  const tally = new Map<string, { sales: number; netMicro: bigint }>();
  for (const row of (purchaseData as Pick<PurchaseRow, "listing_id" | "net_micro" | "revoked_at">[] | null) ?? []) {
    if (row.revoked_at) continue;
    const t = tally.get(row.listing_id) ?? { sales: 0, netMicro: 0n };
    t.sales += 1;
    t.netMicro += toMicro(row.net_micro);
    tally.set(row.listing_id, t);
  }

  return listings.map((listing) => {
    const mine = releases.filter((r) => r.listing_id === listing.id);
    const { sales, netMicro } = tally.get(listing.id) ?? { sales: 0, netMicro: 0n };
    return { listing, status: statusOf(listing), latest: mine.find((r) => r.scan === "pass") ?? null, newest: mine[0] ?? null, sales, netMicro };
  });
}

/**
 * FR-42: what is still standing between this listing and `live`. The publish route is
 * the authority — this is the same list, computed early so the dashboard can show it
 * before the creator presses a button that fails.
 */
export function blockingReasons(input: { listing: ListingRow; latest: ReleaseRow | null; releases: ReleaseRow[] }): string[] {
  const blocking: string[] = [];
  // No licence row: the gate came off on 2026-09-02 and this list must keep matching
  // publishBlockers(), or the dashboard promises a block the API will not enforce.
  if (!input.listing.description || !input.listing.trigger_hint) blocking.push("description_missing");
  if (!input.latest) {
    if (input.releases.length === 0) blocking.push("no_release");
    else blocking.push(input.releases.some((r) => r.scan === "fail") ? "scan_failed" : "scan_pending");
  }
  return blocking;
}

// --- installs (FR-40) --------------------------------------------------------

/**
 * How many wallets own each listing. **One query, never one per listing.**
 *
 * FR-40, as amended on the founder's direction of 30 August 2026: the count is shown
 * exactly, from the first purchase, and a buyer address is never shown at all. The
 * addresses are read here because counting distinct ones is what an install *is*, and
 * they leave the function as a number — `Map<listing_id, count>` is the whole return
 * type, so no caller can print one even by mistake.
 *
 * Three rules, all from the requirement rather than from taste:
 *
 * - **`new` and `free` only.** An update is the same wallet buying again. Counting it
 *   would make a listing with three loyal buyers and nine releases look like twelve
 *   installs, which is the exact inflation an honest number exists to refuse.
 * - **Revoked purchases do not count.** FR-39's takedown path is the only thing that
 *   revokes, and a revoked purchase is not an install any more.
 * - **A listing with no installs is absent from the map, not zero in it.** Printing a
 *   zero as a statistic is a defect (DESIGN.md); the page says "Be the first" or says
 *   nothing, and both of those are the caller's decision to make.
 * - **This chain only** (added 2026-09-07, at the mainnet cutover). One database serves
 *   both networks, so without this the first mainnet listing page would have published
 *   eighteen testnet purchases as installs. An install count is the most public number
 *   the product computes and PRODUCT.md's whole claim rests on it being honest; a count
 *   inflated by test traffic is exactly the inflation the rules above exist to refuse.
 */
export async function installCounts(listingIds: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(listingIds.filter((id) => id.length > 0))];
  const counts = new Map<string, number>();
  if (unique.length === 0) return counts;

  const { data, error } = await db()
    .from("purchase")
    .select("listing_id, buyer_address, kind, revoked_at")
    .in("listing_id", unique)
    .eq("chain_id", paymentChain().chainId)
    .in("kind", ["new", "free"])
    .is("revoked_at", null);
  if (error) throw error;

  const seen = new Map<string, Set<string>>();
  for (const row of (data as Pick<PurchaseRow, "listing_id" | "buyer_address" | "kind" | "revoked_at">[] | null) ?? []) {
    // Belt and braces: the mock database and PostgREST agree on these filters, but the
    // count is a public number and a wrong one is worse than a missing one.
    if (row.revoked_at) continue;
    if (row.kind !== "new" && row.kind !== "free") continue;
    const wallets = seen.get(row.listing_id) ?? new Set<string>();
    wallets.add(String(row.buyer_address ?? "").toLowerCase());
    seen.set(row.listing_id, wallets);
  }
  for (const [listingId, wallets] of seen) counts.set(listingId, wallets.size);
  return counts;
}

/** One listing's installs. The plural form is the one to reach for; this wraps it. */
export async function installCount(listingId: string): Promise<number> {
  return (await installCounts([listingId])).get(listingId) ?? 0;
}

// --- the card (home page and author page share one) --------------------------

/**
 * A listing as a card: the creator's own words in the text face, the computed half in
 * mono, the price on its own line, and the install count when there is one.
 *
 * The home page's three examples and an author page's whole shelf are the same object
 * because they are the same claim — "this is a real listing, here is what is in it, open
 * it" — and a second card type would be a second promise about what a card means.
 */
export type ListingCard = {
  owner: string;
  slug: string;
  /** `examples/humanizer` — the reference a human reads and an agent fetches. */
  path: string;
  /** The manifest page. */
  href: string;
  /** FR-51: the creator's own words. Null until one has been written. */
  description: string | null;
  /** FR-51: the creator's one-line "fetch this when…". Null until one has been written. */
  triggerHint: string | null;
  priceMicro: bigint;
  updatePriceMicro: bigint;
  /** The computed half, from the latest passing release's manifest. Null without one. */
  artifactClass: string | null;
  fileCount: number | null;
  /** `"Python 68% · Shell 32%"`, already rendered. */
  languages: string | null;
  /** The latest passing release, e.g. `"1.0.1"`. Null while nothing has passed. */
  version: string | null;
  /** The date of that release, ISO. Null while nothing has passed. */
  updatedAt: string | null;
  /** FR-40: distinct wallets that own it. Zero when nobody has bought it yet. */
  installs: number;
};

export function listingCard(creator: CreatorRow, listing: ListingRow, releases: ReleaseRow[], installs = 0): ListingCard {
  const latest = releases.find((r) => r.scan === "pass") ?? null;
  const bundle: ListingBundle = {
    creator,
    listing,
    status: statusOf(listing),
    latest,
    releases,
    endpoints: endpointsFor(creator.handle, listing.slug),
  };
  // The same validated manifest the listing page renders — a blob that does not parse
  // yields no computed facts here either, rather than half of them (FR-52).
  const manifest = latest ? manifestFor(bundle, latest) : null;

  return {
    owner: creator.handle,
    slug: listing.slug,
    path: `${creator.handle}/${listing.slug}`,
    href: `/${creator.handle}/${listing.slug}`,
    description: listing.description ?? null,
    triggerHint: listing.trigger_hint ?? null,
    priceMicro: toMicro(listing.price_micro),
    updatePriceMicro: toMicro(listing.update_price_micro),
    artifactClass: manifest?.computed.artifact_class ?? null,
    fileCount: manifest?.computed.file_count ?? null,
    languages: manifest ? languageMix(manifest.computed.languages) : null,
    version: latest?.version ?? null,
    updatedAt: latest?.created_at ?? null,
    installs,
  };
}

// --- the author page ---------------------------------------------------------

export type AuthorPage = {
  creator: CreatorRow;
  /** Every live listing, newest release first, then newest listing. */
  listings: ListingCard[];
  /** The sum of every card's installs. Zero when nobody has bought anything. */
  installs: number;
  /**
   * One live listing row, for the GitHub lookup only: the profile call needs an App
   * installation and a `creator` row does not carry one. Null when nothing is live,
   * which is also when there is no GitHub context to show.
   */
  profileListing: ListingRow | null;
};

/**
 * `GET /:owner` — every live listing one creator sells.
 *
 * A creator hands somebody one URL, and until now the only URL they had was a single
 * listing. This is the shelf: the same cards the home page uses, over the same rows, in
 * the same read path.
 *
 * **Only live listings, and no exception for the owner.** A draft is unreachable by URL
 * to everyone but its owner on `/:owner/:slug`, and a page that showed the owner their
 * drafts here would be a second dashboard that looks like a public page — the sort of
 * surface where somebody screenshots their own drafts believing they are published. The
 * dashboard is the place with the drafts in it.
 *
 * Four queries at most: the creator, the listings, their releases, their purchases.
 */
export async function loadAuthorPage(handle: string): Promise<AuthorPage | null> {
  const normalised = handle.trim().toLowerCase();
  // FR-3 keeps these out of the `creator.handle` column in the first place; refusing
  // them here as well means a route added tomorrow cannot be shadowed by a row written
  // yesterday, whichever order the two happen in.
  if ((RESERVED_HANDLES as readonly string[]).includes(normalised)) return null;

  const creator = await creatorByHandle(normalised);
  if (!creator) return null;

  const { data, error } = await db().from("listing").select("*").eq("creator_id", creator.id).order("created_at", { ascending: false });
  if (error) throw error;
  const live = ((data as ListingRow[] | null) ?? []).filter((l) => statusOf(l) === "live");
  if (live.length === 0) return { creator, listings: [], installs: 0, profileListing: null };

  const ids = live.map((l) => l.id);
  const { data: releaseData, error: releaseError } = await db()
    .from("release")
    .select("*")
    .in("listing_id", ids)
    .order("created_at", { ascending: false });
  if (releaseError) throw releaseError;
  const releases = (releaseData as ReleaseRow[] | null) ?? [];

  const installs = await installCounts(ids);

  const cards = live.map((listing) =>
    listingCard(
      creator,
      listing,
      releases.filter((r) => r.listing_id === listing.id),
      installs.get(listing.id) ?? 0,
    ),
  );

  // Most recently shipped first: a shelf is ordered by what moved last, and a listing
  // with no passing release yet sorts under the ones that have one rather than above
  // them on a null date.
  cards.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));

  return {
    creator,
    listings: cards,
    installs: [...installs.values()].reduce((sum, n) => sum + n, 0),
    profileListing: live.find((l) => l.github_repo_id !== null) ?? live[0],
  };
}

/**
 * How many listings a creator has live. The number under the creator strip on a product
 * page — "3 repos on X402 Git" — and the one that makes that strip a link worth
 * following: a creator with one listing has nothing on their author page the reader is
 * not already looking at, and the page says so by not linking.
 */
export async function liveListingCount(creatorId: string): Promise<number> {
  const { data, error } = await db().from("listing").select("*").eq("creator_id", creatorId);
  if (error) throw error;
  return ((data as ListingRow[] | null) ?? []).filter((l) => statusOf(l) === "live").length;
}

// --- the manifest ------------------------------------------------------------

/**
 * The manifest for a release, validated against the published schema.
 *
 * The analyser owns the `computed` block and stores it on the release row; the owner,
 * slug, version, artifact hash, price and onward URLs are facts the rows already hold,
 * so they are filled in here rather than trusted from the JSON. If the stored blob does
 * not validate, the page renders without a manifest rather than rendering a half one —
 * FR-52 makes computed fields undeletable, and a partial computed block is
 * indistinguishable from a deleted one to a reader.
 */
export function manifestFor(bundle: ListingBundle, release: ReleaseRow): ManifestOutput | null {
  const stored = release.manifest as Record<string, unknown> | null;
  if (!stored || typeof stored !== "object") return null;

  const computed = withoutPrivateFindings("computed" in stored ? (stored as { computed: unknown }).computed : stored);
  const selfReportedStored = "self_reported" in stored ? (stored as { self_reported: unknown }).self_reported : undefined;

  const base = appUrl();
  const path = `${bundle.creator.handle}/${bundle.listing.slug}`;

  const candidate = {
    owner: bundle.creator.handle,
    slug: bundle.listing.slug,
    channel: path,
    version: release.version,
    artifact_sha256: release.artifact_sha256,
    published_at: release.created_at ? new Date(release.created_at).toISOString() : null,
    // FR-49, amended 1 Sep 2026: the list price and the two URLs that follow it, read
    // off the live listing row for the same reason `self_reported` is — the stored blob
    // is a snapshot of a release, and a price is not a property of a release.
    price_micro: micro.serialize(toMicro(bundle.listing.price_micro)),
    update_price_micro: micro.serialize(toMicro(bundle.listing.update_price_micro)),
    resource_endpoint: `${base}/api/r/${path}`,
    version_url: `${base}/api/v/${path}`,
    computed,
    // FR-51/FR-52: the creator's own words always come from the listing row, never from
    // the analyser's blob, so a stale manifest cannot keep showing a retracted claim.
    self_reported: {
      ...(typeof selfReportedStored === "object" && selfReportedStored !== null ? selfReportedStored : {}),
      description: bundle.listing.description ?? undefined,
      trigger_hint: bundle.listing.trigger_hint ?? undefined,
    },
  };

  const parsed = Manifest.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * §4.4's belt and braces, on the reading side (13 Sep 2026).
 *
 * `PublicScanFinding` now *rejects* a `secret` or `injection` finding rather than quietly
 * keeping its `kind`, `path` and `line`. That is the right rule, and applying it as
 * validation alone would have been the wrong medicine: `manifestFor` drops a manifest that
 * does not parse **whole**, so one mislabelled finding would take the file tree, the
 * README, the capability block and the price off the page. A defence-in-depth filter must
 * not be the thing that takes the page down. So the finding is removed here and the rest
 * of the manifest renders — the page shows one disclosure fewer, which is the direction a
 * §4.4 mistake should fail in.
 */
function withoutPrivateFindings(computed: unknown): unknown {
  if (!computed || typeof computed !== "object" || Array.isArray(computed)) return computed;
  const scan = (computed as { scan?: unknown }).scan;
  if (!scan || typeof scan !== "object" || Array.isArray(scan)) return computed;
  const findings = (scan as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) return computed;

  const kept = findings.filter((f) => {
    const kind = f && typeof f === "object" ? (f as { kind?: unknown }).kind : undefined;
    return kind !== "secret" && kind !== "injection";
  });
  if (kept.length === findings.length) return computed;
  return { ...(computed as Record<string, unknown>), scan: { ...(scan as Record<string, unknown>), findings: kept } };
}

// --- earnings (FR-29) --------------------------------------------------------

export type EarningsSaleView = {
  slug: string;
  version: string;
  kind: "new" | "update" | "free";
  grossMicro: bigint;
  feeMicro: bigint;
  netMicro: bigint;
  settledAt: string;
  holdbackUntil: string;
  paidOut: boolean;
};

export type EarningsView = {
  grossMicro: bigint;
  feeMicro: bigint;
  netMicro: bigint;
  withdrawableMicro: bigint;
  heldMicro: bigint;
  gasMicro: bigint;
  platformFeeBps: number;
  holdbackDays: number;
  nextReleaseAt: string | null;
  payoutAddress: string;
  sales: EarningsSaleView[];
};

/**
 * FR-29 and FR-40 together. The buyer address and the transaction hash are on the
 * `purchase` row and are deliberately not read into the view type: a creator cannot be
 * shown what a template never received.
 */
/**
 * W1.5: the money totals come from the **canonical** ledger (`lib/payouts/ledger.ts`
 * `earningsFor`), which aggregates over *every* row — never from the displayed page. The
 * web loader is a view adapter over that one computation: it re-shapes `Earnings` into
 * `EarningsView` (ISO strings, the page's sale rows, the display-only `platformFeeBps` /
 * `holdbackDays` / `payoutAddress`) and does not re-sum money. Summing a `.limit(200)`
 * page understated earnings from sale #201 and diverged from `GET /api/earnings`.
 */
export async function earningsForCreator(creator: CreatorRow, now = new Date(), limit = 200): Promise<EarningsView> {
  const earnings = await earningsFor(creator, { limit, now });
  return {
    grossMicro: earnings.grossMicro,
    feeMicro: earnings.feeMicro,
    netMicro: earnings.netMicro,
    withdrawableMicro: earnings.withdrawableMicro,
    heldMicro: earnings.heldMicro,
    gasMicro: earnings.gasMicro,
    platformFeeBps: Number(platformFeeBps()),
    holdbackDays: holdbackDays(),
    nextReleaseAt: earnings.nextReleaseAt ? earnings.nextReleaseAt.toISOString() : null,
    payoutAddress: creator.payout_address,
    sales: earnings.sales.map((s) => ({
      slug: s.slug,
      version: s.version,
      kind: s.kind,
      grossMicro: s.grossMicro,
      feeMicro: s.feeMicro,
      netMicro: s.netMicro,
      settledAt: s.settledAt.toISOString(),
      holdbackUntil: s.holdbackUntil.toISOString(),
      paidOut: s.paidOut,
    })),
  };
}
