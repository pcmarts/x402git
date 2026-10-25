/**
 * lib/listings/version.ts — "what is the latest, and what would it cost me", once.
 *
 * §11: `/api/v` = `quote` serialised, and MCP `check_version` = `quote`. Those are the
 * same sentence, so they are the same function: the route and the MCP tool both call
 * `versionStatus` and neither of them re-implements the entitlement half.
 *
 * Two shapes, and the difference is the point (FR-20):
 *
 * - **Without a proved wallet** it is version data only. `?address=` is not accepted
 *   and never will be: entitlement state is not a public oracle (FR-40).
 * - **With one** it also answers `owned`, `entitled`, `all_versions` and `price_kind`,
 *   and `price_micro` becomes *this caller's* price.
 *
 * A draft listing is `not_found` to everyone but a holder, because `/api/r` already
 * answers `not_found` for one and the two surfaces must not disagree about whether an
 * unpublished listing exists.
 */

import type * as z from "zod";
import { latestPassingRelease, listingStatus, owned, quote, resolveListing } from "@/lib/core/access";
import type { ReleaseRow } from "@/lib/db/types";
import { toMicro } from "@/lib/db/types";
import { appUrl } from "@/lib/env";
import { ApiError } from "@/lib/errors";
import { normalizeReport } from "@/lib/scan/report";
import { micro, VersionResponse, VersionScan } from "@/lib/schemas";

export type VersionStatus = z.infer<typeof VersionResponse>;

/**
 * The trust report in three numbers ("PRD Trust Report.md" §1 and §5, accepted 13 Sep
 * 2026). This call is the cheapest one an agent makes and it used to be silent on safety.
 *
 * Read through `normalizeReport`, always: rows written before today are v1 and the shim
 * lifts them, so this function has one shape to think about rather than two. It returns
 * `undefined` rather than three noughts for a release with no stored report — a nought
 * reads as "checked, nothing found", which is the one thing a report we do not have
 * cannot say.
 */
function scanBlock(release: ReleaseRow | null): z.infer<typeof VersionScan> | undefined {
  if (!release) return undefined;
  let report: ReturnType<typeof normalizeReport> = null;
  try {
    report = normalizeReport(release.scan_report as Parameters<typeof normalizeReport>[0]);
  } catch {
    report = null;
  }
  if (!report) return undefined;

  return {
    verdict: release.scan,
    at: report.scanned_at ?? null,
    scanner_version: report.scanner_version ?? release.scanner_version ?? null,
    blocking: report.counts?.blocking ?? 0,
    disclosed: report.counts?.disclosed ?? 0,
    review: report.counts?.review ?? 0,
    ...(report.capabilities?.summary ? { capabilities_summary: report.capabilities.summary } : {}),
    ...(report.advisories_refreshed_at ? { advisories_refreshed_at: report.advisories_refreshed_at } : {}),
  };
}

/** Throws `not_found` when there is no such listing. */
export async function versionStatus(ref: { owner: string; slug: string }, buyer: string | null): Promise<VersionStatus> {
  const { owner, slug } = ref;

  const resolved = await resolveListing(ref);
  if (!resolved) throw new ApiError("not_found");
  const { listing } = resolved;

  // A draft is not a public resource, and `/api/r` already answers `not_found` for one
  // (DECISIONS.md). Answering here with its version and prices would confirm the slug
  // is taken and publish an unpublished listing's pricing. Holders — only possible for
  // a listing that was live and is now a draft again — keep their view.
  if (listingStatus(listing) === "draft") {
    const holder = buyer ? (await owned(buyer, ref)).length > 0 : false;
    if (!holder) throw new ApiError("not_found");
  }

  const base = appUrl();
  const latest = await latestPassingRelease(listing.id);

  const body: Record<string, unknown> = {
    owner,
    slug,
    latest: latest?.version ?? null,
    published_at: latest ? new Date(latest.created_at).toISOString() : null,
    price_micro: micro.serialize(toMicro(listing.price_micro)),
    update_price_micro: micro.serialize(toMicro(listing.update_price_micro)),
    releases_url: `${base}/api/v/${owner}/${slug}/releases`,
    resource_endpoint: `${base}/api/r/${owner}/${slug}`,
    status: listingStatus(listing),
  };

  const scan = scanBlock(latest);
  if (scan) body.scan = scan;

  if (buyer) {
    const q = await quote(ref, buyer);
    if (q.kind === "granted") {
      body.owned = q.release.version;
      body.entitled = true;
      body.all_versions = q.purchase.allVersions;
      body.price_kind = "owned";
      body.price_micro = micro.serialize(0n);
    } else if (q.kind === "payment_required") {
      body.owned = q.ownedVersion;
      body.entitled = false;
      body.all_versions = false;
      body.price_kind = q.priceMicro === 0n ? "free" : q.reason;
      body.price_micro = micro.serialize(q.priceMicro);
    } else {
      body.owned = null;
      body.entitled = false;
      body.all_versions = false;
    }
  }

  return VersionResponse.parse(body);
}
