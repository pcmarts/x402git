/**
 * lib/auth/wallet-signature.ts — FR-20, `X-Wallet-Signature: <address>.<nonce>.<sig>`.
 *
 * Accepted on `/api/r/*`, `/api/v/*` and `/api/entitlements`. Two rules that matter:
 *
 * - **Absent is not an error.** Without the header, `/api/r` quotes the new-buyer price
 *   and `/api/v` returns version data only. `walletFrom(req)` returns `null` for that.
 * - **Present and wrong is 401.** A malformed header, an unknown or expired nonce, or a
 *   signature that does not recover is `invalid_signature`, never a silent downgrade to
 *   anonymous — otherwise a typo quietly costs the buyer the full price.
 *
 * `?address=` alone is never accepted: entitlement state is not a public oracle.
 *
 *   const buyer = await walletFrom(req);        // Address | null
 *   const buyer = await requireWallet(req);     // Address, or throws invalid_signature
 */

import { ApiError } from "@/lib/errors";
import { consumeChallenge, normaliseAddress } from "./challenge";

export const WALLET_SIGNATURE_HEADER = "x-wallet-signature";

export type ParsedWalletSignature = { address: string; nonce: string; signature: string };

/** Split the header. Returns null when it is absent; throws when it is malformed. */
export function parseWalletSignature(header: string | null): ParsedWalletSignature | null {
  if (header === null) return null;
  const value = header.trim();
  if (value === "") return null;

  const parts = value.split(".");
  if (parts.length !== 3) {
    throw new ApiError("invalid_signature", { message: "X-Wallet-Signature must be <address>.<nonce>.<signature>." });
  }
  const [address, nonce, signature] = parts;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || nonce.length === 0 || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw new ApiError("invalid_signature", { message: "X-Wallet-Signature must be <address>.<nonce>.<signature>." });
  }
  return { address: normaliseAddress(address), nonce, signature };
}

/**
 * The verified buyer, or `null` when the header is absent. The nonce must be a valid,
 * unexpired challenge for that address, and it is consumed — one header, one request.
 */
export async function walletFrom(req: Request, now = new Date()): Promise<string | null> {
  const parsed = parseWalletSignature(req.headers.get(WALLET_SIGNATURE_HEADER));
  if (!parsed) return null;
  return await consumeChallenge(parsed.address, parsed.nonce, parsed.signature, "wallet_ownership", null, now);
}

/** As `walletFrom`, but an absent header is `invalid_signature` (FR-32). */
export async function requireWallet(req: Request, now = new Date()): Promise<string> {
  const address = await walletFrom(req, now);
  if (!address) throw new ApiError("invalid_signature", { message: "This route requires an X-Wallet-Signature header." });
  return address;
}
