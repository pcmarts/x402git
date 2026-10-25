/**
 * lib/web/wallet-checkout.ts — the browser's half of an x402 purchase.
 *
 * Everything the "Buy with wallet" button does lives here rather than in the React
 * component, for two reasons. The component is a `"use client"` island and cannot be
 * awaited in a unit test; and this is the only code in the product that spends a
 * person's money from a browser, so it has to be provable against a fake wallet and a
 * fake server. `lib/web/wallet-checkout.test.ts` drives every path in this file with a
 * scripted EIP-1193 provider and a scripted `fetch`, and `scripts/e2e-web-checkout.mjs`
 * drives the same functions against a real listing on Base Sepolia.
 *
 * The call order is the one `scripts/e2e-buyer.mjs` proved headlessly, and it is the
 * library's own order — nothing here reimplements x402:
 *
 *   GET /api/r            → 402
 *   getPaymentRequiredResponse(header, body)
 *   createPaymentPayload(required)          ← the wallet signs EIP-3009 here
 *   encodePaymentSignatureHeader(payload)
 *   GET /api/r + PAYMENT-SIGNATURE          → 200 { version, artifact_sha256, download_url }
 *   getPaymentSettleResponse(header)        → the transaction hash
 *
 * Two rules this file keeps:
 *
 * - **Every dependency is injected.** The provider, `fetch` and the base URL are
 *   arguments, never globals reached for inside a function. That is what makes the
 *   Node verification possible without a browser.
 * - **A failure is a value, not an exception.** Every path returns a `CheckoutFailure`
 *   carrying a catalogue code and a sentence naming the recovery, because the button
 *   has to render something useful for all of them — including the ones (`price_changed`,
 *   `settlement_timeout`) where the right answer is "press it again".
 *
 * Nothing here imports React, `next/*`, or anything server-only, and it never reads
 * `window` except through `detectProvider`, which takes its root object as an argument.
 */

import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createWalletClient, custom, defineChain, toHex } from "viem";
import { type Eip1193Provider, NETWORK_TOKEN, TOKEN_TOKEN } from "./checkout-copy";

// --- the wallet ---------------------------------------------------------------

// Detection lives in `checkout-copy.ts` since 25 Oct 2026, so the pay block can name the
// installed wallet on first paint without this module's viem; re-exported so every
// existing `import { detectProvider } from "@/lib/web/wallet-checkout"` still reads.
export { detectProvider, type Eip1193Provider, type ProviderRoot, walletName } from "./checkout-copy";

// --- the chain ------------------------------------------------------------------

export type ChainInfo = {
  id: number;
  /** `eth_chainId` and `wallet_switchEthereumChain` speak hex. */
  hex: `0x${string}`;
  name: string;
  rpcUrls: string[];
  /** Where a transaction hash is readable by a person. */
  explorer: string;
};

/**
 * The chains this product settles on: Base, Base Sepolia, and since 25 Oct 2026 Arbitrum
 * One (USDT0). A chain that is not here can still be paid on — the switch just cannot
 * offer to add it, because inventing an RPC URL for a network we do not run on would be
 * worse than saying so.
 */
export const CHAINS: Record<number, ChainInfo> = {
  8453: { id: 8453, hex: "0x2105", name: "Base", rpcUrls: ["https://mainnet.base.org"], explorer: "https://basescan.org" },
  // Arbitrum One (25 Oct 2026): the USDT0 rail, docs/HACKMERIDIAN-EVM-USDT0-RAIL.md.
  42161: { id: 42161, hex: "0xa4b1", name: "Arbitrum", rpcUrls: ["https://arb1.arbitrum.io/rpc"], explorer: "https://arbiscan.io" },
  84532: {
    id: 84532,
    hex: "0x14a34",
    name: "Base Sepolia",
    rpcUrls: ["https://sepolia.base.org"],
    explorer: "https://sepolia.basescan.org",
  },
};

export function chainInfo(chainId: number): ChainInfo {
  return CHAINS[chainId] ?? { id: chainId, hex: `0x${chainId.toString(16)}`, name: `chain ${chainId}`, rpcUrls: [], explorer: "" };
}

/** `https://sepolia.basescan.org/tx/0x…`, or null on a chain with no explorer we know. */
export function explorerTxUrl(chainId: number, txHash: string): string | null {
  const { explorer } = chainInfo(chainId);
  return explorer ? `${explorer}/tx/${txHash}` : null;
}

/** `https://sepolia.basescan.org/address/0x…`, or null on a chain with no explorer we know. */
export function explorerAddressUrl(chainId: number, address: string): string | null {
  const { explorer } = chainInfo(chainId);
  return explorer ? `${explorer}/address/${address}` : null;
}

// --- outcomes --------------------------------------------------------------------

/**
 * The §9 error catalogue, plus the failures that only exist in a browser: no wallet
 * installed, the person said no, the wallet is on the wrong chain, the network went
 * away, and (25 Oct 2026) the 402 no longer offers the rail the buyer picked on the page.
 */
export type CheckoutErrorCode =
  | "no_wallet"
  | "rejected"
  | "wrong_chain"
  | "rail_unavailable"
  | "insufficient_balance"
  | "price_changed"
  | "settlement_pending"
  | "settlement_timeout"
  | "sanctioned_counterparty"
  | "blocked_jurisdiction"
  | "invalid_signature"
  | "not_found"
  | "retired"
  | "rate_limited"
  | "network"
  | "unknown";

/**
 * What the button says when each of them happens. Every sentence names the problem and
 * the way out, and none of them mentions a status code. Neither the chain nor the token
 * is spelled here: `{network}` and `{token}` are filled in where the message is rendered
 * (`withRail`, lib/web/checkout-copy.ts), from the row the buyer chose.
 */
export const CHECKOUT_MESSAGES: Record<CheckoutErrorCode, string> = {
  no_wallet: "No wallet found in this browser. Install Coinbase Wallet or MetaMask, then reload this page.",
  rejected: "Cancelled in your wallet. Nothing was charged.",
  wrong_chain: `Your wallet is on the wrong network. Switch it to ${NETWORK_TOKEN} and try again.`,
  rail_unavailable: `This listing no longer takes ${TOKEN_TOKEN} on ${NETWORK_TOKEN}. Reload the page to see how to pay.`,
  insufficient_balance: `Not enough ${TOKEN_TOKEN} on ${NETWORK_TOKEN} — top up and try again.`,
  price_changed: "The price changed while you were paying. Press buy again for the current price.",
  settlement_pending: "Your payment was signed but has not confirmed yet. Nothing was charged twice — press buy again to finish it.",
  settlement_timeout: "Settlement did not confirm in time. Press buy again with the same wallet; you cannot be charged twice for it.",
  sanctioned_counterparty: "This address appears on a sanctions list, so no payment can be processed from it.",
  blocked_jurisdiction: "This is not available in your location.",
  invalid_signature: "That wallet signature expired before it reached us. Try again.",
  not_found: "This listing is not for sale.",
  retired: "This listing is no longer sold. If your wallet already owns a version, it is under Your purchases.",
  rate_limited: "Too many attempts in a row. Wait a minute and try again.",
  network: "Could not reach the server. Check your connection and try again.",
  unknown: "Something went wrong and no payment was taken. Try again.",
};

/** A settled purchase: what was bought, where to get it, and the proof it was paid for. */
export type CheckoutSuccess = {
  ok: true;
  version: string;
  artifactSha256: string;
  /** A signed URL over the exact bytes that were scanned. Short-lived — see `expiresAt`. */
  downloadUrl: string;
  expiresAt: string;
  /** Null when nothing settled: a free listing, or a version this wallet already owned. */
  txHash: string | null;
  /** `paid` when money moved, `owned` when the wallet already held it, `free` at $0. */
  kind: "paid" | "owned" | "free";
};

export type CheckoutFailure = {
  ok: false;
  code: CheckoutErrorCode;
  message: string;
  /** True when pressing the same button again is the correct next move. */
  retryable: boolean;
};

export type CheckoutResult = CheckoutSuccess | CheckoutFailure;

/** Codes where the button should say "Try again" rather than "Nothing to do". */
const RETRYABLE: ReadonlySet<CheckoutErrorCode> = new Set<CheckoutErrorCode>([
  "rejected",
  "wrong_chain",
  "insufficient_balance",
  "price_changed",
  "settlement_pending",
  "settlement_timeout",
  "invalid_signature",
  "rate_limited",
  "network",
  "unknown",
]);

export function failure(code: CheckoutErrorCode, message?: string): CheckoutFailure {
  return { ok: false, code, message: message ?? CHECKOUT_MESSAGES[code], retryable: RETRYABLE.has(code) };
}


// --- error mapping ----------------------------------------------------------------

/** EIP-1193's "user rejected request", and the two shapes wallets actually send it in. */
export function isUserRejection(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (code === 4001 || code === "ACTION_REJECTED") return true;
  const message = messageOf(error).toLowerCase();
  return message.includes("user rejected") || message.includes("user denied") || message.includes("request rejected");
}

/**
 * A `{ code, message, docs_url }` error body from `/api/*` → the browser's version of
 * the same failure. The server's own `message` is preferred only for codes whose
 * server-side wording already names a recovery a person can act on; the money codes get
 * this file's wording, because the API's is written for an agent.
 */
export function mapApiError(status: number, body: unknown): CheckoutFailure {
  const code = (body as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code in CHECKOUT_MESSAGES) {
    return failure(code as CheckoutErrorCode);
  }
  if (status === 429) return failure("rate_limited");
  if (status === 404) return failure("not_found");
  if (status === 451) return failure("blocked_jurisdiction");
  const message = (body as { message?: unknown } | null)?.message;
  return failure("unknown", typeof message === "string" && message.length > 0 ? message : undefined);
}

/** Anything thrown anywhere in the flow → a failure the button can render. */
export function mapThrown(error: unknown): CheckoutFailure {
  if (isUserRejection(error)) return failure("rejected");
  const code = (error as { code?: unknown })?.code;
  // EIP-3326: the wallet does not have this chain and refused to add it.
  if (code === 4902) return failure("wrong_chain");
  // A catalogue code carried up from `apiErrorFrom` by one of the helpers that throws.
  if (typeof code === "string" && code in CHECKOUT_MESSAGES) return failure(code as CheckoutErrorCode);
  const message = messageOf(error);
  if (/failed to fetch|networkerror|load failed/i.test(message)) return failure("network");
  return failure("unknown", message.length > 0 && message.length < 200 ? message : undefined);
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  const m = (error as { message?: unknown })?.message;
  return typeof m === "string" ? m : "";
}

// --- connecting ---------------------------------------------------------------------

/** The address the wallet is offering, checksummed by the wallet itself. */
export async function requestAccount(provider: Eip1193Provider): Promise<`0x${string}`> {
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[] | null;
  const address = accounts?.[0];
  if (!address) throw new Error("Your wallet did not share an address.");
  return address as `0x${string}`;
}

/** The address already connected, without prompting. Null when the wallet is locked. */
export async function currentAccount(provider: Eip1193Provider): Promise<`0x${string}` | null> {
  try {
    const accounts = (await provider.request({ method: "eth_accounts" })) as string[] | null;
    return (accounts?.[0] as `0x${string}` | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function currentChainId(provider: Eip1193Provider): Promise<number> {
  const hex = (await provider.request({ method: "eth_chainId" })) as string;
  return Number.parseInt(hex, 16);
}

/**
 * Put the wallet on the chain this deployment settles on.
 *
 * `wallet_switchEthereumChain` answers 4902 when the wallet has never heard of the
 * chain, which is the ordinary case for Base Sepolia in a fresh MetaMask. That is not a
 * failure: it is the prompt to add it, and the add is retried as a switch afterwards
 * because some wallets add without switching.
 */
export async function ensureChain(provider: Eip1193Provider, chainId: number): Promise<void> {
  if ((await currentChainId(provider)) === chainId) return;
  const chain = chainInfo(chainId);

  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chain.hex }] });
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    const unknownChain = code === 4902 || /unrecognized chain|unrecognised chain|not been added/i.test(messageOf(error));
    if (!unknownChain || chain.rpcUrls.length === 0) throw error;

    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: chain.hex,
          chainName: chain.name,
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: chain.rpcUrls,
          blockExplorerUrls: chain.explorer ? [chain.explorer] : [],
        },
      ],
    });
    // Some wallets add without switching; asking twice is cheap and always correct.
    if ((await currentChainId(provider)) !== chainId) {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chain.hex }] });
    }
  }
}

// --- FR-20, the wallet signature -------------------------------------------------------

export type Transport = {
  /** Injected so a test never touches the network and a script can point at any host. */
  fetch: typeof fetch;
  /** No trailing slash. `""` means "same origin", which is what the browser wants. */
  baseUrl: string;
};

/**
 * `<address>.<nonce>.<signature>` over a fresh single-use challenge (FR-20).
 *
 * The message is hex-encoded before `personal_sign` because that is what EIP-191 asks
 * for and what every wallet decodes back to readable text on its confirmation screen;
 * the server verifies the original string, so the two must not drift.
 *
 * One nonce, one request: the server burns it on use *and* on failure, so a caller that
 * needs two signed requests calls this twice.
 */
export async function walletSignature(provider: Eip1193Provider, address: string, transport: Transport): Promise<string> {
  const res = await transport.fetch(`${transport.baseUrl}/api/auth/challenge?address=${address}&purpose=wallet_ownership`, { headers: { accept: "application/json" } });
  if (!res.ok) throw await apiErrorFrom(res);
  const { nonce, message } = (await res.json()) as { nonce: string; message: string };
  const signature = (await provider.request({ method: "personal_sign", params: [toHex(message), address] })) as string;
  return `${address}.${nonce}.${signature}`;
}

// --- what this wallet already owns -------------------------------------------------------

export type Ownership = {
  address: string;
  /** The version this wallet holds, or null. */
  owned: string | null;
  /** The latest published version, whether or not it is owned. */
  latest: string | null;
  /** True when the next fetch costs nothing: lifetime updates, or already on `latest`. */
  entitled: boolean;
  /** What the next fetch would cost *this* wallet, in micro-USDC. */
  priceMicro: bigint;
  /** `new | update | owned | free` — the server's own word for why the price is that. */
  priceKind: string | null;
  status: string;
};

/**
 * `GET /api/v/:owner/:slug` with a wallet signature, which is the only way to learn
 * what an address owns (FR-40: entitlement is never a public oracle, so there is no
 * `?address=` form of this call).
 */
export async function fetchOwnership(
  provider: Eip1193Provider,
  address: string,
  ref: { owner: string; slug: string },
  transport: Transport,
): Promise<Ownership> {
  const signature = await walletSignature(provider, address, transport);
  const res = await transport.fetch(`${transport.baseUrl}/api/v/${ref.owner}/${ref.slug}`, {
    headers: { "x-wallet-signature": signature, accept: "application/json" },
  });
  if (!res.ok) throw await apiErrorFrom(res);
  const body = (await res.json()) as Record<string, unknown>;
  return {
    address,
    owned: (body.owned as string | null) ?? null,
    latest: (body.latest as string | null) ?? null,
    entitled: body.entitled === true,
    priceMicro: BigInt((body.price_micro as string | undefined) ?? "0"),
    priceKind: (body.price_kind as string | null) ?? null,
    status: (body.status as string | undefined) ?? "live",
  };
}

// --- the purchase ---------------------------------------------------------------------------

export type CheckoutInput = {
  provider: Eip1193Provider;
  owner: string;
  slug: string;
  /**
   * The chain of the row the buyer chose: 84532 or 8453 for Base, 42161 for Arbitrum
   * USDT0. The payment is made on `eip155:<chainId>` and nowhere else.
   */
  chainId: number;
  transport: Transport;
  /**
   * Send `X-Wallet-Signature` on the resource fetch. Only worth the extra wallet prompt
   * when the wallet might already own a version, because the header's whole effect is
   * to turn a new-buyer 402 into an update 402 or a free grant.
   */
  proveWallet?: boolean;
};

/**
 * Connect, switch chain, 402, sign, pay, and come back with the download.
 *
 * Every failure is returned rather than thrown, so the caller renders one thing. The
 * only exceptions that escape are programming errors.
 */
export async function buyWithWallet(input: CheckoutInput): Promise<CheckoutResult> {
  const { provider, owner, slug, chainId, transport } = input;
  try {
    const address = await requestAccount(provider);
    await ensureChain(provider, chainId);

    const resourceUrl = `${transport.baseUrl}/api/r/${owner}/${slug}`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (input.proveWallet) headers["x-wallet-signature"] = await walletSignature(provider, address, transport);

    const unpaid = await transport.fetch(resourceUrl, { headers });

    // FR-24, and the already-entitled holder: no money, straight to the bytes.
    if (unpaid.ok) {
      const grant = (await unpaid.json()) as GrantBody;
      return grantResult(grant, null, input.proveWallet ? "owned" : "free");
    }
    if (unpaid.status !== 402) return mapApiError(unpaid.status, await safeJson(unpaid));

    const body402 = (await unpaid.json()) as Record<string, unknown>;
    const network = `eip155:${chainId}`;
    const httpClient = clientFor(provider, address, chainId);
    const required = httpClient.getPaymentRequiredResponse((name) => unpaid.headers.get(name), body402);

    // The rail the buyer chose, and only it (25 Oct 2026). A creator paid on Base and
    // Arbitrum gets a 402 with an accept per chain, and the x402 client takes the first
    // one it has a scheme for — so without this a buyer who picked USDT0 on Arbitrum
    // would be asked to sign for USDC on Base. The client is also registered for this
    // one network (`clientFor`), so the filter and the scheme agree.
    const accepts = required.accepts.filter((a) => a.network === network && a.scheme === "exact");
    if (accepts.length === 0) return failure("rail_unavailable");

    // The wallet signs the EIP-3009 authorization here, and only here.
    const payload = await httpClient.createPaymentPayload({ ...required, accepts });
    const quoteId = (body402.extra as { quote_id?: string } | undefined)?.quote_id ?? "";

    const paid = await transport.fetch(resourceUrl, {
      headers: { ...headers, ...httpClient.encodePaymentSignatureHeader(payload), "x-quote-id": quoteId },
    });
    if (!paid.ok) return mapApiError(paid.status, await safeJson(paid));

    const grant = (await paid.json()) as GrantBody;
    // FR-22: the hash is the receipt. Its absence here would mean the server granted
    // without settling, which it does not do — but the panel says so rather than
    // pretending, because a purchase with no hash is a purchase nobody can audit.
    const settlement = safeSettlement(httpClient, paid);
    return grantResult(grant, settlement, "paid");
  } catch (error) {
    return mapThrown(error);
  }
}

/**
 * A $0 listing (FR-24). It still proves the wallet, because a free grant is a purchase
 * row and a purchase row belongs to an address, not to a browser.
 */
export async function claimFree(input: Omit<CheckoutInput, "proveWallet">): Promise<CheckoutResult> {
  return await buyWithWallet({ ...input, proveWallet: true });
}

/**
 * `GET /api/r/:owner/:slug/v/:version` — FR-19. A version this wallet already owns,
 * fetched again, for as long as the wallet exists and whether or not the listing is
 * still sold.
 */
export async function refetchOwnedVersion(
  provider: Eip1193Provider,
  address: string,
  ref: { owner: string; slug: string; version: string },
  transport: Transport,
): Promise<CheckoutResult> {
  try {
    const signature = await walletSignature(provider, address, transport);
    const res = await transport.fetch(`${transport.baseUrl}/api/r/${ref.owner}/${ref.slug}/v/${ref.version}`, {
      headers: { "x-wallet-signature": signature, accept: "application/json" },
    });
    if (!res.ok) return mapApiError(res.status, await safeJson(res));
    return grantResult((await res.json()) as GrantBody, null, "owned");
  } catch (error) {
    return mapThrown(error);
  }
}

// --- everything this wallet owns ------------------------------------------------------------

export type Entitlement = {
  owner: string;
  slug: string;
  version: string;
  /** Micro-USDC actually paid, which is not necessarily the listing's price today. */
  grossMicro: bigint;
  kind: string;
  grantedAt: string;
  txHash: string | null;
  allVersions: boolean;
  receiptUrl: string | null;
  latestVersion: string | null;
  /** A newer release than this row owns, priced for this wallet. `0n` = included. */
  update: { version: string; priceMicro: bigint } | null;
  /**
   * The rail it settled on (CAIP-2) and the token contract paid, when the API says
   * (25 Oct 2026): `/purchases` puts a "USDT0 on Arbitrum" chip on the row. Null from a
   * server that predates the fields, and the row then shows the amount alone.
   */
  network: string | null;
  asset: string | null;
};

/**
 * `GET /api/entitlements` — FR-32, the wallet's own receipts. One page of 100.
 *
 * `onSigning` fires once the challenge is in hand and the wallet is about to show its
 * signature sheet, and `onSigned` once it has returned one — so a page can say what the
 * sheet is for while it is on screen, and say something else while the list loads.
 */
export async function fetchEntitlements(
  provider: Eip1193Provider,
  address: string,
  transport: Transport,
  hooks: { onSigning?: () => void; onSigned?: () => void } = {},
): Promise<Entitlement[]> {
  hooks.onSigning?.();
  const signature = await walletSignature(provider, address, transport);
  hooks.onSigned?.();
  const res = await transport.fetch(`${transport.baseUrl}/api/entitlements`, {
    headers: { "x-wallet-signature": signature, accept: "application/json" },
  });
  if (!res.ok) throw await apiErrorFrom(res);
  const body = (await res.json()) as { entitlements?: Record<string, unknown>[] };
  return (body.entitlements ?? []).map((e) => ({
    owner: String(e.owner),
    slug: String(e.slug),
    version: String(e.version),
    grossMicro: BigInt((e.gross_micro as string | undefined) ?? "0"),
    kind: String(e.kind ?? "new"),
    grantedAt: String(e.granted_at ?? ""),
    txHash: (e.tx_hash as string | null) ?? null,
    allVersions: e.all_versions === true,
    receiptUrl: typeof e.receipt_url === "string" ? e.receipt_url : null,
    latestVersion: typeof e.latest_version === "string" ? e.latest_version : null,
    update: isUpdate(e.update) ? { version: e.update.version, priceMicro: BigInt(e.update.price_micro) } : null,
    network: typeof e.network === "string" && e.network.length > 0 ? e.network : null,
    asset: typeof e.asset === "string" && e.asset.length > 0 ? e.asset : null,
  }));
}

function isUpdate(value: unknown): value is { version: string; price_micro: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { version?: unknown }).version === "string" &&
    typeof (value as { price_micro?: unknown }).price_micro === "string"
  );
}

// --- plumbing ---------------------------------------------------------------------------------

type GrantBody = { version: string; artifact_sha256: string; download_url: string; expires_at: string };

function grantResult(grant: GrantBody, txHash: string | null, kind: CheckoutSuccess["kind"]): CheckoutSuccess {
  return {
    ok: true,
    version: grant.version,
    artifactSha256: grant.artifact_sha256,
    downloadUrl: grant.download_url,
    expiresAt: grant.expires_at,
    txHash,
    kind,
  };
}

/**
 * The x402 client, built around a viem `WalletClient` over the injected provider.
 *
 * `ExactEvmScheme` needs exactly two things from a signer — an address, and a
 * `signTypedData` that returns a hex signature — so the adapter is three lines rather
 * than a wallet abstraction. viem does the EIP-712 encoding, which is the part that
 * must not be hand-rolled.
 *
 * `spendControls: false` because the price is the server's: this client is paying a
 * quote a person just read on the page, not policing a budget.
 *
 * Registered for `eip155:<chainId>` alone (25 Oct 2026), so even an unfiltered 402 could
 * not make it sign on a chain the buyer did not pick.
 */
function clientFor(provider: Eip1193Provider, address: `0x${string}`, chainId: number): x402HTTPClient {
  const info = chainInfo(chainId);
  const chain = defineChain({
    id: chainId,
    name: info.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: info.rpcUrls } },
  });
  const wallet = createWalletClient({ account: address, chain, transport: custom(provider) });

  const signer = {
    address,
    signTypedData: (message: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }) =>
      wallet.signTypedData(message as unknown as Parameters<typeof wallet.signTypedData>[0]),
  };

  return new x402HTTPClient(
    x402Client.fromConfig({
      // This chain only, not `eip155:*`: the buyer chose one rail on the page.
      schemes: [{ network: `eip155:${chainId}`, client: new ExactEvmScheme(signer) }],
      spendControls: false,
    }),
  );
}

/** The settlement hash, if the header carried one. Never fatal: the grant already happened. */
function safeSettlement(httpClient: x402HTTPClient, res: Response): string | null {
  try {
    const settlement = httpClient.getPaymentSettleResponse((name) => res.headers.get(name));
    return settlement?.transaction ?? null;
  } catch {
    return null;
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** A non-OK response from a helper that returns a value rather than a result. */
async function apiErrorFrom(res: Response): Promise<Error> {
  const body = (await safeJson(res)) as { code?: string; message?: string } | null;
  const error = new Error(body?.message ?? `Request failed (${res.status}).`);
  (error as { code?: string }).code = body?.code;
  return error;
}
