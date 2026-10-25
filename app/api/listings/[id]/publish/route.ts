/**
 * POST /api/listings/:id/publish — draft → live (FR-42).
 *
 * When it cannot go live the 409 carries `details.blocking[]` with *every* reason at
 * once: `no_release`, `scan_pending`, `licence_block`, `description_missing`. An agent
 * that has to discover the requirements one 409 at a time is an agent that gives up,
 * and each value names the route or field that clears it.
 *
 * Publishing an already-live listing is a no-op 200, not an error — a retried call
 * after a dropped response must not look like a failure.
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireCreator } from "@/lib/auth/api-key";
import { enforceLimit } from "@/lib/auth/rate-limit";
import { handle } from "@/lib/errors";
import { publishListing } from "@/lib/listings";
import { PublishResponse } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const creator = await requireCreator(req, "listings:write");
  await enforceLimit("creator_write", creator.id);

  const { id } = await ctx.params;
  const published = await publishListing(creator, id);

  return NextResponse.json(PublishResponse.parse(published), { headers: { "cache-control": "no-store" } });
});
