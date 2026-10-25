/**
 * lib/schemas/earnings.ts — FR-29, FR-26.
 *
 * FR-29 is a privacy requirement as much as a ledger one: a sale row carries the
 * version, the kind, the amount and the time, and **never** the buyer address or the
 * transaction hash (FR-40).
 */

import * as z from "zod";
import { Address, IsoDateTime, MicroUsdc, SemVer, Slug } from "./common";

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
  })
  .meta({ id: "EarningsSale", description: "FR-29 / FR-40: never the buyer address, never the tx hash." });

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
    payout_address: Address,
    sales: z.array(EarningsSale),
    next_cursor: z.string().nullable(),
  })
  .meta({ id: "Earnings" });

export const PayoutStatus = z.enum(["pending", "broadcast", "confirmed", "failed"]).meta({ id: "PayoutStatus" });

export const SweepResponse = z
  .object({
    payout_id: z.uuid().nullable(),
    amount_micro: MicroUsdc,
    gas_micro: MicroUsdc,
    /** FR-26: always the bound payout address. No `to` parameter exists. */
    to_address: Address,
    status: PayoutStatus.nullable(),
    tx_hash: z.string().nullable(),
    purchases_swept: z.number().int().nonnegative(),
  })
  .meta({ id: "Sweep", description: "FR-26 / FR-28. A pending row with an idempotency key is written before any broadcast." });
