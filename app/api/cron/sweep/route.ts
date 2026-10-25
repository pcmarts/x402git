/**
 * GET /api/cron/sweep — FR-26, daily. Every `linked` creator with a released balance is
 * paid to their bound payout address.
 *
 * One creator's failure must not stop the rest, so each sweep is caught and reported in
 * the summary rather than thrown. The per-creator rules (screening, the in-flight
 * block, the pending row before the broadcast) all live in `lib/payouts/sweep.ts` — the
 * cron is a loop and nothing else.
 *
 * The response names the `signer` — the *address* the key in `SWEEP_WALLET_PRIVATE_KEY`
 * derives to, never the key. An address is public the instant it pays anyone, and until
 * this was here there was no way to ask a deployment "which wallet will pay my
 * creators?": the env var is write-only in Vercel, and the answer would first have shown
 * up as a failed payout a week after the mistake. Added at the 2026-09-07 mainnet
 * cutover, when the honest answer to "is the right key in production?" was "nobody can
 * tell".
 *
 * **Per EVM rail** (25 Oct 2026, HackMeridian W6b). The loop is creators × rails: each
 * creator is swept on every EVM rail (Base USDC, Arbitrum USDT0), and `results` has one
 * entry per creator per rail that had something to pay, each naming its `network`. A
 * rail with nothing for that creator is left out — it is most rails for most creators,
 * and `scripts/e2e-sweep-pass.mjs` reads any `skipped` as a failure. `rails` totals each.
 * `?network=eip155:<chainId>` runs one rail. The Stellar sweep is not on this cron: it is
 * `POST /api/payouts/sweep?network=stellar:…`, one creator at a time, because one hot
 * account pays every Stellar payout (lib/payouts/stellar.ts).
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/cron";
import { type EvmRail, evmChains, evmRailFor, paymentChain } from "@/lib/env";
import { ApiError, handle } from "@/lib/errors";
import { record } from "@/lib/events";
import { creatorsWithBalance, sweepCreatorRails } from "@/lib/payouts/sweep";
import { sweepSignerAddress } from "@/lib/payouts/signer";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const GET = handle(async (req: NextRequest) => {
  requireCron(req);
  const now = new Date();
  const rails = selectedRails(req.nextUrl.searchParams.get("network"));

  const creators = await creatorsWithBalance(now, rails);
  const results: Record<string, unknown>[] = [];
  const sweptByRail = new Map<string, bigint>(rails.map((r) => [r.network, 0n]));
  const payoutsByRail = new Map<string, number>(rails.map((r) => [r.network, 0]));

  for (const creator of creators) {
    try {
      const perRail = await sweepCreatorRails(creator, rails.length === 1 ? { now, rail: rails[0] } : { now });
      for (const result of perRail) {
        if (result.skipped === "nothing_to_sweep") continue;
        if (result.status === "confirmed") {
          sweptByRail.set(result.network, (sweptByRail.get(result.network) ?? 0n) + result.amountMicro);
          payoutsByRail.set(result.network, (payoutsByRail.get(result.network) ?? 0) + 1);
        }
        results.push({
          creator_id: creator.id,
          network: result.network,
          asset_symbol: result.symbol,
          payout_id: result.payoutId,
          amount_micro: result.amountMicro.toString(),
          // Diagnostic, like `skipped` on POST /api/payouts/sweep: the bound destination
          // and the broadcast hash, so the FR-34 second pass (scripts/e2e-sweep-pass.mjs,
          // BLOCKERS.md B4) can verify each payout independently on chain.
          to_address: result.toAddress,
          tx_hash: result.txHash,
          status: result.status,
          purchases_swept: result.purchasesSwept,
          ...(result.skipped ? { skipped: result.skipped } : {}),
          ...(result.error ? { error: result.error } : {}),
        });
      }
    } catch (e) {
      results.push({ creator_id: creator.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // USDC and USDT0 are both a dollar here and never converted (USDT0 T5), so the total
  // is a sum of micro-dollars; `rails` keeps the split for anyone who needs the token.
  const sweptMicro = [...sweptByRail.values()].reduce((sum, v) => sum + v, 0n);
  await record({
    name: "cron_sweep",
    props: { creators: creators.length, swept_micro: sweptMicro.toString(), networks: rails.map((r) => r.network) },
  });

  return NextResponse.json(
    {
      ran_at: now.toISOString(),
      // Which wallet pays, and on which chain. Both are configuration a deployment can
      // get wrong silently; neither is a secret. One EOA pays every EVM rail; `chain_id`
      // is the primary rail's, as it always was, and `rails` names the rest.
      signer: sweepSignerAddress(),
      chain_id: paymentChain().chainId,
      rails: rails.map((r) => ({
        network: r.network,
        chain_id: r.chainId,
        asset: r.asset,
        asset_symbol: r.symbol,
        payouts: payoutsByRail.get(r.network) ?? 0,
        swept_micro: (sweptByRail.get(r.network) ?? 0n).toString(),
      })),
      creators: creators.length,
      swept_micro: sweptMicro.toString(),
      results,
    },
    { headers: { "cache-control": "no-store" } },
  );
});

/** Every EVM rail, or the one `?network=` names. A network this deployment does not run is a 400, not a quiet no-op. */
function selectedRails(network: string | null): EvmRail[] {
  if (network === null) return evmChains();
  const rail = /^eip155:\d+$/.test(network) ? evmRailFor(network, { payTo: false }) : null;
  if (!rail) {
    throw new ApiError("invalid_request", {
      message: `network must be one of this deployment's EVM rails (${evmChains().map((r) => r.network).join(", ")}); the Stellar sweep is POST /api/payouts/sweep?network=stellar:….`,
    });
  }
  return [rail];
}
