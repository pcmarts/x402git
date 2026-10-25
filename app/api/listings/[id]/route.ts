/**
 * GET    /api/listings/:id — status, licence, latest release, pricing (§7.2).
 * PATCH  /api/listings/:id — price, update price, description, trigger hint (FR-12, FR-16).
 * DELETE /api/listings/:id — retire (FR-43).
 *
 * Another creator's listing id returns `404 not_found`, not `403`. A 403 would confirm
 * the id exists, which turns the id space into an enumeration oracle.
 *
 * DELETE here is "stop selling", not "delete". It is terminal, holders keep every
 * version they own (FR-19, FR-46), and the manifest stays up marked no longer sold.
 * Deleting the *repository* is a different route (`DELETE /api/listings/:id/repo`) and
 * needs a wallet signature.
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireCreator } from "@/lib/auth/api-key";
import { enforceLimit } from "@/lib/auth/rate-limit";
import { handle } from "@/lib/errors";
import { getListing, patchListing, retireListing } from "@/lib/listings";
import { ListingResponse, PatchListingRequest, RetireResponse } from "@/lib/schemas";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export const GET = handle(async (req: NextRequest, ctx: Context) => {
  const creator = await requireCreator(req);
  await enforceLimit("creator_write", creator.id);

  const { id } = await ctx.params;
  const listing = await getListing(creator, id);

  return NextResponse.json(ListingResponse.parse(listing), { headers: { "cache-control": "no-store" } });
});

export const PATCH = handle(async (req: NextRequest, ctx: Context) => {
  const creator = await requireCreator(req, "listings:write");
  await enforceLimit("creator_write", creator.id);

  const { id } = await ctx.params;
  const body = PatchListingRequest.parse(await req.json());
  const listing = await patchListing(creator, id, body);

  return NextResponse.json(ListingResponse.parse(listing), { headers: { "cache-control": "no-store" } });
});

export const DELETE = handle(async (req: NextRequest, ctx: Context) => {
  const creator = await requireCreator(req, "listings:write");
  await enforceLimit("creator_write", creator.id);

  const { id } = await ctx.params;
  const retired = await retireListing(creator, id);

  return NextResponse.json(RetireResponse.parse(retired), { headers: { "cache-control": "no-store" } });
});
