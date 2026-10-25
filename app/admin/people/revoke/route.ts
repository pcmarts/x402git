/**
 * POST /admin/people/revoke — take an administrator's access away.
 *
 * The row is not deleted; `revoked_at` and `revoked_by` are written, so the table stays
 * the record of who had access and when they stopped. `revokeAdmin` holds the two
 * refusals — a root login is not this table's to revoke, and nobody revokes themselves —
 * and it holds them on the server, because the page's reasons-instead-of-buttons are a
 * courtesy and not a check.
 *
 * Access ends on the next request. There is no session to kill: an administrator's
 * privilege is read fresh on every admin page load, so a revoked person's very next
 * click is a 404.
 */

import { handle } from "@/lib/errors";
import { requireAdminRoute } from "@/lib/admin/guard";
import { revokeAdmin } from "@/lib/admin/people";
import { back } from "@/lib/web/dashboard";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: Request) => {
  const admin = await requireAdminRoute(req, "/admin/people");
  if (admin instanceof Response) return admin;

  const form = await req.formData();
  const result = await revokeAdmin(String(form.get("login") ?? ""), admin.login);
  if (!result.ok) return back("/admin/people", { error: result.message });

  return back("/admin/people", { ok: `${result.login} is no longer an administrator. Their next request to /admin is a 404.` });
});
