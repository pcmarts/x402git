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
import type { ListingRow, ReleaseRow } from "@/lib/db/types";
import { toMicro } from "@/lib/db/types";
import { type ListingEndpoints, type ListingStatus, pricingBlock } from "@/lib/schemas";
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

/** The full `Listing` body. `latestRelease` is the newest passing release, or null. */
export function listingView(listing: ListingRow, handle: string, latestRelease: ReleaseRow | null) {
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
    endpoints: endpointsFor(handle, listing.slug),
    remote,
    ssh_host_key_fingerprints: remote ? sshHostKeyFingerprints() : null,
    default_branch: remote ? HOSTED_DEFAULT_BRANCH : null,
    created_at: new Date(listing.created_at).toISOString(),
    published_at: listing.published_at ? new Date(listing.published_at).toISOString() : null,
    retired_at: listing.retired_at ? new Date(listing.retired_at).toISOString() : null,
  };
}
