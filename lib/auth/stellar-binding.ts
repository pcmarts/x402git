/**
 * lib/auth/stellar-binding.ts — what has to be true of a Stellar `G…` account before it
 * can be a payout address (25 Oct 2026, HACKMERIDIAN-JOURNEYS C2–C5, BUILD §2.5, USDT0 "W2").
 *
 * Proving the key is `consumeChallenge`'s job (SEP-53). This module does the other half:
 *
 * 1. **The account exists and holds an authorised trustline in the configured asset**
 *    (`stellarRail().asset`), read from Horizon. Without the trustline a classic payment
 *    to it fails with `op_no_trust`, so money would have nowhere to go; binding is refused
 *    with the exact sentence the wallet page shows, and nothing is written.
 * 2. **An addition is immediate, a change waits 48 hours** — the same rule as the EVM
 *    rebind (FR-5 / §7.6, `lib/auth/step-up.ts`): both keys signed an addition and the
 *    destination is on a chain the creator just proved they control, while a change is
 *    where a takeover would redirect earnings. `stellarBindPatch` computes the row patch
 *    and nothing else; the route writes it. `lib/payouts/stellar.ts` promotes the pending
 *    address when the delay has passed.
 * 3. **Type-to-confirm**: the whole address or its last six characters, because a
 *    strkey is 56 characters nobody reads, and the last six are what explorers show.
 *
 * F4 (no multisig at the event): the signer is the address, so nothing here reads
 * signers or thresholds. `stellar_payout_meta` records only the trustline check.
 */

import type { CreatorRow } from "@/lib/db/types";
import { type StellarRail, stellarRail } from "@/lib/env";
import { ApiError, describeThrown } from "@/lib/errors";
import { STELLAR_ACCOUNT_SHAPE, addressFamily, canonicalAddress } from "@/lib/x402/stellar";
import { rebindEffectiveAt } from "./step-up";

/** `creator.stellar_payout_meta` (migration 20261025090100). */
export type StellarPayoutMeta = {
  network: string;
  /** The account the trustline was read for: the bound address, or the pending one on a change. */
  address: string;
  trustline: { code: string; issuer: string; authorized: boolean };
  checked_at: string;
};

export type InspectedStellarAccount = { meta: StellarPayoutMeta; verifiedAt: string };

/** `details.reason` on every refusal, so a page or an agent can branch without parsing prose. */
export type StellarBindReason = "stellar_disabled" | "not_an_account" | "account_not_found" | "horizon_unavailable" | "no_trustline";

/** Horizon testnet occasionally 504s; fail closed quickly with a retry message rather than hang a form post. */
export const HORIZON_TIMEOUT_MS = 5000;

/**
 * The one sentence a creator reads when the trustline is missing (JOURNEYS C2 step 3,
 * BATTLE-TEST finding 18). Code and issuer come from configuration, so testnet shows
 * the testnet asset. The same words go in the API error and on the wallet page.
 */
export function trustlineCopy(asset: { code: string; issuer: string }): string {
  return `Your wallet needs to allow ${asset.code} before we can pay you. In Freighter: Manage assets → Add manually, then paste: Asset code ${asset.code}, Issuer ${asset.issuer}. Then come back and press Refresh.`;
}

type HorizonAccount = { balances?: { asset_type?: string; asset_code?: string; asset_issuer?: string; is_authorized?: boolean }[] };

/**
 * Read `GET /accounts/<G>` from Horizon and require an authorised trustline in the rail's
 * asset. Returns the meta to store; throws `invalid_request` (with `details.reason`) for
 * anything that is the creator's to fix, and `internal` when Horizon itself did not answer.
 */
export async function inspectStellarPayoutAccount(
  address: string,
  options: { fetchImpl?: typeof fetch; now?: Date; rail?: StellarRail | null } = {},
): Promise<InspectedStellarAccount> {
  const rail = options.rail === undefined ? stellarRail() : options.rail;
  if (!rail) {
    throw new ApiError("invalid_request", { message: "Being paid on Stellar is not enabled on this deployment.", details: { reason: "stellar_disabled" satisfies StellarBindReason } });
  }

  const canonical = addressFamily(address) === "stellar" ? canonicalAddress(address) : null;
  if (!canonical || !STELLAR_ACCOUNT_SHAPE.test(canonical)) {
    throw new ApiError("invalid_request", {
      message: "A Stellar payout address is a G… account. Contract (C…) and muxed (M…) addresses cannot receive a payout.",
      details: { reason: "not_an_account" satisfies StellarBindReason },
    });
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${rail.horizonUrl}/accounts/${encodeURIComponent(canonical)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(HORIZON_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (e) {
    throw new ApiError("internal", {
      message: "Stellar's Horizon did not answer. Nothing was changed; try again in a moment.",
      details: { reason: "horizon_unavailable" satisfies StellarBindReason, error: describeThrown(e) },
    });
  }
  if (res.status === 404) {
    throw new ApiError("invalid_request", {
      message: "That Stellar account does not exist on the network yet. Fund it with a little XLM first, then try again.",
      details: { reason: "account_not_found" satisfies StellarBindReason, address: canonical },
    });
  }
  if (!res.ok) {
    throw new ApiError("internal", {
      message: `Stellar's Horizon answered ${res.status}. Nothing was changed; try again in a moment.`,
      details: { reason: "horizon_unavailable" satisfies StellarBindReason, status: res.status },
    });
  }

  let body: HorizonAccount;
  try {
    body = (await res.json()) as HorizonAccount;
  } catch (e) {
    throw new ApiError("internal", {
      message: "Stellar's Horizon returned something that was not an account. Nothing was changed; try again in a moment.",
      details: { reason: "horizon_unavailable" satisfies StellarBindReason, error: describeThrown(e) },
    });
  }

  const { code, issuer } = rail.asset;
  const line = (body.balances ?? []).find((b) => b.asset_code === code && b.asset_issuer === issuer);
  // Horizon omits `is_authorized` only for assets that need no authorisation, so absent
  // reads as authorised; an explicit `false` is a trustline the issuer has not (yet) approved.
  const authorized = line !== undefined && line.is_authorized !== false;
  if (!line || !authorized) {
    throw new ApiError("invalid_request", {
      message: trustlineCopy(rail.asset),
      details: { reason: "no_trustline" satisfies StellarBindReason, address: canonical, asset: { code, issuer }, exists: line !== undefined, authorized },
    });
  }

  const checkedAt = (options.now ?? new Date()).toISOString();
  return {
    meta: { network: rail.network, address: canonical, trustline: { code, issuer, authorized: true }, checked_at: checkedAt },
    verifiedAt: checkedAt,
  };
}

/**
 * The Stellar address a creator is paid at today: the bound one, else the identity
 * address when that is itself a `G…` (BUILD H5), else none. The pending address is not
 * "current" — it is where payouts will go once the delay passes.
 */
export function currentStellarPayoutAddress(creator: Pick<CreatorRow, "payout_address" | "stellar_payout_address">): string | null {
  const bound = creator.stellar_payout_address ?? null;
  if (bound) return bound;
  return addressFamily(creator.payout_address) === "stellar" ? canonicalAddress(creator.payout_address) : null;
}

export type StellarBindOutcome = {
  /** `added`: live now (JOURNEYS C3). `queued`: takes effect at `effectiveAt` (C5). */
  applied: "added" | "queued";
  effectiveAt: string | null;
  patch: Record<string, unknown>;
};

/**
 * The `creator` row patch for binding `inspected.meta.address`. Pure: the caller has
 * already proved the key (SEP-53), taken the step-up and read Horizon.
 */
export function stellarBindPatch(
  creator: Pick<CreatorRow, "payout_address" | "stellar_payout_address" | "pending_stellar_payout_address">,
  inspected: InspectedStellarAccount,
  now = new Date(),
): StellarBindOutcome {
  const next = inspected.meta.address;
  const current = currentStellarPayoutAddress(creator);
  if (current === next) throw new ApiError("invalid_request", { message: "That is already your Stellar payout address." });
  if ((creator.pending_stellar_payout_address ?? null) === next) {
    throw new ApiError("invalid_request", { message: "That change is already queued. It takes effect when the 48-hour delay passes." });
  }

  const common = { stellar_payout_meta: inspected.meta, stellar_payout_verified_at: inspected.verifiedAt };
  if (current === null) {
    return {
      applied: "added",
      effectiveAt: null,
      patch: { ...common, stellar_payout_address: next, pending_stellar_payout_address: null, stellar_rebind_effective_at: null },
    };
  }
  const effectiveAt = rebindEffectiveAt(now).toISOString();
  return {
    applied: "queued",
    effectiveAt,
    patch: { ...common, pending_stellar_payout_address: next, stellar_rebind_effective_at: effectiveAt },
  };
}

/** Type-to-confirm: the whole address, or its last six characters, case-insensitively. */
export function confirmsAddress(confirm: string | null | undefined, address: string): boolean {
  if (!confirm) return false;
  const typed = confirm.trim().toUpperCase();
  if (typed.length === 0) return false;
  return typed === address || (typed.length === 6 && address.endsWith(typed));
}

/** The `details.reason` off a refusal, when there is one — for a page to branch on. */
export function stellarBindReason(e: unknown): StellarBindReason | null {
  if (!(e instanceof ApiError) || !e.details || typeof e.details !== "object") return null;
  const reason = (e.details as { reason?: unknown }).reason;
  return typeof reason === "string" ? (reason as StellarBindReason) : null;
}
