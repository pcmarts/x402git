/**
 * lib/web/wallet-checkout.test.ts — the browser checkout, without a browser.
 *
 * The provider is a real EIP-1193 surface backed by a `privateKeyToAccount`, so
 * `eth_signTypedData_v4` returns a signature `@x402/evm` actually produced and the
 * payment payload under test is the one a wallet would have built. `fetch` is scripted,
 * so the 402 body, the settlement header and every error code are exactly the ones
 * `/api/r` returns.
 *
 * What is worth pinning here, in order of how much it would cost to get wrong:
 *
 *   1. the 402 → sign → 200 sequence, including that the `PAYMENT-SIGNATURE` header and
 *      the echoed `x-quote-id` both reach the server (FR-21, FR-23);
 *   2. the chain switch, including the 4902 add-then-switch that a fresh MetaMask needs;
 *   3. the error mapping, because every one of those codes is a sentence a person reads
 *      at the moment they were expecting to have bought something.
 */

import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  buyWithWallet,
  CHAINS,
  CHECKOUT_MESSAGES,
  detectProvider,
  type Eip1193Provider,
  ensureChain,
  explorerAddressUrl,
  explorerTxUrl,
  fetchEntitlements,
  fetchOwnership,
  isUserRejection,
  mapApiError,
  mapThrown,
  walletSignature,
} from "./wallet-checkout";

// A funded-looking throwaway; it never touches a network in this file.
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const account = privateKeyToAccount(KEY);

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
/** Arbitrum One USDT0, the 25 Oct 2026 rail (lib/env.ts KNOWN_EVM_RAILS). */
const USDT0_ARBITRUM = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const BASE = "https://x402git.test";

// --- a wallet ---------------------------------------------------------------------

type ProviderScript = {
  chainId?: number;
  /** Methods that should reject, and the error to reject with. */
  reject?: Record<string, unknown>;
  /** Whether `wallet_switchEthereumChain` fails with 4902 the first time. */
  unknownChain?: boolean;
};

type FakeProvider = Eip1193Provider & { calls: { method: string; params?: unknown }[]; chainId: number };

/**
 * An EIP-1193 provider that signs for real. `eth_signTypedData_v4` is the one method
 * that matters: `@x402/evm` builds the EIP-3009 `TransferWithAuthorization` struct and
 * hands it here, and the resulting signature is what the facilitator would verify.
 */
function fakeProvider(script: ProviderScript = {}): FakeProvider {
  const calls: { method: string; params?: unknown }[] = [];
  let chainId = script.chainId ?? 84532;
  let switched = false;

  const provider = {
    calls,
    get chainId() {
      return chainId;
    },
    async request({ method, params }: { method: string; params?: readonly unknown[] | object }) {
      calls.push({ method, params });
      if (script.reject && method in script.reject) throw script.reject[method];

      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [account.address];
        case "eth_chainId":
          return `0x${chainId.toString(16)}`;
        case "wallet_switchEthereumChain": {
          if (script.unknownChain && !switched) {
            switched = true;
            throw Object.assign(new Error("Unrecognized chain ID."), { code: 4902 });
          }
          chainId = Number.parseInt((params as { chainId: string }[])[0].chainId, 16);
          return null;
        }
        case "wallet_addEthereumChain":
          return null;
        case "personal_sign": {
          const [message] = params as [string, string];
          return await account.signMessage({ message: { raw: message as `0x${string}` } });
        }
        case "eth_signTypedData_v4": {
          const [, typed] = params as [string, string];
          const parsed = JSON.parse(typed) as Parameters<typeof account.signTypedData>[0];
          return await account.signTypedData(parsed);
        }
        default:
          throw new Error(`unexpected wallet method ${method}`);
      }
    },
  };
  return provider as unknown as FakeProvider;
}

// --- a server ----------------------------------------------------------------------

type Route = { status: number; body?: unknown; headers?: Record<string, string> };

/** A `fetch` that answers from a table keyed by "METHOD /path", and records every call. */
function fakeFetch(routes: Record<string, Route | Route[]>) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const cursors: Record<string, number> = {};

  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const path = url.slice(BASE.length).split("?")[0];
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    seen.push({ url, headers });

    const entry = routes[path];
    if (!entry) throw new Error(`no fake route for ${path}`);
    const route = Array.isArray(entry) ? entry[Math.min(cursors[path] ?? 0, entry.length - 1)] : entry;
    if (Array.isArray(entry)) cursors[path] = (cursors[path] ?? 0) + 1;

    return new Response(route.body === undefined ? null : JSON.stringify(route.body), {
      status: route.status,
      headers: { "content-type": "application/json", ...route.headers },
    });
  }) as unknown as typeof fetch;

  return { fetch: impl, seen };
}

const challengeRoute: Route = {
  status: 200,
  body: { nonce: "n-1", message: "x402git challenge\naddress: x\nnonce: n-1", expires_at: "2026-08-30T12:00:00.000Z" },
};

/**
 * The 402 exactly as `toPaymentRequirements` builds it, in both places §13 puts it: the
 * JSON body and the `PAYMENT-REQUIRED` header. The header is the one a v2 client reads,
 * so a fixture that only had the body would test a code path no server produces.
 */
type AcceptRail = { network: string; asset: string; extra: { name: string; version: string } };

/** Base Sepolia USDC, the one accept every 402 had before 25 Oct 2026. */
const BASE_SEPOLIA_ACCEPT: AcceptRail = { network: "eip155:84532", asset: USDC, extra: { name: "USDC", version: "2" } };
/** Arbitrum USDT0, whose EIP-712 domain name carries the ₮ (docs/HACKMERIDIAN-EVM-USDT0-RAIL.md §1). */
const ARBITRUM_ACCEPT: AcceptRail = { network: "eip155:42161", asset: USDT0_ARBITRUM, extra: { name: "USD₮0", version: "1" } };

function paymentRequired(overrides: { amount?: string; quoteId?: string; kind?: string; rails?: AcceptRail[] } = {}): Route {
  const amount = overrides.amount ?? "9000000";
  const resource = `${BASE}/api/r/examples/humanizer`;
  const description = "examples/humanizer v1.0.0 — release. Signed download, 5-minute URL.";
  const accepts = (overrides.rails ?? [BASE_SEPOLIA_ACCEPT]).map((rail) => ({
    scheme: "exact",
    network: rail.network,
    amount,
    asset: rail.asset,
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: rail.extra,
    maxAmountRequired: amount,
    resource,
    description,
    mimeType: "application/zip",
  }));
  const body = {
    x402Version: 2 as const,
    resource: { url: resource, description, mimeType: "application/zip" },
    accepts,
    extra: {
      kind: overrides.kind ?? "new",
      version: "1.0.0",
      manifest_url: `${BASE}/api/label/examples/humanizer`,
      update_price_micro: "5000000",
      quote_id: overrides.quoteId ?? "q_abc",
      valid_before: "2026-08-30T12:05:00.000Z",
    },
  };
  return {
    status: 402,
    body,
    headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(body as Parameters<typeof encodePaymentRequiredHeader>[0]) },
  };
}

const GRANT = {
  version: "1.0.0",
  artifact_sha256: "b".repeat(64),
  download_url: "https://storage.test/humanizer-1.0.0.zip?sig=x",
  expires_at: "2026-08-30T12:05:00.000Z",
};

/** A `PAYMENT-RESPONSE` header the way the resource server encodes one. */
function settlementHeader(transaction: string): Record<string, string> {
  const payload = { success: true, transaction, network: "eip155:84532", payer: account.address };
  return { "PAYMENT-RESPONSE": Buffer.from(JSON.stringify(payload), "utf8").toString("base64") };
}

const ref = { owner: "examples", slug: "humanizer" };

// --- detection --------------------------------------------------------------------------

describe("detectProvider", () => {
  it("finds nothing when no wallet is injected", () => {
    expect(detectProvider(undefined)).toBeNull();
    expect(detectProvider({})).toBeNull();
  });

  it("returns the single injected provider", () => {
    const ethereum = { request: async () => null, isMetaMask: true } as Eip1193Provider;
    expect(detectProvider({ ethereum })).toBe(ethereum);
  });

  it("prefers Coinbase Wallet when several extensions collide on window.ethereum", () => {
    const metamask = { request: async () => null, isMetaMask: true } as Eip1193Provider;
    const coinbase = { request: async () => null, isCoinbaseWallet: true } as Eip1193Provider;
    const ethereum = { request: async () => null, providers: [metamask, coinbase] } as Eip1193Provider;
    expect(detectProvider({ ethereum })).toBe(coinbase);
  });
});

// --- the chain --------------------------------------------------------------------------

describe("ensureChain", () => {
  it("does nothing when the wallet is already on the right chain", async () => {
    const provider = fakeProvider({ chainId: 84532 });
    await ensureChain(provider, 84532);
    expect(provider.calls.map((c) => c.method)).toEqual(["eth_chainId"]);
  });

  it("switches a wallet that is on the wrong chain", async () => {
    const provider = fakeProvider({ chainId: 1 });
    await ensureChain(provider, 84532);
    expect(provider.calls.map((c) => c.method)).toContain("wallet_switchEthereumChain");
    expect(provider.chainId).toBe(84532);
  });

  it("adds the chain, then switches, when the wallet has never heard of it (4902)", async () => {
    const provider = fakeProvider({ chainId: 1, unknownChain: true });
    await ensureChain(provider, 84532);
    const methods = provider.calls.map((c) => c.method);
    expect(methods).toContain("wallet_addEthereumChain");
    expect(methods.filter((m) => m === "wallet_switchEthereumChain")).toHaveLength(2);
    expect(provider.chainId).toBe(84532);
  });

  it("knows Base, Base Sepolia and Arbitrum by their hex ids", () => {
    expect(CHAINS[84532].hex).toBe("0x14a34");
    expect(CHAINS[8453].hex).toBe("0x2105");
    expect(CHAINS[42161].hex).toBe("0xa4b1");
    expect(explorerTxUrl(42161, "0xdead")).toBe("https://arbiscan.io/tx/0xdead");
    expect(explorerTxUrl(84532, "0xdead")).toBe("https://sepolia.basescan.org/tx/0xdead");
    expect(explorerAddressUrl(8453, "0xbeef")).toBe("https://basescan.org/address/0xbeef");
    expect(explorerAddressUrl(1, "0xbeef")).toBeNull();
  });
});

// --- the money path ------------------------------------------------------------------------

describe("buyWithWallet", () => {
  it("goes 402 → sign → 200 and returns the download and the transaction hash", async () => {
    const provider = fakeProvider();
    const { fetch: f, seen } = fakeFetch({
      "/api/r/examples/humanizer": [
        paymentRequired(),
        { status: 200, body: GRANT, headers: settlementHeader("0xabc123") },
      ],
    });

    const result = await buyWithWallet({ provider, ...ref, chainId: 84532, transport: { fetch: f, baseUrl: BASE } });

    expect(result).toMatchObject({ ok: true, version: "1.0.0", txHash: "0xabc123", kind: "paid" });
    if (!result.ok) throw new Error("unreachable");
    expect(result.downloadUrl).toBe(GRANT.download_url);
    expect(result.artifactSha256).toBe(GRANT.artifact_sha256);

    // The wallet was asked to sign the authorization, and only the authorization.
    expect(provider.calls.filter((c) => c.method === "eth_signTypedData_v4")).toHaveLength(1);
    expect(provider.calls.some((c) => c.method === "personal_sign")).toBe(false);

    // FR-21 and FR-23 both travel on the paid request.
    const paid = seen[1];
    expect(paid.headers["payment-signature"]).toBeTruthy();
    expect(paid.headers["x-quote-id"]).toBe("q_abc");
  });

  it("proves the wallet first when it might already own a version", async () => {
    const provider = fakeProvider();
    const { fetch: f, seen } = fakeFetch({
      "/api/auth/challenge": challengeRoute,
      "/api/r/examples/humanizer": { status: 200, body: GRANT },
    });

    const result = await buyWithWallet({ provider, ...ref, chainId: 84532, proveWallet: true, transport: { fetch: f, baseUrl: BASE } });

    expect(result).toMatchObject({ ok: true, kind: "owned", txHash: null });
    expect(seen[1].headers["x-wallet-signature"]).toMatch(/^0x[0-9a-fA-F]{40}\.n-1\.0x/);
    expect(provider.calls.some((c) => c.method === "eth_signTypedData_v4")).toBe(false);
  });

  it("serves a free listing without settling anything", async () => {
    const provider = fakeProvider();
    const { fetch: f } = fakeFetch({ "/api/r/examples/humanizer": { status: 200, body: GRANT } });
    const result = await buyWithWallet({ provider, ...ref, chainId: 84532, transport: { fetch: f, baseUrl: BASE } });
    expect(result).toMatchObject({ ok: true, kind: "free", txHash: null });
  });

  it("switches the wallet to the settlement chain before it asks for a signature", async () => {
    const provider = fakeProvider({ chainId: 1 });
    const { fetch: f } = fakeFetch({
      "/api/r/examples/humanizer": [
        paymentRequired(),
        { status: 200, body: GRANT, headers: settlementHeader("0xfeed") },
      ],
    });
    await buyWithWallet({ provider, ...ref, chainId: 84532, transport: { fetch: f, baseUrl: BASE } });

    const methods = provider.calls.map((c) => c.method);
    expect(methods.indexOf("wallet_switchEthereumChain")).toBeLessThan(methods.indexOf("eth_signTypedData_v4"));
  });

  /**
   * 25 Oct 2026 (EVM USDT0): a creator paid on Base and Arbitrum gets a 402 with an accept
   * per chain, Base first. The x402 client takes the first entry it has a scheme for, so a
   * buyer who chose "USDT0 on Arbitrum" on the page would have signed for USDC on Base.
   */
  it("pays the Arbitrum accept, not accepts[0], when the buyer chose Arbitrum", async () => {
    const provider = fakeProvider({ chainId: 42161 });
    const { fetch: f, seen } = fakeFetch({
      "/api/r/examples/humanizer": [
        paymentRequired({ rails: [BASE_SEPOLIA_ACCEPT, ARBITRUM_ACCEPT] }),
        { status: 200, body: GRANT, headers: settlementHeader("0xa4b1") },
      ],
    });

    const result = await buyWithWallet({ provider, ...ref, chainId: 42161, transport: { fetch: f, baseUrl: BASE } });
    expect(result).toMatchObject({ ok: true, txHash: "0xa4b1", kind: "paid" });

    const payload = decodePaymentSignatureHeader(seen[1].headers["payment-signature"]);
    expect(payload.accepted.network).toBe("eip155:42161");
    expect(payload.accepted.asset).toBe(USDT0_ARBITRUM);
    expect(payload.accepted.extra).toMatchObject({ name: "USD₮0", version: "1" });
    // The wallet signed one EIP-712 struct, for Arbitrum's chain id and USDT0's domain.
    const signed = provider.calls.filter((c) => c.method === "eth_signTypedData_v4");
    expect(signed).toHaveLength(1);
    const typed = JSON.parse((signed[0].params as [string, string])[1]) as { domain: { chainId: number; name: string; verifyingContract: string } };
    expect(typed.domain).toMatchObject({ chainId: 42161, name: "USD₮0" });
    expect(typed.domain.verifyingContract.toLowerCase()).toBe(USDT0_ARBITRUM.toLowerCase());
  });

  it("still pays Base when the buyer chose Base and the 402 also offers Arbitrum", async () => {
    const provider = fakeProvider();
    const { fetch: f, seen } = fakeFetch({
      "/api/r/examples/humanizer": [
        paymentRequired({ rails: [ARBITRUM_ACCEPT, BASE_SEPOLIA_ACCEPT] }),
        { status: 200, body: GRANT, headers: settlementHeader("0xba5e") },
      ],
    });

    const result = await buyWithWallet({ provider, ...ref, chainId: 84532, transport: { fetch: f, baseUrl: BASE } });
    expect(result).toMatchObject({ ok: true, kind: "paid" });
    expect(decodePaymentSignatureHeader(seen[1].headers["payment-signature"]).accepted.network).toBe("eip155:84532");
  });

  it("signs nothing when the 402 no longer offers the chosen chain, and says to reload", async () => {
    const provider = fakeProvider({ chainId: 42161 });
    const { fetch: f, seen } = fakeFetch({ "/api/r/examples/humanizer": paymentRequired() });

    const result = await buyWithWallet({ provider, ...ref, chainId: 42161, transport: { fetch: f, baseUrl: BASE } });
    expect(result).toEqual({ ok: false, code: "rail_unavailable", message: CHECKOUT_MESSAGES.rail_unavailable, retryable: false });
    expect(provider.calls.some((c) => c.method === "eth_signTypedData_v4")).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it("reads insufficient_balance off the paid request and says how to fix it", async () => {
    const provider = fakeProvider();
    const { fetch: f } = fakeFetch({
      "/api/r/examples/humanizer": [
        paymentRequired(),
        { status: 402, body: { code: "insufficient_balance", message: "The payer does not hold enough USDC." } },
      ],
    });

    const result = await buyWithWallet({ provider, ...ref, chainId: 84532, transport: { fetch: f, baseUrl: BASE } });
    expect(result).toEqual({
      ok: false,
      code: "insufficient_balance",
      // The chain is a placeholder here and is filled in where the message is rendered
      // (lib/web/checkout-copy.ts) — these mappers are pure and know no chain.
      message: CHECKOUT_MESSAGES.insufficient_balance,
      retryable: true,
    });
  });

  it("treats price_changed as a re-quote a person can retry", async () => {
    const provider = fakeProvider();
    const { fetch: f } = fakeFetch({
      "/api/r/examples/humanizer": [
        paymentRequired(),
        { status: 409, body: { code: "price_changed" } },
      ],
    });
    const result = await buyWithWallet({ provider, ...ref, chainId: 84532, transport: { fetch: f, baseUrl: BASE } });
    expect(result).toMatchObject({ ok: false, code: "price_changed", retryable: true });
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("Press buy again");
  });

  it("explains a settlement that did not confirm, and offers the retry", async () => {
    const provider = fakeProvider();
    const { fetch: f } = fakeFetch({
      "/api/r/examples/humanizer": [
        paymentRequired(),
        { status: 504, body: { code: "settlement_timeout" } },
      ],
    });
    const result = await buyWithWallet({ provider, ...ref, chainId: 84532, transport: { fetch: f, baseUrl: BASE } });
    expect(result).toMatchObject({ ok: false, code: "settlement_timeout", retryable: true });
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("cannot be charged twice");
  });

  it("stops on a sanctioned counterparty and does not offer a retry", async () => {
    const provider = fakeProvider();
    const { fetch: f } = fakeFetch({
      "/api/r/examples/humanizer": [
        paymentRequired(),
        { status: 403, body: { code: "sanctioned_counterparty" } },
      ],
    });
    const result = await buyWithWallet({ provider, ...ref, chainId: 84532, transport: { fetch: f, baseUrl: BASE } });
    expect(result).toMatchObject({ ok: false, code: "sanctioned_counterparty", retryable: false });
  });

  it("reports a cancelled signature as a cancellation, not an error", async () => {
    const provider = fakeProvider({ reject: { eth_signTypedData_v4: Object.assign(new Error("User rejected the request."), { code: 4001 }) } });
    const { fetch: f } = fakeFetch({
      "/api/r/examples/humanizer": [
        paymentRequired(),
        { status: 200, body: GRANT },
      ],
    });
    const result = await buyWithWallet({ provider, ...ref, chainId: 84532, transport: { fetch: f, baseUrl: BASE } });
    expect(result).toMatchObject({ ok: false, code: "rejected" });
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("Nothing was charged");
  });

  it("reports a refused chain switch as the wrong chain", async () => {
    const provider = fakeProvider({ chainId: 1, reject: { wallet_switchEthereumChain: Object.assign(new Error("no"), { code: 4902 }) } });
    const { fetch: f } = fakeFetch({ "/api/r/examples/humanizer": { status: 200, body: GRANT } });
    const result = await buyWithWallet({ provider, ...ref, chainId: 999999, transport: { fetch: f, baseUrl: BASE } });
    expect(result).toMatchObject({ ok: false, code: "wrong_chain" });
  });

  it("reports an unreachable server as a network failure", async () => {
    const provider = fakeProvider();
    const f = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const result = await buyWithWallet({ provider, ...ref, chainId: 84532, transport: { fetch: f, baseUrl: BASE } });
    expect(result).toMatchObject({ ok: false, code: "network", retryable: true });
  });
});

// --- what a wallet already owns ----------------------------------------------------------------

describe("fetchOwnership", () => {
  it("signs a challenge and reports the owned version and the update price", async () => {
    const provider = fakeProvider();
    const { fetch: f, seen } = fakeFetch({
      "/api/auth/challenge": challengeRoute,
      "/api/v/examples/humanizer": {
        status: 200,
        body: { owner: "examples", slug: "humanizer", latest: "1.1.0", owned: "1.0.0", entitled: false, price_micro: "5000000", price_kind: "update", status: "live" },
      },
    });

    const state = await fetchOwnership(provider, account.address, ref, { fetch: f, baseUrl: BASE });
    expect(state).toMatchObject({ owned: "1.0.0", latest: "1.1.0", entitled: false, priceKind: "update" });
    expect(state.priceMicro).toBe(5_000_000n);
    expect(seen[1].headers["x-wallet-signature"]).toContain(".n-1.");
  });
});

describe("fetchEntitlements", () => {
  it("returns the wallet's own receipts with money as bigint", async () => {
    const provider = fakeProvider();
    const { fetch: f } = fakeFetch({
      "/api/auth/challenge": challengeRoute,
      "/api/entitlements": {
        status: 200,
        body: {
          address: account.address,
          entitlements: [
            { owner: "examples", slug: "humanizer", version: "1.0.0", gross_micro: "9000000", kind: "new", granted_at: "2026-08-30T09:00:00.000Z", tx_hash: "0xabc", all_versions: false },
          ],
        },
      },
    });

    const [one] = await fetchEntitlements(provider, account.address, { fetch: f, baseUrl: BASE });
    expect(one).toEqual({
      owner: "examples",
      slug: "humanizer",
      version: "1.0.0",
      grossMicro: 9_000_000n,
      kind: "new",
      grantedAt: "2026-08-30T09:00:00.000Z",
      txHash: "0xabc",
      allVersions: false,
      receiptUrl: null,
      latestVersion: null,
      update: null,
      network: null,
      asset: null,
    });
  });

  it("carries the rail each purchase settled on, when the server sends it (25 Oct 2026)", async () => {
    const provider = fakeProvider();
    const { fetch: f } = fakeFetch({
      "/api/auth/challenge": challengeRoute,
      "/api/entitlements": {
        status: 200,
        body: {
          address: account.address,
          entitlements: [
            {
              owner: "examples",
              slug: "humanizer",
              version: "1.0.0",
              gross_micro: "9000000",
              kind: "new",
              granted_at: "2026-10-25T19:00:00.000Z",
              tx_hash: "0xabc",
              all_versions: false,
              network: "eip155:42161",
              asset: USDT0_ARBITRUM,
            },
          ],
        },
      },
    });

    const [one] = await fetchEntitlements(provider, account.address, { fetch: f, baseUrl: BASE });
    expect(one.network).toBe("eip155:42161");
    expect(one.asset).toBe(USDT0_ARBITRUM);
  });

  it("carries the receipt link and a newer release, priced as bigint", async () => {
    const provider = fakeProvider();
    const { fetch: f } = fakeFetch({
      "/api/auth/challenge": challengeRoute,
      "/api/entitlements": {
        status: 200,
        body: {
          address: account.address,
          entitlements: [
            {
              owner: "examples",
              slug: "humanizer",
              version: "1.2.0",
              gross_micro: "9000000",
              kind: "new",
              granted_at: "2026-08-30T09:00:00.000Z",
              tx_hash: "0xabc",
              all_versions: false,
              receipt_url: "https://x402git.test/receipts/abc?t=tok",
              latest_version: "1.4.0",
              update: { version: "1.4.0", price_micro: "3000000" },
            },
          ],
        },
      },
    });

    const [one] = await fetchEntitlements(provider, account.address, { fetch: f, baseUrl: BASE });
    expect(one.receiptUrl).toBe("https://x402git.test/receipts/abc?t=tok");
    expect(one.latestVersion).toBe("1.4.0");
    expect(one.update).toEqual({ version: "1.4.0", priceMicro: 3_000_000n });
  });
});

// --- the mapping itself -------------------------------------------------------------------------

describe("error mapping", () => {
  it("recognises every shape a wallet says no in", () => {
    expect(isUserRejection({ code: 4001 })).toBe(true);
    expect(isUserRejection({ code: "ACTION_REJECTED" })).toBe(true);
    expect(isUserRejection(new Error("MetaMask Tx Signature: User denied transaction signature."))).toBe(true);
    expect(isUserRejection(new Error("nonce too low"))).toBe(false);
  });

  it("maps a status with no catalogue code onto something a person can act on", () => {
    expect(mapApiError(429, null).code).toBe("rate_limited");
    expect(mapApiError(451, null).code).toBe("blocked_jurisdiction");
    expect(mapApiError(404, null).code).toBe("not_found");
    expect(mapApiError(500, { message: "boom" })).toMatchObject({ code: "unknown", message: "boom" });
  });

  it("carries a catalogue code up from a helper that throws", () => {
    expect(mapThrown(Object.assign(new Error("expired"), { code: "invalid_signature" })).code).toBe("invalid_signature");
  });
});

// --- the signature itself --------------------------------------------------------------------------

describe("walletSignature", () => {
  it("builds <address>.<nonce>.<signature> over the exact bytes the server issued", async () => {
    const provider = fakeProvider();
    const { fetch: f } = fakeFetch({ "/api/auth/challenge": challengeRoute });
    const header = await walletSignature(provider, account.address, { fetch: f, baseUrl: BASE });

    const [address, nonce, signature] = header.split(".");
    expect(address).toBe(account.address);
    expect(nonce).toBe("n-1");
    expect(signature).toMatch(/^0x[0-9a-f]+$/i);

    // The wallet was handed the message hex-encoded, per EIP-191.
    const call = provider.calls.find((c) => c.method === "personal_sign");
    expect((call?.params as string[])[0]).toMatch(/^0x/);
  });
});
