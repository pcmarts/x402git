/**
 * lib/test/x402.ts — fixtures for the money path.
 *
 * A test must never reach a facilitator, so `stubFacilitator` returns a client whose
 * `verify` and `settle` are whatever the test says they are, and records every call —
 * "no settle call happened" is an assertion several of the FR-22 / FR-38 tests make.
 *
 * `signatureHeader` builds a real `PAYMENT-SIGNATURE` value with `@x402/core`'s own
 * encoder, so the decode path under test is the production one.
 */

import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import { privateKeyToAccount } from "viem/accounts";
import type { X402Requirement } from "@/lib/core/access";
import { assetDomain } from "@/lib/x402/asset";

export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const NETWORK = "eip155:84532";

export type AuthorizationInput = {
  from: string;
  to?: string;
  amountMicro: bigint;
  nonce: string;
  payTo?: string;
  asset?: string;
  network?: string;
};

/** An x402 v2 payload carrying an EIP-3009 authorization, as a real client would send. */
export function paymentPayload(input: AuthorizationInput): PaymentPayload {
  const amount = input.amountMicro.toString();
  const payTo = input.payTo ?? "0x1111111111111111111111111111111111111111";
  return {
    x402Version: 2,
    resource: { url: "https://x402git.test/api/r/adrian/humanizer" },
    accepted: {
      scheme: "exact",
      network: (input.network ?? NETWORK) as `${string}:${string}`,
      amount,
      asset: input.asset ?? USDC_BASE_SEPOLIA,
      payTo,
      maxTimeoutSeconds: 300,
      extra: { name: "USDC", version: "2" },
    },
    payload: {
      signature: "0x" + "ab".repeat(65),
      authorization: {
        from: input.from,
        to: input.to ?? payTo,
        value: amount,
        validAfter: "0",
        validBefore: String(Math.floor(Date.now() / 1000) + 3600),
        nonce: input.nonce,
      },
    },
  };
}

export function signatureHeader(input: AuthorizationInput): string {
  return encodePaymentSignatureHeader(paymentPayload(input));
}

/** The EIP-3009 `TransferWithAuthorization` type, for real local signing (W1.4 replay). */
export const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/**
 * A `PAYMENT-SIGNATURE` header carrying a **real** EIP-3009 signature over the asset's own
 * EIP-712 domain — the shape `lib/x402/flow.ts` verifies locally on a nonce-replay (DA /
 * W1.4). `signatureHeader` above leaves a placeholder signature, which is fine for the
 * fresh-settle path (the facilitator is stubbed), but the replay path verifies the
 * signature itself, so a genuine crash-retry test needs a genuine signature.
 */
export async function signedSignatureHeader(privateKey: `0x${string}`, input: AuthorizationInput): Promise<string> {
  const payload = paymentPayload(input);
  const auth = (payload.payload as Record<string, any>).authorization as {
    from: `0x${string}`;
    to: `0x${string}`;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: `0x${string}`;
  };
  const network = input.network ?? NETWORK;
  const asset = (input.asset ?? USDC_BASE_SEPOLIA) as `0x${string}`;
  const chainId = Number(network.split(":")[1]);
  const account = privateKeyToAccount(privateKey);
  const signature = await account.signTypedData({
    domain: { ...assetDomain(network, asset), chainId, verifyingContract: asset },
    types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: auth.from,
      to: auth.to,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    },
  });
  (payload.payload as Record<string, any>).signature = signature;
  return encodePaymentSignatureHeader(payload);
}

/** A 32-byte hex nonce, the shape EIP-3009 uses. */
export function nonceHex(seed: string): string {
  return "0x" + seed.padEnd(64, "0").slice(0, 64).replace(/[^0-9a-f]/g, "0");
}

export type FacilitatorStub = {
  client: FacilitatorClient;
  verifyCalls: { payload: PaymentPayload; requirements: unknown }[];
  settleCalls: { payload: PaymentPayload; requirements: unknown }[];
};

export type StubOptions = {
  verify?: VerifyResponse | ((payload: PaymentPayload) => VerifyResponse | Promise<VerifyResponse>);
  settle?: SettleResponse | ((payload: PaymentPayload) => SettleResponse | Promise<SettleResponse>) | Error;
};

export function stubFacilitator(options: StubOptions = {}): FacilitatorStub {
  const verifyCalls: FacilitatorStub["verifyCalls"] = [];
  const settleCalls: FacilitatorStub["settleCalls"] = [];

  const client: FacilitatorClient = {
    async verify(payload, requirements) {
      verifyCalls.push({ payload, requirements });
      const v = options.verify ?? { isValid: true };
      return typeof v === "function" ? await v(payload) : v;
    },
    async settle(payload, requirements) {
      settleCalls.push({ payload, requirements });
      const s = options.settle ?? {
        success: true,
        transaction: "0x" + "cd".repeat(32),
        network: NETWORK as `${string}:${string}`,
        payer: payload.payload.authorization ? (payload.payload.authorization as { from: string }).from : undefined,
      };
      if (s instanceof Error) throw s;
      return typeof s === "function" ? await s(payload) : s;
    },
    async getSupported(): Promise<SupportedResponse> {
      return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK as `${string}:${string}` }], extensions: [], signers: {} };
    },
  };

  return { client, verifyCalls, settleCalls };
}

/** The canonical requirement `toPaymentRequirements` produces, for unit tests of the wrapper. */
export function requirement(amountMicro: bigint, overrides: Partial<X402Requirement> = {}): X402Requirement {
  return {
    scheme: "exact",
    network: NETWORK,
    amount: amountMicro.toString(),
    asset: USDC_BASE_SEPOLIA,
    payTo: "0x1111111111111111111111111111111111111111",
    maxTimeoutSeconds: 300,
    extra: { name: "USDC", version: "2" },
    ...overrides,
  };
}
