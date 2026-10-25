/**
 * GET /api/earnings — FR-29. The creator's ledger view.
 *
 * Gross, fee, net, withdrawable, held, gas, the next holdback release, and one
 * cursor-paginated page of sale rows. Each sale carries the version, the kind, the
 * amount and the time and **never** the buyer address or the transaction hash (FR-40):
 * a creator learns that a sale happened, not who made it. `lib/payouts/ledger.ts#toSale`
 * is the single place that shape is built, and `route.test.ts` asserts the absence.
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireCreator } from "@/lib/auth/api-key";
import { normaliseAddress } from "@/lib/auth/challenge";
import { enforceLimit } from "@/lib/auth/rate-limit";
import { holdbackDays, platformFeeBps } from "@/lib/env";
import { handle } from "@/lib/errors";
import { earningsFor } from "@/lib/payouts/ledger";
import { EarningsResponse, micro } from "@/lib/schemas";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export const GET = handle(async (req: NextRequest) => {
  const creator = await requireCreator(req, "earnings:read");
  await enforceLimit("creator_write", creator.id);

  const cursor = req.nextUrl.searchParams.get("cursor") ?? undefined;
  const ledger = await earningsFor(creator, { cursor, limit: PAGE_SIZE });

  const body = EarningsResponse.parse({
    gross_micro: micro.serialize(ledger.grossMicro),
    fee_micro: micro.serialize(ledger.feeMicro),
    net_micro: micro.serialize(ledger.netMicro),
    withdrawable_micro: micro.serialize(ledger.withdrawableMicro),
    held_micro: micro.serialize(ledger.heldMicro),
    gas_micro: micro.serialize(ledger.gasMicro),
    platform_fee_bps: Number(platformFeeBps()),
    holdback_days: holdbackDays(),
    next_release_at: ledger.nextReleaseAt ? ledger.nextReleaseAt.toISOString() : null,
    // FR-26: the bound address, echoed so the creator can see where a sweep will go.
    payout_address: normaliseAddress(creator.payout_address),
    sales: ledger.sales.map((sale) => ({
      slug: sale.slug,
      version: sale.version,
      kind: sale.kind,
      gross_micro: micro.serialize(sale.grossMicro),
      fee_micro: micro.serialize(sale.feeMicro),
      net_micro: micro.serialize(sale.netMicro),
      settled_at: sale.settledAt.toISOString(),
      holdback_until: sale.holdbackUntil.toISOString(),
      paid_out: sale.paidOut,
    })),
    next_cursor: ledger.nextCursor,
  });

  return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
});
