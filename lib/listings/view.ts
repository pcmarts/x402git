/**
 * lib/listings/view.ts — rows → the API's listing shapes.
 *
 * Everything here is pure: no database, no network, no clock beyond what is passed in.
 * The service does the reads; this file decides what a listing *looks like*, and it is
 * the only place that knows the URL layout (§9) and the draft/live/retired rule (FR-42).
 */

import { appUrl, platformFeeBps } from "@/lib/env";
import { currentHostedOrg } from "@/lib/github/app";
import { HOSTED_DEFAULT_BRANCH, hostedRemote, hostedRepoName, sshHostKeyFingerprints } from "@/lib/github/hosted";
import { paymentOptionsFor } from "@/lib/core/access";
import type { CreatorRow, ListingRow, ReleaseRow } from "@/lib/db/types";
import { toMicro } from "@/lib/db/types";
import { type ListingEndpoints, type ListingStatus, type OpenReleaseBlockOutput, type OpenReleaseCheckOutput, pricingBlock } from "@/lib/schemas";
import type * as z from "zod";

export type Endpoints = z.infer<typeof ListingEndpoints>;
export type Status = z.infer<typeof ListingStatus>;

/**
 * FR-42. Retired wins over published: a listing that was live and is now retired is
 * retired, and there is no path back.
 */
export function statusOf(listing: Pick<ListingRow, "published_at" | "retired_at">): Status {
  if (listing.retired_at) return "retired";
  if (listing.published_at) return "live";
  return "draft";
}

/** §9. Every public URL a listing has, absolute, so an agent never builds one itself. */
export function endpointsFor(handle: string, slug: string): Endpoints {
  const base = appUrl();
  return {
    url: `${base}/${handle}/${slug}`,
    label_endpoint: `${base}/api/label/${handle}/${slug}`,
    version_endpoint: `${base}/api/v/${handle}/${slug}`,
    releases_endpoint: `${base}/api/v/${handle}/${slug}/releases`,
    resource_endpoint: `${base}/api/r/${handle}/${slug}`,
  };
}

export function manifestUrl(handle: string, slug: string): string {
  return `${appUrl()}/api/label/${handle}/${slug}`;
}

/**
 * The Rail B remote, or null. `hosted_org` is authoritative; older rows written before
 * migration 0400 fall back to the current cohort org, which is right while there is
 * exactly one. Null once FR-44 has deleted the repo.
 */
export function remoteFor(listing: ListingRow, handle: string): string | null {
  if (listing.source !== "hosted" || listing.github_repo_id === null) return null;
  const org = listing.hosted_org ?? safeCurrentHostedOrg();
  if (!org) return null;
  return hostedRemote(org, hostedRepoName(handle, listing.slug));
}

function safeCurrentHostedOrg(): string | null {
  try {
    return currentHostedOrg();
  } catch {
    return null;
  }
}

/** FR-13 / D2a: the pricing block is on every listing response, without exception. */
export function pricingFor(listing: Pick<ListingRow, "price_micro" | "update_price_micro">) {
  return pricingBlock(toMicro(listing.price_micro), toMicro(listing.update_price_micro), Number(platformFeeBps()));
}

/** FR-9: "latest" is the newest release with `scan = pass`. `pending` and `fail` are not sellable. */
export function latestReleaseView(release: ReleaseRow | null, handle: string, slug: string) {
  if (!release) return null;
  return {
    release_id: release.id,
    version: release.version,
    scan: release.scan,
    artifact_sha256: release.artifact_sha256,
    published_at: release.created_at ? new Date(release.created_at).toISOString() : null,
    manifest_url: manifestUrl(handle, slug),
  };
}

// ---------------------------------------------------------------------------
// Open releases (25 Oct 2026, HackMeridian)
// ---------------------------------------------------------------------------

/**
 * The promise stamped on a release, as the API and the page show it. Pure: stored
 * columns only, so the listing page, the listing JSON and MCP `get_listing` cannot
 * disagree about a status. Null when the release carries no promise — a release cut
 * before the listing became an open release was never promised to anyone, and saying
 * "opens on …" over it would be a claim nobody made.
 *
 * `public_repo_url` is read off the listing, not the release: the check in
 * `lib/release/promise.ts` asks the listing's current URL too, so the two agree.
 */
export function openReleaseView(listing: Pick<ListingRow, "public_repo_url" | "open_release" | "open_after_days">, release: ReleaseRow | null): OpenReleaseBlockOutput | null {
  if (!release?.promise_status) return null;
  const evidence = (release.promise_evidence ?? null) as { html_url?: unknown } | null;
  return {
    opens_at: iso(release.opens_at),
    open_after_days: openAfterDays(listing),
    public_repo_url: listing.public_repo_url ?? "",
    licence: release.open_licence_spdx ?? null,
    status: release.promise_status,
    opened_at: iso(release.opened_at),
    checked_at: iso(release.promise_checked_at),
    evidence_url: evidence && typeof evidence.html_url === "string" ? evidence.html_url : null,
    checks: openReleaseChecks(release.open_eligibility),
  };
}

/**
 * The standing offer, for the creator's own `GET /api/listings/:id` before any release
 * has been stamped: what the next cut will promise. Never shown on a public surface,
 * where only a stamped release speaks (see `openReleaseView`).
 */
export function openReleaseOffer(listing: Pick<ListingRow, "open_release" | "public_repo_url" | "open_after_days" | "licence_spdx" | "open_eligibility">): OpenReleaseBlockOutput | null {
  const days = openAfterDays(listing);
  if (!listing.open_release || !listing.public_repo_url || days === null) return null;
  return {
    // No release, so no date yet: the offer is the rule, and the cut turns it into a day.
    opens_at: null,
    open_after_days: days,
    public_repo_url: listing.public_repo_url,
    licence: listing.licence_spdx ?? null,
    status: "pending",
    opened_at: null,
    checked_at: null,
    evidence_url: null,
    checks: openReleaseChecks(listing.open_eligibility),
  };
}

/** The standing rule, or null when the listing is not (or no longer) an open release. */
function openAfterDays(listing: Pick<ListingRow, "open_release" | "open_after_days">): number | null {
  if (!listing.open_release) return null;
  const days = listing.open_after_days;
  return typeof days === "number" && Number.isInteger(days) && days >= 1 ? days : null;
}

/** A jsonb `open_eligibility` column as the checks array, dropping anything malformed. */
export function openReleaseChecks(stored: unknown): OpenReleaseCheckOutput[] {
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((c) => {
    const row = c as { id?: unknown; ok?: unknown; detail?: unknown } | null;
    return row && typeof row.id === "string" && typeof row.ok === "boolean" && typeof row.detail === "string" ? [{ id: row.id, ok: row.ok, detail: row.detail }] : [];
  });
}

function iso(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * The full `Listing` body. `latestRelease` is the newest passing release, or null.
 *
 * `creator`, when given, adds `payment_options` — the networks this listing can be paid
 * on, from the creator's bound addresses (JOURNEYS B4a, 25 Oct 2026). It is optional
 * only so the create response, which picks its own fields, can keep calling with a handle.
 */
export function listingView(
  listing: ListingRow,
  handle: string,
  latestRelease: ReleaseRow | null,
  creator?: Pick<CreatorRow, "handle" | "payout_address" | "stellar_payout_address">,
) {
  const remote = remoteFor(listing, handle);
  return {
    listing_id: listing.id,
    owner: handle,
    slug: listing.slug,
    status: statusOf(listing),
    source: listing.source,
    description: listing.description,
    trigger_hint: listing.trigger_hint,
    licence: { verdict: listing.licence_verdict, spdx: listing.licence_spdx },
    latest_release: latestReleaseView(latestRelease, handle, listing.slug),
    pricing: pricingFor(listing),
    ...(creator ? { payment_options: paymentOptionsFor(creator, listing) } : {}),
    // The creator's choice of rails (migration 20261025213000); `payment_options` above is
    // already filtered by it. Null, and absent on a row read before the migration: every rail.
    offered_networks: Array.isArray(listing.offered_networks) ? listing.offered_networks : null,
    // The promise on the release that sells, else what the next cut will stamp. This is
    // the creator's own view, so the standing offer belongs here; public surfaces call
    // `openReleaseView` alone.
    open_release: openReleaseView(listing, latestRelease) ?? openReleaseOffer(listing),
    endpoints: endpointsFor(handle, listing.slug),
    remote,
    ssh_host_key_fingerprints: remote ? sshHostKeyFingerprints() : null,
    default_branch: remote ? HOSTED_DEFAULT_BRANCH : null,
    created_at: new Date(listing.created_at).toISOString(),
    published_at: listing.published_at ? new Date(listing.published_at).toISOString() : null,
    retired_at: listing.retired_at ? new Date(listing.retired_at).toISOString() : null,
  };
}
