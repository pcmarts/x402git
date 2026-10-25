/**
 * lib/x402/server.evm-rails.test.ts — the facilitator boundary with two EVM rails
 * (25 Oct 2026, docs/HACKMERIDIAN-EVM-USDT0-RAIL.md §2.3).
 *
 * The hack deployment's shape: Base Sepolia on the public facilitator, USDT0 on Arbitrum
 * at Coinbase's. Each rail is settled by its own facilitator; the CDP key pair travels only
 * to CDP's host, per URL; and an EVM payload is paid only against the accept of its own
 * network, token and receiving address, checked before any facilitator is asked.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnv } from "@/lib/env";
import { nonceHex, requirement, signatureHeader, stubFacilitator } from "@/lib/test/x402";
import {
  decodeSignature,
  facilitatorConfig,
  resetFacilitator,
  resourceServer,
  resourceServerFor,
  selectRequirement,
  setFacilitator,
  setFacilitatorFor,
  verifyAndSettle,
} from "./server";

const PAYER = "0xAAaAAAaAAaaAaaAaAaAAAAaAaAaAaAAAAaaAAaAa";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const ARBITRUM_USDT0 = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9";
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const CDP_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const PUBLIC_URL = "https://x402.org/facilitator";
const KEYS = { CDP_API_KEY_ID: "test-key-id", CDP_API_KEY_SECRET: "test-key-secret" };

let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = { ...process.env };
  delete process.env.CDP_API_KEY_ID;
  delete process.env.CDP_API_KEY_SECRET;
  process.env.PLATFORM_RECEIVING_ADDRESS = PAY_TO;
  process.env.X402_NETWORK = "base-sepolia";
  process.env.X402_FACILITATOR_URL = PUBLIC_URL;
  process.env.X402_EXTRA_EVM_RAILS = JSON.stringify([{ network: "eip155:42161", facilitatorUrl: CDP_URL }]);
  resetEnv();
});

afterEach(() => {
  resetFacilitator();
  process.env = saved;
  resetEnv();
});

/** The Arbitrum accept, as `toPaymentRequirements` builds it. */
const arbitrum = (amountMicro: bigint) =>
  requirement(amountMicro, { network: "eip155:42161", asset: ARBITRUM_USDT0, extra: { name: "USD₮0", version: "1" } });
const arbitrumHeader = (amountMicro: bigint, nonce: string, overrides: { asset?: string; payTo?: string; network?: string } = {}) =>
  signatureHeader({ from: PAYER, amountMicro, nonce, network: "eip155:42161", asset: ARBITRUM_USDT0, payTo: PAY_TO, ...overrides });

describe("facilitatorConfig(url) — rule 1 holds for every rail's URL", () => {
  it("attaches the CDP key pair to the Arbitrum rail's CDP URL while the primary stays keyless on x402.org", () => {
    Object.assign(process.env, KEYS);
    resetEnv();
    const primary = facilitatorConfig();
    expect(primary.url).toBe(PUBLIC_URL);
    expect(primary.createAuthHeaders).toBeUndefined();

    const rail = facilitatorConfig(CDP_URL);
    expect(rail.url).toBe(CDP_URL);
    expect(rail.createAuthHeaders).toBeTypeOf("function");
  });

  it("never sends the key pair to a rail URL that is not CDP's, nor to a lookalike", () => {
    Object.assign(process.env, KEYS, { X402_FACILITATOR_URL: CDP_URL });
    resetEnv();
    expect(facilitatorConfig().createAuthHeaders).toBeTypeOf("function");
    expect(facilitatorConfig("https://facilitator.example/x402")).toEqual({ url: "https://facilitator.example/x402" });
    expect(facilitatorConfig("https://api.cdp.coinbase.com.evil.example/x402").createAuthHeaders).toBeUndefined();
  });

  it("treats an omitted or empty URL as the primary's", () => {
    expect(facilitatorConfig(undefined)).toEqual({ url: PUBLIC_URL });
    delete process.env.X402_FACILITATOR_URL;
    resetEnv();
    expect(facilitatorConfig("")).toEqual({});
  });
});

describe("resourceServerFor — one server per facilitator URL", () => {
  it("gives Arbitrum its own server when its facilitatorUrl differs, and keeps it", () => {
    const base = resourceServerFor("eip155:84532");
    const arb = resourceServerFor("eip155:42161");
    expect(base).toBe(resourceServer());
    expect(arb).not.toBe(base);
    expect(resourceServerFor("eip155:42161")).toBe(arb);
  });

  it("shares the primary's server when the rail names no facilitator, or names the primary's", () => {
    process.env.X402_EXTRA_EVM_RAILS = '[{"network":"eip155:42161"}]';
    resetEnv();
    expect(resourceServerFor("eip155:42161")).toBe(resourceServer());

    resetFacilitator();
    process.env.X402_EXTRA_EVM_RAILS = JSON.stringify([{ network: "eip155:42161", facilitatorUrl: PUBLIC_URL }]);
    resetEnv();
    expect(resourceServerFor("eip155:42161")).toBe(resourceServer());
  });

  it("refuses an EVM network no rail serves rather than forwarding it to the primary", () => {
    expect(() => resourceServerFor("eip155:1")).toThrow(/no EVM rail on this deployment serves eip155:1/);
  });
});

describe("verifyAndSettle — each EVM rail is settled by its own facilitator", () => {
  it("settles an Arbitrum payload at the Arbitrum facilitator, against the USD₮0 requirement, and Base's is never asked", async () => {
    const base = stubFacilitator();
    const arb = stubFacilitator();
    setFacilitator(base.client);
    setFacilitatorFor(CDP_URL, arb.client);

    const result = await verifyAndSettle(arbitrumHeader(2_000_000n, nonceHex("a1")), arbitrum(2_000_000n));
    expect(result).toMatchObject({ ok: true, network: "eip155:42161", nonce: nonceHex("a1"), amountMicro: 2_000_000n });
    expect(arb.verifyCalls).toHaveLength(1);
    expect(arb.settleCalls).toHaveLength(1);
    expect(arb.verifyCalls[0].requirements).toMatchObject({ network: "eip155:42161", asset: ARBITRUM_USDT0, extra: { name: "USD₮0", version: "1" } });
    expect(base.verifyCalls).toHaveLength(0);
    expect(base.settleCalls).toHaveLength(0);
  });

  it("still settles a Base payload at the primary facilitator", async () => {
    const base = stubFacilitator();
    const arb = stubFacilitator();
    setFacilitator(base.client);
    setFacilitatorFor(CDP_URL, arb.client);

    const result = await verifyAndSettle(signatureHeader({ from: PAYER, amountMicro: 2_000_000n, nonce: nonceHex("b1"), payTo: PAY_TO }), requirement(2_000_000n));
    expect(result).toMatchObject({ ok: true, network: "eip155:84532" });
    expect(base.settleCalls).toHaveLength(1);
    expect(arb.verifyCalls).toHaveLength(0);
  });
});

describe("verifyAndSettle — an EVM payload is paid only against its own rail's accept, checked locally", () => {
  const cases: [string, () => [string, ReturnType<typeof requirement>], RegExp][] = [
    ["an Arbitrum payload sent to the Base requirement", () => [arbitrumHeader(2_000_000n, nonceHex("c1")), requirement(2_000_000n)], /is for eip155:42161, not eip155:84532/],
    ["a Base payload sent to the Arbitrum requirement", () => [signatureHeader({ from: PAYER, amountMicro: 2_000_000n, nonce: nonceHex("c2"), payTo: PAY_TO }), arbitrum(2_000_000n)], /is for eip155:84532, not eip155:42161/],
    ["an Arbitrum payload in Base's USDC rather than USDT0", () => [arbitrumHeader(2_000_000n, nonceHex("c3"), { asset: BASE_SEPOLIA_USDC }), arbitrum(2_000_000n)], /not in USDT0/],
    ["an Arbitrum payload to someone else's address", () => [arbitrumHeader(2_000_000n, nonceHex("c4"), { payTo: "0x2222222222222222222222222222222222222222" }), arbitrum(2_000_000n)], /receiving address/],
    ["a requirement that is not the rail's own token", () => [arbitrumHeader(2_000_000n, nonceHex("c5"), { asset: BASE_SEPOLIA_USDC }), requirement(2_000_000n, { network: "eip155:42161", asset: BASE_SEPOLIA_USDC })], /not this deployment's USDT0/],
    ["an EVM network this deployment does not run", () => [arbitrumHeader(2_000_000n, nonceHex("c6"), { network: "eip155:1" }), requirement(2_000_000n, { network: "eip155:1" })], /does not take payments on eip155:1/],
  ];

  for (const [name, make, message] of cases) {
    it(`is authorization_mismatch for ${name}, with no facilitator call`, async () => {
      const base = stubFacilitator();
      const arb = stubFacilitator();
      setFacilitator(base.client);
      setFacilitatorFor(CDP_URL, arb.client);

      const [header, req] = make();
      const result = await verifyAndSettle(header, req);
      expect(result).toMatchObject({ ok: false, code: "authorization_mismatch", payer: PAYER });
      if (!result.ok) expect(result.message).toMatch(message);
      expect([...base.verifyCalls, ...base.settleCalls, ...arb.verifyCalls, ...arb.settleCalls]).toHaveLength(0);
    });
  }

  it("checks a Permit2 payload's token and witness recipient the same way", async () => {
    const arb = stubFacilitator();
    setFacilitatorFor(CDP_URL, arb.client);
    const permit2 = (token: string, to: string) => {
      const p = JSON.parse(Buffer.from(arbitrumHeader(2_000_000n, nonceHex("d1")), "base64").toString("utf8"));
      p.payload = {
        signature: "0x" + "ab".repeat(65),
        permit2Authorization: {
          from: PAYER,
          permitted: { token, amount: "2000000" },
          spender: "0x402085c248EeA27D92E8b30b2C58ed07f9E20001",
          nonce: "123456789",
          deadline: "1900000000",
          witness: { to, validAfter: "0" },
        },
      };
      return Buffer.from(JSON.stringify(p), "utf8").toString("base64");
    };

    expect(await verifyAndSettle(permit2(BASE_SEPOLIA_USDC, PAY_TO), arbitrum(2_000_000n))).toMatchObject({ ok: false, code: "authorization_mismatch" });
    expect(await verifyAndSettle(permit2(ARBITRUM_USDT0, "0x2222222222222222222222222222222222222222"), arbitrum(2_000_000n))).toMatchObject({ ok: false, code: "authorization_mismatch" });
    expect(arb.verifyCalls).toHaveLength(0);
    expect(await verifyAndSettle(permit2(ARBITRUM_USDT0, PAY_TO), arbitrum(2_000_000n))).toMatchObject({ ok: true, network: "eip155:42161" });
    expect(arb.settleCalls).toHaveLength(1);
  });
});

describe("selectRequirement with two EVM accepts", () => {
  it("picks the accept of the payload's own network, and nothing for a network that is not on the wire", () => {
    const accepts = [requirement(2_000_000n), arbitrum(2_000_000n)];
    const arbPayload = decodeSignature(arbitrumHeader(2_000_000n, nonceHex("e1")))!;
    const basePayload = decodeSignature(signatureHeader({ from: PAYER, amountMicro: 2_000_000n, nonce: nonceHex("e2"), payTo: PAY_TO }))!;
    const ethPayload = decodeSignature(arbitrumHeader(2_000_000n, nonceHex("e3"), { network: "eip155:1" }))!;
    expect(selectRequirement(accepts, arbPayload)).toBe(accepts[1]);
    expect(selectRequirement(accepts, basePayload)).toBe(accepts[0]);
    expect(selectRequirement(accepts, ethPayload)).toBeNull();
  });
});
