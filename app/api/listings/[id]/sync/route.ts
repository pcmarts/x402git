/**
 * POST /api/listings/:id/sync — cut a version now (FR-8.2).
 *
 * The primary sync path is the GitHub webhook; this is the manual trigger and the
 * recovery path when a delivery is dropped. The web UI's "Check for releases" button calls this
 * same route (D9), and both paths land in `lib/release/cutRelease`, so a release cut by
 * hand is indistinguishable from one cut by a tag push.
 *
 * 202, not 200: analysis, snapshot and scan continue after the row exists, and the
 * release is `pending` until the scan lands (FR-35).
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireCreator } from "@/lib/auth/api-key";
import { enforceLimit } from "@/lib/auth/rate-limit";
import { handle } from "@/lib/errors";
import { syncListing } from "@/lib/listings";
import { SyncRequest, SyncResponse } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const creator = await requireCreator(req, "listings:write");
  await enforceLimit("creator_write", creator.id);

  const { id } = await ctx.params;
  // An empty body is legitimate and is what the dashboard's "Check for releases" sends: "cut
  // whatever this repository is tagged at" (FR-8.2, amended 2026-09-01).
  const body = SyncRequest.parse(await readJson(req));
  const release = await syncListing(creator, id, body);

  return NextResponse.json(SyncResponse.parse(release), { status: 202, headers: { "cache-control": "no-store" } });
});

async function readJson(req: NextRequest): Promise<unknown> {
  const text = await req.text();
  return text.trim().length === 0 ? {} : JSON.parse(text);
}
