/**
 * lib/admin/download.ts — an operator downloads a release without buying it.
 *
 * Added 16 Sep 2026 on the founder's direction (DECISIONS.md, same date). Scan findings
 * say what the analyser saw; a takedown notice, an abuse report or a `review`-tier flag
 * is often only settled by reading the files. Until now that meant pulling the object out
 * of the private bucket by hand with the secret key.
 *
 * Three rules hold here.
 *
 * - **It is not a purchase.** Nothing here imports `lib/core/access.ts`. No `purchase`
 *   row is written, so the listing's sales, install count, the creator's earnings and the
 *   Bazaar's first-sale signal are all untouched, and the operator's wallet owns nothing.
 * - **No record, no download.** The audit row is written first, and a row that did not
 *   save refuses the download. Operators reading creators' unsold code is exactly the act
 *   that has to leave a name on it (lib/admin/audit.ts).
 * - **The creator is not told.** The row goes to the `event` table, which only the admin
 *   section reads, and the notification goes to the operators' Telegram chat. There is no
 *   abuse-webhook event for it and none should be added: the creator agreement (§3.5) says
 *   operators may do this, not that they will announce it.
 */

import { recordAdminAction } from "@/lib/admin/audit";
import { db } from "@/lib/db";
import type { ListingRow, ReleaseRow } from "@/lib/db/types";
import { signedUrl } from "@/lib/storage";

/** One minute: long enough for the redirect to be followed, short enough not to be a link worth pasting. */
export const ADMIN_DOWNLOAD_TTL_SECONDS = 60;

export type AdminDownload = { ok: true; url: string; ref: string } | { ok: false; message: string };

export async function adminReleaseDownload(input: { listingId: string; releaseId: string; by: string }): Promise<AdminDownload> {
  const { data: releaseData } = await db()
    .from("release")
    .select("*")
    .eq("id", input.releaseId)
    .eq("listing_id", input.listingId)
    .maybeSingle();
  if (!releaseData) return { ok: false, message: "No such release on this listing." };
  const release = releaseData as ReleaseRow;

  const { data: listingData } = await db().from("listing").select("*").eq("id", input.listingId).maybeSingle();
  if (!listingData) return { ok: false, message: "No such listing." };
  const listing = listingData as ListingRow;
  const { data: creatorData } = await db().from("creator").select("id, handle").eq("id", listing.creator_id).maybeSingle();
  const handle = (creatorData as { handle: string } | null)?.handle ?? "—";
  const ref = `${handle}/${listing.slug}@${release.version}`;

  // FR-35: a failed cut's snapshot is deleted and `storage_path` goes null with it.
  if (!release.storage_path) return { ok: false, message: `${ref} has no stored artifact. A cut that failed is not kept.` };

  const auditError = await recordAdminAction({
    name: "artifact_downloaded",
    by: input.by,
    listingId: listing.id,
    props: { ref, release_id: release.id, sha256: release.artifact_sha256 },
  });
  if (auditError) return { ok: false, message: `Not downloaded: the audit row did not save (${auditError}).` };

  try {
    const { url } = await signedUrl(release.storage_path, ADMIN_DOWNLOAD_TTL_SECONDS, `${listing.slug}-${release.version}.zip`);
    return { ok: true, url, ref };
  } catch (e) {
    return { ok: false, message: `${ref}: the stored artifact could not be signed (${e instanceof Error ? e.message : String(e)}).` };
  }
}
