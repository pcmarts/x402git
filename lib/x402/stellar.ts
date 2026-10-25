/**
 * lib/x402/stellar.ts — the pure half of the Stellar rail: units, address shapes, and
 * reading an `exact` Stellar payment payload without a network.
 *
 * 25 Oct 2026, HackMeridian (docs/HACKMERIDIAN-BUILD.md §2.1/§2.2, docs/HACKMERIDIAN-USDT0.md
 * W1). Nothing here touches the ledger or a facilitator; `lib/x402/server.ts` and
 * `lib/core/access.ts` call these and own the decisions.
 *
 * **Units.** The ledger is micro-dollars (6 decimals, `bigint`), the same on every rail.
 * Stellar assets carry 7 decimals (stroops), so the wire amount is micro × 10 and a
 * stroop amount that is not a multiple of 10 has no micro value: `stroopsToMicro`
 * throws rather than rounding, because rounding money is how a buyer is charged one
 * thing and granted another.
 *
 * **Addresses.** EVM addresses are stored lower-case (DECISIONS.md). A Stellar strkey is
 * case-sensitive base32 with a checksum; lower-casing one produces a string Horizon and
 * every explorer reject (BUILD H11). `canonicalAddress` is the one function that knows
 * both rules, and every write of a buyer or payee address goes through it.
 *
 * **The payload.** An `exact` Stellar payment is one Soroban transaction: a single
 * `invokeHostFunction` calling `transfer(from, to, amount)` on the asset contract, with
 * the payer's authorization entry attached and signed. `decodeExactPayload` reads those
 * facts out of the XDR the same way `@x402/stellar`'s facilitator does (its
 * `exact/facilitator/index.mjs` is the reference), so what the ledger records is what
 * will settle. The payer's auth-entry nonce is the replay key: Soroban consumes it on
 * chain, and this module hands it to the ledger as part of the `payment_nonce`.
 */

import { Address, Keypair, StrKey, Transaction, hash, scValToNative, xdr } from "@stellar/stellar-sdk";
import { stellarPassphrase } from "@/lib/env";
import { ApiError } from "@/lib/errors";

/** The DB CHECK shapes from migration 20261025090100, so a mismatch is caught here first. */
export const STELLAR_PAYER_SHAPE = /^[GC][A-Z2-7]{55}$/;
export const STELLAR_ACCOUNT_SHAPE = /^G[A-Z2-7]{55}$/;
export const STELLAR_CONTRACT_SHAPE = /^C[A-Z2-7]{55}$/;
const EVM_SHAPE = /^0x[0-9a-fA-F]{40}$/;

// --- units -----------------------------------------------------------------------------

/** Micro-dollars → stroops (7 decimals). Exact: every micro amount is a whole number of stroops. */
export function microToStroops(micro: bigint): bigint {
  if (micro < 0n) throw new RangeError("microToStroops: negative amount");
  return micro * 10n;
}

/** Thrown when a stroop amount has a digit the ledger cannot hold. Named so callers can tell it from a bug. */
export class StroopsNotMicroError extends RangeError {
  constructor(stroops: bigint) {
    super(`stroopsToMicro: ${stroops} stroops is not a whole number of micro-dollars`);
    this.name = "StroopsNotMicroError";
  }
}

/** Stroops → micro-dollars. Throws on a remainder; never rounds money. */
export function stroopsToMicro(stroops: bigint): bigint {
  if (stroops < 0n) throw new RangeError("stroopsToMicro: negative amount");
  if (stroops % 10n !== 0n) throw new StroopsNotMicroError(stroops);
  return stroops / 10n;
}

// --- addresses -------------------------------------------------------------------------

/** Which rail an address belongs to, or null for a string that is neither shape. */
export function addressFamily(address: string): "evm" | "stellar" | null {
  if (typeof address !== "string") return null;
  if (EVM_SHAPE.test(address)) return "evm";
  const upper = address.toUpperCase();
  if (STELLAR_PAYER_SHAPE.test(upper) && (StrKey.isValidEd25519PublicKey(upper) || StrKey.isValidContract(upper))) return "stellar";
  return null;
}

/**
 * The stored spelling of an address: EVM lower-case, Stellar upper-case strkey with the
 * checksum verified. Anything else is `invalid_request`, which is what every caller
 * would otherwise have to say about an address that fits no rail.
 */
export function canonicalAddress(address: string): string {
  const family = addressFamily(address);
  if (family === "evm") return address.toLowerCase();
  if (family === "stellar") return address.toUpperCase();
  throw new ApiError("invalid_request", { message: "Not a valid EVM (0x…) or Stellar (G…/C…) address." });
}

// --- the payload -----------------------------------------------------------------------

export type DecodedExactPayload = {
  /** The payer: a `G…` account or a `C…` contract wallet, as the transfer names it. */
  from: string;
  /** The recipient the transfer names. The caller compares it to the rail's `payTo`. */
  to: string;
  /** The transfer amount in stroops. The caller converts with `stroopsToMicro`. */
  amount: bigint;
  /** The contract being called. The caller compares it to the rail's asset contract. */
  contract: string;
  /** The payer's auth-entry nonce, decimal. Consumed on chain once; the replay key here. */
  authNonce: string;
  /** The ledger the payer's signature expires at. */
  signatureExpirationLedger: number;
};

/** A payload that is not an `exact` Stellar transfer. The message says which rule it broke. */
export class StellarPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StellarPayloadError";
  }
}

/**
 * Read the four facts out of a base64 transaction envelope, or throw `StellarPayloadError`.
 * Mirrors the facilitator's structural checks exactly: one operation, an
 * `invokeHostFunction` of `transfer` with three arguments, address-credential auth
 * entries, and an entry for the payer. No simulation and no signature check here; the
 * facilitator simulates, and `verifyPayerAuthEntry` below checks the signature when the
 * replay path needs it.
 */
export function decodeExactPayload(transactionXdr: string, network: string): DecodedExactPayload {
  const { from, to, amount, contract, payerEntry } = readTransfer(transactionXdr, network);
  const credentials = addressCredentialsOf(payerEntry);
  return {
    from,
    to,
    amount,
    contract,
    authNonce: credentials.nonce().toBigInt().toString(),
    signatureExpirationLedger: credentials.signatureExpirationLedger(),
  };
}

/**
 * Does the payer's authorization entry carry a valid ed25519 signature from the payer's
 * own key? This is the replay path's local check (lib/x402/flow.ts): the payer, nonce
 * and amount are public on chain seconds after settlement, so a resent payload must
 * prove it is the original and not a forgery assembled from public data.
 *
 * Only a `G…` payer can be checked this way: a `C…` contract wallet's `__check_auth` is
 * arbitrary code that only the network can run, so it is `false` here and the replay
 * path fails closed (BATTLE-TEST finding 15 is the follow-up).
 *
 * The preimage is the one `@stellar/stellar-sdk`'s `authorizeEntry` signs, for both the
 * legacy address credentials and the CAP-71 V2 arm that binds the address in.
 */
export function verifyPayerAuthEntry(transactionXdr: string, network: string): boolean {
  try {
    const { from, payerEntry } = readTransfer(transactionXdr, network);
    if (!STELLAR_ACCOUNT_SHAPE.test(from)) return false;

    const credentials = payerEntry.credentials();
    const addressCredentials = addressCredentialsOf(payerEntry);
    const signature = addressCredentials.signature();
    if (signature.switch().name === "scvVoid") return false;

    const networkId = hash(Buffer.from(stellarPassphrase(network)));
    const common = {
      networkId,
      nonce: addressCredentials.nonce(),
      invocation: payerEntry.rootInvocation(),
      signatureExpirationLedger: addressCredentials.signatureExpirationLedger(),
    };
    const preimage =
      credentials.switch().name === "sorobanCredentialsAddress"
        ? xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(new xdr.HashIdPreimageSorobanAuthorization(common))
        : xdr.HashIdPreimage.envelopeTypeSorobanAuthorizationWithAddress(
            new xdr.HashIdPreimageSorobanAuthorizationWithAddress({ ...common, address: addressCredentials.address() }),
          );
    const payload = hash(preimage.toXDR());

    // `scvVec([ scvMap({ public_key: bytes, signature: bytes }) ])`, as `authorizeEntry` writes it.
    const entries = scValToNative(signature) as unknown;
    if (!Array.isArray(entries) || entries.length === 0) return false;
    const payer = Keypair.fromPublicKey(from);
    return entries.some((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const { public_key: publicKey, signature: sig } = entry as { public_key?: unknown; signature?: unknown };
      if (!(publicKey instanceof Uint8Array) || !(sig instanceof Uint8Array)) return false;
      if (StrKey.encodeEd25519PublicKey(Buffer.from(publicKey)) !== from) return false;
      return payer.verify(payload, Buffer.from(sig));
    });
  } catch {
    return false;
  }
}

// --- reading the envelope ------------------------------------------------------------------

type Transfer = { from: string; to: string; amount: bigint; contract: string; payerEntry: xdr.SorobanAuthorizationEntry };

function readTransfer(transactionXdr: string, network: string): Transfer {
  let tx: Transaction;
  try {
    // A fee-bump envelope throws here too, which is right: the payer signs the inner
    // transaction, and the facilitator wraps it, never the client.
    tx = new Transaction(transactionXdr, stellarPassphrase(network));
  } catch (e) {
    throw new StellarPayloadError(`transaction is not a Stellar transaction envelope: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (tx.operations.length !== 1) throw new StellarPayloadError(`expected exactly one operation, got ${tx.operations.length}`);
  const op = tx.operations[0];
  if (op.type !== "invokeHostFunction") throw new StellarPayloadError(`expected an invokeHostFunction operation, got ${op.type}`);

  const func = op.func;
  if (func.switch().name !== "hostFunctionTypeInvokeContract") throw new StellarPayloadError("expected a contract invocation");
  const invoke = func.invokeContract();
  const contract = Address.fromScAddress(invoke.contractAddress()).toString();
  const functionName = invoke.functionName().toString();
  const args = invoke.args();
  if (functionName !== "transfer" || args.length !== 3) {
    throw new StellarPayloadError(`expected transfer(from, to, amount), got ${functionName}/${args.length}`);
  }

  const from = scValToNative(args[0]) as unknown;
  const to = scValToNative(args[1]) as unknown;
  const amount = scValToNative(args[2]) as unknown;
  if (typeof from !== "string" || typeof to !== "string") throw new StellarPayloadError("transfer from/to are not addresses");
  if (typeof amount !== "bigint") throw new StellarPayloadError("transfer amount is not an i128");

  const auth = op.auth ?? [];
  if (auth.length === 0) throw new StellarPayloadError("transaction carries no authorization entries");
  let payerEntry: xdr.SorobanAuthorizationEntry | null = null;
  for (const entry of auth) {
    // Every entry must be address-credentialed: a source-account entry would make the
    // facilitator's fee account the authorizer, which it refuses too.
    const credentials = addressCredentialsOf(entry);
    if (Address.fromScAddress(credentials.address()).toString() === from) payerEntry = entry;
  }
  if (!payerEntry) throw new StellarPayloadError("the payer has no authorization entry");

  return { from, to, amount, contract, payerEntry };
}

/** Both address arms (legacy and CAP-71 V2) wrap the same structure; anything else is refused. */
function addressCredentialsOf(entry: xdr.SorobanAuthorizationEntry): xdr.SorobanAddressCredentials {
  const credentials = entry.credentials();
  switch (credentials.switch().name) {
    case "sorobanCredentialsAddress":
      return credentials.address();
    case "sorobanCredentialsAddressV2":
      return credentials.addressV2();
    default:
      throw new StellarPayloadError(`unsupported credential type ${credentials.switch().name}`);
  }
}
