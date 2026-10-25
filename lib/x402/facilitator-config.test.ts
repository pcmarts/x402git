/**
 * Which facilitator this deployment talks to, and — the part worth a test — who gets
 * our CDP credentials. They are a bearer JWT, so "attach them to whatever URL is
 * configured" is a credential-disclosure bug waiting for a misconfiguration.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnv } from "@/lib/env";
import { facilitatorConfig } from "./server";

const KEYS = { CDP_API_KEY_ID: "test-key-id", CDP_API_KEY_SECRET: "test-key-secret" };
const CDP_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const PUBLIC_URL = "https://x402.org/facilitator";

let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = { ...process.env };
  process.env.PLATFORM_RECEIVING_ADDRESS = "0x0000000000000000000000000000000000000001";
  process.env.X402_NETWORK = "base-sepolia";
  delete process.env.CDP_API_KEY_ID;
  delete process.env.CDP_API_KEY_SECRET;
  delete process.env.X402_FACILITATOR_URL;
  resetEnv();
});

afterEach(() => {
  process.env = saved;
  resetEnv();
});

const withEnv = (vars: Record<string, string>) => {
  Object.assign(process.env, vars);
  resetEnv();
  return facilitatorConfig();
};

describe("facilitatorConfig", () => {
  it("is the library's own default when nothing is configured", () => {
    const config = facilitatorConfig();
    expect(config.url).toBeUndefined();
    expect(config.createAuthHeaders).toBeUndefined();
  });

  it("keeps a configured URL and sends no credentials when there are none", () => {
    const config = withEnv({ X402_FACILITATOR_URL: PUBLIC_URL });
    expect(config.url).toBe(PUBLIC_URL);
    expect(config.createAuthHeaders).toBeUndefined();
  });

  /**
   * The security property. Base Sepolia runs against the public facilitator, which
   * wants no key; if CDP keys are present in the same environment — as they are on
   * production today — they must not travel to it.
   */
  it("never sends CDP credentials to a facilitator that is not CDP's", () => {
    const config = withEnv({ ...KEYS, X402_FACILITATOR_URL: PUBLIC_URL });
    expect(config.url).toBe(PUBLIC_URL);
    expect(config.createAuthHeaders).toBeUndefined();
  });

  it("refuses a lookalike host", () => {
    const config = withEnv({ ...KEYS, X402_FACILITATOR_URL: "https://api.cdp.coinbase.com.evil.example/x402" });
    expect(config.createAuthHeaders).toBeUndefined();
  });

  it("attaches them to CDP's own host, and to a subdomain of it", () => {
    expect(withEnv({ ...KEYS, X402_FACILITATOR_URL: CDP_URL }).createAuthHeaders).toBeTypeOf("function");
    resetEnv();
    expect(withEnv({ ...KEYS, X402_FACILITATOR_URL: "https://x.api.cdp.coinbase.com/x402" }).createAuthHeaders).toBeTypeOf("function");
  });

  it("keeps the configured CDP URL rather than replacing it with the default", () => {
    const config = withEnv({ ...KEYS, X402_FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402-staging" });
    expect(config.url).toBe("https://api.cdp.coinbase.com/platform/v2/x402-staging");
  });

  /** The mainnet path: clear the URL, keep the keys, and CDP's default is used. */
  it("falls to CDP's own endpoint with credentials when no URL is set", () => {
    const config = withEnv(KEYS);
    expect(config.url).toContain("api.cdp.coinbase.com");
    expect(config.createAuthHeaders).toBeTypeOf("function");
  });

  it("ignores a half-configured credential pair", () => {
    const config = withEnv({ CDP_API_KEY_ID: "only-the-id" });
    expect(config.createAuthHeaders).toBeUndefined();
  });

  /**
   * Not a test of CDP's signing — that is their contract, and the header shape is
   * theirs to keep. It is a test that we wired the real signer rather than something
   * that returns an empty object: a stub would resolve happily on this nonsense key,
   * and every settle would then fail at the facilitator with no clue why.
   */
  it("wires a signer that actually signs, rather than a no-op", async () => {
    const config = withEnv(KEYS);
    await expect(config.createAuthHeaders?.()).rejects.toThrow();
  });
});
