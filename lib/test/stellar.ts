/**
 * lib/test/stellar.ts — fixtures for the Stellar rail's money path.
 *
 * `exactStellarTransaction` builds the same shape `@x402/stellar`'s client builds — one
 * `invokeHostFunction` calling `transfer(from, to, amount)` on the asset contract, with
 * the payer's authorization entry signed — but without simulating against an RPC, so a
 * test never touches the network. The payer signs with a real keypair, so the replay
 * path's local signature check (`verifyPayerAuthEntry`) is exercised for real.
 *
 * `stellarPaymentPayload` wraps it in an x402 v2 envelope whose `accepted` is the
 * Stellar accept entry, the way a client echoes it; `stellarSignatureHeader` encodes
 * that with `@x402/core`'s own encoder, so the decode path under test is production's.
 */

import { Account, Address, BASE_FEE, Keypair, Operation, TransactionBuilder, authorizeInvocation, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { stellarPassphrase } from "@/lib/env";

/** Testnet USDC's SAC, the `stellarRail()` default on `stellar:testnet`. */
export const STELLAR_TESTNET_USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
export const STELLAR_NETWORK = "stellar:testnet";

/** A fixed payer so tests can name the address; any `Keypair` works. */
export const STELLAR_BUYER = Keypair.fromSecret("SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X");
/** `STELLAR_BUYER.publicKey()`, spelled out so a test can read it. */
export const STELLAR_BUYER_ADDRESS = "GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57";
export const STELLAR_PAY_TO = "GD6ROJBYLKQMOW3E7N4M2YBPUHMZD7PL65VRHRMO24BOVSBV5H3BQRSL";
/** A creator's Stellar payout address, distinct from the platform's. */
export const STELLAR_CREATOR = "GBTL47RTFR5EKMZSXWOQU735WBK7LRPPDIDK3JTNTCZZ7NUBBRDTVSK2";
/** The platform account's secret for `STELLAR_SWEEP_SECRET` in payout tests (pays from `STELLAR_PAY_TO`? no: a throwaway). */
export const STELLAR_SWEEP_SECRET_FIXTURE = "SAFQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQX44I";

export type ExactStellarInput = {
  payer?: Keypair;
  payTo?: string;
  contract?: string;
  /** Stroops (7 decimals): micro × 10. */
  amountStroops: bigint;
  network?: string;
  /** The auth-entry nonce; random when omitted, as the SDK does. */
  nonce?: bigint;
  signatureExpirationLedger?: number;
  /** A second signer for the auth entry, to test a forged entry. */
  signWith?: Keypair;
  /** Leave the auth entry unsigned (the shape before the payer signs). */
  unsigned?: boolean;
};

/** The `transfer(from, to, amount)` invocation, as `InvokeContractArgs`. */
function transferArgs(contract: string, from: string, to: string, amountStroops: bigint): xdr.InvokeContractArgs {
  return new xdr.InvokeContractArgs({
    contractAddress: new Address(contract).toScAddress(),
    functionName: "transfer",
    args: [nativeToScVal(from, { type: "address" }), nativeToScVal(to, { type: "address" }), nativeToScVal(amountStroops, { type: "i128" })],
  });
}

/** A base64 transaction envelope carrying one signed `exact` Stellar transfer. */
export async function exactStellarTransaction(input: ExactStellarInput): Promise<string> {
  const payer = input.payer ?? STELLAR_BUYER;
  const payTo = input.payTo ?? STELLAR_PAY_TO;
  const contract = input.contract ?? STELLAR_TESTNET_USDC;
  const network = input.network ?? STELLAR_NETWORK;
  const passphrase = stellarPassphrase(network);
  const expiration = input.signatureExpirationLedger ?? 1_000_000;

  const args = transferArgs(contract, payer.publicKey(), payTo, input.amountStroops);
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(args),
    subInvocations: [],
  });

  let entry: xdr.SorobanAuthorizationEntry;
  if (input.unsigned) {
    entry = new xdr.SorobanAuthorizationEntry({
      rootInvocation: invocation,
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(payer.publicKey()).toScAddress(),
          nonce: new xdr.Int64(input.nonce ?? 1n),
          signatureExpirationLedger: expiration,
          signature: xdr.ScVal.scvVoid(),
        }),
      ),
    });
  } else {
    // `authorizeInvocation` picks a random nonce; a fixed one is written over it before
    // signing by building the entry ourselves and calling the SDK's signer on it.
    const signer = input.signWith ?? payer;
    entry = await authorizeInvocation({ signer, validUntilLedgerSeq: expiration, invocation, networkPassphrase: passphrase, publicKey: payer.publicKey() });
    if (input.nonce !== undefined) {
      const { authorizeEntry } = await import("@stellar/stellar-sdk");
      const creds = entry.credentials().address();
      creds.nonce(new xdr.Int64(input.nonce));
      creds.signature(xdr.ScVal.scvVoid());
      entry = await authorizeEntry(entry, signer, expiration, passphrase);
    }
  }

  const tx = new TransactionBuilder(new Account(payer.publicKey(), "0"), { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(Operation.invokeHostFunction({ func: xdr.HostFunction.hostFunctionTypeInvokeContract(args), auth: [entry] }))
    .setTimeout(300)
    .build();
  return tx.toXDR();
}

/** A two-operation envelope: what a facilitator refuses with `wrong_operation`. */
export function twoOperationTransaction(network = STELLAR_NETWORK): string {
  const passphrase = stellarPassphrase(network);
  const args = transferArgs(STELLAR_TESTNET_USDC, STELLAR_BUYER.publicKey(), STELLAR_PAY_TO, 10n);
  const op = Operation.invokeHostFunction({ func: xdr.HostFunction.hostFunctionTypeInvokeContract(args), auth: [] });
  return new TransactionBuilder(new Account(STELLAR_BUYER.publicKey(), "0"), { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(op)
    .addOperation(op)
    .setTimeout(300)
    .build()
    .toXDR();
}

/** A contract call that is not `transfer`. */
export function nonTransferTransaction(network = STELLAR_NETWORK): string {
  const passphrase = stellarPassphrase(network);
  const args = new xdr.InvokeContractArgs({
    contractAddress: new Address(STELLAR_TESTNET_USDC).toScAddress(),
    functionName: "approve",
    args: [nativeToScVal(STELLAR_BUYER.publicKey(), { type: "address" }), nativeToScVal(STELLAR_PAY_TO, { type: "address" }), nativeToScVal(10n, { type: "i128" })],
  });
  return new TransactionBuilder(new Account(STELLAR_BUYER.publicKey(), "0"), { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(Operation.invokeHostFunction({ func: xdr.HostFunction.hostFunctionTypeInvokeContract(args), auth: [] }))
    .setTimeout(300)
    .build()
    .toXDR();
}

/** A `C…` contract wallet as payer: its auth entry carries a non-void signature only the network can check. */
export const STELLAR_CONTRACT_PAYER = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

export function contractPayerTransaction(input: { amountStroops: bigint; nonce: bigint; network?: string; payTo?: string; contract?: string }): string {
  const network = input.network ?? STELLAR_NETWORK;
  const passphrase = stellarPassphrase(network);
  const payTo = input.payTo ?? STELLAR_PAY_TO;
  const contract = input.contract ?? STELLAR_TESTNET_USDC;
  const args = transferArgs(contract, STELLAR_CONTRACT_PAYER, payTo, input.amountStroops);
  const entry = new xdr.SorobanAuthorizationEntry({
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(args),
      subInvocations: [],
    }),
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(STELLAR_CONTRACT_PAYER).toScAddress(),
        nonce: new xdr.Int64(input.nonce),
        signatureExpirationLedger: 1_000_000,
        // Whatever the contract's `__check_auth` wants; opaque to us.
        signature: xdr.ScVal.scvVec([xdr.ScVal.scvBytes(Buffer.alloc(64, 1))]),
      }),
    ),
  });
  return new TransactionBuilder(new Account(STELLAR_BUYER.publicKey(), "0"), { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(Operation.invokeHostFunction({ func: xdr.HostFunction.hostFunctionTypeInvokeContract(args), auth: [entry] }))
    .setTimeout(300)
    .build()
    .toXDR();
}

export type StellarPayloadInput = ExactStellarInput & { resource?: string };

/** The x402 v2 envelope a Stellar client sends: `accepted` is the Stellar entry, `payload.transaction` the XDR. */
export async function stellarPaymentPayload(input: StellarPayloadInput): Promise<PaymentPayload> {
  const transaction = await exactStellarTransaction(input);
  return {
    x402Version: 2,
    resource: { url: input.resource ?? "https://x402git.test/api/r/adrian/humanizer" },
    accepted: {
      scheme: "exact",
      network: (input.network ?? STELLAR_NETWORK) as `${string}:${string}`,
      amount: input.amountStroops.toString(),
      asset: input.contract ?? STELLAR_TESTNET_USDC,
      payTo: input.payTo ?? STELLAR_PAY_TO,
      maxTimeoutSeconds: 300,
      extra: { areFeesSponsored: true },
    },
    payload: { transaction },
  };
}

export async function stellarSignatureHeader(input: StellarPayloadInput): Promise<string> {
  return encodePaymentSignatureHeader(await stellarPaymentPayload(input));
}

/** Wrap an arbitrary XDR string in the envelope, for the malformed-payload cases. */
export function stellarHeaderFor(transaction: string, amountStroops: bigint, network = STELLAR_NETWORK): string {
  return encodePaymentSignatureHeader({
    x402Version: 2,
    resource: { url: "https://x402git.test/api/r/adrian/humanizer" },
    accepted: {
      scheme: "exact",
      network: network as `${string}:${string}`,
      amount: amountStroops.toString(),
      asset: STELLAR_TESTNET_USDC,
      payTo: STELLAR_PAY_TO,
      maxTimeoutSeconds: 300,
      extra: { areFeesSponsored: true },
    },
    payload: { transaction },
  });
}

/** `process.env` for a testnet Stellar rail beside the Base Sepolia the suites already set. */
export function setStellarTestnetEnv(): void {
  process.env.STELLAR_NETWORK = STELLAR_NETWORK;
  process.env.STELLAR_RECEIVING_ADDRESS = STELLAR_PAY_TO;
}

export function clearStellarEnv(): void {
  for (const key of Object.keys(process.env)) if (key.startsWith("STELLAR_")) delete process.env[key];
  delete process.env.CROSS_CHAIN_PAYOUTS;
}
