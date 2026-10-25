/**
 * lib/schemas/earnings.ts — FR-29, FR-26.
 *
 * FR-29 is a privacy requirement as much as a ledger one: a sale row carries the
 * version, the kind, the amount and the time, and **never** the buyer address or the
 * transaction hash (FR-40).
 *
 * 25 Oct 2026 (HackMeridian W6b): a sale row also names its rail — `network` and
 * `asset_symbol`, where the money is, not who sent it — and `by_rail` splits the totals
 * the same way, so a creator paid on Base and on Arbitrum can see what lands on each.
 */

import * as z from "zod";
import { AnyAddress, IsoDateTime, MicroUsdc, SemVer, Slug } from "./common";

export const SaleKind = z.enum(["new", "update", "free"]).meta({ id: "SaleKind" });

export const EarningsSale = z
  .object({
    slug: Slug,
    version: SemVer,
    kind: SaleKind,
    gross_micro: MicroUsdc,
    fee_micro: MicroUsdc,
    net_micro: MicroUsdc,
    settled_at: IsoDateTime,
    holdback_until: IsoDateTime,
    paid_out: z.boolean(),
    /** CAIP-2: the rail it settled on, which is where its payout goes. */
    network: z.string().describe("CAIP-2 rail the sale settled on: `eip155:8453` is Base, `eip155:42161` Arbitrum, `stellar:pubnet` Stellar."),
    asset_symbol: z.string().describe("The token it was paid in, e.g. `USDC` or `USDT0`. Paid out in the same token."),
  })
  .meta({ id: "EarningsSale", description: "FR-29 / FR-40: never the buyer address, never the tx hash. The rail, never the payer." });

/** One rail's share of the totals (25 Oct 2026). The amounts are micro-dollars of that rail's token. */
export const EarningsRail = z
  .object({
    network: z.string().describe("CAIP-2 rail, e.g. `eip155:42161`."),
    asset_symbol: z.string().describe("The token on that rail, e.g. `USDT0`."),
    gross_micro: MicroUsdc,
    fee_micro: MicroUsdc,
    net_micro: MicroUsdc,
    withdrawable_micro: MicroUsdc,
    held_micro: MicroUsdc,
    /** Confirmed payouts on this rail, in this token. */
    paid_out_micro: MicroUsdc,
  })
  .meta({ id: "EarningsRail", description: "Where it lands: the totals for one (network, token), paid out on that network in that token." });

export const EarningsResponse = z
  .object({
    gross_micro: MicroUsdc,
    fee_micro: MicroUsdc,
    net_micro: MicroUsdc,
    /** Past the 7-day holdback and not yet swept. */
    withdrawable_micro: MicroUsdc,
    /** Inside the holdback window. */
    held_micro: MicroUsdc,
    /** Gas deducted from sweeps to date (FR-26). */
    gas_micro: MicroUsdc,
    platform_fee_bps: z.number().int(),
    holdback_days: z.number().int(),
    /** When the next tranche leaves the holdback. */
    next_release_at: IsoDateTime.nullable(),
    /** FR-26: the bound identity address — an EVM `0x…`, or a `G…` for a Stellar-only creator (BUILD H5). */
    payout_address: AnyAddress,
    /** The totals split by rail and token, configured rails first; only rails with a sale or a payout. */
    by_rail: z.array(EarningsRail),
    sales: z.array(EarningsSale),
    next_cursor: z.string().nullable(),
  })
  .meta({ id: "Earnings" });

/** `in_transit` (migration 20261025090000): left our account, not yet arrived. Bridged payouts only. */
export const PayoutStatus = z.enum(["pending", "broadcast", "in_transit", "confirmed", "failed"]).meta({ id: "PayoutStatus" });

export const SweepResponse = z
  .object({
    payout_id: z.uuid().nullable(),
    amount_micro: MicroUsdc,
    gas_micro: MicroUsdc,
    /**
     * FR-26: always the bound payout address. No `to` parameter exists. A `G…` on a
     * Stellar sweep (`?network=stellar:…`); null only when that sweep was skipped
     * because the creator has no Stellar address to pay.
     */
    to_address: AnyAddress.nullable(),
    status: PayoutStatus.nullable(),
    tx_hash: z.string().nullable(),
    purchases_swept: z.number().int().nonnegative(),
  })
  .meta({ id: "Sweep", description: "FR-26 / FR-28. A pending row with an idempotency key is written before any broadcast." });

