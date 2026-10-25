/**
 * POST /api/payouts/sweep — FR-26. Force a sweep of this creator's released balance.
 *
 * The request body is ignored, and that is the design: **there is no `to` parameter**.
 * The destination is `creator.payout_address`. Changing it is a separate, signed,
 * 48-hour-delayed action (FR-5), which is what makes a leaked API key (§14.7) unable to
 * move money.
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireCreator } from "@/lib/auth/api-key";
import { normaliseAddress } from "@/lib/auth/challenge";
import { enforceLimit } from "@/lib/auth/rate-limit";
import { handle } from "@/lib/errors";
import { sweepCreator } from "@/lib/payouts/sweep";
import { micro, SweepResponse } from "@/lib/schemas";
import { requirePermittedJurisdiction } from "@/lib/x402/jurisdiction";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest) => {
  // FR-38: 451 on paid and creator routes. This one moves money.
  requirePermittedJurisdiction(req);
  const creator = await requireCreator(req, "earnings:read");
  await enforceLimit("creator_write", creator.id);

  const result = await sweepCreator(creator);

  const body = SweepResponse.parse({
    payout_id: result.payoutId,
    amount_micro: micro.serialize(result.amountMicro),
    gas_micro: micro.serialize(result.gasMicro),
    to_address: normaliseAddress(result.toAddress),
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
