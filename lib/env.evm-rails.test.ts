/**
 * lib/env.evm-rails.test.ts — `X402_EXTRA_EVM_RAILS` (25 Oct 2026, HackMeridian;
 * docs/HACKMERIDIAN-EVM-USDT0-RAIL.md §2.1). Unset is today's one EVM rail; the minimal
 * `[{"network":"eip155:42161"}]` is a complete Arbitrum USDT0 rail; and every way to
 * mis-set it is an `EvmRailConfigError` naming the entry, at read, never a 402 nobody can pay.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearStellarEnv, setStellarTestnetEnv } from "@/lib/test/stellar";
import { EvmRailConfigError, evmChains, evmRailFor, evmRails, extraEvmRails, paymentNetworks, paymentRails, resetEnv } from "./env";

const PAY_TO = "0x1111111111111111111111111111111111111111";
const ARBITRUM_USDT0 = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9";
const CDP_URL = "https://api.cdp.coinbase.com/platform/v2/x402";

beforeEach(() => {
  clearStellarEnv();
  delete process.env.X402_EXTRA_EVM_RAILS;
  delete process.env.ARBITRUM_RPC_URL;
  process.env.X402_NETWORK = "base-sepolia";
  process.env.PLATFORM_RECEIVING_ADDRESS = PAY_TO;
  resetEnv();
});
afterEach(() => {
  clearStellarEnv();
  delete process.env.X402_EXTRA_EVM_RAILS;
  delete process.env.ARBITRUM_RPC_URL;
  delete process.env.X402_NETWORK;
  delete process.env.PLATFORM_RECEIVING_ADDRESS;
  resetEnv();
});

function rails(value: unknown): void {
  process.env.X402_EXTRA_EVM_RAILS = typeof value === "string" ? value : JSON.stringify(value);
  resetEnv();
}

describe("unset", () => {
  it("is no extra rail: the lists are the primary alone, as before", () => {
    expect(extraEvmRails(PAY_TO)).toEqual([]);
    expect(evmRails().map((r) => r.network)).toEqual(["eip155:84532"]);
    expect(evmChains().map((r) => r.network)).toEqual(["eip155:84532"]);
    expect(paymentNetworks()).toEqual(["eip155:84532"]);
    expect(evmRailFor("eip155:42161")).toBeNull();
  });

  it("treats an empty or blank value as unset", () => {
    rails("   ");
    expect(extraEvmRails(PAY_TO)).toEqual([]);
  });
});

describe("the minimal Arbitrum entry", () => {
  it("is completed from KNOWN_EVM_RAILS: USDT0, 6 decimals, the byte-exact USD₮0 domain, Arbiscan", () => {
    rails([{ network: "eip155:42161" }]);
    const [arbitrum] = extraEvmRails(PAY_TO);
    expect(arbitrum).toEqual({
      family: "evm",
      network: "eip155:42161",
      chainId: 42161,
      asset: ARBITRUM_USDT0,
      payTo: PAY_TO,
      symbol: "USDT0",
      decimals: 6,
      domain: { name: "USD₮0", version: "1" },
      rpcUrl: "https://arb1.arbitrum.io/rpc",
      explorer: "https://arbiscan.io",
    });
    // Unset means "the primary's facilitator", so the key is absent rather than undefined-valued.
    expect("facilitatorUrl" in arbitrum).toBe(false);
  });

  it("sits after the primary in every list; pages get it without the receiving address", () => {
    rails([{ network: "eip155:42161" }]);
    expect(evmRails().map((r) => [r.network, r.payTo])).toEqual([
      ["eip155:84532", PAY_TO],
      ["eip155:42161", PAY_TO],
    ]);
    expect(evmChains().map((r) => [r.network, r.payTo])).toEqual([
      ["eip155:84532", ""],
      ["eip155:42161", ""],
    ]);
    expect(paymentNetworks()).toEqual(["eip155:84532", "eip155:42161"]);
    expect(evmRailFor("eip155:42161")?.asset).toBe(ARBITRUM_USDT0);
    expect(evmRailFor("eip155:42161", { payTo: false })?.payTo).toBe("");
    expect(evmRailFor("eip155:1")).toBeNull();

    // A page needs no receiving address to list the chains.
    delete process.env.PLATFORM_RECEIVING_ADDRESS;
    resetEnv();
    expect(evmChains().map((r) => r.network)).toEqual(["eip155:84532", "eip155:42161"]);
    expect(() => evmRails()).toThrow(/PLATFORM_RECEIVING_ADDRESS/);
  });

  it("keeps a per-rail facilitator, and an RPC override from ARBITRUM_RPC_URL", () => {
    process.env.ARBITRUM_RPC_URL = "https://arb.example/rpc";
    rails([{ network: "eip155:42161", facilitatorUrl: CDP_URL }]);
    const [arbitrum] = extraEvmRails(PAY_TO);
    expect(arbitrum.facilitatorUrl).toBe(CDP_URL);
    expect(arbitrum.rpcUrl).toBe("https://arb.example/rpc");
  });

  it("orders paymentRails EVM first, the primary first of all, then Stellar", () => {
    setStellarTestnetEnv();
    rails([{ network: "eip155:42161" }]);
    expect(paymentRails().map((r) => r.network)).toEqual(["eip155:84532", "eip155:42161", "stellar:testnet"]);
    expect(paymentNetworks()).toEqual(["eip155:84532", "eip155:42161", "stellar:testnet"]);
  });

  it("takes a chain the table does not know when the entry says everything", () => {
    rails([
      {
        network: "eip155:10",
        asset: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
        symbol: "USDC",
        domain: { name: "USD Coin", version: "2" },
        rpcUrl: "https://mainnet.optimism.io",
      },
    ]);
    expect(extraEvmRails(PAY_TO)[0]).toMatchObject({ network: "eip155:10", chainId: 10, symbol: "USDC", domain: { name: "USD Coin", version: "2" }, explorer: "" });
  });
});

describe("mis-set is a named EvmRailConfigError", () => {
  const refuses = (value: unknown, message: RegExp) => {
    rails(value);
    expect(() => extraEvmRails(PAY_TO)).toThrow(EvmRailConfigError);
    expect(() => extraEvmRails(PAY_TO)).toThrow(message);
    // Every list reads through it, so the 402, the options and the pages all stop together.
    expect(() => evmRails()).toThrow(EvmRailConfigError);
    expect(() => evmChains()).toThrow(EvmRailConfigError);
  };

  it("refuses a value that is not JSON", () => refuses('[{"network":"eip155:42161"', /X402_EXTRA_EVM_RAILS is not JSON/));
  it("refuses JSON that is not an array", () => refuses({ network: "eip155:42161" }, /must be a JSON array/));
  it("refuses a network that is not eip155:<chainId>", () => refuses([{ network: "arbitrum" }], /\[0\]\.network must be eip155:<chainId>/));
  it("refuses an unknown network with no asset", () => refuses([{ network: "eip155:10" }], /\[0\] \(eip155:10\) needs an asset address; none known/));
  it("refuses an unknown network with an asset but no EIP-712 domain", () =>
    refuses([{ network: "eip155:10", asset: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", symbol: "USDC", rpcUrl: "https://mainnet.optimism.io" }], /needs the token's EIP-712 domain/));
  it("refuses a duplicate network", () => refuses([{ network: "eip155:42161" }, { network: "eip155:42161" }], /\[1\] repeats eip155:42161/));
  it("refuses an entry that repeats the primary network", () => refuses([{ network: "eip155:84532" }], /\[0\] repeats eip155:84532/));
});

describe("an overridden asset brings its own symbol and domain (W6a, 25 Oct 2026)", () => {
  const ARB_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

  it("refuses a different asset on a known network unless symbol and domain are given", () => {
    process.env.X402_EXTRA_EVM_RAILS = JSON.stringify([{ network: "eip155:42161", asset: ARB_USDC }]);
    resetEnv();
    expect(() => extraEvmRails(null)).toThrow(EvmRailConfigError);
    expect(() => extraEvmRails(null)).toThrow(/not the known token/);
  });

  it("accepts it once both are named, and does not borrow USDT0's domain", () => {
    process.env.X402_EXTRA_EVM_RAILS = JSON.stringify([{ network: "eip155:42161", asset: ARB_USDC, symbol: "USDC", domain: { name: "USD Coin", version: "2" } }]);
    resetEnv();
    const [rail] = extraEvmRails(null);
    expect(rail.symbol).toBe("USDC");
    expect(rail.domain).toEqual({ name: "USD Coin", version: "2" });
    expect(rail.rpcUrl).toBe("https://arb1.arbitrum.io/rpc");
  });

  it("still completes the known token from the table when the asset matches, in any letter case", () => {
    process.env.X402_EXTRA_EVM_RAILS = JSON.stringify([{ network: "eip155:42161", asset: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9" }]);
    resetEnv();
    const [rail] = extraEvmRails(null);
    expect(rail.symbol).toBe("USDT0");
    expect(rail.domain).toEqual({ name: "USD\u20AE0", version: "1" });
  });
});
