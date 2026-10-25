/**
 * POST /dashboard/:id/actions/retire — FR-43, `DELETE /api/listings/:id`.
 *
 * Reached only from the confirmation page, which is a real page and not a JavaScript
 * dialog — a `confirm()` does not exist with scripting off, and this action is terminal.
 * The typed confirmation is checked here as well as there, because the page is not a
 * security boundary and this route is reachable directly.
 */

import { handle } from "@/lib/errors";
import { creatorApi } from "@/lib/web/api-client";
import { back, requireActor } from "@/lib/web/dashboard";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const target = `/dashboard/${id}`;

  const actor = await requireActor(req, target);
  if (actor instanceof Response) return actor;

  const form = await req.formData();
  const typed = String(form.get("confirm") ?? "").trim();
  const slug = String(form.get("slug") ?? "").trim();
  if (!slug || typed.toLowerCase() !== slug.toLowerCase()) {
    return back(`/dashboard/${id}/retire`, { error: `Type ${slug || "the slug"} exactly to confirm.` });
  }

  const result = await creatorApi({ method: "DELETE", path: `/api/listings/${id}`, apiKey: actor.apiKey });

  return result.ok
    ? back(target, { ok: "Retired. Holders keep every version they bought, and the manifest stays up." })
    : back(`/dashboard/${id}/retire`, { error: result.message });
});
