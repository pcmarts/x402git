/** lib/web/stellar-checkout.test.ts — the pure parts of the Freighter checkout. */

import { describe, expect, it } from "vitest";
import { canonicalRequirement, decimalToStroops, mapFreighterThrown, readAccount, selectStellarAccept, stroopsToDollars, type StellarCheckoutConfig } from "./stellar-checkout";

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

describe("mapFreighterThrown", () => {
  it("reads Freighter's refusals as a cancel, a dead fetch as network, and keeps other sentences", () => {
    expect(mapFreighterThrown(new Error("User declined access"))).toMatchObject({ ok: false, code: "rejected", retryable: true });
    expect(mapFreighterThrown(new Error("The user rejected this request"))).toMatchObject({ ok: false, code: "rejected" });
    expect(mapFreighterThrown(new TypeError("Failed to fetch"))).toMatchObject({ ok: false, code: "network" });
    expect(mapFreighterThrown(new Error("Freighter is on Mainnet; switch it to Testnet in its network menu, then try again."))).toMatchObject({
      ok: false,
      code: "unknown",
      message: "Freighter is on Mainnet; switch it to Testnet in its network menu, then try again. Nothing was charged.",
    });
    expect(mapFreighterThrown(new Error("simulation failed: insufficient balance"))).toMatchObject({ ok: false, code: "insufficient_balance" });
  });
});
