/**
 * GET /api/cron/reconcile — FR-28 lite, daily.
 *
 * Settled money lands on the receiving address; payouts leave from the sweep wallet.
 * The platform's float is therefore the *sum of both balances*, and the ledger's
 * prediction is:
 *
 *   expected = Σ purchase.gross_micro (not revoked) − Σ payout.amount_micro (confirmed)
 *
 * checked against `balanceOf(receiving) + balanceOf(sweep wallet)`. Watching the
 * receiving address alone goes permanently wrong after the first sweep — every payout
 * would read as a variance from a wallet it never touched, and the real theft signal
 * (money leaving the sweep wallet to an unbound address) would never be seen.
 *
 * The variance is recorded as an `event` named `reconcile` whatever it is, because the
 * point of the job is the time series: a variance that appears is only meaningful
 * against the days it did not.
 *
 * FR-28 also says variance halts sweeps and pages. V0 records and reports; the halt is
 * the operator reading the event, because there is no paging system in V0 and inventing
 * one that nobody is subscribed to would be worse than the honest gap. See DECISIONS.md.
 *
 * **Per EVM rail** (25 Oct 2026, HackMeridian W6b; docs/HACKMERIDIAN-EVM-USDT0-RAIL.md
 * §2). The same equation once for each `(network, asset)`: the ledger sums filtered to
 * that rail and token, the two balances read in that token on that rail's own RPC. The
 * receiving address and the sweep EOA are the same two addresses on every chain, so a
 * Base sum compared against Arbitrum balances is exactly the permanent variance this job
 * exists to avoid. One `reconcile` event per rail, with `network` and `asset` beside the
 * props it always had; one rail's RPC being down is that rail's `error`, not the others'.
 * The response keeps the primary rail's figures at the top level, as before, and lists
 * every rail under `rails`. Stellar is not reconciled here yet.
 */

import { type NextRequest, NextResponse } from "next/server";
import { erc20Abi } from "viem";
import { requireCron } from "@/lib/auth/cron";
import { db } from "@/lib/db";
import type { PayoutRow, PurchaseRow } from "@/lib/db/types";
import { toMicro } from "@/lib/db/types";
import { type EvmRail, evmRails } from "@/lib/env";
import { assertRpcServesChain } from "@/lib/chain";
import { handle } from "@/lib/errors";
import { record } from "@/lib/events";
import { purgeExpiredIdempotency } from "@/lib/idempotency";
import { sweepSignerAddress } from "@/lib/payouts/signer";
import { railClient } from "@/lib/payouts/sweep";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export const GET = handle(async (req: NextRequest) => {
  requireCron(req);
  const now = new Date();

  // The sweep wallet the payouts actually leave from (lib/payouts/sweep.ts). Derived
  // from the signing key, so it is definitionally the address in play; absent when no
  // signer is configured, and skipped when it *is* the receiving address.
  const sweepAddress = sweepSignerAddress();

  const rails: Record<string, unknown>[] = [];
  for (const rail of evmRails()) {
    const props = await reconcileRail(rail, sweepAddress);
    await record({ name: "reconcile", network: rail.network, props });
    rails.push(props);
  }

  // Daily housekeeping rides on the one cron that moves no money: replayable responses
  // past their 24 hours hold a sealed API key and have no reason to exist (lib/idempotency.ts).
  const idempotencyPurged = await purgeExpiredIdempotency(now);

  return NextResponse.json(
    { ran_at: now.toISOString(), ...rails[0], rails, idempotency_purged: idempotencyPurged },
    { headers: { "cache-control": "no-store" } },
  );
});

async function reconcileRail(rail: EvmRail, sweepAddress: string | null): Promise<Record<string, unknown>> {
  // `network` and `asset` scope both reads below: one database serves every network, the
  // balances are read from one chain in one token, and a mixed ledger would read as
  // permanent variance (20260906010000, 20261025090100).
  const { data: purchaseRows, error: purchaseError } = await db()
    .from("purchase")
    .select("*")
    .eq("network", rail.network)
    .eq("asset", rail.asset)
    .is("revoked_at", null);
  if (purchaseError) throw purchaseError;
  const grossMicro = ((purchaseRows ?? []) as PurchaseRow[]).reduce<bigint>((sum, p) => sum + toMicro(p.gross_micro), 0n);

  const { data: payoutRows, error: payoutError } = await db()
    .from("payout")
    .select("*")
    .eq("network", rail.network)
    .eq("asset", rail.asset)
    .eq("status", "confirmed");
  if (payoutError) throw payoutError;
  const paidMicro = ((payoutRows ?? []) as PayoutRow[]).reduce<bigint>((sum, p) => sum + toMicro(p.amount_micro), 0n);

  const ledgerMicro = grossMicro - paidMicro;
  const payTo = rail.payTo;
  const watched = [payTo as `0x${string}`, ...(sweepAddress && sweepAddress.toLowerCase() !== payTo.toLowerCase() ? [sweepAddress as `0x${string}`] : [])];

  let receivingMicro: bigint | null = null;
  let sweepMicro: bigint | null = null;
  let readError: string | null = null;
  try {
    const client = railClient(rail);
    await assertRpcServesChain(client, rail.chainId, `reconcile ${rail.network}`, rail.rpcUrl);

    const balances = await Promise.all(
      watched.map(
        (address) =>
          client.readContract({
            address: rail.asset as `0x${string}`,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [address],
          }) as Promise<bigint>,
      ),
    );
    receivingMicro = balances[0];
    sweepMicro = balances.length > 1 ? balances[1] : 0n;
  } catch (e) {
    // An RPC outage must not look like a variance of the whole balance.
    readError = e instanceof Error ? e.message : String(e);
  }

  const onchainMicro = receivingMicro === null ? null : receivingMicro + (sweepMicro ?? 0n);
  const varianceMicro = onchainMicro === null ? null : onchainMicro - ledgerMicro;

  return {
    network: rail.network,
    asset: rail.asset,
    asset_symbol: rail.symbol,
    ledger_micro: ledgerMicro.toString(),
    gross_micro: grossMicro.toString(),
    paid_out_micro: paidMicro.toString(),
    onchain_micro: onchainMicro === null ? null : onchainMicro.toString(),
    receiving_micro: receivingMicro === null ? null : receivingMicro.toString(),
    sweep_wallet_micro: sweepMicro === null ? null : sweepMicro.toString(),
    variance_micro: varianceMicro === null ? null : varianceMicro.toString(),
    receiving_address: payTo,
    sweep_wallet_address: sweepAddress,
    ...(readError ? { error: readError } : {}),
  };
}
