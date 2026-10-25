/**
 * POST /admin/ops/switch — pause or resume one §19 kill switch.
 *
 * The same write `scripts/ops-switch.mjs` makes, from a page an operator can reach
 * without a checkout. Every check is in `changeSwitch` on the server: the switch name
 * typed to confirm, a reason on a pause, and a refusal to overwrite a pause that is
 * already in place. `updated_by` and the audit row take the login from the session.
 */

import { changeSwitch } from "@/lib/admin/controls";
import { requireAdminRoute } from "@/lib/admin/guard";
import { loadOpsHealth } from "@/lib/admin/ops";
import { handle } from "@/lib/errors";
import { back } from "@/lib/web/dashboard";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: Request) => {
  const admin = await requireAdminRoute(req, "/admin/ops");
  if (admin instanceof Response) return admin;

  const form = await req.formData();
  const { switches } = await loadOpsHealth();
  const result = await changeSwitch({
    name: String(form.get("name") ?? ""),
    action: String(form.get("action") ?? ""),
    reason: form.get("reason"),
    confirm: form.get("confirm"),
    by: admin.login,
    current: switches,
  });

  return back("/admin/ops", result.ok ? { ok: result.message } : { error: result.message });
});
