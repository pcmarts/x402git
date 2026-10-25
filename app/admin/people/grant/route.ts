/**
 * POST /admin/people/grant — let another GitHub account into `/admin`.
 *
 * Only an administrator can call it, and the refusal for everybody else is a 404 rather
 * than a 403, exactly as on the pages (`lib/admin/guard.ts`). `granted_by` is the
 * caller's own login, taken from the session rather than the form, so the audit row
 * cannot be forged by editing a hidden input.
 */

import { handle } from "@/lib/errors";
import { requireAdminRoute } from "@/lib/admin/guard";
import { grantAdmin } from "@/lib/admin/people";
import { back } from "@/lib/web/dashboard";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: Request) => {
  const admin = await requireAdminRoute(req, "/admin/people");
  if (admin instanceof Response) return admin;

  const form = await req.formData();
  const login = String(form.get("login") ?? "");
  const note = String(form.get("note") ?? "").trim().slice(0, 200);

  const result = await grantAdmin(login, admin.login, note);
  if (!result.ok) return back("/admin/people", { error: result.message });

  return back("/admin/people", {
    ok: `${result.login} is an administrator. It takes effect the next time they sign in with that GitHub account.`,
  });
});
