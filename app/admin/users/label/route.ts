/**
 * POST /admin/users/label — mark a user as test or as real.
 *
 * Reached from the row button on `/admin/users`. `by` comes from the session, and `back`
 * is accepted only as a `/admin/users` URL, so the form cannot redirect anywhere else.
 */

import { requireAdminRoute } from "@/lib/admin/guard";
import { setUserLabel } from "@/lib/admin/users";
import { handle } from "@/lib/errors";
import { back } from "@/lib/web/dashboard";

export const dynamic = "force-dynamic";

const BACK = /^\/admin\/users(\?[^#\s]*)?$/;

export const POST = handle(async (req: Request) => {
  const admin = await requireAdminRoute(req, "/admin/users");
  if (admin instanceof Response) return admin;

  const form = await req.formData();
  const requested = String(form.get("back") ?? "");
  const page = BACK.test(requested) ? requested : "/admin/users";

  const result = await setUserLabel({ subject: form.get("subject"), isTest: form.get("test") === "1", by: admin.login });
  return back(page, result.ok ? { ok: result.message } : { error: result.message });
});
