/**
 * DELETE /api/listings/:id/repo — delete the hosted repo (FR-44).
 *
 * Step-up required, for the obvious reason: this is the most destructive thing a
 * creator credential can reach, and §14.7 assumes the credential has leaked.
 *
 * What survives is the point. **Releases with at least one purchase are retained** —
 * they are the product, and FR-46 says a buyer never loses a purchased version to a
 * creator action. Releases nobody bought are deleted, snapshot bytes included.
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireCreator } from "@/lib/auth/api-key";
import { enforceLimit } from "@/lib/auth/rate-limit";
import { requireStepUp } from "@/lib/auth/step-up";
import { handle } from "@/lib/errors";
import { deleteListingRepo, loadOwnedListing } from "@/lib/listings";
import { DeleteRepoRequest, DeleteRepoResponse } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export const DELETE = handle(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const creator = await requireCreator(req, "listings:write");
  await enforceLimit("creator_write", creator.id);

  const { id } = await ctx.params;
  const body = DeleteRepoRequest.parse(await readJson(req));

  // Ownership before step-up, so a wrong id does not burn a single-use nonce.
  await loadOwnedListing(creator, id);
  await requireStepUp(creator, body.step_up);

  const result = await deleteListingRepo(creator, id);

  return NextResponse.json(DeleteRepoResponse.parse(result), { headers: { "cache-control": "no-store" } });
});

async function readJson(req: NextRequest): Promise<unknown> {
  const text = await req.text();
  return text.trim().length === 0 ? {} : JSON.parse(text);
}
