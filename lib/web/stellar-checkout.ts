/**
 * lib/web/stellar-checkout.ts — the browser's Stellar purchase, through Freighter.
 *
 * 25 Oct 2026, HackMeridian (founder: "we need a non-agent way for users to pay, a visual
 * 'pay with wallet' option"). This is the same x402 exchange the CLI (`x402git-stellar`)
 * and the Base button run, with Freighter as the signer:
 *
 *   GET the resource → 402 with `accepts` → the Stellar `exact` entry → `ExactStellarScheme`
 *   simulates the token contract's `transfer` and asks Freighter to sign the one Soroban
 *   auth entry (SEP-43 `signAuthEntry`) → the same GET again with PAYMENT-SIGNATURE and
 *   X-Quote-Id → the grant, and the settlement hash from PAYMENT-RESPONSE.
 *
 * Before anything is signed, Horizon is read once: no account, no trustline, a trustline
 * the issuer has not authorised, or a short balance each end in a sentence that says what
 * to do — not a simulation error from inside the SDK. Fees are the facilitator's
 * (`areFeesSponsored`), so the account needs the token and nothing else.
 *
 * Shapes are shared with the EVM checkout (`CheckoutResult`, `failure`, `mapApiError`) so
 * the two buttons render the same panels. `@stellar/freighter-api`, `@x402/stellar` and the
 * SDK behind it are imported on the first press and never run on the server.
 */

import { decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { type CheckoutResult, type CheckoutSuccess, failure, isUserRejection, mapApiError, type Transport } from "@/lib/web/wallet-checkout";

export type Freighter = typeof import("@stellar/freighter-api");

/** What the page hands the button: the one Stellar network this deployment pays on, and its token. */
export type StellarCheckoutConfig = {
  /** `stellar:testnet` or `stellar:pubnet`. */
  network: string;
  passphrase: string;
  rpcUrl: string;
  horizonUrl: string;
  asset: { code: string; issuer: string; contract: string; symbol: string };
};

export const FREIGHTER_URL = "https://www.freighter.app/";

type FreighterError = { message?: string; code?: number } | undefined;

function freighterMessage(error: FreighterError, fallback: string): string {
  return error && typeof error.message === "string" && error.message.length > 0 ? error.message : fallback;
}

/** The words a person sees in Freighter's network menu, from the passphrase it reports. */
export function networkLabel(passphrase: string, name?: string): string {
  if (passphrase === "Public Global Stellar Network ; September 2015") return "Mainnet";
  if (passphrase === "Test SDF Network ; September 2015") return "Testnet";
  return name && name.length > 0 ? name : "another network";
}

/** Installed and unlocked, or null: the caller shows the install link. */
export async function loadFreighter(): Promise<Freighter | null> {
  const api = await import("@stellar/freighter-api");
  const connected = await api.isConnected();
  if (connected.error || !connected.isConnected) return null;
  return api;
}

/** Freighter must be on the network this listing is paid on, said in the words of its own menu. */
export async function requireNetwork(api: Freighter, passphrase: string): Promise<void> {
  const net = await api.getNetwork();
  if (net.error) throw new Error(freighterMessage(net.error, "Freighter did not say which network it is on."));
  if (net.networkPassphrase !== passphrase) {
    throw new Error(`Freighter is on ${networkLabel(net.networkPassphrase, net.network)}; switch it to ${networkLabel(passphrase)} in its network menu, then try again.`);
  }
}

export async function requestAddress(api: Freighter): Promise<string> {
  const access = await api.requestAccess();
  if (access.error) throw new Error(freighterMessage(access.error, "Freighter refused to share an account."));
  if (!access.address) throw new Error("Freighter did not share an account. Unlock it, allow this site, and try again.");
  return access.address;
}

// --- Horizon: can this account pay? ---------------------------------------------------

/** The three facts the button needs about an account, read from Horizon. */
export type StellarAccount = {
  exists: boolean;
  trustline: boolean;
  authorized: boolean;
  balanceStroops: bigint;
};

type HorizonBalance = { asset_type?: string; asset_code?: string; asset_issuer?: string; balance?: string; is_authorized?: boolean };

export async function readAccount(config: StellarCheckoutConfig, address: string, fetchImpl: typeof fetch = fetch): Promise<StellarAccount> {
  const res = await fetchImpl(`${config.horizonUrl.replace(/\/+$/, "")}/accounts/${address}`, { headers: { accept: "application/json" } });
  if (res.status === 404) return { exists: false, trustline: false, authorized: false, balanceStroops: 0n };
  if (!res.ok) throw new Error(`Horizon answered ${res.status}; try again in a moment.`);
  const body = (await res.json()) as { balances?: HorizonBalance[] };
  const line = (body.balances ?? []).find((b) => b.asset_code === config.asset.code && b.asset_issuer === config.asset.issuer);
  if (!line) return { exists: true, trustline: false, authorized: false, balanceStroops: 0n };
  return { exists: true, trustline: true, authorized: line.is_authorized !== false, balanceStroops: decimalToStroops(line.balance ?? "0") };
}

/** Horizon's `"5.1234567"` → stroops. Anything unreadable is zero, which is the safe direction. */
export function decimalToStroops(value: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,7}))?$/.exec(value.trim());
  if (!m) return 0n;
  return BigInt(m[1]) * 10_000_000n + BigInt((m[2] ?? "").padEnd(7, "0"));
}

/** Stroops of a dollar token → `$1.50`, two places, truncated. */
export function stroopsToDollars(stroops: bigint): string {
  const whole = stroops / 10_000_000n;
  const cents = (stroops % 10_000_000n) / 100_000n;
  return `$${whole}.${String(cents).padStart(2, "0")}`;
}

// --- the 402 ----------------------------------------------------------------------------

export type Accept = {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown> | null;
  [key: string]: unknown;
};

function isAccept(value: unknown): value is Accept {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  return typeof a.scheme === "string" && typeof a.network === "string" && typeof a.amount === "string" && typeof a.asset === "string" && typeof a.payTo === "string" && typeof a.maxTimeoutSeconds === "number";
}

/** The `exact` entry for this deployment's Stellar network. Never `accepts[0]`. */
export function selectStellarAccept(accepts: unknown, network: string): Accept | null {
  if (!Array.isArray(accepts)) return null;
  return accepts.filter(isAccept).find((a) => a.scheme === "exact" && a.network === network) ?? null;
}

/** The entry as the signer and the server both read it: the six fields, nothing the server decorated it with. */
export function canonicalRequirement(accept: Accept): PaymentRequirements {
  return {
    scheme: accept.scheme,
    network: accept.network,
    amount: accept.amount,
    asset: accept.asset,
    payTo: accept.payTo,
    maxTimeoutSeconds: accept.maxTimeoutSeconds,
    extra: (accept.extra ?? undefined) as PaymentRequirements["extra"],
  } as PaymentRequirements;
}

// --- the signer -------------------------------------------------------------------------

/**
 * `ClientStellarSigner` over Freighter. `@x402/stellar` hands over the auth entry's
 * preimage as base64 XDR and wants it back signed; Freighter's `signAuthEntry` (SEP-43)
 * speaks exactly that. The network and the account are pinned here so the extension
 * cannot be asked to sign for a different one.
 */
export function freighterSigner(api: Freighter, address: string, passphrase: string) {
  return {
    address,
    signAuthEntry: async (entry: string, opts?: { networkPassphrase?: string; address?: string }) => {
      const result = await api.signAuthEntry(entry, { networkPassphrase: opts?.networkPassphrase ?? passphrase, address: opts?.address ?? address });
      if (result.error) throw new Error(freighterMessage(result.error, "Freighter refused to sign the payment."));
      if (!result.signedAuthEntry) throw new Error("Freighter returned no signature. Nothing was charged.");
      if (result.signerAddress && result.signerAddress !== address) {
        throw new Error(`Freighter signed with ${result.signerAddress}, not ${address}. Switch to that account and try again.`);
      }
      return { signedAuthEntry: result.signedAuthEntry, signerAddress: result.signerAddress };
    },
  };
}

// --- the purchase -----------------------------------------------------------------------

export type FreighterCheckoutInput = {
  api: Freighter;
  address: string;
  owner: string;
  slug: string;
  config: StellarCheckoutConfig;
  transport: Transport;
  /** Already read by the connect step; read again here when absent. */
  account?: StellarAccount | null;
};

export async function buyWithFreighter(input: FreighterCheckoutInput): Promise<CheckoutResult> {
  const { api, address, owner, slug, config, transport } = input;
  const symbol = config.asset.symbol;
  try {
    const resourceUrl = `${transport.baseUrl}/api/r/${owner}/${slug}`;
    const headers: Record<string, string> = { accept: "application/json" };

    const unpaid = await transport.fetch(resourceUrl, { headers });
    // FR-24: a $0 listing grants on the first call. Nothing to sign.
    if (unpaid.ok) return grantResult((await unpaid.json()) as GrantBody, null, "free");
    if (unpaid.status !== 402) return mapApiError(unpaid.status, await safeJson(unpaid));

    const body402 = (await unpaid.json()) as Record<string, unknown>;
    const accept = selectStellarAccept(body402.accepts, config.network);
    if (!accept) return failure("unknown", `This listing is not sold on Stellar ${networkLabel(config.passphrase)} right now. Reload the page and try again.`);
    const quoteId = (body402.extra as { quote_id?: unknown } | undefined)?.quote_id;
    if (typeof quoteId !== "string" || quoteId.length === 0) return failure("unknown", "The server sent no quote. Reload the page and try again.");
    if (!/^\d+$/.test(accept.amount)) return failure("unknown", "The server sent a price this page cannot read. Reload and try again.");
    const price = BigInt(accept.amount);

    // Read before signing, so a short account never builds a payment.
    const account = input.account ?? (await readAccount(config, address, transport.fetch));
    if (!account.exists) {
      return failure("unknown", `${short(address)} does not exist on Stellar ${networkLabel(config.passphrase)} yet. Send it a little XLM first, then try again.`);
    }
    if (!account.trustline) {
      return failure("unknown", `This wallet has not added ${symbol} yet. In Freighter: Manage assets → Add manually → code ${config.asset.code}, issuer ${config.asset.issuer}. Then try again.`);
    }
    if (!account.authorized) return failure("unknown", `This wallet's ${symbol} trustline has not been authorised by the issuer, so it cannot pay yet.`);
    if (account.balanceStroops < price) {
      return failure("insufficient_balance", `This wallet holds ${stroopsToDollars(account.balanceStroops)} in ${symbol}; the price is ${stroopsToDollars(price)}. Top it up and try again.`);
    }

    // The wallet signs the auth entry here, and only here.
    const { ExactStellarScheme } = await import("@x402/stellar");
    const scheme = new ExactStellarScheme(freighterSigner(api, address, config.passphrase), { url: config.rpcUrl });
    const requirement = canonicalRequirement(accept);
    const signed = await scheme.createPaymentPayload(2, requirement);

    // `resource` and `extensions` are echoed unchanged — that is how the listing gets indexed.
    const paymentPayload = {
      x402Version: 2,
      resource: body402.resource as PaymentPayload["resource"],
      accepted: requirement,
      payload: signed.payload,
      ...(body402.extensions && typeof body402.extensions === "object" ? { extensions: body402.extensions as Record<string, unknown> } : {}),
    } as PaymentPayload;

    const paid = await transport.fetch(resourceUrl, {
      headers: { ...headers, "payment-signature": encodePaymentSignatureHeader(paymentPayload), "x-quote-id": quoteId },
    });
    if (!paid.ok) return mapApiError(paid.status, await safeJson(paid));

    const grant = (await paid.json()) as GrantBody;
    const txHash = settlementHash(paid);
    return grantResult(grant, txHash, txHash ? "paid" : "owned");
  } catch (error) {
    return mapFreighterThrown(error);
  }
}

/** Freighter's refusals, the SDK's simulation errors and a dead network, as the checkout's own codes. */
export function mapFreighterThrown(error: unknown): CheckoutResult {
  const message = error instanceof Error ? error.message : String(error);
  if (isUserRejection(error) || /declin|reject|denied|cancel/i.test(message)) return failure("rejected");
  if (error instanceof TypeError && /fetch|network/i.test(message)) return failure("network");
  if (/balance|insufficient/i.test(message)) return failure("insufficient_balance", `The payment could not be built: ${message}`);
  return failure("unknown", message.length > 0 ? `${message} Nothing was charged.` : undefined);
}

type GrantBody = { version: string; artifact_sha256: string; download_url: string; expires_at: string };

function grantResult(grant: GrantBody, txHash: string | null, kind: CheckoutSuccess["kind"]): CheckoutSuccess {
  return { ok: true, version: grant.version, artifactSha256: grant.artifact_sha256, downloadUrl: grant.download_url, expiresAt: grant.expires_at, txHash, kind };
}

/** The settlement hash, if the header carried one. Never fatal: the grant already happened. */
function settlementHash(res: Response): string | null {
  const header = res.headers.get("payment-response");
  if (!header) return null;
  try {
    const settlement = decodePaymentResponseHeader(header) as { transaction?: unknown };
    return typeof settlement.transaction === "string" && settlement.transaction.length > 0 ? settlement.transaction : null;
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

export function short(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}
