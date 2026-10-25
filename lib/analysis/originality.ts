/**
 * lib/analysis/originality.ts — FR-50 V0: blob-SHA overlap.
 *
 * Identical files have identical git blob SHAs, and the recursive tree call already
 * hands us every one of them, so verbatim reuse is detectable for free (QS §5.3).
 * MinHash over normalised token streams — which also catches reformatted copies —
 * is V1; this is the cheap, exact half.
 *
 * Two traps from §5.3 are handled here:
 * - **The empty blob.** `e69de29b…` appears in essentially every Python repo. Left in,
 *   copy detection fires on every `__init__.py` and `.gitkeep` in existence.
 * - **Trivial files.** Anything under `MIN_BLOB_BYTES` is excluded for the same reason:
 *   a shared `.gitignore` is not evidence of copying.
 *
 * The corpus is the blob set of the newest release of every *other* live listing.
 * There is no public API for "which repos contain this blob", so the corpus is ours
 * to build; seeding it from public repos is a follow-on, not a V0 blocker.
 */

import { db } from "@/lib/db";
import type { ListingRow, ReleaseRow } from "@/lib/db/types";

/** The empty blob. Never evidence of anything. */
export const EMPTY_BLOB_SHA = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

/** Below this, a shared file is a convention, not a copy. */
export const MIN_BLOB_BYTES = 64;

/** FR-50: at or above this, publishing is blocked as `derivative_of`. */
export const DERIVATIVE_THRESHOLD = 0.9;

export type BlobRef = { sha: string; size: number };

export type OriginalityResult = {
  blob_overlap_ratio: number;
  blobs_seen_elsewhere: number;
  blobs_total: number;
  nearest_listing: string | null;
  /** FR-50. Set when `blob_overlap_ratio >= 0.9` against a single live listing. */
  derivative_of?: string | null;
};

/** The blob SHAs worth storing and comparing: non-empty, non-trivial, deduplicated. */
export function significantBlobs(blobs: BlobRef[]): string[] {
  const out = new Set<string>();
  for (const blob of blobs) {
    if (!blob.sha || blob.sha === EMPTY_BLOB_SHA) continue;
    if (blob.size < MIN_BLOB_BYTES) continue;
    out.add(blob.sha);
  }
  return [...out].sort();
}

export type CorpusEntry = { listingId: string; label: string; blobShas: string[] };

/** Pure half, so the arithmetic is testable without a database. */
export function overlapAgainst(mine: string[], corpus: CorpusEntry[]): OriginalityResult {
  const total = mine.length;
  if (total === 0) {
    return { blob_overlap_ratio: 0, blobs_seen_elsewhere: 0, blobs_total: 0, nearest_listing: null, derivative_of: null };
  }

  const mineSet = new Set(mine);
  const seenAnywhere = new Set<string>();
  let bestRatio = 0;
  let bestLabel: string | null = null;

  for (const entry of corpus) {
    let shared = 0;
    for (const sha of entry.blobShas) {
      if (!mineSet.has(sha)) continue;
      shared++;
      seenAnywhere.add(sha);
    }
    const ratio = shared / total;
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestLabel = entry.label;
    }
  }

  return {
    blob_overlap_ratio: Math.round(bestRatio * 1000) / 1000,
    blobs_seen_elsewhere: seenAnywhere.size,
    blobs_total: total,
    nearest_listing: bestLabel,
    derivative_of: bestRatio >= DERIVATIVE_THRESHOLD ? bestLabel : null,
  };
}

/**
 * Load the corpus: the newest release carrying blob SHAs for every live listing other
 * than this one. Three indexed reads, no joins — PostgREST embedding is not worth the
 * coupling for a query this shape.
 */
export async function loadCorpus(excludeListingId: string): Promise<CorpusEntry[]> {
  const client = db();

  const { data: listingData, error: listingError } = await client
    .from("listing")
    .select("*")
    .not("published_at", "is", null)
    .is("retired_at", null);
  if (listingError) throw listingError;

  const listings = ((listingData ?? []) as ListingRow[]).filter((l) => l.id !== excludeListingId);
  if (listings.length === 0) return [];

  // Three columns, not `*`. Every release row carries a `manifest` jsonb holding the whole
  // file tree, and this query spans every live listing on the platform; pulling all of them
  // into a 300s function to read one `text[]` is how the release cut runs out of memory
  // long before the corpus is interesting.
  const { data: releaseData, error: releaseError } = await client
    .from("release")
    .select("listing_id, created_at, blob_shas")
    .in(
      "listing_id",
      listings.map((l) => l.id),
    )
    .eq("scan", "pass")
    .order("created_at", { ascending: false });
  if (releaseError) throw releaseError;

  type CorpusRelease = Pick<ReleaseRow, "listing_id" | "created_at"> & { blob_shas?: string[] | null };
  const newest = new Map<string, CorpusRelease>();
  for (const release of (releaseData ?? []) as CorpusRelease[]) {
    if (!release.blob_shas || release.blob_shas.length === 0) continue;
    if (!newest.has(release.listing_id)) newest.set(release.listing_id, release);
  }
  if (newest.size === 0) return [];

  const creatorIds = [...new Set(listings.map((l) => l.creator_id))];
  const { data: creatorData, error: creatorError } = await client.from("creator").select("*").in("id", creatorIds);
  if (creatorError) throw creatorError;
  const handles = new Map<string, string>();
  for (const creator of (creatorData ?? []) as { id: string; handle: string }[]) handles.set(creator.id, creator.handle);

  const corpus: CorpusEntry[] = [];
  for (const listing of listings) {
    const release = newest.get(listing.id);
    if (!release) continue;
    corpus.push({
      listingId: listing.id,
      label: `${handles.get(listing.creator_id) ?? "unknown"}/${listing.slug}`,
      blobShas: release.blob_shas ?? [],
    });
  }
  return corpus;
}

/** The whole check: load the corpus and compare. */
export async function originality(blobShas: string[], excludeListingId: string): Promise<OriginalityResult> {
  const corpus = await loadCorpus(excludeListingId);
  return overlapAgainst(blobShas, corpus);
}
