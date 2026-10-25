/**
 * lib/auth/challenge.ts — the signed challenge behind every wallet-authenticated
 * action (FR-2 `address_proof`, FR-4 rotate-key, FR-5 step-up, FR-20 X-Wallet-Signature).
 *
 * One nonce, one use, five minutes. A challenge is consumed the first time it verifies
 * *and* the first time it fails: a failed attempt still burns it, so a stolen nonce
 * cannot be brute-forced against.
 *
 * A challenge is also bound to a **purpose**. The bytes the caller signs name the action
 * (`address_proof`, `step_up`, `rotate_key`, `wallet_ownership`), and `consumeChallenge`
 * refuses a signature whose stored purpose is not the one the calling path expects — so a
 * benign "prove your wallet" prompt cannot be replayed as a payout-address rebind (W2.2).
 *
 *   const { nonce, message, expires_at } = await issueChallenge(address, "step_up");
 *   // caller signs `message` verbatim with personal_sign
 *   await consumeChallenge(address, nonce, signature, "step_up");   // throws ApiError on failure
 */

import { randomBytes } from "node:crypto";
import { getAddress, verifyMessage } from "viem";
import { db } from "@/lib/db";
import type { ChallengePurpose, ChallengeRow } from "@/lib/db/types";
import { ApiError } from "@/lib/errors";

/** FR-20. */
export const CHALLENGE_TTL_SEC = 300;

export type IssuedChallenge = {
  nonce: string;
  message: string;
  expires_at: string;
  address: string;
};

/**
 * The exact bytes the caller signs. Human-readable on a hardware wallet screen, and
 * it names the site, the address, the action and the expiry so a signature harvested
 * elsewhere — or for a different action — is useless here.
 *
 * `context` narrows the action to its operand — `rebind:<new address>` on a payout
 * rebind — so the wallet screen shows *where the money will go*, and the signature is
 * useless for a rebind to anywhere else. §14.7 assumes the API key leaks; a phished
 * generic step-up must not be enough to redirect earnings.
 */
export function challengeMessage(address: string, nonce: string, expiresAt: Date, purpose: ChallengePurpose, context?: string | null): string {
  return [
    "x402git challenge",
    `address: ${address}`,
    `purpose: ${purpose}`,
    ...(context ? [`context: ${context}`] : []),
    `nonce: ${nonce}`,
    `expires: ${expiresAt.toISOString()}`,
  ].join("\n");
}

export function newNonce(): string {
  return randomBytes(24).toString("base64url");
}

/** Mint and store a challenge for a specific purpose. Valid for `CHALLENGE_TTL_SEC`, single use. */
export async function issueChallenge(address: string, purpose: ChallengePurpose, context: string | null = null, now = new Date()): Promise<IssuedChallenge> {
  const checksummed = normaliseAddress(address);
  const nonce = newNonce();
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_SEC * 1000);
  const message = challengeMessage(checksummed, nonce, expiresAt, purpose, context);

  const { error } = await db()
    .from("challenge")
    .insert({ nonce, address: checksummed.toLowerCase(), message, purpose, context, expires_at: expiresAt.toISOString() });
  if (error) throw error;

  return { nonce, message, expires_at: expiresAt.toISOString(), address: checksummed };
}

/**
 * Verify a signature over a stored challenge and burn the nonce.
 *
 * Throws `invalid_signature` when the nonce is unknown, expired, already used, issued
 * to a different address, issued for a different purpose, or the signature does not
 * recover to `address`. Returns the checksummed address on success.
 *
 * The burn is a **compare-and-set** (W2.8): only the writer that flips `used_at`
 * `null → now` may continue, so two concurrent presentations of the same nonce cannot
 * both succeed — the loser reads zero affected rows and is rejected as already-used.
 *
 * V0 verifies EOA `personal_sign` only. FR-2 also allows ERC-1271 contract wallets;
 * that needs an on-chain `isValidSignature` read and is not wired up yet.
 */
export async function consumeChallenge(
  address: string,
  nonce: string,
  signature: string,
  purpose: ChallengePurpose,
  context: string | null = null,
  now = new Date(),
): Promise<string> {
  const checksummed = normaliseAddress(address);
  const lower = checksummed.toLowerCase();

  const { data, error } = await db().from("challenge").select("*").eq("nonce", nonce).maybeSingle();
  if (error) throw error;
  const row = data as ChallengeRow | null;
  if (!row) throw new ApiError("invalid_signature", { message: "Unknown challenge nonce." });

  // Compare-and-set burn: the update only matches a row whose `used_at` is still null, and
  // returns the rows it touched. Zero rows back means another request already spent this
  // nonce — one signature, one use, even under concurrency.
  const { data: burned, error: burnError } = await db()
    .from("challenge")
    .update({ used_at: now.toISOString() })
    .eq("nonce", nonce)
    .is("used_at", null)
    .select();
  if (burnError) throw burnError;
  if (!burned || (burned as unknown[]).length === 0) {
    throw new ApiError("invalid_signature", { message: "That challenge has already been used." });
  }

  if (row.address.toLowerCase() !== lower) throw new ApiError("invalid_signature", { message: "That challenge was issued to a different address." });
  if (new Date(row.expires_at).getTime() <= now.getTime()) throw new ApiError("invalid_signature", { message: "That challenge has expired." });
  if (row.purpose !== purpose) throw new ApiError("invalid_signature", { message: "That challenge was issued for a different action." });
  // The context is part of what was signed: a rebind signature names the new address,
  // and is refused for a rebind to any other address — or for a contextless action.
  if ((row.context ?? null) !== (context ?? null)) {
    throw new ApiError("invalid_signature", { message: "That challenge was issued for a different operation. Request one that names this exact change." });
  }

  let ok = false;
  try {
    ok = await verifyMessage({ address: checksummed as `0x${string}`, message: row.message, signature: signature as `0x${string}` });
  } catch {
    ok = false;
  }
  if (!ok) throw new ApiError("invalid_signature", { message: "The signature does not match the challenge for that address." });

  return checksummed;
}

/** Checksum, or `invalid_request` if it is not an address at all. */
export function normaliseAddress(address: string): string {
  try {
    return getAddress(address);
  } catch {
    throw new ApiError("invalid_request", { message: "Not a valid EVM address." });
  }
}

/**
 * The form an address takes in the database: lowercase. Every column that holds an
 * address stores it lowercased so `.eq()` is always correct, and API responses
 * checksum it on the way out with `normaliseAddress`. Mixing the two forms is the
 * bug this function exists to prevent. See DECISIONS.md.
 */
export function dbAddress(address: string): string {
  return normaliseAddress(address).toLowerCase();
}
