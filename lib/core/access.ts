/**
 * lib/core/access.ts — the only module that knows about entitlements or money.
 *
 * Every surface (resource API, version endpoint, MCP tools, the buy button) calls
 * `quote`; only paid paths call `grant`. See PRD Final.md §11.
 *
 * Money is micro-USDC as bigint. Never a float.
 *
 * The whole entitlement model is one WHERE clause (PRD §12):
 *
 *   purchase WHERE listing_id AND buyer_address AND revoked_at IS NULL
 *            AND (release_id = N OR all_versions OR granted_at > now() - 7 days)
 *
 * It is implemented once, in `entitlingPurchase`, and every branch of `quote` goes
 * through it. The three disjuncts are FR-19 (you keep what you bought), FR-16 (a $0
 * update price stamps lifetime access) and FR-18 (at most one update charge per
 * listing per 7 days).
 */

import { createHash } from "node:crypto";
import { buyLinks, chainLabel, paymentInstructions } from "@/lib/buy-links";
import { db } from "@/lib/db";
import type { CreatorRow, ListingRow, PurchaseKind, PurchaseRow, PurchaseSource, ReleaseRow } from "@/lib/db/types";
import { fromMicro, toMicro } from "@/lib/db/types";
import {
  appUrl,
  holdbackDays as holdbackDaysEnv,
  paymentChain,
  platformFeeBps,
  type StellarRail,
  stellarRail,
  usdcAddress,
  x402Config,
} from "@/lib/env";
import { ApiError } from "@/lib/errors";
import { DiffSummary, type PaymentRequiredBodyOutput, type ReleaseLogEntryOutput } from "@/lib/schemas";
import { PLATFORM_FEE_BPS, splitFee } from "@/lib/core/fee";
import { signedUrl } from "@/lib/storage";
import { assetDomain } from "@/lib/x402/asset";
import { bazaarExtensions, type DiscoveryHints, discoveryHints, serviceMetadata } from "@/lib/x402/bazaar";
import { addressFamily, canonicalAddress, microToStroops, stroopsToMicro } from "@/lib/x402/stellar";

/**
 * D6's split lives in `lib/core/fee.ts` — a file with no imports, so a browser bundle
 * can carry it — and is re-exported here so that this module stays the single address
 * every caller asks about money at. One implementation, two import paths.
 */
export { PLATFORM_FEE_BPS, splitFee };

/**
 * The Stellar rail's pure half (25 Oct 2026) lives in `lib/x402/stellar.ts` for the same
 * reason: units and address spelling are money facts, and callers outside the core import
 * them from here only, so there is one answer to "how many stroops is a micro-dollar".
 */
export { addressFamily, canonicalAddress, microToStroops, stroopsToMicro };

/** An EVM address. Kept for the EVM-only call sites; a buyer or payee may now also be a Stellar strkey. */
export type Address = `0x${string}`;

export type ListingRef = { owner: string; slug: string };

export type Release = {
  id: string;
  listingId: string;
  version: string;
  artifactSha256: string;
  storagePath: string;
  publishedAt: Date;
};

/**
 * FR-15's public release-log row, in the shape `lib/schemas/releases.ts` publishes and
 * the OpenAPI document names. The update 402 carries these verbatim (FR-17), so the
 * quote holds the wire shape rather than a second, camel-cased one that would have to be
 * translated — and mistranslated — on the way out.
 */
export type ReleaseLogEntry = ReleaseLogEntryOutput;

export type Purchase = {
  id: string;
  listingId: string;
  releaseId: string;
  /** Canonical spelling: an EVM `0x…` lower-case, or a Stellar `G…`/`C…` upper-case (BUILD H11). */
  buyerAddress: string;
  allVersions: boolean;
  updatePriceAtPurchase: bigint;
  kind: PurchaseKind;
  source: PurchaseSource;
  grossMicro: bigint;
  feeMicro: bigint;
  netMicro: bigint;
  txHash: string | null;
  paymentNonce: string | null;
  grantedAt: Date;
  holdbackUntil: Date;
  revokedAt: Date | null;
  /** The rail it settled on (CAIP-2), the ledger's partition key since 20261025090100. */
  network: string;
  /** The token contract that was paid, or null for an EVM row the migration could not attribute. */
  asset: string | null;
};

/**
 * The two addresses a creator may have bound, which decide the rails a listing offers
 * (JOURNEYS rule 4). Carried on the quote so `toPaymentRequirements` can build the 402
 * per creator without a second read.
 */
export type Payee = { payoutAddress: string; stellarPayoutAddress: string | null };

export type PaymentRequiredQuote = {
  kind: "payment_required";
  /** Which listing this quote is for. `toPaymentRequirements` needs the URLs. */
  ref: ListingRef;
  listingId: string;
  release: Release;
  priceMicro: bigint;
  reason: "new" | "update";
  releasesSince: ReleaseLogEntry[];
  quoteId: string;
  /** The listing's *current* update price — what a buyer is stamped with (FR-16). */
  updatePriceMicro: bigint;
  /** `update` only: the newest version this buyer already holds. */
  ownedVersion: string | null;
  /** Product copy inputs for the 402 `description` (§13 — an agent reads it). */
  listingDescription: string | null;
  artifactKind: string | null;
  /** Computed manifest facts the Bazaar declaration is built from (lib/x402/bazaar.ts). */
  discovery: DiscoveryHints;
  /** Who gets paid, and so which rails the 402 may offer (`paymentOptionsFor`). */
  payee: Payee;
};

export type Quote =
  | { kind: "granted"; release: Release; purchase: Purchase }
  | PaymentRequiredQuote
  | { kind: "unavailable"; code: "not_found" | "retired" | "no_release" | "not_entitled" };

/** `network` is the requirement's, never the facilitator's (BATTLE-TEST finding 10). */
export type SettleResult = { txHash: string; nonce: string; amountMicro: bigint; network: string };

/**
 * What `toPaymentRequirements` produces. Two views of one quote:
 *
 * - `body` is the 402 JSON *and* the `PAYMENT-REQUIRED` header payload.
 * - `accepts` is the canonical x402 v2 requirement the facilitator is called with.
 *
 * They are separate because `@x402/core`'s v2 schema strips every field it does not
 * name, so the requirement a client echoes back in `accepted` is the canonical one.
 * See DECISIONS.md, "the 402 body carries both spellings".
 */
export type X402Requirement = {
  scheme: "exact";
  network: string;
  /** The asset's smallest unit: micro-USDC on Base, stroops (micro × 10) on Stellar. */
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  /** The EIP-712 domain on Base; exactly `{ areFeesSponsored: true }` on Stellar (BUILD §3.4). */
  extra: { name: string; version: string } | { areFeesSponsored: true };
};

/**
 * One way to pay a listing, as the listing JSON, the MCP tools and the listing page show
 * it (JOURNEYS B4a, BUILD §0b B4). `amount` is the wire amount of the `accepts` entry for
 * the same rail, so an agent reading this can predict the 402 exactly.
 */
export type PaymentOption = {
  network: string;
  asset: string;
  asset_symbol: string;
  amount: string;
  how: string;
};

export type PaymentRequirements = {
  body: PaymentRequiredBodyOutput;
  accepts: X402Requirement[];
  quoteId: string;
  priceMicro: bigint;
};

/** FR-27: fixed holdback. */
export const HOLDBACK_DAYS = 7;

/** FR-18: a holder is charged at most one update per listing per this many days. */
export const UPDATE_BILLING_WINDOW_DAYS = 7;

/** §7.4: a signed download URL lives five minutes. */
export const DOWNLOAD_TTL_SEC = 300;

/** §13: the payer has this long to submit the authorization. */
export const PAYMENT_TIMEOUT_SEC = 300;

/**
 * FR-16: a holder pays the lower of the update price stamped on their purchase
 * and the listing's current update price. A stamped $0 is lifetime (all_versions)
 * and never reaches this function.
 */
export function updatePriceFor(purchase: Pick<Purchase, "updatePriceAtPurchase">, currentUpdatePriceMicro: bigint): bigint {
  return purchase.updatePriceAtPurchase < currentUpdatePriceMicro ? purchase.updatePriceAtPurchase : currentUpdatePriceMicro;
}

// ---------------------------------------------------------------------------
// Resolution helpers — exported because `/api/v` needs the public columns of a
// listing whose quote came back `unavailable`, and nothing outside this module
// should be reading `listing` for a money decision.
// ---------------------------------------------------------------------------

export type ResolvedListing = { creator: CreatorRow; listing: ListingRow };

export async function resolveListing(ref: ListingRef): Promise<ResolvedListing | null> {
  const { data: creatorRow, error: creatorError } = await db().from("creator").select("*").eq("handle", ref.owner).maybeSingle();
  if (creatorError) throw creatorError;
  if (!creatorRow) return null;
  const creator = creatorRow as CreatorRow;

  const { data: listingRow, error: listingError } = await db()
    .from("listing")
    .select("*")
    .eq("creator_id", creator.id)
    .eq("slug", ref.slug)
    .maybeSingle();
  if (listingError) throw listingError;
  if (!listingRow) return null;

  return { creator, listing: listingRow as ListingRow };
}

/**
 * §12: "latest sellable = newest `pass`". Ordered by creation, not by semver.
 *
 * The licence does not gate the sale. Until 2026-09-02 a release whose per-release
 * verdict was `block` was skipped here in favour of the newest *licensed* one (W1.8 /
 * FR-36); the founder took that gate off for the first release along with the publish
 * gate, because half a change is worse than none — a listing that publishes without a
 * licence and then has nothing sellable is a dead listing with no error to explain it.
 * `release.licence_verdict` is still stamped on every cut and still read by the manifest;
 * it just no longer decides what sells. See DECISIONS.md, "The licence gate is a signal,
 * not a gate". The scan gate is untouched and still terminal.
 */
export async function latestPassingRelease(listingId: string): Promise<ReleaseRow | null> {
  const { data, error } = await db()
    .from("release")
    .select("*")
    .eq("listing_id", listingId)
    .eq("scan", "pass")
    .order("created_at", { ascending: false });
  if (error) throw error;
  const rows = (data ?? []) as ReleaseRow[];
  return rows[0] ?? null;
}

export function listingStatus(listing: ListingRow): "draft" | "live" | "retired" {
  if (listing.retired_at) return "retired";
  return listing.published_at ? "live" : "draft";
}

// ---------------------------------------------------------------------------
// quote
// ---------------------------------------------------------------------------

/**
 * What this buyer would pay, right now, for this listing.
 *
 * `buyer` is `null` for an unauthenticated caller: FR-20 says an unsigned request is
 * quoted the new-buyer price and is never told what any address owns.
 */
export async function quote(ref: ListingRef, buyer: Address | string | null, version?: string, now = new Date()): Promise<Quote> {
  const resolved = await resolveListing(ref);
  if (!resolved) return { kind: "unavailable", code: "not_found" };
  const { listing, creator } = resolved;

  const buyerAddress = buyer ? canonicalAddress(buyer) : null;
  const purchases = buyerAddress ? await purchasesFor(listing.id, buyerAddress) : [];
  const isHolder = purchases.length > 0;

  // FR-19 / FR-46: an explicit version is a re-fetch, and it works forever —
  // including after the listing retires, and regardless of the release's scan state
  // at fetch time (the bytes that were sold are the bytes that were scanned).
  if (version !== undefined) {
    const release = await releaseByVersion(listing.id, version);
    if (!release) return { kind: "unavailable", code: "not_found" };
    // W1.6: an explicit version is entitled by an exact-release match or a lifetime
    // purchase only. The FR-18 update window (below) must not grant an arbitrary older
    // version the wallet never bought, so it is disallowed here.
    const purchase = entitlingPurchase(purchases, release.id, now, false);
    if (!purchase) return { kind: "unavailable", code: "not_entitled" };
    return { kind: "granted", release: toRelease(release), purchase };
  }

  // FR-43 / §8.9: retire is terminal for buyers, not for holders.
  if (listing.retired_at && !isHolder) return { kind: "unavailable", code: "retired" };
  // A draft is not a public resource. Holders of an earlier release keep their access
  // through the explicit-version branch above.
  if (!listing.published_at && !isHolder) return { kind: "unavailable", code: "not_found" };

  const latest = await latestPassingRelease(listing.id);
  if (!latest) return { kind: "unavailable", code: "no_release" };

  // The FR-18 window disjunct applies here because `latest` is, by construction, the
  // current latest release (W1.6).
  const entitled = entitlingPurchase(purchases, latest.id, now, true);
  if (entitled) return { kind: "granted", release: toRelease(latest), purchase: entitled };

  // A retired listing sells nothing further, even to a holder.
  if (listing.retired_at) return { kind: "unavailable", code: "retired" };

  const listingPrice = toMicro(listing.price_micro);
  const currentUpdatePrice = toMicro(listing.update_price_micro);

  let priceMicro = listingPrice;
  let reason: "new" | "update" = "new";
  let ownedVersion: string | null = null;
  let releasesSince: ReleaseLogEntry[] = [];

  if (isHolder) {
    reason = "update";
    // FR-16: the stamped terms never worsen. With several purchases, the best of them.
    priceMicro = purchases.reduce<bigint>((best, p) => {
      const candidate = updatePriceFor(p, currentUpdatePrice);
      return candidate < best ? candidate : best;
    }, currentUpdatePrice);

    const ownedRelease = await newestOwnedRelease(listing.id, purchases);
    ownedVersion = ownedRelease?.version ?? null;
    // FR-17: the update 402 carries every release-log entry between the two.
    releasesSince = await releaseLogBetween(listing.id, ownedRelease, latest);
  }

  return {
    kind: "payment_required",
    ref,
    listingId: listing.id,
    release: toRelease(latest),
    priceMicro,
    reason,
    releasesSince,
    quoteId: quoteId(listing, latest, priceMicro, reason),
    updatePriceMicro: currentUpdatePrice,
    ownedVersion,
    listingDescription: listing.description,
    artifactKind: manifestKind(latest),
    discovery: discoveryHints(latest.manifest),
    payee: payeeOf(creator),
  };
}

/** The two bound addresses, as `paymentOptionsFor` reads them. */
function payeeOf(creator: Pick<CreatorRow, "payout_address" | "stellar_payout_address">): Payee {
  return { payoutAddress: creator.payout_address, stellarPayoutAddress: creator.stellar_payout_address ?? null };
}

/**
 * PRD §12's access check, verbatim, over rows already filtered to
 * `listing_id AND buyer_address AND revoked_at IS NULL`.
 *
 * Preference order matters only for which purchase is reported, not for the verdict:
 * an exact release match is the most specific fact, then lifetime, then the FR-18
 * window.
 */
function entitlingPurchase(purchases: Purchase[], releaseId: string, now: Date, allowUpdateWindow: boolean): Purchase | null {
  const windowStart = new Date(now.getTime() - UPDATE_BILLING_WINDOW_DAYS * 86_400_000);
  return (
    purchases.find((p) => p.releaseId === releaseId) ??
    purchases.find((p) => p.allVersions) ??
    // FR-18: the window opens on an *update* charge, not on the initial purchase — otherwise
    // FR-34's "update 402 at the stamped price" could never be observed (DECISIONS, 2026-08-29).
    // W1.6: it grants only the *current latest* release, never an arbitrary explicit version
    // the wallet never bought — so callers resolving an explicit version pass `false`.
    (allowUpdateWindow
      ? purchases.find((p) => p.kind === "update" && p.grantedAt.getTime() > windowStart.getTime())
      : undefined) ??
    null
  );
}

/**
 * FR-23: the quote a payment is bound to. It is a digest of everything that would make
 * the price wrong, so a `PATCH /api/listings/:id` or a new release changes it and a
 * payment against the old one is `409 price_changed`.
 *
 * A digest rather than a signature: forging one buys nothing, because the server
 * recomputes the price from the same rows before it accepts any money.
 */
export function quoteId(listing: ListingRow, release: ReleaseRow, priceMicro: bigint, reason: string): string {
  const material = [
    listing.id,
    release.id,
    priceMicro.toString(),
    String(listing.price_micro),
    String(listing.update_price_micro),
    listing.retired_at ?? "",
    reason,
  ].join("|");
  return `q_${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// paymentOptionsFor — one function decides which rails a listing offers (§11, BUILD §0b B4)
// ---------------------------------------------------------------------------

/**
 * JOURNEYS rule 4: a listing offers a rail only if its money has somewhere to go.
 *
 * - **Base** when the creator's identity address is an EVM `0x…`. A Stellar `G…` identity
 *   does not count (BUILD H5): there is no way to pay USDC on Base to a Stellar account.
 * - **Stellar** when a Stellar payout address is bound, or the identity address itself is
 *   a `G…` — and only when this deployment runs the Stellar rail at all.
 *
 * `CROSS_CHAIN_PAYOUTS` is off (BUILD §0b B3): an EVM-only creator gets Base only. When
 * W5 lands, this is the one place that changes.
 *
 * The 402's `accepts`, `payment_options` in the listing JSON and MCP, and the listing
 * page's Pay area all derive from this, so they cannot disagree.
 */
function railsFor(payee: Payee): { evm: boolean; stellar: StellarRail | null } {
  const identity = addressFamily(payee.payoutAddress);
  const stellar = stellarRail();
  return {
    evm: identity === "evm",
    stellar: stellar && (payee.stellarPayoutAddress !== null || identity === "stellar") ? stellar : null,
  };
}

export function paymentOptionsFor(
  creator: Pick<CreatorRow, "handle" | "payout_address" | "stellar_payout_address">,
  listing: Pick<ListingRow, "slug" | "price_micro">,
): PaymentOption[] {
  const rails = railsFor(payeeOf(creator));
  const priceMicro = toMicro(listing.price_micro);
  const options: PaymentOption[] = [];
  if (rails.evm) {
    // `paymentChain()`, not `x402Config()`: the listing page renders on deployments that
    // hold no receiving address, and an option carries no `payTo`.
    const { network, asset } = paymentChain();
    options.push({
      network,
      asset,
      asset_symbol: "USDC",
      amount: priceMicro.toString(),
      how: `Sign the ${network} entry of accepts as an EIP-3009 USDC authorization on ${chainLabel(network)} and retry with it in PAYMENT-SIGNATURE.`,
    });
  }
  if (rails.stellar) {
    const rail = rails.stellar;
    options.push({
      network: rail.network,
      asset: rail.asset.contract,
      asset_symbol: rail.asset.code,
      amount: microToStroops(priceMicro).toString(),
      how: stellarHow(rail, `${creator.handle}/${listing.slug}`),
    });
  }
  return options;
}

/** The Stellar sentence. The CLI is W4's; the fallback is any x402 client with the Stellar scheme registered. */
function stellarHow(rail: StellarRail, name: string): string {
  return (
    `Pay ${rail.asset.code} on ${chainLabel(rail.network)}: \`npx x402git-stellar buy ${name}\`, ` +
    `or sign the ${rail.network} entry of accepts as a Soroban \`transfer\` of the ${rail.asset.code} contract with an x402 client that has the Stellar scheme registered.`
  );
}

// ---------------------------------------------------------------------------
// toPaymentRequirements — the only place a 402 body is built (§11)
// ---------------------------------------------------------------------------

export function toPaymentRequirements(q: PaymentRequiredQuote, now = new Date()): PaymentRequirements {
  const base = appUrl();
  const links = buyLinks({ owner: q.ref.owner, slug: q.ref.slug, appUrl: base });
  const resource = links.resource_endpoint;
  const manifestUrl = links.manifest_url;
  const amount = q.priceMicro.toString();

  // One accept per rail the creator can be paid on, EVM first (BUILD H10): the MCP text
  // tells EVM agents to sign `accepts[0]`, and an x402 client picks the first entry whose
  // network it has a scheme for, so the Stellar CLI finds its entry wherever it sits.
  const rails = railsFor(q.payee);
  if (!rails.evm && !rails.stellar) {
    // A Stellar-only creator on a deployment with the Stellar rail off. The listing exists
    // and the price is right; there is simply no rail here that reaches the creator. 503,
    // like the kill switch, because turning the rail on is what fixes it.
    throw new ApiError("paused", { message: "This listing's creator cannot be paid on any payment rail this deployment serves." });
  }

  const description = paymentDescription(q);
  const canonicals: X402Requirement[] = [];
  const accepts: PaymentRequiredBodyOutput["accepts"] = [];

  if (rails.evm) {
    const { network, payTo, asset } = x402Config();
    // Spelled out rather than spread from the union type, so the published schema's
    // narrower EVM shape typechecks; the key order is the wire order it always had.
    const canonical = {
      scheme: "exact" as const,
      network,
      amount,
      asset,
      payTo,
      maxTimeoutSeconds: PAYMENT_TIMEOUT_SEC,
      // EIP-712 domain of the asset, per x402 v2, looked up per network: Base Sepolia
      // USDC is ("USDC", "2") and Base mainnet USDC is ("USD Coin", "2"). Getting it
      // wrong is not a validation error — the buyer signs for a domain the token does
      // not recognise and settlement fails on simulation. See lib/x402/asset.ts.
      extra: assetDomain(network, asset),
    };
    canonicals.push(canonical);
    // Both spellings: the v2 names `@x402/core` validates, and the v1 names PRD §13 and
    // `lib/schemas/payment.ts` specify. A v2 client strips the aliases before it signs,
    // so `accepted` still deep-equals `canonical`.
    accepts.push({ ...canonical, maxAmountRequired: amount, resource, description, mimeType: "application/zip" });
  }

  if (rails.stellar) {
    const rail = rails.stellar;
    const stroops = microToStroops(q.priceMicro).toString();
    // BUILD §3.4, exactly. `extra` must be `{ areFeesSponsored: true }` and nothing else:
    // the client echoes it in `accepted` and the facilitator compares the two.
    const canonical = {
      scheme: "exact" as const,
      network: rail.network,
      amount: stroops,
      asset: rail.asset.contract,
      payTo: rail.payTo,
      maxTimeoutSeconds: PAYMENT_TIMEOUT_SEC,
      extra: { areFeesSponsored: true as const },
    };
    canonicals.push(canonical);
    accepts.push({
      ...canonical,
      maxAmountRequired: stroops,
      resource,
      // The same product copy, naming the configured symbol so an agent holding USDT0
      // on Stellar and USDC on Base knows which this entry wants.
      description: `${description} ${dollars(q.priceMicro)} in ${rail.asset.code} on ${chainLabel(rail.network)}.`,
      mimeType: "application/zip",
    });
  }

  // The prose beside the fields. Unchanged for a Base creator; a Stellar-only creator's
  // reader is told the Stellar procedure instead, and a creator on both rails gets the
  // Base sentence with the Stellar alternative appended.
  const stellarSentence = rails.stellar ? stellarHow(rails.stellar, `${q.ref.owner}/${q.ref.slug}`) : null;
  const instructions = rails.evm
    ? stellarSentence
      ? `${paymentInstructions(links, chainLabel(canonicals[0].network))} Or on Stellar: ${stellarSentence}`
      : paymentInstructions(links, chainLabel(canonicals[0].network))
    : `This is an x402 paywall, not an error. To buy: ${stellarSentence} Then GET ${resource} again with the payment in the PAYMENT-SIGNATURE header and extra.quote_id in X-Quote-Id. ` +
      `The full procedure is at ${links.skill_url}; the same tools are an MCP server at ${links.mcp_url}. ` +
      `No wallet? A person can buy at ${links.listing_url}, and the free manifest at ${manifestUrl} shows what is inside before anyone pays.`;

  const body = {
    x402Version: 2 as const,
    // ResourceInfo — required by the x402 v2 envelope. `serviceName` and `tags` are the
    // Bazaar's, computed from the manifest and never from the creator's copy (FR-52).
    resource: { url: resource, description, mimeType: "application/zip", ...serviceMetadata(q.ref, q.discovery) },
    accepts,
    // The Bazaar discovery declaration (adopted 16 Sep 2026). An x402 client echoes it
    // in the payment payload and the facilitator catalogues this URL on settlement.
    extensions: bazaarExtensions(q.ref, q.release.version, base),
    extra: {
      kind: q.reason,
      version: q.release.version,
      ...(q.reason === "update" && q.ownedVersion ? { from: q.ownedVersion, to: q.release.version } : {}),
      manifest_url: manifestUrl,
      scan_badge_url: `${manifestUrl}#scan`,
      update_price_micro: q.updatePriceMicro.toString(),
      ...(q.releasesSince.length > 0 ? { releases: q.releasesSince } : {}),
      quote_id: q.quoteId,
      // FR-23: a quote carries `quote_id` *and* a validity horizon. It is the same
      // window the payer has to submit the authorization (`maxTimeoutSeconds`), and it
      // is advisory: the binding check is that the amount still equals the price.
      valid_before: new Date(now.getTime() + PAYMENT_TIMEOUT_SEC * 1000).toISOString(),
      // The self-describing part (2026-09-02). An x402 client never reads these; every
      // other reader — a shell agent, a chat model's fetch tool, a person with curl —
      // has nothing else to go on, and this is the moment it decides what to do next.
      instructions,
      listing_url: links.listing_url,
      skill_url: links.skill_url,
      mcp_url: links.mcp_url,
    },
  } satisfies PaymentRequiredBodyOutput;

  return { body, accepts: canonicals, quoteId: q.quoteId, priceMicro: q.priceMicro };
}

/** `$2.00` from micro-dollars, two places, no float. For prose only; the fields carry the integer. */
function dollars(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const cents = (micro % 1_000_000n) / 10_000n;
  return `$${whole}.${cents.toString().padStart(2, "0")}`;
}

/**
 * §13: "The `description` is read inside an agent's reasoning — it is product copy."
 * It has to answer, in one line, what this is, what version, and why this price.
 */
function paymentDescription(q: PaymentRequiredQuote): string {
  const name = `${q.ref.owner}/${q.ref.slug}`;
  const kind = q.artifactKind ? ` ${q.artifactKind}` : "";
  if (q.reason === "update" && q.ownedVersion) {
    const n = q.releasesSince.length;
    const releases = n === 1 ? "1 release" : `${n} releases`;
    return `${name} v${q.ownedVersion} → v${q.release.version} — the update price for a${kind} you already own. ${releases} since.`;
  }
  const summary = q.listingDescription ? ` ${q.listingDescription}` : "";
  return `${name} v${q.release.version} —${kind ? kind : " release"}.${summary} Security scan passed; signed download, 5-minute URL.`;
}

// ---------------------------------------------------------------------------
// grant — only ever called after `settle` returned a tx hash (FR-22)
// ---------------------------------------------------------------------------

export type GrantOptions = { source?: PurchaseSource; now?: Date };

/**
 * Write the purchase. Idempotent on the EIP-3009 nonce (FR-22, §13):
 *
 * - the same nonce with the same `{listing, version, amount}` returns the existing row;
 * - the same nonce with anything else is `authorization_mismatch`;
 * - a race that loses the `payment_nonce` unique index re-reads and returns the winner.
 */
export async function grant(
  q: PaymentRequiredQuote,
  buyer: Address | string,
  settlement: SettleResult,
  options: GrantOptions = {},
): Promise<Purchase> {
  const now = options.now ?? new Date();
  const buyerAddress = canonicalAddress(buyer);

  // The rail must be one this deployment serves, and the payer must belong to it: a
  // settlement naming a network we never quoted is not ours to grant, and a `0x…` buyer
  // on a Stellar row (or the reverse) would fail the `purchase_network_shape` CHECK
  // after the money moved (BATTLE-TEST finding 11).
  const rail = servedRail(settlement.network);
  if (!rail || rail.family !== addressFamily(buyerAddress)) {
    throw new ApiError("authorization_mismatch", {
      message: `That settlement is on ${settlement.network}, which this deployment does not serve for this payer.`,
    });
  }

  // The rail `insertPurchase` stamps. A row for the same nonce on another rail is a
  // different authorization (CORE-1, now partitioned on `network` — BATTLE-TEST finding
  // 1), never this one's idempotent replay.
  const existing = await purchaseByNonce(settlement.nonce, settlement.network);
  if (existing) {
    const matches =
      existing.listingId === q.listingId && existing.releaseId === q.release.id && existing.grossMicro === settlement.amountMicro;
    if (!matches) {
      throw new ApiError("authorization_mismatch", {
        message: "That payment authorization was already used for a different listing, version or amount.",
        details: { nonce_bound_to: { listing_id: existing.listingId, release_id: existing.releaseId } },
      });
    }
    return existing;
  }

  return await insertPurchase(q, buyerAddress, settlement, options.source ?? "api", now);
}

/**
 * FR-24: a $0 listing hands over the artifact with no payment at all. A purchase row is
 * written only when the caller signed, because an anonymous fetch has no address to
 * stamp — and without a row the re-fetch and update-pricing paths cannot work.
 */
export async function grantFree(q: PaymentRequiredQuote, buyer: Address | string, options: GrantOptions = {}): Promise<Purchase> {
  if (q.priceMicro !== 0n) throw new Error("grantFree called on a priced quote");
  const now = options.now ?? new Date();
  const buyerAddress = canonicalAddress(buyer);

  const held = await purchasesFor(q.listingId, buyerAddress);
  const already = held.find((p) => p.releaseId === q.release.id);
  if (already) return already;

  return await insertPurchase(q, buyerAddress, null, options.source ?? "api", now);
}

async function insertPurchase(
  q: PaymentRequiredQuote,
  buyerAddress: string,
  settlement: SettleResult | null,
  source: PurchaseSource,
  now: Date,
): Promise<Purchase> {
  const grossMicro = q.priceMicro;
  const { feeMicro, netMicro } = splitFee(grossMicro, platformFeeBps());
  const holdbackUntil = new Date(now.getTime() + holdbackDaysEnv() * 86_400_000);

  // FR-16: $0 updates are lifetime, irrevocably, whatever the price does later.
  const allVersions = q.updatePriceMicro === 0n;
  const kind: PurchaseKind = grossMicro === 0n ? "free" : q.reason;

  // Which rail this row belongs to: the settlement's on a paid grant (`grant` has already
  // checked it is served and matches the payer), the buyer's own family on a free one.
  const rail = settlement ? servedRail(settlement.network) : railForBuyer(buyerAddress);
  if (!rail) throw new ApiError("authorization_mismatch", { message: "No payment rail on this deployment matches that wallet." });

  const { data, error } = await db()
    .from("purchase")
    .insert({
      listing_id: q.listingId,
      release_id: q.release.id,
      buyer_address: buyerAddress,
      all_versions: allVersions,
      update_price_at_purchase: fromMicro(q.updatePriceMicro),
      kind,
      source,
      gross_micro: fromMicro(grossMicro),
      fee_micro: fromMicro(feeMicro),
      net_micro: fromMicro(netMicro),
      tx_hash: settlement?.txHash ?? null,
      payment_nonce: settlement?.nonce ?? null,
      granted_at: now.toISOString(),
      holdback_until: holdbackUntil.toISOString(),
      // Which rail this settled on, and in which token. One database serves Base Sepolia,
      // Base mainnet and Stellar, so without these the sweep would pay real money for
      // testnet sales (20260906010000) or USDT0 for a USDC sale (20261025090100).
      // `chain_id` is the EVM spelling of `network` and is null on Stellar; the admin and
      // reconcile reads still filter on it, and by construction never see a Stellar row.
      network: rail.network,
      asset: rail.asset,
      chain_id: rail.chainId,
    })
    .select("*")
    .single();

  if (error) {
    // 23505: a concurrent request for the same purchase won the race. Re-read and return
    // the winner rather than surfacing a duplicate-key error.
    if (error.code === "23505") {
      // Paid path: the `(network, payment_nonce)` unique index (FR-22).
      if (settlement) {
        const winner = await purchaseByNonce(settlement.nonce, settlement.network);
        if (winner) return winner;
      } else {
        // W1.7 / W3.7: the free path's `(listing_id, release_id, buyer_address) where
        // kind='free'` partial unique index — mirror the paid path's idempotency.
        const winner = await freePurchaseFor(q.listingId, q.release.id, buyerAddress);
        if (winner) return winner;
      }
    }
    throw error;
  }
  return toPurchase(data as PurchaseRow);
}

// ---------------------------------------------------------------------------
// downloadUrl / owned
// ---------------------------------------------------------------------------

/**
 * A short-lived signed URL over the exact bytes that were scanned (§6, D3). The hash is
 * returned with it so the caller can verify what it got without trusting the URL.
 */
export async function downloadUrl(
  p: Purchase,
  ttlSec = DOWNLOAD_TTL_SEC,
): Promise<{ url: string; artifactSha256: string; version: string; expiresAt: Date }> {
  const release = await releaseById(p.releaseId);
  if (!release) throw new ApiError("not_found", { message: "The release for that purchase no longer exists." });
  return await downloadUrlForRelease(toRelease(release), ttlSec);
}

export async function downloadUrlForRelease(
  release: Release,
  ttlSec = DOWNLOAD_TTL_SEC,
): Promise<{ url: string; artifactSha256: string; version: string; expiresAt: Date }> {
  if (!release.storagePath) {
    throw new ApiError("not_found", { message: "That release has no stored artifact." });
  }
  const { url, expiresAt } = await signedUrl(release.storagePath, ttlSec);
  return { url, artifactSha256: release.artifactSha256, version: release.version, expiresAt };
}

/** Everything this wallet owns, newest first. FR-32. */
export async function owned(buyer: Address | string, ref?: ListingRef): Promise<Purchase[]> {
  const buyerAddress = canonicalAddress(buyer);
  let listingId: string | null = null;
  if (ref) {
    const resolved = await resolveListing(ref);
    if (!resolved) return [];
    listingId = resolved.listing.id;
  }

  // This wallet's rail only. One database serves both networks, so without the filter a
  // wallet that bought on Sepolia would read as owning the version on mainnet and be
  // handed a free download of something it paid test money for (2026-09-07, the
  // cutover). The rail follows the address family (JOURNEYS rule 7: a buyer is a wallet
  // on a network); a Stellar wallet on a deployment with no Stellar rail owns nothing here.
  const network = networkForBuyer(buyerAddress);
  if (!network) return [];
  let query = db()
    .from("purchase")
    .select("*")
    .eq("buyer_address", buyerAddress)
    .eq("network", network)
    .is("revoked_at", null);
  if (listingId) query = query.eq("listing_id", listingId);
  const { data, error } = await query.order("granted_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as PurchaseRow[]).map(toPurchase);
}

export type OwnedEntitlement = { purchase: Purchase; owner: string; slug: string; version: string };

/**
 * `owned`, plus the names FR-32 has to render. One extra read per distinct listing and
 * release rather than a join, because PostgREST embedding is not in the mock DB.
 */
export async function ownedWithContext(buyer: Address | string, limit = 100, cursor?: string): Promise<{ items: OwnedEntitlement[]; nextCursor: string | null }> {
  const buyerAddress = canonicalAddress(buyer);
  let query = db().from("purchase").select("*").eq("buyer_address", buyerAddress);
  if (cursor) query = query.lt("granted_at", cursor);
  const { data, error } = await query.order("granted_at", { ascending: false }).limit(limit + 1);
  if (error) throw error;

  const rows = (data ?? []) as PurchaseRow[];
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? page[page.length - 1].granted_at : null;

  const items: OwnedEntitlement[] = [];
  for (const row of page) {
    const listing = await listingById(row.listing_id);
    const release = await releaseById(row.release_id);
    if (!listing || !release) continue;
    const creator = await creatorById(listing.creator_id);
    if (!creator) continue;
    items.push({ purchase: toPurchase(row), owner: creator.handle, slug: listing.slug, version: release.version });
  }
  return { items, nextCursor };
}

// ---------------------------------------------------------------------------
// row plumbing
// ---------------------------------------------------------------------------

async function purchasesFor(listingId: string, buyerAddress: string): Promise<Purchase[]> {
  // See the note in `owned`: entitlement does not cross rails, and the rail is the
  // wallet's. Partitioned on `network`, not `chain_id`, because a Stellar row has none
  // (BATTLE-TEST finding 1: filtering `chain_id` made every G buyer own nothing).
  const network = networkForBuyer(buyerAddress);
  if (!network) return [];
  const { data, error } = await db()
    .from("purchase")
    .select("*")
    .eq("listing_id", listingId)
    .eq("buyer_address", buyerAddress)
    .eq("network", network)
    .is("revoked_at", null)
    .order("granted_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as PurchaseRow[]).map(toPurchase);
}

/**
 * §13: "a replay returns the existing purchase". The route looks the nonce up before it
 * spends a facilitator call, so a resent authorization is answered from our own ledger.
 *
 * Chain-scoped, like every other entitlement read (CORE-1, RED-TEAM-2026-09-21). An
 * EIP-3009 nonce is unique per token contract *per chain*, so the same 32 bytes can be
 * signed legally on Base Sepolia and on Base mainnet, and one database holds both. An
 * unscoped lookup let a testnet purchase answer a mainnet replay: buy with test USDC on
 * a Sepolia deployment, then present a signed-but-unsubmitted mainnet authorization with
 * the same nonce and be handed the mainnet download. The default is the EVM chain this
 * deployment settles on; a Stellar replay passes the network its payload named.
 *
 * The partition key is `network` (CAIP-2), not `chain_id`, since 20261025090100: a
 * Stellar row has no chain id, and a lookup on one missed every Stellar replay, so the
 * insert hit the global nonce key and an idempotent retry 500d (BATTLE-TEST finding 1).
 */
export async function findPurchaseByNonce(nonce: string, network: string = paymentChain().network): Promise<Purchase | null> {
  return await purchaseByNonce(nonce, network);
}

async function purchaseByNonce(nonce: string, network: string): Promise<Purchase | null> {
  const { data, error } = await db()
    .from("purchase")
    .select("*")
    .eq("payment_nonce", nonce)
    .eq("network", network)
    .maybeSingle();
  if (error) throw error;
  return data ? toPurchase(data as PurchaseRow) : null;
}

/** W1.7: the single free purchase for this `(listing, release, wallet)`, if one exists. */
async function freePurchaseFor(listingId: string, releaseId: string, buyerAddress: string): Promise<Purchase | null> {
  const { data, error } = await db()
    .from("purchase")
    .select("*")
    .eq("listing_id", listingId)
    .eq("release_id", releaseId)
    .eq("buyer_address", buyerAddress)
    .eq("kind", "free")
    .is("revoked_at", null)
    .maybeSingle();
  if (error) throw error;
  return data ? toPurchase(data as PurchaseRow) : null;
}

async function releaseById(id: string): Promise<ReleaseRow | null> {
  const { data, error } = await db().from("release").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as ReleaseRow) ?? null;
}

async function releaseByVersion(listingId: string, version: string): Promise<ReleaseRow | null> {
  const { data, error } = await db().from("release").select("*").eq("listing_id", listingId).eq("version", version).maybeSingle();
  if (error) throw error;
  return (data as ReleaseRow) ?? null;
}

async function listingById(id: string): Promise<ListingRow | null> {
  const { data, error } = await db().from("listing").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as ListingRow) ?? null;
}

async function creatorById(id: string): Promise<CreatorRow | null> {
  const { data, error } = await db().from("creator").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as CreatorRow) ?? null;
}

/** The newest release this buyer holds — the `from` of an update 402. */
async function newestOwnedRelease(listingId: string, purchases: Purchase[]): Promise<ReleaseRow | null> {
  const ids = new Set(purchases.map((p) => p.releaseId));
  if (ids.size === 0) return null;
  const { data, error } = await db().from("release").select("*").eq("listing_id", listingId).order("created_at", { ascending: false });
  if (error) throw error;
  const rows = (data ?? []) as ReleaseRow[];
  return rows.find((r) => ids.has(r.id)) ?? null;
}

/**
 * FR-17: the release-log entries strictly after `from`, up to and including `to`, in the
 * FR-15 wire shape. `diff_summary` is passed through only when it validates, so a 402
 * body can never fail its own published schema because an analyzer wrote something odd.
 */
async function releaseLogBetween(listingId: string, from: ReleaseRow | null, to: ReleaseRow): Promise<ReleaseLogEntry[]> {
  const { data, error } = await db().from("release").select("*").eq("listing_id", listingId).order("created_at", { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as ReleaseRow[];

  const fromTime = from ? new Date(from.created_at).getTime() : -Infinity;
  const toTime = new Date(to.created_at).getTime();

  return rows
    .filter((r) => {
      const t = new Date(r.created_at).getTime();
      return t > fromTime && t <= toTime && r.scan === "pass";
    })
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .map(toReleaseLogEntry);
}

export function toReleaseLogEntry(r: ReleaseRow): ReleaseLogEntry {
  const diff = DiffSummary.safeParse(r.diff_summary);
  return {
    version: r.version,
    tag: r.git_ref,
    commit_sha: r.commit_sha,
    artifact_sha256: r.artifact_sha256,
    published_at: new Date(r.created_at).toISOString(),
    changelog: r.changelog,
    diff_summary: diff.success ? diff.data : null,
    scan: r.scan,
    scanner_version: r.scanner_version,
    analyzer_version: r.analyzer_version,
    price_micro: toMicro(r.price_micro_at_publish).toString(),
    update_price_micro: toMicro(r.update_price_micro_at_publish).toString(),
  };
}

function manifestKind(release: ReleaseRow): string | null {
  const manifest = release.manifest as { kind?: unknown } | null;
  const kind = manifest && typeof manifest === "object" ? manifest.kind : null;
  return typeof kind === "string" && kind.length > 0 ? kind : null;
}

export function toRelease(row: ReleaseRow): Release {
  return {
    id: row.id,
    listingId: row.listing_id,
    version: row.version,
    artifactSha256: row.artifact_sha256 ?? "",
    storagePath: row.storage_path ?? "",
    publishedAt: new Date(row.created_at),
  };
}

export function toPurchase(row: PurchaseRow): Purchase {
  return {
    id: row.id,
    listingId: row.listing_id,
    releaseId: row.release_id,
    buyerAddress: row.buyer_address,
    allVersions: row.all_versions,
    updatePriceAtPurchase: toMicro(row.update_price_at_purchase),
    kind: row.kind,
    source: row.source,
    grossMicro: toMicro(row.gross_micro),
    feeMicro: toMicro(row.fee_micro),
    netMicro: toMicro(row.net_micro),
    txHash: row.tx_hash,
    paymentNonce: row.payment_nonce,
    grantedAt: new Date(row.granted_at),
    holdbackUntil: new Date(row.holdback_until),
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
    // Rows written before 20261025090100 were backfilled; the mock has no trigger, so a
    // fixture that forgot the column reads as the deployment's EVM chain, as it would have.
    network: row.network ?? (row.chain_id != null ? `eip155:${row.chain_id}` : paymentChain().network),
    asset: row.asset ?? null,
  };
}

// ---------------------------------------------------------------------------
// rails — which network a row belongs to, in one place
// ---------------------------------------------------------------------------

/** What `insertPurchase` stamps: the three columns that say where a row settled. */
type RowRail = { family: "evm" | "stellar"; network: string; asset: string; chainId: number | null };

/** The rail named by a CAIP-2 id, if this deployment serves it. */
function servedRail(network: string): RowRail | null {
  const evm = paymentChain();
  if (network === evm.network) return { family: "evm", network: evm.network, asset: evm.asset, chainId: evm.chainId };
  const stellar = stellarRail();
  if (stellar && network === stellar.network) return { family: "stellar", network: stellar.network, asset: stellar.asset.contract, chainId: null };
  return null;
}

/**
 * JOURNEYS rule 7: a buyer is a wallet on a network, and the network follows the address.
 * An EVM wallet is on this deployment's EVM chain; a Stellar wallet is on its Stellar
 * network, or nowhere when the rail is off.
 */
function railForBuyer(buyerAddress: string): RowRail | null {
  const family = addressFamily(buyerAddress);
  if (family === "evm") return servedRail(paymentChain().network);
  const stellar = stellarRail();
  if (family === "stellar" && stellar) return servedRail(stellar.network);
  return null;
}

function networkForBuyer(buyerAddress: string): string | null {
  return railForBuyer(buyerAddress)?.network ?? null;
}

/** Re-exported so callers do not have to know which module owns the default. */
export { usdcAddress };
