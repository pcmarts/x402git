/**
 * POST /dashboard/:id/actions/publish — draft → live (FR-42).
 *
 * A 409 `listing_not_ready` carries `details.blocking[]`, and it is passed through to
 * the page rather than flattened into "something went wrong". The blocking list is the
 * only useful part of that failure: it is the to-do list.
 */

import { handle } from "@/lib/errors";
import { blockingFrom, creatorApi } from "@/lib/web/api-client";
import { back, requireActor } from "@/lib/web/dashboard";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const target = `/dashboard/${id}`;

  const actor = await requireActor(req, target);
  if (actor instanceof Response) return actor;

  const result = await creatorApi<{ endpoints?: { url?: string } }>({
    method: "POST",
    path: `/api/listings/${id}/publish`,
    apiKey: actor.apiKey,
  });

  if (result.ok) {
    const url = result.data?.endpoints?.url;
    return back(target, { ok: url ? `Live at ${url}` : "Live." });
  }

  return back(target, { error: result.message, blocking: blockingFrom(result) });
});
