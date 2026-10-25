/**
 * lib/payouts/sweep.ts — FR-26 / FR-28. Net earnings leave for the bound payout
 * address, and nowhere else.
 *
 * **There is no `to` parameter.** Not on `POST /api/payouts/sweep`, not in this
 * function, not in the cron. The destination is `creator.payout_address`, read from the
 * row, every time. §14.7 assumes the API key leaks; this is why that is survivable.
 *
 * The ledger discipline of FR-28, in order:
 *
 *   1. screen the payout address (FR-38) — a hit freezes, it does not pay;
 *   2. refuse to start if this creator has a payout that is not `confirmed`;
 *   3. write the `payout` row `pending`, with a deterministic idempotency key,
 *      **before** anything is broadcast;
 *   4. broadcast, then `broadcast(tx_hash)`, then wait for the receipt;
 *   5. `confirmed` → stamp `payout_id` on the purchases. Reverted → `failed`.
 *
 * If the process dies between 3 and 5 the row is `pending`, rule 2 blocks the creator,
 * and a human reconciles — which is the failure we want, rather than a second transfer.
 */

import { createHash } from "node:crypto";
import { createPublicClient, createWalletClient, erc20Abi, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { db } from "@/lib/db";
import type { CreatorRow, PayoutRow } from "@/lib/db/types";
import { fromMicro, toMicro } from "@/lib/db/types";
import { paymentChain, rpcUrl, sweepPrivateKey, x402Config } from "@/lib/env";
import { assertRpcServesChain } from "@/lib/chain";
import { isPaused } from "@/lib/ops/switches";
import { record } from "@/lib/events";
import { screen } from "@/lib/screening";
import { addressFamily } from "@/lib/x402/stellar";
import { creatorListings, sweepablePurchases } from "./ledger";

export type SweepSkip =
  | "sanctioned"
  | "payout_in_flight"
  | "payout_retries_exhausted"
  | "nothing_to_sweep"
  | "no_sweep_signer"
  | "no_evm_payout_address"
  | "paused";

export type SweepResult = {
  creatorId: string;
  payoutId: string | null;
  amountMicro: bigint;
  gasMicro: bigint;
  toAddress: string;
  status: PayoutRow["status"] | null;
  txHash: string | null;
  purchasesSwept: number;
  skipped?: SweepSkip;
};

/**
 * V0 records gas as 0. Gas on Base is paid in ETH by the sweep wallet, and converting
 * it to micro-USDC needs a price oracle the PRD does not have (§11, "deliberately not
 * in V0"). The column exists, FR-26 promises the field on `GET /api/earnings`, and it
 * reports 0 until there is an oracle. Documented rather than guessed.
 */
export const GAS_MICRO_V0 = 0n;

/** Confirmation wait. Base blocks are ~2s; 60s is many blocks and bounded well under a cron budget. */
const RECEIPT_TIMEOUT_MS = 60_000;

export type SweepOptions = {
  now?: Date;
  /** Test seam: broadcast the USDC transfer and return its hash. */
  broadcast?: (args: { to: `0x${string}`; amountMicro: bigint }) => Promise<`0x${string}`>;
  /** Test seam: wait for the receipt of a broadcast transfer. */
  confirm?: (txHash: `0x${string}`) => Promise<{ status: "success" | "reverted" }>;
};

export async function sweepCreator(creator: CreatorRow, options: SweepOptions = {}): Promise<SweepResult> {
  const now = options.now ?? new Date();
  // FR-5 / §7.6: a rebind takes effect 48h after it was signed, and sweeps continue to
  // the old address until then. Nothing else in the system promotes the pending
  // address, so the sweep — the only thing that spends it — does it here, once, on the
  // first sweep after `rebind_effective_at`.
  const toAddress = await payoutAddressFor(creator, now);
  const empty: SweepResult = {
    creatorId: creator.id,
    payoutId: null,
    amountMicro: 0n,
    gasMicro: GAS_MICRO_V0,
    toAddress,
    status: null,
    txHash: null,
    purchasesSwept: 0,
  };

  // 0. §19 kill switch, before the screening call and well before any broadcast. It
  //    returns rather than throws, because both callers — the daily cron and the manual
  //    force-sweep — walk a list of creators and a pause is not one creator's failure.
  //    Nothing is written: the purchases stay unswept and the next unpaused run takes
  //    them, which is the same path a creator with no released balance already follows.
  if (await isPaused("sweeps")) {
    await record({ name: "sweep_skipped", props: { creator_id: creator.id, reason: "paused" } });
    return { ...empty, skipped: "paused" };
  }

  // 0a. This is the EVM sweep, and it pays an EVM address. A creator whose identity
  //     address is a Stellar `G…` (BUILD H5, since 20261025090100) is paid by
  //     `sweepStellarCreator` from their Stellar purchases; their EVM purchases, if any,
  //     have nowhere to go on this rail. Nothing is written: a `pending` row to a `G…`
  //     would fail the payout CHECK, and before the CHECK it would have reached
  //     `writeContract` and stuck.
  if (addressFamily(toAddress) !== "evm") {
    await record({ name: "sweep_skipped", props: { creator_id: creator.id, reason: "no_evm_payout_address" } });
    return { ...empty, skipped: "no_evm_payout_address" };
  }

  // 0b. The RPC must serve the chain the ledger describes — a mainnet endpoint on a
  //     Sepolia deployment would broadcast to one chain while the ledger described
  //     another. Checked before `openPayout` writes anything, so a misconfiguration
  //     cannot also leave a `pending` row blocking the creator.
  //
  //     Only when this run is actually going to broadcast: a caller that injects
  //     `broadcast` never touches the configured RPC, and a deployment with no signer
  //     (§14.8) stops before it would. In both cases asking the RPC which chain it
  //     serves is a network call to answer a question that does not arise.
  if (!options.broadcast && sweepPrivateKey()) {
    await assertRpcServesChain(publicClient(), x402Config().chainId, "sweep");
  }

  // 1. FR-38: screen before every sweep. A hit freezes and raises a ticket; it never pays.
  const screening = await screen(toAddress, "sweep");
  if (screening.hit) {
    await record({ name: "sweep_skipped", props: { creator_id: creator.id, reason: "sanctioned", frozen: true } });
    return { ...empty, skipped: "sanctioned" };
  }

  // 2. FR-28: a non-confirmed payout row blocks further sweeps for that creator.
  const inFlight = await inFlightPayout(creator.id);
  if (inFlight) {
    await record({ name: "sweep_skipped", props: { creator_id: creator.id, reason: "payout_in_flight", payout_id: inFlight.id } });
    return { ...empty, payoutId: inFlight.id, status: inFlight.status, txHash: inFlight.tx_hash, skipped: "payout_in_flight" };
  }

  // 3. The sweep set.
  const listings = await creatorListings(creator.id);
  const purchases = await sweepablePurchases(listings.map((l) => l.id), now);
  const amountMicro = purchases.reduce<bigint>((sum, p) => sum + toMicro(p.net_micro), 0n);
  if (amountMicro <= 0n) return { ...empty, skipped: "nothing_to_sweep" };

  // 4. The pending row, before any broadcast. The key is derived from the exact set of
  //    purchases, so a retry of the same sweep collides and a different set does not.
  const idempotencyKey = sweepKey(creator.id, purchases.map((p) => p.id));
  const opened = await openPayout(creator.id, toAddress, amountMicro, idempotencyKey);
  const payout = opened.payout;
  // The unique index on `idempotency_key` is the lock. Losing the insert means another
  // sweep for this exact purchase set is already running (the cron and a manual
  // `POST /api/payouts/sweep` can overlap); only the winner may broadcast, or the
  // creator is paid twice for the same rows.
  if (!opened.created) {
    // Colliding with a `failed` row means every retry key is spent: the address
    // reverts transfers and an operator has to look. Anything else is a running sweep.
    const reason: SweepSkip = payout.status === "failed" ? "payout_retries_exhausted" : "payout_in_flight";
    await record({ name: "sweep_skipped", props: { creator_id: creator.id, reason, payout_id: payout.id } });
    return { ...empty, payoutId: payout.id, amountMicro, status: payout.status, txHash: payout.tx_hash, skipped: reason };
  }

  // 5. No signer here (§14.8: the key belongs in the signing service). The row stays
  //    `pending` and the reason is on the event log; nothing is invented.
  const key = sweepPrivateKey();
  if (!options.broadcast && !key) {
    await record({ name: "sweep_skipped", props: { creator_id: creator.id, reason: "no_signer", payout_id: payout.id } });
    return {
      ...empty,
      payoutId: payout.id,
      amountMicro,
      status: "pending",
      purchasesSwept: 0,
      skipped: "no_sweep_signer",
    };
  }

  const broadcast = options.broadcast ?? defaultBroadcast;
  const confirm = options.confirm ?? defaultConfirm;

  let txHash: `0x${string}`;
  try {
    txHash = await broadcast({ to: toAddress as `0x${string}`, amountMicro });
  } catch {
    // W1.2: a broadcast throw (e.g. an RPC timeout after the tx was accepted) is
    // *indeterminate* — the transfer may have landed. Recording it terminal `failed`
    // (which does not block) would let a retry re-pay a transfer that actually
    // succeeded. Leave the payout `pending` — still covered by the
    // `payout_one_in_flight_per_creator` index, so it blocks the creator — record the
    // indeterminacy, and stop without re-throwing a 500 the cron would retry. No tx hash
    // is invented. Only a positively confirmed non-inclusion (an ops/reconcile action in
    // V0; there is no automated `broadcast/pending` → `failed` promotion) may move it to
    // `failed`.
    await record({ name: "sweep_indeterminate", props: { creator_id: creator.id, payout_id: payout.id, stage: "broadcast" } });
    return { ...empty, payoutId: payout.id, amountMicro, status: "pending", purchasesSwept: 0 };
  }
  await setPayoutStatus(payout.id, "broadcast", txHash);

  const receipt = await confirm(txHash);
  if (receipt.status !== "success") {
    await setPayoutStatus(payout.id, "failed", txHash);
    await record({ name: "sweep_failed", props: { creator_id: creator.id, payout_id: payout.id, stage: "receipt" } });
    return { ...empty, payoutId: payout.id, amountMicro, status: "failed", txHash, purchasesSwept: 0 };
  }

  // W1.1: stamp *before* confirming. If the process dies between these two writes the
  // payout is left `broadcast` (still covered by the in-flight index, so it blocks a
  // re-sweep) with its purchases already stamped — no double-pay. The old
  // confirm-then-stamp order could leave a `confirmed` payout (no longer blocking) whose
  // purchases were never stamped, and a later sweep would re-pay them. Clearing a payout
  // genuinely stuck at `broadcast` is a manual ops/reconcile action in V0.
  await stampPayout(purchases.map((p) => p.id), payout.id);
  await setPayoutStatus(payout.id, "confirmed", txHash);

  await record({
    name: "sweep",
    props: { creator_id: creator.id, payout_id: payout.id, amount_micro: amountMicro.toString(), purchases: purchases.length },
  });

  return {
    creatorId: creator.id,
    payoutId: payout.id,
    amountMicro,
    gasMicro: GAS_MICRO_V0,
    toAddress,
    status: "confirmed",
    txHash,
    purchasesSwept: purchases.length,
  };
}

/** Every creator with something to sweep. The cron's outer loop. */
export async function creatorsWithBalance(now: Date): Promise<CreatorRow[]> {
  const { data, error } = await db().from("creator").select("*").eq("wallet_mode", "linked");
  if (error) throw error;
  const creators = (data ?? []) as CreatorRow[];

  const out: CreatorRow[] = [];
  for (const creator of creators) {
    const listings = await creatorListings(creator.id);
    const purchases = await sweepablePurchases(listings.map((l) => l.id), now);
    if (purchases.reduce<bigint>((sum, p) => sum + toMicro(p.net_micro), 0n) > 0n) out.push(creator);
  }
  return out;
}

// --- rows -------------------------------------------------------------------

/** Deterministic: the same set of purchases always produces the same key. */
export function sweepKey(creatorId: string, purchaseIds: string[]): string {
  const digest = createHash("sha256").update([...purchaseIds].sort().join(",")).digest("hex").slice(0, 32);
  return `sweep:${creatorId}:${digest}`;
}

async function inFlightPayout(creatorId: string): Promise<PayoutRow | null> {
  // Per creator *per chain*: a Sepolia payout stuck at `pending` must not block a
  // mainnet sweep, and vice versa. One database serves both (20260906010000).
  const { data, error } = await db()
    .from("payout")
    .select("*")
    .eq("creator_id", creatorId)
    .eq("chain_id", paymentChain().chainId)
    .in("status", ["pending", "broadcast"]);
  if (error) throw error;
  return (((data ?? []) as PayoutRow[])[0] as PayoutRow | undefined) ?? null;
}

/**
 * FR-5 / §7.6: the bound payout address, promoting a pending rebind whose 48 hours have
 * passed. Returns the address the money may go to right now — the old one during the
 * delay, the new one after it, and never anything a request supplied.
 */
export async function payoutAddressFor(creator: CreatorRow, now: Date): Promise<string> {
  const effectiveAt = creator.rebind_effective_at ? new Date(creator.rebind_effective_at) : null;
  const pending = creator.pending_payout_address;
  if (!pending || !effectiveAt || effectiveAt.getTime() > now.getTime()) return creator.payout_address;

  const { error } = await db()
    .from("creator")
    .update({ payout_address: pending, pending_payout_address: null, rebind_effective_at: null })
    .eq("id", creator.id);
  if (error) throw error;

  await record({ name: "payout_address_rebound", props: { creator_id: creator.id, effective_at: creator.rebind_effective_at } });
  // Keep the caller's row consistent with what we just wrote.
  creator.payout_address = pending;
  creator.pending_payout_address = null;
  creator.rebind_effective_at = null;
  return pending;
}

/**
 * A `failed` payout may be retried this many times before the creator's balance needs
 * an operator. `failed` is only ever written off a mined-and-reverted receipt — no
 * funds moved, so a retry can never double-pay — but an address that reverts every
 * transfer (e.g. USDC-blacklisted) must not burn gas on every cron tick forever.
 */
export const MAX_FAILED_RETRIES = 3;

async function openPayout(
  creatorId: string,
  toAddress: string,
  amountMicro: bigint,
  idempotencyKey: string,
): Promise<{ payout: PayoutRow; created: boolean }> {
  // `:r2`, `:r3`… suffixes retry a purchase set whose previous payout *reverted on
  // chain*. Any other terminal state keeps the original key and therefore keeps
  // blocking — pending/broadcast are indeterminate and only ops may clear them.
  for (let attempt = 0; attempt <= MAX_FAILED_RETRIES; attempt++) {
    const key = attempt === 0 ? idempotencyKey : `${idempotencyKey}:r${attempt + 1}`;
    const { data, error } = await db()
      .from("payout")
      .insert({
        creator_id: creatorId,
        amount_micro: fromMicro(amountMicro),
        gas_micro: fromMicro(GAS_MICRO_V0),
        to_address: toAddress,
        idempotency_key: key,
        status: "pending",
        // The rail, in both spellings (20261025090100). Written explicitly rather than
        // left to the `payout_set_network` trigger: the mock has no trigger, and a row
        // the in-flight index cannot see is a sweep test that passes whatever it does.
        chain_id: paymentChain().chainId,
        network: paymentChain().network,
        asset: paymentChain().asset,
      })
      .select("*")
      .single();

    if (!error) return { payout: data as PayoutRow, created: true };
    if (error.code !== "23505") throw error;

    const { data: existing } = await db().from("payout").select("*").eq("idempotency_key", key).maybeSingle();
    if (!existing) throw error;
    if ((existing as PayoutRow).status === "failed" && attempt < MAX_FAILED_RETRIES) continue;
    return { payout: existing as PayoutRow, created: false };
  }
  // Unreachable: the loop always returns on its last attempt.
  throw new Error("openPayout: exhausted retry keys");
}

/** Shared with the Stellar sweep (lib/payouts/stellar.ts): one status writer, one stamp. */
export async function setPayoutStatus(payoutId: string, status: PayoutRow["status"], txHash: string | null): Promise<void> {
  const patch: Record<string, unknown> = { status };
  if (txHash) patch.tx_hash = txHash;
  const { error } = await db().from("payout").update(patch).eq("id", payoutId);
  if (error) throw error;
}

export async function stampPayout(purchaseIds: string[], payoutId: string): Promise<void> {
  if (purchaseIds.length === 0) return;
  const { error } = await db().from("purchase").update({ payout_id: payoutId }).in("id", purchaseIds);
  if (error) throw error;
}

// --- chain ------------------------------------------------------------------

function chain() {
  const { chainId } = x402Config();
  return {
    id: chainId,
    name: `eip155:${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl()] } },
  } as const;
}

/** A plain ERC-20 `transfer` from the sweep wallet. No router, no allowance, no `to` input. */
async function defaultBroadcast({ to, amountMicro }: { to: `0x${string}`; amountMicro: bigint }): Promise<`0x${string}`> {
  const key = sweepPrivateKey();
  if (!key) throw new Error("no sweep signer configured");
  const account = privateKeyToAccount(key as `0x${string}`);
  const { asset } = x402Config();
  const wallet = createWalletClient({ account, chain: chain(), transport: http(rpcUrl()) });
  return await wallet.writeContract({ address: asset as `0x${string}`, abi: erc20Abi, functionName: "transfer", args: [to, amountMicro] });
}

/** A read-only client on the configured RPC. Used for the chain check and the receipt. */
function publicClient() {
  return createPublicClient({ chain: chain(), transport: http(rpcUrl()) });
}

async function defaultConfirm(txHash: `0x${string}`): Promise<{ status: "success" | "reverted" }> {
  const client = publicClient();
  const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: RECEIPT_TIMEOUT_MS });
  return { status: receipt.status };
}
