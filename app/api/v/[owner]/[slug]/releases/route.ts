/**
 * GET /api/v/:owner/:slug/releases — FR-15, the public release log.
 *
 * "The release log is public and machine-readable" is a product claim, not a
 * convenience: it is the evidence behind the update 402 (FR-17), the thing a buyer
 * checks before paying again, and **creators cannot delete entries**. So this route
 * takes no credential, reveals nothing about who owns what (FR-20), and reads only the
 * public columns of `release` — never `storage_path`, never the scan report's detail.
 *
 * Retired listings keep serving their log (FR-43): "no longer sold" is not "never
 * existed", and a holder still needs to see what they own.
 */

import { type NextRequest, NextResponse } from "next/server";
import { clientIp, enforceLimit } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import type { CreatorRow, ListingRow, ReleaseRow } from "@/lib/db/types";
import { ApiError, handle } from "@/lib/errors";
import { ReleaseLogResponse } from "@/lib/schemas";
import type { DiffSummaryOutput } from "@/lib/schemas/releases";

export const dynamic = "force-dynamic";

/** One page. Small enough that an agent can hold it, large enough to be one call. */
const PAGE_SIZE = 50;

/** FR-15's list, verbatim. Anything not named here never leaves the database. */
const PUBLIC_COLUMNS =
  "version, git_ref, commit_sha, artifact_sha256, created_at, changelog, diff_summary, scan, scanner_version, analyzer_version, price_micro_at_publish, update_price_micro_at_publish";

/** Exactly the columns `PUBLIC_COLUMNS` selects — the row shape `toLogEntry` may see. */
type PublicRelease = Pick<
  ReleaseRow,
  | "version"
  | "git_ref"
  | "commit_sha"
  | "artifact_sha256"
  | "created_at"
  | "changelog"
  | "diff_summary"
  | "scan"
  | "scanner_version"
  | "analyzer_version"
  | "price_micro_at_publish"
  | "update_price_micro_at_publish"
>;

type Params = { params: Promise<{ owner: string; slug: string }> };

export const GET = handle(async (req: NextRequest, context: Params) => {
  // §9: /api/v is 600/min/IP and cacheable.
  await enforceLimit("version", clientIp(req));

  const { owner, slug } = await context.params;
  const client = db();

  const { data: creatorData, error: creatorError } = await client.from("creator").select("*").eq("handle", owner).maybeSingle();
  if (creatorError) throw creatorError;
  const creator = creatorData as CreatorRow | null;
  if (!creator) throw new ApiError("not_found");

  const { data: listingData, error: listingError } = await client
    .from("listing")
    .select("*")
    .eq("creator_id", creator.id)
    .eq("slug", slug)
    .maybeSingle();
  if (listingError) throw listingError;
  const listing = listingData as ListingRow | null;
  if (!listing) throw new ApiError("not_found");

  const cursor = decodeCursor(req.nextUrl.searchParams.get("cursor"));

  // FR-15 names the public columns; this route asks the database for exactly those and no
  // others. `select("*")` would pull `storage_path`, the full `scan_report` and the whole
  // `manifest` blob of fifty releases across the wire on an unauthenticated route, only to
  // drop them in `toLogEntry` — the shape of a leak waiting for one careless `...release`.
  let query = client
    .from("release")
    .select(PUBLIC_COLUMNS)
    .eq("listing_id", listing.id)
    .order("created_at", { ascending: false });
  if (cursor) query = query.lt("created_at", cursor);
  // One extra row answers "is there a next page?" without a count query.
  const { data: releaseData, error: releaseError } = await query.limit(PAGE_SIZE + 1);
  if (releaseError) throw releaseError;

  const rows = (releaseData ?? []) as unknown as PublicRelease[];
  const page = rows.slice(0, PAGE_SIZE);
  const nextCursor = rows.length > PAGE_SIZE ? encodeCursor(page[page.length - 1].created_at) : null;

  const body = ReleaseLogResponse.parse({
    owner: creator.handle,
    slug: listing.slug,
    releases: page.map(toLogEntry),
    next_cursor: nextCursor,
  });

  return NextResponse.json(body, {
    status: 200,
    // Public and cacheable (§9). A new release invalidates by time, not by purge.
    headers: { "cache-control": "public, max-age=30, s-maxage=60, stale-while-revalidate=300" },
  });
});

/** FR-15: exactly the public columns, and every one of them. */
function toLogEntry(release: PublicRelease) {
  return {
    version: release.version,
    tag: release.git_ref && release.git_ref !== "HEAD" ? release.git_ref : null,
    commit_sha: release.commit_sha,
    artifact_sha256: release.artifact_sha256,
    published_at: new Date(release.created_at).toISOString(),
    changelog: release.changelog,
    diff_summary: (release.diff_summary as DiffSummaryOutput | null) ?? null,
    scan: release.scan,
    scanner_version: release.scanner_version,
    analyzer_version: release.analyzer_version,
    price_micro: String(release.price_micro_at_publish),
    update_price_micro: String(release.update_price_micro_at_publish),
  };
}

/** The cursor is the previous page's last `created_at`; opaque so the shape can change. */
function encodeCursor(createdAt: string): string {
  return Buffer.from(createdAt, "utf8").toString("base64url");
}

function decodeCursor(cursor: string | null): string | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    return Number.isFinite(Date.parse(decoded)) ? decoded : null;
  } catch {
    return null;
  }
}
