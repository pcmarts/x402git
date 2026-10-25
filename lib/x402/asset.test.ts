/**
 * lib/x402/asset.test.ts — the EIP-712 domains the 402 advertises, pinned.
 *
 * A wrong domain fails nowhere but at settle, so each one is pinned here byte for byte.
 * The Arbitrum pin is the reason the file exists (25 Oct 2026,
 * docs/HACKMERIDIAN-EVM-USDT0-RAIL.md §5): USDT0's name is `USD₮0`, with U+20AE, and
 * `@x402/evm`'s table would have answered USDC's `("USDC", "2")` for it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnv } from "@/lib/env";
import { assetDomain } from "./asset";

const ARBITRUM_USDT0 = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9";
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

beforeEach(() => {
  delete process.env.X402_EXTRA_EVM_RAILS;
  delete process.env.X402_ASSET_ADDRESS;
  process.env.X402_NETWORK = "base-sepolia";
  resetEnv();
});
afterEach(() => {
  delete process.env.X402_EXTRA_EVM_RAILS;
  delete process.env.X402_ASSET_ADDRESS;
  delete process.env.X402_NETWORK;
  resetEnv();
});

describe("assetDomain", () => {
  it("pins Arbitrum USDT0 to USD₮0 / 1, byte-exact, from the rail", () => {
    process.env.X402_EXTRA_EVM_RAILS = '[{"network":"eip155:42161"}]';
    resetEnv();
    const domain = assetDomain("eip155:42161", ARBITRUM_USDT0);
    expect(domain).toEqual({ name: "USD₮0", version: "1" });
    // The ₮ is three UTF-8 bytes (e2 82 ae); a lookalike "T" or a stripped one would sign for another domain.
    expect(Buffer.from(domain.name, "utf8").toString("hex")).toBe("555344e282ae30");
    // The address is compared case-blind.
    expect(assetDomain("eip155:42161", ARBITRUM_USDT0.toLowerCase())).toEqual(domain);
  });

  it("throws for USDT0 on Arbitrum when the rail is not configured, rather than guessing USDC's domain", () => {
    expect(() => assetDomain("eip155:42161", ARBITRUM_USDT0)).toThrow(/no EIP-712 domain is known for asset 0xFd08.* on eip155:42161/);
  });

  it("throws for any non-primary network with no answer", () => {
    expect(() => assetDomain("eip155:999999", "0x0000000000000000000000000000000000000001")).toThrow(/no EIP-712 domain/);
  });

  it("still answers from @x402/evm's table for an asset it lists, rail or not (Arbitrum USDC)", () => {
    expect(assetDomain("eip155:42161", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831")).toEqual({ name: "USD Coin", version: "2" });
  });

  it("keeps the two Base domains: USDC/2 on Sepolia, USD Coin/2 on mainnet", () => {
    expect(assetDomain("eip155:84532", BASE_SEPOLIA_USDC)).toEqual({ name: "USDC", version: "2" });
    process.env.X402_NETWORK = "base";
    resetEnv();
    expect(assetDomain("eip155:8453", BASE_USDC)).toEqual({ name: "USD Coin", version: "2" });
  });

  it("falls back to USDC/2 for a custom asset on the primary network only, as it always has", () => {
    const custom = "0x00000000000000000000000000000000000000c5";
    process.env.X402_ASSET_ADDRESS = custom;
    resetEnv();
    expect(assetDomain("eip155:84532", custom)).toEqual({ name: "USDC", version: "2" });
  });

  it("does not take the primary rail's guessed domain over @x402/evm's table for a custom primary", () => {
    // Polygon USDC as the primary: KNOWN_EVM_RAILS does not list Polygon, so `evmRail()`'s
    // domain is the USDC/2 guess; the x402 table knows it is "USD Coin".
    process.env.X402_NETWORK = "eip155:137";
    process.env.X402_ASSET_ADDRESS = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
    resetEnv();
    expect(assetDomain("eip155:137", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359")).toEqual({ name: "USD Coin", version: "2" });
  });
});
