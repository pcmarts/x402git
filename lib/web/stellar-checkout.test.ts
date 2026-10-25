/**
 * lib/web/stellar-checkout.test.ts — the Stellar checkout's pure parts, and (25 Oct 2026,
 * ~21:30, the wallet kit) the parts that talk to a wallet, through fakes: the kit-backed
 * signer, the connect step, and the whole purchase with a signer that is not a wallet.
 */

import { describe, expect, it, vi } from "vitest";
import {
  buyWithStellarWallet,
  cannotPayWith,
  canonicalRequirement,
  connectStellarWallet,
  decimalToStroops,
  isPickerClosed,
  kitSigner,
  mapStellarThrown,
  readAccount,
  requireNetwork,
  selectStellarAccept,
  type StellarCheckoutConfig,
  stroopsToDollars,
  type WalletKit,
  WalletCannotPayError,
} from "./stellar-checkout";

const CONFIG: StellarCheckoutConfig = {
  network: "stellar:testnet",
  passphrase: "Test SDF Network ; September 2015",
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
  asset: { code: "USDT0", issuer: "GDJSXY37UYEOBH4RM77NVLBYN5NGWXE6B52YBCJUOKCJFPPPZI3CZE2M", contract: "CA5HAM7BFUSFV6HRLNP2HLMZS5F2TTHFA37PWV3ZUXQFREAY3DYKYF72", symbol: "USDT0" },
};
const G = "GDYQUMOACG2DAPVXJI5RLPFAF3I754EXP6HRET4KDBOW3MEP3EMRXMR6";

describe("amounts", () => {
  it("reads Horizon's decimal balances as stroops, and anything odd as zero", () => {
    expect(decimalToStroops("5.0000000")).toBe(50_000_000n);
    expect(decimalToStroops("0.1")).toBe(1_000_000n);
    expect(decimalToStroops("12")).toBe(120_000_000n);
    expect(decimalToStroops("")).toBe(0n);
    expect(decimalToStroops("1e5")).toBe(0n);
  });

  it("prints stroops of a dollar token as dollars and cents", () => {
    expect(stroopsToDollars(10_000_000n)).toBe("$1.00");
    expect(stroopsToDollars(15_000_000n)).toBe("$1.50");
    expect(stroopsToDollars(123_456_789n)).toBe("$12.34");
    expect(stroopsToDollars(0n)).toBe("$0.00");
  });
});

describe("selectStellarAccept", () => {
  const base = { scheme: "exact", amount: "10000000", asset: "C".padEnd(56, "A"), payTo: G, maxTimeoutSeconds: 300 };

  it("picks the exact entry for this deployment's network, never accepts[0]", () => {
    const accepts = [
      { ...base, network: "eip155:8453" },
      { ...base, network: "stellar:pubnet" },
      { ...base, network: "stellar:testnet", extra: { quote_id: "q" } },
    ];
    expect(selectStellarAccept(accepts, "stellar:testnet")?.network).toBe("stellar:testnet");
    expect(selectStellarAccept(accepts, "stellar:pubnet")?.network).toBe("stellar:pubnet");
    expect(selectStellarAccept(accepts, "stellar:futurenet")).toBeNull();
    expect(selectStellarAccept(accepts.slice(0, 1), "stellar:testnet")).toBeNull();
    expect(selectStellarAccept(null, "stellar:testnet")).toBeNull();
    expect(selectStellarAccept([{ scheme: "exact", network: "stellar:testnet" }], "stellar:testnet")).toBeNull();
  });

  it("reduces an entry to the six fields the signer and the server both read", () => {
    const accept = { ...base, network: "stellar:testnet", extra: { quote_id: "q", areFeesSponsored: true }, description: "decor", payment_options: [] };
    expect(canonicalRequirement(accept)).toEqual({
      scheme: "exact",
      network: "stellar:testnet",
      amount: "10000000",
      asset: base.asset,
      payTo: G,
      maxTimeoutSeconds: 300,
      extra: { quote_id: "q", areFeesSponsored: true },
    });
  });
});

describe("readAccount", () => {
  const horizon = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

  it("reports a missing account, a missing trustline, and the balance in stroops", async () => {
    expect(await readAccount(CONFIG, G, horizon(404, { status: 404 }))).toEqual({ exists: false, trustline: false, authorized: false, balanceStroops: 0n });
    expect(await readAccount(CONFIG, G, horizon(200, { balances: [{ asset_type: "native", balance: "10.0000000" }] }))).toEqual({ exists: true, trustline: false, authorized: false, balanceStroops: 0n });
    expect(
      await readAccount(CONFIG, G, horizon(200, { balances: [{ asset_type: "credit_alphanum12", asset_code: "USDT0", asset_issuer: CONFIG.asset.issuer, balance: "5.0000000", is_authorized: true }] })),
    ).toEqual({ exists: true, trustline: true, authorized: true, balanceStroops: 50_000_000n });
  });

  it("does not mistake a same-code token from another issuer for the one the listing takes", async () => {
    const other = { asset_type: "credit_alphanum12", asset_code: "USDT0", asset_issuer: "G".padEnd(56, "B"), balance: "99.0000000" };
    expect((await readAccount(CONFIG, G, horizon(200, { balances: [other] }))).trustline).toBe(false);
  });

  it("throws on a Horizon error, so the caller can say so rather than claim an empty account", async () => {
    await expect(readAccount(CONFIG, G, horizon(503, {}))).rejects.toThrow(/Horizon answered 503/);
  });
});

describe("mapStellarThrown", () => {
  it("reads a wallet's refusals as a cancel, a dead fetch as network, and keeps other sentences", () => {
    expect(mapStellarThrown(new Error("User declined access"))).toMatchObject({ ok: false, code: "rejected", retryable: true });
    expect(mapStellarThrown(new Error("The user rejected this request"))).toMatchObject({ ok: false, code: "rejected" });
    expect(mapStellarThrown(new TypeError("Failed to fetch"))).toMatchObject({ ok: false, code: "network" });
    expect(mapStellarThrown(new Error("Freighter is on Mainnet; switch it to Testnet in its network menu, then try again."))).toMatchObject({
      ok: false,
      code: "unknown",
      message: "Freighter is on Mainnet; switch it to Testnet in its network menu, then try again. Nothing was charged.",
    });
    expect(mapStellarThrown(new Error("simulation failed: insufficient balance"))).toMatchObject({ ok: false, code: "insufficient_balance" });
  });

  it("reads the kit's bare { code, message } rejections, not as [object Object]", () => {
    expect(mapStellarThrown({ code: -4, message: "The user rejected this request." })).toMatchObject({ ok: false, code: "rejected" });
    expect(mapStellarThrown({ code: -1, message: "Freighter is not connected" })).toMatchObject({ ok: false, code: "unknown", message: "Freighter is not connected Nothing was charged." });
  });

  it("says which wallets can pay when one cannot sign an auth entry, however it arrives", () => {
    const sentence = "xBull can't approve this kind of payment yet. Use Freighter, Hana or HOT Wallet, or pay from the terminal below.";
    expect(mapStellarThrown(new WalletCannotPayError("xBull"))).toEqual({ ok: false, code: "unknown", message: sentence, retryable: true });
    expect(mapStellarThrown({ code: -3, message: 'xBull does not support the "signAuthEntry" function' })).toMatchObject({ message: sentence });
  });
});

// --- the wallet kit, faked ------------------------------------------------------------

const SIGNED = "c2lnbmVk"; // "signed", base64

describe("kitSigner: ClientStellarSigner over the kit's signAuthEntry", () => {
  it("pins the network and the account, whatever the SDK passes, and hands back the signature", async () => {
    const sign = vi.fn(async () => ({ signedAuthEntry: SIGNED, signerAddress: G }));
    const signer = kitSigner(G, CONFIG.passphrase, { walletName: "Hana", sign });
    expect(signer.address).toBe(G);
    await expect(signer.signAuthEntry("ZW50cnk=", { address: G })).resolves.toEqual({ signedAuthEntry: SIGNED, signerAddress: G });
    await signer.signAuthEntry("ZW50cnk=", { networkPassphrase: "Public Global Stellar Network ; September 2015", address: "G".padEnd(56, "Z") });
    for (const call of sign.mock.calls as unknown as [string, { networkPassphrase: string; address: string }][]) {
      expect(call[1]).toEqual({ networkPassphrase: CONFIG.passphrase, address: G });
    }
  });

  it("turns the kit's not-supported rejection into the sentence naming the wallets that can", async () => {
    for (const [name, message] of [
      ["xBull", 'xBull does not support the "signAuthEntry" function'],
      ["Lobstr", 'Lobstr does not support the "signAuthEntry" function'],
      ["Trezor", 'Trezor Wallets do not support the "signAuthEntry" method'],
    ]) {
      const signer = kitSigner(G, CONFIG.passphrase, { walletName: name, sign: async () => Promise.reject({ code: -3, message }) });
      const thrown = await signer.signAuthEntry("ZW50cnk=").catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(WalletCannotPayError);
      expect((thrown as Error).message).toBe(`${name} can't approve this kind of payment yet. Use Freighter, Hana or HOT Wallet, or pay from the terminal below.`);
    }
  });

  it("keeps a wallet's own refusal as an Error with its code, so the mapper reads it as a cancel", async () => {
    const signer = kitSigner(G, CONFIG.passphrase, { walletName: "Freighter", sign: async () => Promise.reject({ code: -4, message: "The user rejected this request." }) });
    const thrown = await signer.signAuthEntry("ZW50cnk=").catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toMatchObject({ message: "The user rejected this request.", code: -4 });
    expect(mapStellarThrown(thrown)).toMatchObject({ code: "rejected" });
  });

  it("refuses an empty signature, and a signature from another account", async () => {
    const empty = kitSigner(G, CONFIG.passphrase, { walletName: "Hana", sign: async () => ({ signedAuthEntry: "" }) });
    await expect(empty.signAuthEntry("ZW50cnk=")).rejects.toThrow("Hana returned no signature. Nothing was charged.");
    const other = "G".padEnd(56, "Q");
    const wrong = kitSigner(G, CONFIG.passphrase, { walletName: "Hana", sign: async () => ({ signedAuthEntry: SIGNED, signerAddress: other }) });
    await expect(wrong.signAuthEntry("ZW50cnk=")).rejects.toThrow(`Hana signed with ${other}, not ${G}.`);
  });
});

function fakeKit(over: Partial<WalletKit> & { id?: string; name?: string } = {}): WalletKit {
  return {
    authModal: async () => ({ address: G }),
    getNetwork: async () => ({ network: "TESTNET", networkPassphrase: CONFIG.passphrase }),
    signAuthEntry: async () => ({ signedAuthEntry: SIGNED }),
    signMessage: async () => ({ signedMessage: SIGNED }),
    disconnect: async () => undefined,
    selectedModule: { productId: over.id ?? "freighter", productName: over.name ?? "Freighter" },
    ...over,
  };
}

describe("connectStellarWallet and requireNetwork", () => {
  it("returns the account the picker chose and the wallet that holds it", async () => {
    const load = vi.fn(async () => fakeKit({ id: "hana", name: "Hana" }));
    await expect(connectStellarWallet(CONFIG, load)).resolves.toEqual({ address: G, walletId: "hana", walletName: "Hana" });
    expect(load).toHaveBeenCalledWith(CONFIG.passphrase);
  });

  it("names the wallet's network in its own menu's words when it is on another", async () => {
    const kit = fakeKit({ getNetwork: async () => ({ network: "PUBLIC", networkPassphrase: "Public Global Stellar Network ; September 2015" }) });
    await expect(connectStellarWallet(CONFIG, async () => kit)).rejects.toThrow("Freighter is on Mainnet; switch it to Testnet in its network menu, then try again.");
  });

  it("trusts a wallet that cannot report a network to the passphrase each signature carries", async () => {
    const kit = fakeKit({ getNetwork: async () => Promise.reject({ code: -3, message: 'Hana does not support the "getNetwork" function' }) });
    await expect(requireNetwork(kit, CONFIG.passphrase, "Hana")).resolves.toBeUndefined();
    const locked = fakeKit({ getNetwork: async () => Promise.reject({ code: -1, message: "" }) });
    await expect(requireNetwork(locked, CONFIG.passphrase, "Freighter")).rejects.toThrow("Freighter did not say which network it is on.");
  });

  it("tells a closed picker from a failure", async () => {
    const kit = fakeKit({ authModal: async () => Promise.reject({ code: -1, message: "The user closed the modal." }) });
    const thrown = await connectStellarWallet(CONFIG, async () => kit).catch((e: unknown) => e);
    expect(isPickerClosed(thrown)).toBe(true);
    expect(isPickerClosed(new Error("The user rejected this request."))).toBe(false);
  });

  it("knows at connect which wallets the kit cannot sign an auth entry with", () => {
    expect(cannotPayWith("xbull", "xBull")).toMatchObject({ ok: false, message: expect.stringContaining("xBull can't approve this kind of payment yet.") });
    for (const id of ["albedo", "lobstr", "rabet", "LEDGER", "TREZOR"]) expect(cannotPayWith(id, id)).not.toBeNull();
    for (const id of ["freighter", "hana", "hot-wallet", "klever", "metamask"]) expect(cannotPayWith(id, id)).toBeNull();
  });
});

// --- the purchase, with a signer that is not a wallet ---------------------------------

describe("buyWithStellarWallet", () => {
  const ASSET = "C".padEnd(56, "A");
  const accept = { scheme: "exact", network: "stellar:testnet", amount: "10000000", asset: ASSET, payTo: G, maxTimeoutSeconds: 300, extra: { areFeesSponsored: true } };
  const funded = { exists: true, trustline: true, authorized: true, balanceStroops: 250_000_000n };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const grant = { version: "1.2.0", artifact_sha256: "ab".repeat(32), download_url: "https://dl.example/x.zip", expires_at: "2026-10-25T22:00:00Z" };

  function transportFor(...responses: Response[]) {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      const next = responses.shift();
      if (!next) throw new Error("unexpected fetch");
      return next;
    }) as unknown as typeof fetch;
    return { transport: { fetch: fetchImpl, baseUrl: "https://x402git.test" }, calls };
  }

  const neverSigns = { address: G, signAuthEntry: vi.fn(async () => ({ signedAuthEntry: SIGNED })) };

  it("grants a free listing on the first call, with nothing signed", async () => {
    const { transport, calls } = transportFor(json(200, grant));
    const out = await buyWithStellarWallet({ signer: neverSigns, address: G, owner: "adrian", slug: "humanizer", config: CONFIG, transport, account: funded });
    expect(out).toMatchObject({ ok: true, kind: "free", version: "1.2.0", txHash: null });
    expect(calls[0].url).toBe("https://x402git.test/api/r/adrian/humanizer");
    expect(neverSigns.signAuthEntry).not.toHaveBeenCalled();
  });

  it("stops before signing when the account cannot pay, in the chosen wallet's words", async () => {
    const offer = { accepts: [accept], extra: { quote_id: "q1" } };
    const noLine = await buyWithStellarWallet({
      signer: neverSigns,
      address: G,
      walletName: "Hana",
      owner: "adrian",
      slug: "humanizer",
      config: CONFIG,
      transport: transportFor(json(402, offer)).transport,
      account: { exists: true, trustline: false, authorized: false, balanceStroops: 0n },
    });
    expect(noLine).toMatchObject({ ok: false, code: "unknown", message: `This wallet has not added USDT0 yet. Add it in Hana: code USDT0, issuer ${CONFIG.asset.issuer}. Then try again.` });

    const short = await buyWithStellarWallet({
      signer: neverSigns,
      address: G,
      owner: "adrian",
      slug: "humanizer",
      config: CONFIG,
      transport: transportFor(json(402, offer)).transport,
      account: { ...funded, balanceStroops: 5_000_000n },
    });
    expect(short).toMatchObject({ ok: false, code: "insufficient_balance", message: "This wallet holds $0.50 in USDT0; the price is $1.00. Top it up and try again." });
    expect(neverSigns.signAuthEntry).not.toHaveBeenCalled();
  });

  it("refuses a 402 that does not sell on this network, or sends no quote", async () => {
    const elsewhere = await buyWithStellarWallet({
      signer: neverSigns,
      address: G,
      owner: "adrian",
      slug: "humanizer",
      config: CONFIG,
      transport: transportFor(json(402, { accepts: [{ ...accept, network: "eip155:8453" }], extra: { quote_id: "q1" } })).transport,
      account: funded,
    });
    expect(elsewhere).toMatchObject({ ok: false, message: "This listing is not sold on Stellar Testnet right now. Reload the page and try again." });
    const noQuote = await buyWithStellarWallet({
      signer: neverSigns,
      address: G,
      owner: "adrian",
      slug: "humanizer",
      config: CONFIG,
      transport: transportFor(json(402, { accepts: [accept] })).transport,
      account: funded,
    });
    expect(noQuote).toMatchObject({ ok: false, message: "The server sent no quote. Reload the page and try again." });
  });

  it("hands the signer it was given to the x402 scheme, and maps what the scheme throws", async () => {
    // The scheme's own network work is @x402/stellar's; here it is replaced by one that
    // calls the signer once, the way `signAuthEntries` does, and throws what it throws.
    vi.resetModules();
    vi.doMock("@x402/stellar", () => ({
      ExactStellarScheme: class {
        constructor(private signer: { signAuthEntry: (e: string, o: { address: string }) => Promise<unknown> }) {}
        async createPaymentPayload() {
          await this.signer.signAuthEntry("cHJlaW1hZ2U=", { address: G });
          return { payload: { transaction: "AAAA" } };
        }
      },
    }));
    const fresh = await import("./stellar-checkout");
    const refusing = fresh.kitSigner(G, CONFIG.passphrase, { walletName: "Albedo", sign: async () => Promise.reject({ code: -3, message: 'Albedo does not support the "signAuthEntry" function' }) });
    const { transport } = transportFor(json(402, { accepts: [accept], extra: { quote_id: "q1" } }));
    const out = await fresh.buyWithStellarWallet({ signer: refusing, address: G, owner: "adrian", slug: "humanizer", config: CONFIG, transport, account: funded });
    expect(out).toEqual({
      ok: false,
      code: "unknown",
      message: "Albedo can't approve this kind of payment yet. Use Freighter, Hana or HOT Wallet, or pay from the terminal below.",
      retryable: true,
    });

    const signing = { address: G, signAuthEntry: vi.fn(async () => ({ signedAuthEntry: SIGNED })) };
    const paid = transportFor(json(402, { accepts: [accept], extra: { quote_id: "q1" }, resource: { url: "https://x402git.test/api/r/adrian/humanizer" } }), json(200, grant));
    const ok = await fresh.buyWithStellarWallet({ signer: signing, address: G, owner: "adrian", slug: "humanizer", config: CONFIG, transport: paid.transport, account: funded });
    expect(ok).toMatchObject({ ok: true, kind: "owned", version: "1.2.0" });
    expect(signing.signAuthEntry).toHaveBeenCalledTimes(1);
    expect(paid.calls[1].headers["x-quote-id"]).toBe("q1");
    expect(paid.calls[1].headers["payment-signature"]).toBeTruthy();
    vi.doUnmock("@x402/stellar");
  });
});

import { kitExclusions } from "./stellar-checkout";

describe("the picker is filtered for what it is for (25 Oct 2026, 23:05)", () => {
  it("paying leaves out every wallet that cannot sign an auth entry", () => {
    const out = kitExclusions("pay");
    for (const id of ["albedo", "xbull", "lobstr", "rabet", "LEDGER", "TREZOR"]) expect(out.has(id)).toBe(true);
    expect(out.has("freighter")).toBe(false);
  });

  it("binding an address needs only signMessage, so xBull and Lobstr stay and Albedo, Rabet, Ledger, Trezor go", () => {
    const out = kitExclusions("sign");
    expect(out.has("xbull")).toBe(false);
    expect(out.has("lobstr")).toBe(false);
    for (const id of ["albedo", "rabet", "LEDGER", "TREZOR"]) expect(out.has(id)).toBe(true);
  });
});
