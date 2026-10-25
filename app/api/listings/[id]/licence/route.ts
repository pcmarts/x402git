/**
 * POST /api/listings/:id/licence — commit an allow-listed LICENSE (FR-11, Rail B).
 *
 * The licence gate is three-way: a resale-compatible SPDX id passes, a missing licence
 * blocks, `NOASSERTION` goes to manual. On Rail B there is no licence until somebody
 * puts one there, and an agent has no browser to go and add one — so it picks from
 * MIT / Apache-2.0 / BSD-3-Clause / MPL-2.0 and we commit the file to `main`.
 *
 * D4: the attestation that the code may be sold under that licence is made by the
 * registering operator, not by the platform. We supply the words, not the warranty.
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireCreator } from "@/lib/auth/api-key";
import { enforceLimit } from "@/lib/auth/rate-limit";
import { handle } from "@/lib/errors";
import { setListingLicence } from "@/lib/listings";
import { LicenceRequest, LicenceResponse } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const creator = await requireCreator(req, "listings:write");
  await enforceLimit("creator_write", creator.id);

  const { id } = await ctx.params;
  const body = LicenceRequest.parse(await req.json());
  const result = await setListingLicence(creator, id, body.spdx);

  return NextResponse.json(LicenceResponse.parse(result), { headers: { "cache-control": "no-store" } });
});
