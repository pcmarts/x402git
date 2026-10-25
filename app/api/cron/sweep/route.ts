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
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/cron";
import { x402Config } from "@/lib/env";
import { handle } from "@/lib/errors";
import { record } from "@/lib/events";
import { creatorsWithBalance, sweepCreator } from "@/lib/payouts/sweep";
import { sweepSignerAddress } from "@/lib/payouts/signer";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const GET = handle(async (req: NextRequest) => {
  requireCron(req);
  const now = new Date();

  const creators = await creatorsWithBalance(now);
  const results: Record<string, unknown>[] = [];
  let sweptMicro = 0n;

  for (const creator of creators) {
    try {
      const result = await sweepCreator(creator, { now });
      if (result.status === "confirmed") sweptMicro += result.amountMicro;
      results.push({
        creator_id: creator.id,
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
      });
    } catch (e) {
      results.push({ creator_id: creator.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  await record({ name: "cron_sweep", props: { creators: creators.length, swept_micro: sweptMicro.toString() } });

  return NextResponse.json(
    {
      ran_at: now.toISOString(),
      // Which wallet pays, and on which chain. Both are configuration a deployment can
      // get wrong silently; neither is a secret.
      signer: sweepSignerAddress(),
      chain_id: x402Config().chainId,
      creators: creators.length,
      swept_micro: sweptMicro.toString(),
      results,
    },
    { headers: { "cache-control": "no-store" } },
  );
});
