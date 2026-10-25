/**
 * lib/web/stellar-checkout.ts — the browser's Stellar purchase, through any Stellar wallet.
 *
 * 25 Oct 2026, HackMeridian (founder: "we need a non-agent way for users to pay, a visual
 * 'pay with wallet' option"). This is the same x402 exchange the CLI (`x402git-stellar`)
 * and the Base button run, with the buyer's wallet as the signer:
 *
 *   GET the resource → 402 with `accepts` → the Stellar `exact` entry → `ExactStellarScheme`
 *   simulates the token contract's `transfer` and asks the wallet to sign the one Soroban
 *   auth entry (SEP-43 `signAuthEntry`) → the same GET again with PAYMENT-SIGNATURE and
 *   X-Quote-Id → the grant, and the settlement hash from PAYMENT-RESPONSE.
 *
 * Before anything is signed, Horizon is read once: no account, no trustline, a trustline
 * the issuer has not authorised, or a short balance each end in a sentence that says what
 * to do — not a simulation error from inside the SDK. Fees are the facilitator's
 * (`areFeesSponsored`), so the account needs the token and nothing else.
 *
 * Shapes are shared with the EVM checkout (`CheckoutResult`, `failure`, `mapApiError`) so
 * the two buttons render the same panels. The wallet kit, `@x402/stellar` and the SDK
 * behind it are imported on the first press and never run on the server.
 *
 * Amended 25 Oct 2026, ~21:30 (founder: "Lets use the stellar wallet SDK instead so we can
 * support more wallets?"). The signer was Freighter's API; it is now the Stellar Wallets
 * Kit (`@creit.tech/stellar-wallets-kit`, pinned 2.7.1), whose picker lists every wallet it
 * knows and links the ones not installed. The purchase itself did not change: it takes any
 * `ClientStellarSigner` (`buyWithStellarWallet`), and `kitSigner` is that signer over the
 * kit. Not every wallet in the picker can sign a Soroban auth entry — xBull, Albedo, Lobstr,
 * Rabet, Fordefi, Bitget, Ledger and Trezor say so in their kit modules — so the kit's
 * "does not support the signAuthEntry function" becomes one sentence naming the wallets
 * that can, and the button says it at connect time for the ones known not to
 * (`cannotPayWith`), before the buyer is asked to press Pay. The kit is set to this
 * deployment's network; a wallet that reports another one is told so in its own menu's
 * words, and one that cannot report a network at all is trusted to the passphrase every
 * signing request carries.
 */

import { decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { type CheckoutFailure, type CheckoutResult, type CheckoutSuccess, failure, isUserRejection, mapApiError, type Transport } from "@/lib/web/wallet-checkout";

/** What the page hands the button: the one Stellar network this deployment pays on, and its token. */
export type StellarCheckoutConfig = {
  /** `stellar:testnet` or `stellar:pubnet`. */
  network: string;
  passphrase: string;
  rpcUrl: string;
  horizonUrl: string;
  asset: { code: string; issuer: string; contract: string; symbol: string };
};

/** The words a person sees in a wallet's network menu, from the passphrase it reports. */
export function networkLabel(passphrase: string, name?: string): string {
  if (passphrase === "Public Global Stellar Network ; September 2015") return "Mainnet";
  if (passphrase === "Test SDF Network ; September 2015") return "Testnet";
  return name && name.length > 0 ? name : "another network";
}

// --- the wallet kit ---------------------------------------------------------------------

/** SEP-43's `signAuthEntry`, as the kit (and each wallet module behind it) speaks it. */
export type SignAuthEntryFn = (
  authEntry: string,
  opts: { networkPassphrase: string; address: string },
) => Promise<{ signedAuthEntry: string; signerAddress?: string }>;

/**
 * The slice of the kit's static `StellarWalletsKit` this file calls. Typed here, not taken
 * from the package, so the type costs nothing on first paint and a test can hand in a fake.
 */
export type WalletKit = {
  authModal(): Promise<{ address: string }>;
  getNetwork(): Promise<{ network: string; networkPassphrase: string }>;
  signAuthEntry(authEntry: string, opts?: { networkPassphrase?: string; address?: string }): Promise<{ signedAuthEntry: string; signerAddress?: string }>;
  disconnect(): Promise<void>;
  readonly selectedModule: { productId: string; productName: string };
};

/** The wallets that can approve this payment, in the order the failure copy names them. */
export const AUTH_ENTRY_WALLETS = "Freighter, Hana or HOT Wallet";

/**
 * Kit module ids whose `signAuthEntry` is a hard-coded refusal in 2.7.1 (read from the
 * modules, 25 Oct 2026). Pinned with the package: a kit upgrade re-reads this list.
 */
const NO_AUTH_ENTRY: ReadonlySet<string> = new Set(["albedo", "xbull", "lobstr", "rabet", "fordefi", "BitgetWallet", "LEDGER", "TREZOR"]);

let kitFor: { passphrase: string; kit: Promise<WalletKit> } | null = null;

/**
 * The kit, initialised once per page for this deployment's network. `defaultModules()` is
 * every wallet that needs no app-side setup (Ledger, Trezor and WalletConnect are not in
 * it: the first two cannot sign an auth entry, and WalletConnect needs a project id). HOT
 * Wallet is not in it either — its module warns it wants `Buffer` and `global` — so it is
 * added from its own module, fetched in parallel, in a guard of its own: a wallet SDK that
 * fails to load costs that one row of the picker and not the picker. It is also the
 * heaviest chunk the press fetches (~92 KB gzipped of ~167 KB, 25 Oct 2026 build).
 */
export function loadKit(passphrase: string): Promise<WalletKit> {
  if (kitFor && kitFor.passphrase === passphrase) return kitFor.kit;
  const kit = (async () => {
    const [{ StellarWalletsKit }, { defaultModules }, hot] = await Promise.all([
      import("@creit.tech/stellar-wallets-kit"),
      import("@creit.tech/stellar-wallets-kit/modules/utils"),
      import("@creit.tech/stellar-wallets-kit/modules/hotwallet").then((m) => new m.HotWalletModule()).catch(() => null),
    ]);
    StellarWalletsKit.init({
      // Only wallets that can sign a Soroban auth entry are offered (integrator, 25 Oct
      // 2026, 22:10): a picker that lists Albedo or xBull first and then says "can't
      // approve this kind of payment" is a worse first minute than a shorter list. The
      // refusing set is the kit's own, read from each module's code; the per-connect
      // check below stays as the belt to this brace.
      modules: [...defaultModules({ filterBy: (m) => !NO_AUTH_ENTRY.has(m.productId) }), ...(hot ? [hot] : [])],
      network: passphrase as Parameters<typeof StellarWalletsKit.setNetwork>[0],
    });
    return StellarWalletsKit as WalletKit;
  })();
  kitFor = { passphrase, kit };
  // A failed load is not cached: the next press tries again.
  kit.catch(() => {
    if (kitFor?.kit === kit) kitFor = null;
  });
  return kit;
}

/** A kit or wallet refusal, which arrives as a bare `{ code, message }`, or anything else thrown. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  const m = (error as { message?: unknown } | null)?.message;
  return typeof m === "string" ? m : "";
}

/** `<wallet> does not support the "<fn>" function` (or "do not … method"), as the kit's modules word it. */
function notSupported(error: unknown, fn: string): boolean {
  return new RegExp(`\\b(?:does|do) not support the "?${fn}"? (?:function|method)`, "i").test(messageOf(error));
}

/** The picker's ✕ or its backdrop: the buyer changed their mind, which is not an error. */
export function isPickerClosed(error: unknown): boolean {
  return /closed the modal/i.test(messageOf(error));
}

/** Thrown when the chosen wallet cannot sign an auth entry; its message is the whole sentence. */
export class WalletCannotPayError extends Error {
  constructor(walletName: string) {
    super(`${walletName} can't approve this kind of payment yet. Use ${AUTH_ENTRY_WALLETS}, or pay from the terminal below.`);
    this.name = "WalletCannotPayError";
  }
}

/** For a wallet the kit's own module refuses `signAuthEntry` for, the failure to show at connect. */
export function cannotPayWith(walletId: string, walletName: string): CheckoutFailure | null {
  return NO_AUTH_ENTRY.has(walletId) ? failure("unknown", new WalletCannotPayError(walletName).message) : null;
}

/**
 * The chosen wallet must be on the network this listing is paid on, said in the words of
 * its own menu. A wallet that cannot say (xBull, Hana, Lobstr…) is not refused for it:
 * every signing request names the passphrase, and a wallet on the wrong network fails there.
 */
export async function requireNetwork(kit: Pick<WalletKit, "getNetwork">, passphrase: string, walletName: string): Promise<void> {
  let net: { network: string; networkPassphrase: string };
  try {
    net = await kit.getNetwork();
  } catch (error) {
    if (notSupported(error, "getNetwork")) return;
    const said = messageOf(error);
    throw new Error(said.length > 0 ? said : `${walletName} did not say which network it is on.`);
  }
  if (net.networkPassphrase && net.networkPassphrase !== passphrase) {
    throw new Error(`${walletName} is on ${networkLabel(net.networkPassphrase, net.network)}; switch it to ${networkLabel(passphrase)} in its network menu, then try again.`);
  }
}

export type ConnectedWallet = { address: string; walletId: string; walletName: string };

/**
 * The kit's picker → the account the buyer chose, and which wallet holds it. Detection is
 * the picker's: nothing is asked of any extension before this press.
 */
export async function connectStellarWallet(config: StellarCheckoutConfig, load: (passphrase: string) => Promise<WalletKit> = loadKit): Promise<ConnectedWallet> {
  const kit = await load(config.passphrase);
  const { address } = await kit.authModal();
  if (!address) throw new Error("The wallet did not share an account. Unlock it, allow this site, and try again.");
  const { productId, productName } = kit.selectedModule;
  await requireNetwork(kit, config.passphrase, productName);
  return { address, walletId: productId, walletName: productName };
}

/** Forget the chosen wallet, so the next press opens the picker clean. Best effort. */
export async function disconnectStellarWallet(passphrase: string): Promise<void> {
  try {
    await (await loadKit(passphrase)).disconnect();
  } catch {
    // Nothing to forget, or the kit never loaded: the next press opens the picker either way.
  }
}

/** `@x402/stellar`'s `ClientStellarSigner` (SEP-43's shape), as this file builds and accepts it. */
export type StellarSigner = {
  address: string;
  signAuthEntry: (authEntry: string, opts?: { networkPassphrase?: string; address?: string }) => Promise<{ signedAuthEntry: string; signerAddress?: string }>;
};

/**
 * `ClientStellarSigner` over the kit. `@x402/stellar` hands over the auth entry's preimage
 * as base64 XDR and wants it back signed; SEP-43 `signAuthEntry` speaks exactly that. The
 * network and the account are pinned here, whatever the caller passes, so the wallet cannot
 * be asked to sign for a different one.
 */
export function kitSigner(address: string, passphrase: string, opts: { walletName?: string; sign?: SignAuthEntryFn } = {}): StellarSigner {
  const name = opts.walletName ?? "Your wallet";
  const sign: SignAuthEntryFn = opts.sign ?? (async (entry, o) => (await loadKit(passphrase)).signAuthEntry(entry, o));
  return {
    address,
    signAuthEntry: async (entry: string, _opts?: { networkPassphrase?: string; address?: string }) => {
      let result: { signedAuthEntry?: string; signerAddress?: string } | undefined;
      try {
        result = await sign(entry, { networkPassphrase: passphrase, address });
      } catch (error) {
        if (notSupported(error, "signAuthEntry")) throw new WalletCannotPayError(name);
        // The kit rejects with a bare `{ code, message }`; keep both for the mapper.
        if (error instanceof Error) throw error;
        throw Object.assign(new Error(messageOf(error) || `${name} refused to sign the payment.`), { code: (error as { code?: unknown } | null)?.code });
      }
      if (!result?.signedAuthEntry) throw new Error(`${name} returned no signature. Nothing was charged.`);
      if (result.signerAddress && result.signerAddress !== address) {
        throw new Error(`${name} signed with ${result.signerAddress}, not ${address}. Switch to that account and try again.`);
      }
      return { signedAuthEntry: result.signedAuthEntry, signerAddress: result.signerAddress };
    },
  };
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

// --- the purchase -----------------------------------------------------------------------

export type StellarWalletCheckoutInput = {
  /** Any `ClientStellarSigner`: `kitSigner` in the page, a fake in a test. */
  signer: StellarSigner;
  address: string;
  /** "Freighter", "Hana": named in the trustline sentence. */
  walletName?: string;
  owner: string;
  slug: string;
  config: StellarCheckoutConfig;
  transport: Transport;
  /** Already read by the connect step; read again here when absent. */
  account?: StellarAccount | null;
};

export async function buyWithStellarWallet(input: StellarWalletCheckoutInput): Promise<CheckoutResult> {
  const { signer, address, owner, slug, config, transport } = input;
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
      return failure("unknown", `This wallet has not added ${symbol} yet. ${trustlineSteps(input.walletName, config.asset)} Then try again.`);
    }
    if (!account.authorized) return failure("unknown", `This wallet's ${symbol} trustline has not been authorised by the issuer, so it cannot pay yet.`);
    if (account.balanceStroops < price) {
      return failure("insufficient_balance", `This wallet holds ${stroopsToDollars(account.balanceStroops)} in ${symbol}; the price is ${stroopsToDollars(price)}. Top it up and try again.`);
    }

    // The wallet signs the auth entry here, and only here.
    const { ExactStellarScheme } = await import("@x402/stellar");
    const scheme = new ExactStellarScheme(signer, { url: config.rpcUrl });
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
    return mapStellarThrown(error);
  }
}

/** Where a wallet adds a token, in Freighter's own menu words when it is Freighter. */
export function trustlineSteps(walletName: string | undefined, asset: { code: string; issuer: string }): string {
  if (!walletName || walletName === "Freighter") return `In Freighter: Manage assets → Add manually → code ${asset.code}, issuer ${asset.issuer}.`;
  return `Add it in ${walletName}: code ${asset.code}, issuer ${asset.issuer}.`;
}

/**
 * A wallet's refusal, the SDK's simulation errors and a dead network, as the checkout's
 * own codes. Wallets reject with a bare `{ code, message }` as often as with an Error.
 */
export function mapStellarThrown(error: unknown): CheckoutFailure {
  if (error instanceof WalletCannotPayError) return failure("unknown", error.message);
  const message = messageOf(error);
  // The same refusal, if something between the wallet and here re-threw it as its own.
  if (notSupported(error, "signAuthEntry")) return failure("unknown", new WalletCannotPayError(/^(.+?) (?:does|do) not support/i.exec(message)?.[1] ?? "This wallet").message);
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
