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
 */

import { type NextRequest, NextResponse } from "next/server";
import { createPublicClient, erc20Abi, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { requireCron } from "@/lib/auth/cron";
import { db } from "@/lib/db";
import type { PayoutRow, PurchaseRow } from "@/lib/db/types";
import { toMicro } from "@/lib/db/types";
import { rpcUrl, sweepPrivateKey, x402Config } from "@/lib/env";
import { assertRpcServesChain } from "@/lib/chain";
import { handle } from "@/lib/errors";
import { record } from "@/lib/events";
import { purgeExpiredIdempotency } from "@/lib/idempotency";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export const GET = handle(async (req: NextRequest) => {
  requireCron(req);
  const now = new Date();
  const { asset, payTo, chainId } = x402Config();

  // `chainId` above scopes both reads below: one database serves both networks, the
  // balances are read from one chain, and a mixed ledger would read as permanent
  // variance (20260906010000).
  const { data: purchaseRows, error: purchaseError } = await db().from("purchase").select("*").eq("chain_id", chainId).is("revoked_at", null);
  if (purchaseError) throw purchaseError;
  const grossMicro = ((purchaseRows ?? []) as PurchaseRow[]).reduce<bigint>((sum, p) => sum + toMicro(p.gross_micro), 0n);

  const { data: payoutRows, error: payoutError } = await db().from("payout").select("*").eq("chain_id", chainId).eq("status", "confirmed");
  if (payoutError) throw payoutError;
  const paidMicro = ((payoutRows ?? []) as PayoutRow[]).reduce<bigint>((sum, p) => sum + toMicro(p.amount_micro), 0n);

  const ledgerMicro = grossMicro - paidMicro;

  // The sweep wallet the payouts actually leave from (lib/payouts/sweep.ts). Derived
  // from the signing key, so it is definitionally the address in play; absent when no
  // signer is configured, and skipped when it *is* the receiving address.
  const sweepKey = sweepPrivateKey();
  const sweepAddress = sweepKey ? privateKeyToAccount(sweepKey as `0x${string}`).address : null;
  const watched = [payTo as `0x${string}`, ...(sweepAddress && sweepAddress.toLowerCase() !== payTo.toLowerCase() ? [sweepAddress] : [])];

  let receivingMicro: bigint | null = null;
  let sweepMicro: bigint | null = null;
  let readError: string | null = null;
  try {
    const client = createPublicClient({
      chain: {
        id: chainId,
        name: `eip155:${chainId}`,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl()] } },
      },
      transport: http(rpcUrl()),
    });
    await assertRpcServesChain(client, chainId, "reconcile");

    const balances = await Promise.all(
      watched.map(
        (address) =>
          client.readContract({
            address: asset as `0x${string}`,
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

  const props = {
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
  await record({ name: "reconcile", props });

  // Daily housekeeping rides on the one cron that moves no money: replayable responses
  // past their 24 hours hold a sealed API key and have no reason to exist (lib/idempotency.ts).
  const idempotencyPurged = await purgeExpiredIdempotency(now);

  return NextResponse.json({ ran_at: now.toISOString(), ...props, idempotency_purged: idempotencyPurged }, { headers: { "cache-control": "no-store" } });
});
