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
 * Two shapes of header, one meaning (BUILD §0a F3, JOURNEYS rule 7 — a buyer is a wallet
 * on a network, and both kinds re-download forever by signing with the wallet that paid):
 *
 *   0x<40 hex>.<nonce>.0x<hex>          EIP-191 personal_sign from an EVM wallet
 *   G<55 base32>.<nonce>.<base64>       SEP-53 from a Stellar account (Freighter
 *                                       `signMessage`, or `Keypair.signMessage` in the CLI)
 *
 * The dot is a safe separator for both: a nonce is base64url, a SEP-53 signature is
 * base64, and neither alphabet contains it.
 *
 *   const buyer = await walletFrom(req);        // Address | null
 *   const buyer = await requireWallet(req);     // Address, or throws invalid_signature
 */

import { ApiError } from "@/lib/errors";
import { consumeChallenge, normaliseAddress } from "./challenge";

export const WALLET_SIGNATURE_HEADER = "x-wallet-signature";

export type ParsedWalletSignature = { address: string; nonce: string; signature: string };

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EVM_SIGNATURE = /^0x[0-9a-fA-F]+$/;
// Case-insensitive on purpose: a lower-cased strkey is repaired by `normaliseAddress`,
// not refused, the way a lower-cased EVM address is checksummed rather than refused.
const STELLAR_ACCOUNT = /^G[A-Z2-7]{55}$/i;
// 64 bytes of base64 is 86 characters plus padding; a hex EVM signature is 132, so the
// length alone keeps a `0x…` signature out of the Stellar branch.
const BASE64_SIGNATURE = /^[A-Za-z0-9+/_-]{86,88}={0,2}$/;

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
  // Each family's signature must come with that family's address: a hex signature for a
  // `G…`, or a base64 one for a `0x…`, is malformed here rather than "does not verify"
  // later, so the two paths can never be confused for one another.
  const evm = EVM_ADDRESS.test(address) && EVM_SIGNATURE.test(signature);
  const stellar = STELLAR_ACCOUNT.test(address) && BASE64_SIGNATURE.test(signature);
  if (nonce.length === 0 || !(evm || stellar)) {
    throw new ApiError("invalid_signature", { message: "X-Wallet-Signature must be <address>.<nonce>.<signature>." });
  }
  return { address: normaliseAddress(address), nonce, signature };
}

/**
 * The verified buyer, or `null` when the header is absent. The nonce must be a valid,
 * unexpired challenge for that address, and it is consumed — one header, one request.
 * The address comes back in its canonical spelling: EIP-55 for EVM, upper-case strkey
 * for Stellar, which is what entitlement rows are matched on (with `network`).
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
