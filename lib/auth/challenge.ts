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
 *
 * **Two families of address, one challenge** (25 Oct 2026, the Stellar rail, BUILD §0a F3,
 * HACKMERIDIAN-JOURNEYS rule 7). The message is the same bytes whichever wallet signs it;
 * only the verification differs. An EVM `0x…` address signs with EIP-191 `personal_sign`
 * and is checked with viem, exactly as before. A Stellar `G…` account signs with SEP-53
 * (`SHA256("Stellar Signed Message:\n" + message)`, ed25519) — Freighter's `signMessage`
 * and the SDK's `Keypair.signMessage` both produce it — and is checked with
 * `Keypair.fromPublicKey(address).verifyMessage`. The signer must *be* the address (F4:
 * no multisig, no Horizon signer lookup): a `C…` contract account has no key that could
 * sign, so it is refused up front with a message that says so.
 */

import { randomBytes } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { getAddress, verifyMessage } from "viem";
import { db } from "@/lib/db";
import type { ChallengePurpose, ChallengeRow } from "@/lib/db/types";
import { ApiError } from "@/lib/errors";
import { STELLAR_CONTRACT_SHAPE, addressFamily, canonicalAddress } from "@/lib/x402/stellar";

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
    .insert({ nonce, address: dbAddress(checksummed), message, purpose, context, expires_at: expiresAt.toISOString() });
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
 * that needs an on-chain `isValidSignature` read and is not wired up yet. A Stellar
 * address is verified as SEP-53 from its own key (see the module comment).
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
  const family = addressFamily(checksummed) as "evm" | "stellar";
  const stored = dbAddress(checksummed);

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

  // An EVM row is stored lower-case; a strkey is stored as it is spelled, and is never
  // lower-cased on either side of the comparison (BUILD H11).
  const sameAddress = family === "evm" ? row.address.toLowerCase() === stored : row.address === stored;
  if (!sameAddress) throw new ApiError("invalid_signature", { message: "That challenge was issued to a different address." });
  if (new Date(row.expires_at).getTime() <= now.getTime()) throw new ApiError("invalid_signature", { message: "That challenge has expired." });
  if (row.purpose !== purpose) throw new ApiError("invalid_signature", { message: "That challenge was issued for a different action." });
  // The context is part of what was signed: a rebind signature names the new address,
  // and is refused for a rebind to any other address — or for a contextless action.
  if ((row.context ?? null) !== (context ?? null)) {
    throw new ApiError("invalid_signature", { message: "That challenge was issued for a different operation. Request one that names this exact change." });
  }

  const ok = family === "evm" ? await verifyEvmSignature(checksummed, row.message, signature) : verifySep53(checksummed, row.message, signature);
  if (!ok) throw new ApiError("invalid_signature", { message: "The signature does not match the challenge for that address." });

  // Migration 20261025090100 `challenge.signer`: the key that signed. On this rail it is
  // the address itself (F4), recorded so an audit can read it off the row rather than
  // infer it. Written only on the Stellar path, so the EVM write shape is unchanged and
  // a database without the column keeps working for EVM creators.
  if (family === "stellar") {
    const { error: signerError } = await db().from("challenge").update({ signer: checksummed }).eq("nonce", nonce);
    if (signerError) throw signerError;
  }

  return checksummed;
}

/** EIP-191 `personal_sign`, recovered with viem. Any throw is "does not verify". */
async function verifyEvmSignature(address: string, message: string, signature: string): Promise<boolean> {
  try {
    return await verifyMessage({ address: address as `0x${string}`, message, signature: signature as `0x${string}` });
  } catch {
    return false;
  }
}

/**
 * SEP-53: is `signature` (base64, 64 bytes) the ed25519 signature of
 * `SHA256("Stellar Signed Message:\n" + message)` by the key behind `address`?
 *
 * Freighter v4 returns the signature as base64; v3 returned a Buffer, which the client
 * component base64-encodes before it reaches us. URL-safe base64 is accepted too, since
 * some wallets emit it. Anything that is not 64 bytes is "does not verify", never a
 * throw — a malformed signature is a wrong signature.
 */
export function verifySep53(address: string, message: string, signature: string): boolean {
  const bytes = decodeSep53Signature(signature);
  if (!bytes) return false;
  try {
    return Keypair.fromPublicKey(address).verifyMessage(message, bytes);
  } catch {
    return false;
  }
}

/** Standard or URL-safe base64 → the 64 signature bytes, or null for anything else. */
export function decodeSep53Signature(signature: string): Buffer | null {
  if (typeof signature !== "string" || signature.length === 0 || signature.length > 128) return null;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(signature)) return null;
  const standard = signature.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const bytes = Buffer.from(standard, "base64");
  return bytes.length === 64 ? bytes : null;
}

/**
 * The spelling an address is shown in, or `invalid_request` if it is not an address at
 * all: an EVM address EIP-55 checksummed; a Stellar `G…` account upper-case with its
 * checksum verified. A `C…` contract account is refused by name — it cannot sign a
 * challenge, so letting it through would only fail later with a worse message.
 */
export function normaliseAddress(address: string): string {
  const family = addressFamily(address);
  if (family === "evm") {
    try {
      return getAddress(address);
    } catch {
      throw new ApiError("invalid_request", { message: "Not a valid EVM (0x…) or Stellar (G…) address." });
    }
  }
  if (family === "stellar") {
    const canonical = canonicalAddress(address);
    if (STELLAR_CONTRACT_SHAPE.test(canonical)) {
      throw new ApiError("invalid_request", {
        message: "A Stellar contract account (C…) cannot sign a challenge. Use the G… account whose key you hold.",
      });
    }
    return canonical;
  }
  throw new ApiError("invalid_request", { message: "Not a valid EVM (0x…) or Stellar (G…) address." });
}

/**
 * The form an address takes in the database. EVM: lowercase, so `.eq()` is always
 * correct, and API responses checksum it on the way out with `normaliseAddress`. Stellar:
 * the upper-case strkey exactly as `canonicalAddress` spells it — a lower-cased strkey is
 * a string no explorer or Horizon resolves (BUILD H11), so it is never produced here.
 * Mixing the forms is the bug this function exists to prevent. See DECISIONS.md.
 */
export function dbAddress(address: string): string {
  const shown = normaliseAddress(address);
  return addressFamily(shown) === "evm" ? shown.toLowerCase() : shown;
}
