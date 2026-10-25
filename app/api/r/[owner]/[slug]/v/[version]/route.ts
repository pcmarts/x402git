/**
 * GET /api/r/:owner/:slug/v/:version — FR-19 / FR-46. Owned versions stay fetchable
 * forever, including after the listing retires.
 *
 * This route never sells anything, so it never issues a 402. It requires
 * `X-Wallet-Signature`: without a proved wallet there is nobody to be entitled, and
 * answering `?address=` would be the purchase-history oracle FR-20 forbids.
 *
 * The check itself is `lib/x402/flow.ts#refetchVersion`, shared with the MCP
 * `fetch_release` tool (FR-31) so the two cannot drift.
 */

import { type NextRequest, NextResponse } from "next/server";
import { clientIp, enforceLimit } from "@/lib/auth/rate-limit";
import { requireWallet } from "@/lib/auth/wallet-signature";
import { handle } from "@/lib/errors";
import { refetchVersion } from "@/lib/x402/flow";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ owner: string; slug: string; version: string }> };

export const GET = handle(async (req: NextRequest, { params }: Params) => {
  const { owner, slug, version } = await params;

  const buyer = await requireWallet(req);
  await enforceLimit("resource", (buyer || clientIp(req)).toLowerCase());

  const body = await refetchVersion({ owner, slug, buyer, version, source: "api" });
  return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
});
