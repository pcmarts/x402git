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
 * they were paid in (lib/payouts/stellar.ts). The named network must be the one this
 * deployment runs; there is still no destination parameter on either rail.
 *
 * **Per EVM rail** (25 Oct 2026, HackMeridian W6b). Without `?network=` this sweeps every
 * EVM rail the deployment is paid on — Base USDC, Arbitrum USDT0 — each to the same bound
 * `0x…`, each in the token its sales were paid in. `?network=eip155:<chainId>` sweeps that
 * one rail. The top-level body is still the `Sweep` a caller has always read, now the
 * first rail's (the primary, or the one named); `rails` beside it has one entry per rail
 * swept, with its `network`, `asset_symbol` and `skipped` reason. Like `skipped`, `rails`
 * rides beside the FR-29 schema rather than in it.
 *
 * A rail that throws is reported as `error: "rail_failed"` and the others still count.
 * The message stays in the server log: a viem error quotes its RPC URL, and an RPC URL is
 * often a credential (lib/chain.ts). When every rail fails the call is a 500, as a single
 * failed sweep always was.
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireCreator } from "@/lib/auth/api-key";
import { normaliseAddress } from "@/lib/auth/challenge";
import { enforceLimit } from "@/lib/auth/rate-limit";
import { evmRailFor, stellarRail } from "@/lib/env";
import { ApiError, handle } from "@/lib/errors";
import { sweepStellarCreator } from "@/lib/payouts/stellar";
import { sweepCreatorRails } from "@/lib/payouts/sweep";
import { micro, SweepResponse } from "@/lib/schemas";
import { addressFamily } from "@/lib/x402/stellar";
import { requirePermittedJurisdiction } from "@/lib/x402/jurisdiction";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest) => {
  // FR-38: 451 on paid and creator routes. This one moves money.
  requirePermittedJurisdiction(req);
  const creator = await requireCreator(req, "earnings:read");
  await enforceLimit("creator_write", creator.id);

  const network = req.nextUrl.searchParams.get("network");
  const results = network !== null && network.startsWith("stellar:") ? [await sweepStellar(creator, network)] : await sweepEvm(creator, network);

  const failed = results.filter((r) => r.error);
  for (const r of failed) console.error(`[sweep] ${r.network} failed for creator ${creator.id}: ${r.error}`);
  if (failed.length === results.length) throw new Error(`sweep failed on every rail: ${failed.map((r) => r.network).join(", ")}`);

  const rails = results.map((r) => ({
    network: r.network,
    asset_symbol: r.symbol,
    ...sweepBody(r),
    ...(r.skipped ? { skipped: r.skipped } : {}),
    ...(r.error ? { error: "rail_failed" } : {}),
  }));
  const first = results[0];

  // `skipped` is diagnostic, not part of the FR-29 schema; it rides beside the body so
  // a caller can tell "nothing to pay" from "frozen" from "this deployment has no signer".
  return NextResponse.json(
    { ...sweepBody(first), ...(first.skipped ? { skipped: first.skipped } : {}), network: first.network, rails },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
});

type RouteResult = {
  network: string;
  symbol: string;
  payoutId: string | null;
  amountMicro: bigint;
  gasMicro: bigint;
  toAddress: string | null;
  status: string | null;
  txHash: string | null;
  purchasesSwept: number;
  skipped?: string;
  error?: string;
};

function sweepBody(result: RouteResult) {
  return SweepResponse.parse({
    payout_id: result.payoutId,
    amount_micro: micro.serialize(result.amountMicro),
    gas_micro: micro.serialize(result.gasMicro),
    to_address: result.toAddress,
    status: result.status,
    tx_hash: result.txHash,
    purchases_swept: result.purchasesSwept,
  });
}

async function sweepEvm(creator: Parameters<typeof sweepCreatorRails>[0], network: string | null): Promise<RouteResult[]> {
  let rail: ReturnType<typeof evmRailFor> | undefined;
  if (network !== null) {
    if (!/^eip155:\d+$/.test(network)) {
      throw new ApiError("invalid_request", {
        message: "network must be eip155:<chainId>, stellar:testnet or stellar:pubnet, or omitted to sweep every EVM rail.",
      });
    }
    rail = evmRailFor(network, { payTo: false });
    if (!rail) throw new ApiError("invalid_request", { message: `This deployment does not run ${network}.` });
  }
  const results = await sweepCreatorRails(creator, rail ? { rail } : {});
  // Checksummed on the way out, as it always was. A Stellar identity address never gets
  // here as a destination: the EVM sweep skips it before any row is written.
  return results.map((r) => ({ ...r, toAddress: addressFamily(r.toAddress) === "evm" ? normaliseAddress(r.toAddress) : null }));
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
  const result = await sweepStellarCreator(creator);
  return { ...result, symbol: rail.asset.code };
}
