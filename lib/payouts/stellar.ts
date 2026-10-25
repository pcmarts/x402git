/**
 * lib/payouts/stellar.ts — the Stellar sweep. Net earnings from Stellar sales leave for
 * the creator's bound Stellar address, in the asset they were paid in, and nowhere else.
 *
 * 25 Oct 2026, HackMeridian (docs/HACKMERIDIAN-BUILD.md §2.3 and W1 step 10,
 * docs/HACKMERIDIAN-USDT0.md W1 items 2a–3). A sibling of `sweepCreator` in `./sweep.ts`
 * with the same ledger discipline, in the same order:
 *
 *   1. screen the destination (FR-38; a Stellar address is recorded unscreened, BUILD H12);
 *   2. refuse to start if this creator has a Stellar payout that is not `confirmed`;
 *   3. the destination must hold an authorised trustline in the asset, or there is nothing
 *      to send to — checked before any row is written, so a creator who has not yet added
 *      the asset in Freighter is skipped, not blocked;
 *   4. write the `payout` row `pending`, with the deterministic idempotency key, `network`,
 *      `asset` and **`chain_id = null`** (BATTLE-TEST finding 12), before anything is sent;
 *   5. submit a classic `payment` of `code:issuer` through Horizon; Horizon answers once the
 *      transaction is in a ledger, so a success is final: `broadcast(hash)`, stamp the
 *      purchases, `confirmed`.
 *
 * **There is no `to` parameter.** The destination is `creator.stellar_payout_address`
 * (or the identity address when that is itself a `G…`, BUILD H5), read from the row.
 *
 * **The SAC is the payment surface, the classic asset is the payout surface.** Buyers pay
 * by calling `transfer` on the asset's Soroban contract (lib/x402/server.ts); the platform
 * account receives that as a classic balance, and a classic `payment` of the same
 * `code:issuer` is how it leaves. Same token, two spellings.
 *
 * **One hot account.** The receiving address is also the sweep source, and a Stellar
 * account has one sequence number: two submits that overlap collide, the loser gets
 * `tx_bad_seq`, and the transaction was definitively not included. The
 * `payout_one_in_flight_per_stellar_network` index serialises sweeps across creators,
 * and a `tx_bad_seq` that slips through is treated as "try again next tick", not as a
 * reverted transfer: the `pending` row is removed so the key is free, and the attempt
 * does not count against `MAX_FAILED_RETRIES` (BATTLE-TEST finding 9).
 */

import { Asset, BASE_FEE, Horizon, Keypair, Memo, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { db } from "@/lib/db";
import type { CreatorRow, PayoutRow } from "@/lib/db/types";
import { fromMicro, toMicro } from "@/lib/db/types";
import { type StellarNetwork, type StellarRail, stellarRail, stellarSweepSecret } from "@/lib/env";
import { record } from "@/lib/events";
import { isPaused } from "@/lib/ops/switches";
import { screen } from "@/lib/screening";
import { addressFamily, microToStroops, STELLAR_ACCOUNT_SHAPE } from "@/lib/x402/stellar";
import { creatorListings, sweepablePurchasesOn } from "./ledger";
import { GAS_MICRO_V0, MAX_FAILED_RETRIES, setPayoutStatus, stampPayout, type SweepSkip, sweepKey } from "./sweep";

export type StellarSweepSkip =
  | SweepSkip
  /** The creator has no Stellar address bound: neither `stellar_payout_address` nor a `G…` identity. */
  | "no_stellar_destination"
  /** The destination holds no authorised trustline in the configured asset (or dropped it). */
  | "no_trustline"
  /** `tx_bad_seq`: another submit from the platform account won the sequence number. Retried next tick, uncounted. */
  | "sequence_collision";

export type StellarSweepResult = {
  creatorId: string;
  network: StellarNetwork;
  /** The token contract the purchases were paid in and the payout is sent in. */
  asset: string;
  payoutId: string | null;
  amountMicro: bigint;
  gasMicro: bigint;
  /** The bound Stellar address, canonical upper-case; null only when there is none. */
  toAddress: string | null;
  status: PayoutRow["status"] | null;
  txHash: string | null;
  purchasesSwept: number;
  skipped?: StellarSweepSkip;
};

export type Trustline = { exists: boolean; authorized: boolean; error?: string };

export type StellarSweepOptions = {
  now?: Date;
  /** Test seam: send the classic payment and return its hash, or throw `StellarSubmitError`. */
  broadcast?: (args: { to: string; amountMicro: bigint; memo: string }) => Promise<{ hash: string }>;
  /** Test seam: does `address` hold an authorised trustline in the rail's asset? */
  trustline?: (address: string) => Promise<Trustline>;
};

/**
 * A Horizon submit that failed. `definitelyNotIncluded` is the fact the sweep acts on:
 * true only for a 400 carrying result codes (the network rejected the transaction, so no
 * funds moved and the row may be `failed` without risk of a double pay); false for a
 * timeout or a 5xx, where the transaction may yet land and the row must stay `pending`.
 */
export class StellarSubmitError extends Error {
  constructor(
    message: string,
    /** The most specific Horizon result code: an operation code (`op_no_trust`) over the transaction's (`tx_failed`). */
    readonly code: string | null,
    readonly definitelyNotIncluded: boolean,
  ) {
    super(message);
    this.name = "StellarSubmitError";
  }
}

export async function sweepStellarCreator(creator: CreatorRow, options: StellarSweepOptions = {}): Promise<StellarSweepResult> {
  const rail = stellarRail();
  if (!rail) throw new Error("sweepStellarCreator: the Stellar rail is not configured on this deployment");
  const now = options.now ?? new Date();

  // FR-5 / §7.6, the Stellar twin of `payoutAddressFor`: a rebind takes effect 48h after
  // it was signed, and the sweep is what promotes it, once, on the first run after.
  const toAddress = await stellarPayoutAddressFor(creator, now);
  const empty: StellarSweepResult = {
    creatorId: creator.id,
    network: rail.network,
    asset: rail.asset.contract,
    payoutId: null,
    amountMicro: 0n,
    gasMicro: GAS_MICRO_V0,
    toAddress,
    status: null,
    txHash: null,
    purchasesSwept: 0,
  };

  // 0. §19 kill switch, before anything else — the same rule as the EVM sweep.
  if (await isPaused("sweeps")) {
    await record({ name: "sweep_skipped", network: rail.network, props: { creator_id: creator.id, reason: "paused" } });
    return { ...empty, skipped: "paused" };
  }

  // 0a. No Stellar address, no Stellar payout. The purchases stay unswept; nothing is
  //     written. `CROSS_CHAIN_PAYOUTS` is read and `off` (BUILD §0b B3): bridging a Stellar
  //     sale to an EVM-only creator is W5, not this function.
  if (!toAddress) {
    await record({ name: "sweep_skipped", network: rail.network, props: { creator_id: creator.id, reason: "no_stellar_destination" } });
    return { ...empty, skipped: "no_stellar_destination" };
  }

  // 1. FR-38. There is no Stellar list (BUILD H12); the row says so and the sweep goes on.
  const screening = await screen(toAddress, "sweep");
  if (screening.hit) {
    await record({ name: "sweep_skipped", network: rail.network, props: { creator_id: creator.id, reason: "sanctioned", frozen: true } });
    return { ...empty, skipped: "sanctioned" };
  }

  // 2. FR-28: a non-confirmed Stellar payout blocks further Stellar sweeps for this
  //    creator. Per rail: an EVM row stuck at `pending` is the EVM sweep's problem.
  const inFlight = await inFlightStellarPayout(creator.id, rail.network);
  if (inFlight) {
    await record({ name: "sweep_skipped", network: rail.network, props: { creator_id: creator.id, reason: "payout_in_flight", payout_id: inFlight.id } });
    return { ...empty, payoutId: inFlight.id, status: inFlight.status, txHash: inFlight.tx_hash, skipped: "payout_in_flight" };
  }

  // 3. The destination must be able to receive the asset. Checked before any row exists:
  //    a creator who has not added the asset in their wallet yet is *skipped*, and the
  //    next sweep after they do pays them, with no `pending` row to clear in between.
  //    A caller that injects `broadcast` never touches Horizon (the EVM sweep's rule for
  //    its RPC check), unless it also says what the trustline is.
  const trustline = options.trustline ?? (options.broadcast ? assumeTrustline : (address: string) => horizonTrustline(rail, address));
  const line = await trustline(toAddress);
  if (!line.exists || !line.authorized) {
    await record({
      name: "sweep_skipped",
      network: rail.network,
      props: { creator_id: creator.id, reason: "no_trustline", exists: line.exists, authorized: line.authorized, ...(line.error ? { error: line.error } : {}) },
    });
    return { ...empty, skipped: "no_trustline" };
  }

  // 4. The sweep set: this rail, this token (USDT0 T5), past the holdback, unpaid.
  const listings = await creatorListings(creator.id);
  const purchases = await sweepablePurchasesOn(rail.network, rail.asset.contract, listings.map((l) => l.id), now);
  const amountMicro = purchases.reduce<bigint>((sum, p) => sum + toMicro(p.net_micro), 0n);
  if (amountMicro <= 0n) return { ...empty, skipped: "nothing_to_sweep" };

  // 5. The pending row, before anything is sent. The key is the exact purchase set, so a
  //    retry of the same sweep collides and a different set does not. The purchase ids
  //    are rail-specific, so a Stellar key can never equal an EVM key for the same creator.
  const idempotencyKey = sweepKey(creator.id, purchases.map((p) => p.id));
  const opened = await openStellarPayout(creator.id, rail, toAddress, amountMicro, idempotencyKey);
  if (opened.kind === "single_flight") {
    // Lost the `payout_one_in_flight_per_stellar_network` index: another creator's Stellar
    // payout is mid-flight from the one platform account. Next tick.
    await record({ name: "sweep_skipped", network: rail.network, props: { creator_id: creator.id, reason: "payout_in_flight", source_busy: true } });
    return { ...empty, amountMicro, skipped: "payout_in_flight" };
  }
  const payout = opened.payout;
  if (!opened.created) {
    const reason: StellarSweepSkip = payout.status === "failed" ? "payout_retries_exhausted" : "payout_in_flight";
    await record({ name: "sweep_skipped", network: rail.network, props: { creator_id: creator.id, reason, payout_id: payout.id } });
    return { ...empty, payoutId: payout.id, amountMicro, status: payout.status, txHash: payout.tx_hash, skipped: reason };
  }

  // 6. No signer here (§14.8). The row stays `pending` and the reason is on the event log.
  if (!options.broadcast && !stellarSweepSecret()) {
    await record({ name: "sweep_skipped", network: rail.network, props: { creator_id: creator.id, reason: "no_signer", payout_id: payout.id } });
    return { ...empty, payoutId: payout.id, amountMicro, status: "pending", skipped: "no_sweep_signer" };
  }

  const broadcast = options.broadcast ?? ((args: { to: string; amountMicro: bigint; memo: string }) => payStellar(args, rail));
  // The memo names the payout so a creator can match the explorer row to their ledger.
  // Memo text is at most 28 bytes.
  const memo = `x402git sweep ${payout.id.slice(0, 8)}`;

  let hash: string;
  try {
    ({ hash } = await broadcast({ to: toAddress, amountMicro, memo }));
  } catch (e) {
    if (e instanceof StellarSubmitError && e.definitelyNotIncluded) {
      if (e.code === "tx_bad_seq") {
        // The network refused the transaction before inclusion: no funds moved. The row
        // never left `pending` and records no money movement, so it is removed rather than
        // marked `failed` — a `failed` row would spend one of the creator's retry keys on a
        // collision that is nobody's fault (BATTLE-TEST finding 9).
        await deletePendingPayout(payout.id);
        await record({ name: "sweep_retry", network: rail.network, props: { creator_id: creator.id, reason: "tx_bad_seq" } });
        return { ...empty, amountMicro, skipped: "sequence_collision" };
      }
      // `op_no_trust`, `op_not_authorized`, `op_underfunded`, `tx_insufficient_fee`, …: a
      // definite refusal. `failed` is terminal and does not block; the retry keys (`:r2`,
      // `:r3`) bound how often it is tried again, and the trustline check above stops a
      // revoked or dropped trustline from being retried at all while it stays that way.
      await setPayoutStatus(payout.id, "failed", null);
      await record({ name: "sweep_failed", network: rail.network, props: { creator_id: creator.id, payout_id: payout.id, stage: "submit", code: e.code } });
      return { ...empty, payoutId: payout.id, amountMicro, status: "failed", ...(e.code === "op_no_trust" ? { skipped: "no_trustline" as const } : {}) };
    }
    // Indeterminate (a timeout, a 5xx): the transfer may have landed. Leave the row
    // `pending` — it blocks the creator and the network, as it should — and invent no hash.
    await record({ name: "sweep_indeterminate", network: rail.network, props: { creator_id: creator.id, payout_id: payout.id, stage: "broadcast" } });
    return { ...empty, payoutId: payout.id, amountMicro, status: "pending" };
  }

  // Horizon returns only once the transaction is in a closed ledger, so the hash is final.
  // Stamp before confirming (W1.1, as the EVM sweep): a crash between the two leaves a
  // `broadcast` row whose purchases are already stamped, never a confirmed row with
  // unstamped purchases that a later sweep would pay again.
  await setPayoutStatus(payout.id, "broadcast", hash);
  await stampPayout(purchases.map((p) => p.id), payout.id);
  await setPayoutStatus(payout.id, "confirmed", hash);

  await record({
    name: "sweep",
    network: rail.network,
    props: { creator_id: creator.id, payout_id: payout.id, amount_micro: amountMicro.toString(), purchases: purchases.length, asset: rail.asset.code },
  });

  return { ...empty, payoutId: payout.id, amountMicro, status: "confirmed", txHash: hash, purchasesSwept: purchases.length };
}

/** Every `linked` creator with released Stellar earnings in this rail's asset. A cron's outer loop. */
export async function creatorsWithStellarBalance(now: Date): Promise<CreatorRow[]> {
  const rail = stellarRail();
  if (!rail) return [];
  const { data, error } = await db().from("creator").select("*").eq("wallet_mode", "linked");
  if (error) throw error;
  const out: CreatorRow[] = [];
  for (const creator of (data ?? []) as CreatorRow[]) {
    const listings = await creatorListings(creator.id);
    const purchases = await sweepablePurchasesOn(rail.network, rail.asset.contract, listings.map((l) => l.id), now);
    if (purchases.reduce<bigint>((sum, p) => sum + toMicro(p.net_micro), 0n) > 0n) out.push(creator);
  }
  return out;
}

// --- destination ------------------------------------------------------------------------

/**
 * Where a Stellar payout may go right now: the bound Stellar address, promoting a pending
 * rebind whose 48 hours have passed (FR-5 / §7.6), or the identity address when that is
 * itself a `G…` (BUILD H5), or nothing. Never anything a request supplied.
 */
export async function stellarPayoutAddressFor(creator: CreatorRow, now: Date): Promise<string | null> {
  const pending = creator.pending_stellar_payout_address ?? null;
  const effectiveAt = creator.stellar_rebind_effective_at ? new Date(creator.stellar_rebind_effective_at) : null;
  if (pending && effectiveAt && effectiveAt.getTime() <= now.getTime()) {
    const { error } = await db()
      .from("creator")
      .update({ stellar_payout_address: pending, pending_stellar_payout_address: null, stellar_rebind_effective_at: null })
      .eq("id", creator.id);
    if (error) throw error;
    await record({ name: "payout_address_rebound", props: { creator_id: creator.id, rail: "stellar", effective_at: creator.stellar_rebind_effective_at } });
    creator.stellar_payout_address = pending;
    creator.pending_stellar_payout_address = null;
    creator.stellar_rebind_effective_at = null;
  }

  const bound = creator.stellar_payout_address ?? null;
  const destination = bound ?? (addressFamily(creator.payout_address) === "stellar" ? creator.payout_address : null);
  // Belt and braces against the payout CHECK: a classic payment reaches a `G…` account only.
  return destination && STELLAR_ACCOUNT_SHAPE.test(destination) ? destination : null;
}

// --- rows -------------------------------------------------------------------------------

async function inFlightStellarPayout(creatorId: string, network: StellarNetwork): Promise<PayoutRow | null> {
  const { data, error } = await db()
    .from("payout")
    .select("*")
    .eq("creator_id", creatorId)
    .eq("network", network)
    .in("status", ["pending", "broadcast", "in_transit"]);
  if (error) throw error;
  return (((data ?? []) as PayoutRow[])[0] as PayoutRow | undefined) ?? null;
}

type Opened = { kind: "row"; payout: PayoutRow; created: boolean } | { kind: "single_flight" };

/**
 * The twin of `openPayout` in `./sweep.ts`, stamping `network`, `asset` and a null
 * `chain_id` (BATTLE-TEST finding 12: an EVM chain id on a Stellar payout made the EVM
 * in-flight check block the EVM sweep and the EVM reconcile subtract USDT0 from the USDC
 * ledger). Two unique indexes can refuse the insert: the idempotency key (a running or
 * exhausted sweep of this exact set) and the per-network single-flight index (another
 * Stellar payout mid-flight from the one platform account). A 23505 with no row under
 * our key is the second.
 */
async function openStellarPayout(creatorId: string, rail: StellarRail, toAddress: string, amountMicro: bigint, idempotencyKey: string): Promise<Opened> {
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
        tx_hash: null,
        network: rail.network,
        asset: rail.asset.contract,
        chain_id: null,
      })
      .select("*")
      .single();

    if (!error) return { kind: "row", payout: data as PayoutRow, created: true };
    if (error.code !== "23505") throw error;

    const { data: existing } = await db().from("payout").select("*").eq("idempotency_key", key).maybeSingle();
    if (!existing) return { kind: "single_flight" };
    if ((existing as PayoutRow).status === "failed" && attempt < MAX_FAILED_RETRIES) continue;
    return { kind: "row", payout: existing as PayoutRow, created: false };
  }
  throw new Error("openStellarPayout: exhausted retry keys");
}

/** Only ever a `pending` row that nothing was sent for (see `tx_bad_seq` above). */
async function deletePendingPayout(payoutId: string): Promise<void> {
  const { error } = await db().from("payout").delete().eq("id", payoutId).eq("status", "pending");
  if (error) throw error;
}

// --- Horizon ----------------------------------------------------------------------------

const SUBMIT_TIMEOUT_SEC = 60;

/**
 * A classic `payment` of the rail's asset from the platform account. No router, no path
 * payment, no `to` input beyond the bound address. `amountMicro × 10` stroops, written as
 * the 7-decimal string Horizon wants, with no float in between.
 */
export async function payStellar(args: { to: string; amountMicro: bigint; memo: string }, rail: StellarRail = requireRail()): Promise<{ hash: string }> {
  const secret = stellarSweepSecret();
  if (!secret) throw new Error("no Stellar sweep signer configured");
  const source = Keypair.fromSecret(secret);
  const horizon = new Horizon.Server(rail.horizonUrl);

  const account = await horizon.loadAccount(source.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: rail.passphrase })
    .addOperation(
      Operation.payment({
        destination: args.to,
        asset: new Asset(rail.asset.code, rail.asset.issuer),
        amount: stroopsToDecimal(microToStroops(args.amountMicro)),
      }),
    )
    .addMemo(Memo.text(args.memo.slice(0, 28)))
    .setTimeout(SUBMIT_TIMEOUT_SEC)
    .build();
  tx.sign(source);

  try {
    const result = await horizon.submitTransaction(tx);
    return { hash: result.hash };
  } catch (e) {
    throw classifySubmitError(e);
  }
}

/** `12345678n` stroops → `"1.2345678"`. Integer arithmetic only. */
export function stroopsToDecimal(stroops: bigint): string {
  const whole = stroops / 10_000_000n;
  const frac = (stroops % 10_000_000n).toString().padStart(7, "0");
  return `${whole}.${frac}`;
}

/**
 * Horizon's error shape: a 400 carries `extras.result_codes` with the transaction code
 * and, when an operation failed, the per-operation codes. That is the definitive "not
 * included". Anything else — a 504 (`tx_timeout` is Horizon saying it stopped waiting,
 * not that the network refused), a 5xx, a dropped socket — is indeterminate.
 */
export function classifySubmitError(e: unknown): StellarSubmitError {
  const response = (e as { response?: { status?: number; data?: { extras?: { result_codes?: { transaction?: string; operations?: string[] } } } } })?.response;
  const status = response?.status;
  const codes = response?.data?.extras?.result_codes;
  const code = codes?.operations?.find((c) => c !== "op_success") ?? codes?.transaction ?? null;
  const definitelyNotIncluded = status === 400 && codes !== undefined;
  const message = e instanceof Error ? e.message : String(e);
  return new StellarSubmitError(`Horizon submit failed${code ? ` (${code})` : ""}: ${message}`, code, definitelyNotIncluded);
}

/** The destination's trustline in the rail's asset, read from Horizon. Any failure reads as "no trustline" with the error recorded. */
async function horizonTrustline(rail: StellarRail, address: string): Promise<Trustline> {
  try {
    const res = await fetch(`${rail.horizonUrl}/accounts/${encodeURIComponent(address)}`, { headers: { accept: "application/json" } });
    if (res.status === 404) return { exists: false, authorized: false };
    if (!res.ok) return { exists: false, authorized: false, error: `horizon returned ${res.status}` };
    const body = (await res.json()) as { balances?: { asset_code?: string; asset_issuer?: string; is_authorized?: boolean }[] };
    const line = (body.balances ?? []).find((b) => b.asset_code === rail.asset.code && b.asset_issuer === rail.asset.issuer);
    if (!line) return { exists: false, authorized: false };
    return { exists: true, authorized: line.is_authorized !== false };
  } catch (e) {
    return { exists: false, authorized: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function assumeTrustline(): Promise<Trustline> {
  return { exists: true, authorized: true };
}

function requireRail(): StellarRail {
  const rail = stellarRail();
  if (!rail) throw new Error("the Stellar rail is not configured on this deployment");
  return rail;
}
