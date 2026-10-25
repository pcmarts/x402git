/**
 * POST /api/payouts/sweep — FR-26. Force a sweep of this creator's released balance.
 *
 * The request body is ignored, and that is the design: **there is no `to` parameter**.
 * The destination is `creator.payout_address`. Changing it is a separate, signed,
 * 48-hour-delayed action (FR-5), which is what makes a leaked API key (§14.7) unable to
 * move money.
 *
 * `?network=stellar:testnet|stellar:pubnet` (25 Oct 2026) runs the Stellar sweep instead:
 * the creator's released Stellar earnings, to their bound Stellar address, in the asset
 * they were paid in (lib/payouts/stellar.ts). Without the parameter this is the EVM sweep
 * it always was. The named network must be the one this deployment runs; there is still
 * no destination parameter on either rail.
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireCreator } from "@/lib/auth/api-key";
import { normaliseAddress } from "@/lib/auth/challenge";
import { enforceLimit } from "@/lib/auth/rate-limit";
import { stellarRail } from "@/lib/env";
import { ApiError, handle } from "@/lib/errors";
import { sweepStellarCreator } from "@/lib/payouts/stellar";
import { sweepCreator } from "@/lib/payouts/sweep";
import { micro, SweepResponse } from "@/lib/schemas";
import { requirePermittedJurisdiction } from "@/lib/x402/jurisdiction";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest) => {
  // FR-38: 451 on paid and creator routes. This one moves money.
  requirePermittedJurisdiction(req);
  const creator = await requireCreator(req, "earnings:read");
  await enforceLimit("creator_write", creator.id);

  const network = req.nextUrl.searchParams.get("network");
  const result = network === null ? await sweepEvm(creator) : await sweepStellar(creator, network);

  const body = SweepResponse.parse({
    payout_id: result.payoutId,
    amount_micro: micro.serialize(result.amountMicro),
    gas_micro: micro.serialize(result.gasMicro),
    to_address: result.toAddress,
    status: result.status,
    tx_hash: result.txHash,
    purchases_swept: result.purchasesSwept,
  });

  // `skipped` is diagnostic, not part of the FR-29 schema; it rides beside the body so
  // a caller can tell "nothing to pay" from "frozen" from "this deployment has no signer".
  return NextResponse.json(result.skipped ? { ...body, skipped: result.skipped } : body, {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
});

type RouteResult = {
  payoutId: string | null;
  amountMicro: bigint;
  gasMicro: bigint;
  toAddress: string | null;
  status: string | null;
  txHash: string | null;
  purchasesSwept: number;
  skipped?: string;
};

async function sweepEvm(creator: Parameters<typeof sweepCreator>[0]): Promise<RouteResult> {
  const result = await sweepCreator(creator);
  // Checksummed on the way out, as it always was. A Stellar identity address never gets
  // here: the EVM sweep skips it before any row is written.
  return { ...result, toAddress: result.skipped === "no_evm_payout_address" ? null : normaliseAddress(result.toAddress) };
}

async function sweepStellar(creator: Parameters<typeof sweepStellarCreator>[0], network: string): Promise<RouteResult> {
  const rail = stellarRail();
  if (network !== "stellar:testnet" && network !== "stellar:pubnet") {
    throw new ApiError("invalid_request", { message: "network must be stellar:testnet or stellar:pubnet, or omitted for the EVM sweep." });
  }
  if (!rail || rail.network !== network) {
    throw new ApiError("invalid_request", { message: `This deployment does not run ${network}.` });
  }
  // The destination is already canonical (upper-case strkey); nothing to normalise.
  return await sweepStellarCreator(creator);
}
