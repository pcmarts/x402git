/**
 * POST /admin/listings/:id/releases/:releaseId/download — the stored artifact, for an
 * operator, without a purchase.
 *
 * Reached from the Download button beside each release on the listing's admin page. A
 * POST rather than a link so a cross-site page cannot make an admin's browser write
 * audit rows (`requireAdminRoute` checks the Origin), and a 303 to a one-minute signed
 * URL so the bytes never pass through this function. Everything else — the audit row,
 * and why the creator is not told — is in lib/admin/download.ts.
 */

import { adminReleaseDownload } from "@/lib/admin/download";
import { requireAdminRoute } from "@/lib/admin/guard";
import { handle } from "@/lib/errors";
import { back, seeOther } from "@/lib/web/dashboard";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string; releaseId: string }> }) => {
  const { id, releaseId } = await ctx.params;
  const page = `/admin/listings/${encodeURIComponent(id)}`;

  const admin = await requireAdminRoute(req, page);
  if (admin instanceof Response) return admin;

  const result = await adminReleaseDownload({ listingId: id, releaseId, by: admin.login });
  if (!result.ok) return back(page, { error: result.message });
  return seeOther(result.url);
});
