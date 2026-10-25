/**
 * PUT /api/listings/:id/ssh-key — rotate the deploy key (FR-7, FR-5, §14.6).
 *
 * Step-up required. §14.7 assumes the bearer key has leaked, and a leaked key that can
 * swap the write credential on a repo is a key that can take the repo. So the signature
 * must come from the bound payout address, which a bearer key cannot produce.
 *
 * One public key, one repo: GitHub rejects a deploy key already registered elsewhere,
 * so rotation is add-then-remove on this repository alone.
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireCreator } from "@/lib/auth/api-key";
import { enforceLimit } from "@/lib/auth/rate-limit";
import { requireStepUp } from "@/lib/auth/step-up";
import { handle } from "@/lib/errors";
import { loadOwnedListing, rotateListingSshKey } from "@/lib/listings";
import { SshKeyRequest, SshKeyResponse } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export const PUT = handle(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const creator = await requireCreator(req, "listings:write");
  await enforceLimit("creator_write", creator.id);

  const { id } = await ctx.params;
  const body = SshKeyRequest.parse(await req.json());

  // Ownership before step-up: a challenge nonce is single-use, and burning one on a
  // listing id that was never yours is a worse failure than one extra read.
  await loadOwnedListing(creator, id);

  // FR-5: prove the wallet, not just the key, before the write credential changes.
  await requireStepUp(creator, body.step_up);

  const result = await rotateListingSshKey(creator, id, body.ssh_public_key);

  return NextResponse.json(SshKeyResponse.parse(result), { headers: { "cache-control": "no-store" } });
});
