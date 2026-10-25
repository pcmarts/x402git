/**
 * POST /admin/listings/:id/takedown — FR-39's takedown, the `retire` half.
 *
 * Reached from the form on the listing's admin page. The typed `owner/slug` and the
 * reason are checked in `takeDownListing`, because this route is reachable directly and
 * the page is not a security boundary. `revoke` is not here: see lib/admin/controls.ts.
 */

import { takeDownListing } from "@/lib/admin/controls";
import { requireAdminRoute } from "@/lib/admin/guard";
import { handle } from "@/lib/errors";
import { back } from "@/lib/web/dashboard";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const page = `/admin/listings/${encodeURIComponent(id)}`;

  const admin = await requireAdminRoute(req, page);
  if (admin instanceof Response) return admin;

  const form = await req.formData();
  const result = await takeDownListing({ listingId: id, confirm: form.get("confirm"), reason: form.get("reason"), by: admin.login });

  return back(page, result.ok ? { ok: result.message } : { error: result.message });
});
