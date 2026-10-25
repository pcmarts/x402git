/**
 * lib/env.stellar.test.ts — `stellarRail()`: unset is off, the defaults are the two real
 * assets, and a mis-set asset is a boot error with a name, never a per-request surprise.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearStellarEnv, STELLAR_PAY_TO } from "@/lib/test/stellar";
import { crossChainPayouts, paymentNetworks, paymentRails, resetEnv, STELLAR_PUBNET_PINNED_ISSUER, StellarRailConfigError, stellarRail, stellarSweepSecret } from "./env";

const TESTNET_USDC = {
  code: "USDC",
  issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  contract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
};
const PUBNET_USDT0 = {
  code: "USDT0",
  issuer: "GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q",
  contract: "CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF",
};

beforeEach(() => {
  clearStellarEnv();
  process.env.X402_NETWORK = "base-sepolia";
  process.env.PLATFORM_RECEIVING_ADDRESS = "0x1111111111111111111111111111111111111111";
  resetEnv();
});
afterEach(() => {
  clearStellarEnv();
  delete process.env.X402_NETWORK;
  delete process.env.PLATFORM_RECEIVING_ADDRESS;
  resetEnv();
});

describe("stellarRail()", () => {
  it("is null when STELLAR_NETWORK is unset, and the rail lists stay EVM-only", () => {
    expect(stellarRail()).toBeNull();
    expect(paymentNetworks()).toEqual(["eip155:84532"]);
    expect(paymentRails().map((r) => r.family)).toEqual(["evm"]);
    expect(stellarSweepSecret()).toBeNull();
    expect(crossChainPayouts()).toBe("off");
  });

  it("defaults testnet to Circle's testnet USDC and the public endpoints", () => {
    process.env.STELLAR_NETWORK = "stellar:testnet";
    process.env.STELLAR_RECEIVING_ADDRESS = STELLAR_PAY_TO;
    resetEnv();
    const rail = stellarRail();
    expect(rail).toMatchObject({
      family: "stellar",
      network: "stellar:testnet",
      chainId: null,
      asset: TESTNET_USDC,
      payTo: STELLAR_PAY_TO,
      horizonUrl: "https://horizon-testnet.stellar.org",
      rpcUrl: "https://soroban-testnet.stellar.org",
      facilitatorUrl: "https://x402.org/facilitator",
      facilitatorApiKey: null,
    });
    expect(paymentNetworks()).toEqual(["eip155:84532", "stellar:testnet"]);
    expect(paymentRails().map((r) => r.network)).toEqual(["eip155:84532", "stellar:testnet"]);
  });

  it("defaults pubnet to Tether's USDT0 and requires an RPC URL there", () => {
    process.env.STELLAR_NETWORK = "stellar:pubnet";
    process.env.STELLAR_RECEIVING_ADDRESS = STELLAR_PAY_TO;
    resetEnv();
    expect(() => stellarRail()).toThrow(StellarRailConfigError);
    expect(() => stellarRail()).toThrow(/STELLAR_RPC_URL is required/);

    process.env.STELLAR_RPC_URL = "https://rpc.example/soroban";
    process.env.STELLAR_FACILITATOR_API_KEY = "oz-key";
    resetEnv();
    expect(stellarRail()).toMatchObject({
      network: "stellar:pubnet",
      asset: PUBNET_USDT0,
      horizonUrl: "https://horizon.stellar.org",
      facilitatorUrl: "https://channels.openzeppelin.com/x402",
      facilitatorApiKey: "oz-key",
    });
    expect(STELLAR_PUBNET_PINNED_ISSUER).toBe(PUBNET_USDT0.issuer);
  });

  it("requires a G… receiving address when the rail is on", () => {
    process.env.STELLAR_NETWORK = "stellar:testnet";
    resetEnv();
    expect(() => stellarRail()).toThrow(/STELLAR_RECEIVING_ADDRESS/);
    process.env.STELLAR_RECEIVING_ADDRESS = "0x1111111111111111111111111111111111111111";
    resetEnv();
    expect(() => stellarRail()).toThrow(/STELLAR_RECEIVING_ADDRESS/);
  });

  it("refuses an unknown network name", () => {
    process.env.STELLAR_NETWORK = "stellar:futurenet";
    process.env.STELLAR_RECEIVING_ADDRESS = STELLAR_PAY_TO;
    resetEnv();
    expect(() => stellarRail()).toThrow(/stellar:testnet or stellar:pubnet/);
  });

  describe("the asset (USDT0 §3.2, BATTLE-TEST finding 13)", () => {
    beforeEach(() => {
      process.env.STELLAR_NETWORK = "stellar:testnet";
      process.env.STELLAR_RECEIVING_ADDRESS = STELLAR_PAY_TO;
    });

    it("takes all three values together, and refuses a partial set", () => {
      process.env.STELLAR_ASSET_CODE = "USDC";
      resetEnv();
      expect(() => stellarRail()).toThrow(/set together or not at all/);
    });

    it("throws a named error when the contract is not the SAC of code:issuer", () => {
      process.env.STELLAR_ASSET_ADDRESS = PUBNET_USDT0.contract; // USDT0's SAC with USDC's code+issuer
      process.env.STELLAR_ASSET_CODE = TESTNET_USDC.code;
      process.env.STELLAR_ASSET_ISSUER = TESTNET_USDC.issuer;
      resetEnv();
      let thrown: unknown;
      try {
        stellarRail();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(StellarRailConfigError);
      expect((thrown as Error).name).toBe("StellarRailConfigError");
      // Names the SAC the SDK derived, so the operator can compare.
      expect((thrown as Error).message).toContain(TESTNET_USDC.contract);
    });

    it("accepts an explicit, consistent asset", () => {
      process.env.STELLAR_ASSET_ADDRESS = TESTNET_USDC.contract;
      process.env.STELLAR_ASSET_CODE = TESTNET_USDC.code;
      process.env.STELLAR_ASSET_ISSUER = TESTNET_USDC.issuer;
      resetEnv();
      expect(stellarRail()?.asset).toEqual(TESTNET_USDC);
    });

    it("pins the pubnet issuer to Tether's unless STELLAR_ALLOW_CUSTOM_ASSET=1", () => {
      // A consistent triple (code, issuer, derived SAC) that is not USDT0: our own issuer.
      process.env.STELLAR_NETWORK = "stellar:pubnet";
      process.env.STELLAR_RPC_URL = "https://rpc.example/soroban";
      process.env.STELLAR_ASSET_CODE = "USDC";
      process.env.STELLAR_ASSET_ISSUER = TESTNET_USDC.issuer;
      // Derived for USDC:<testnet issuer> on the *pubnet* passphrase.
      process.env.STELLAR_ASSET_ADDRESS = "CAMXTUKKGSRVMA3QOQEQBEZO56DBEO4EEWJJVDGNGX2VWSNE5BDBGACQ";
      resetEnv();
      expect(() => stellarRail()).toThrow(/STELLAR_ASSET_ISSUER on stellar:pubnet must be GATISXX6/);

      process.env.STELLAR_ALLOW_CUSTOM_ASSET = "1";
      resetEnv();
      // The pin lifts; the derivation check still has to pass.
      const rail = stellarRail();
      expect(rail?.asset.issuer).toBe(TESTNET_USDC.issuer);
    });
  });
});
