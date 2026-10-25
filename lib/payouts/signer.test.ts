import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnv } from "@/lib/env";
import { sweepSignerAddress } from "./signer";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

beforeEach(() => resetEnv());
afterEach(() => {
  delete process.env.SWEEP_WALLET_PRIVATE_KEY;
  resetEnv();
});

const withKey = (v: string) => {
  process.env.SWEEP_WALLET_PRIVATE_KEY = v;
  resetEnv();
  return sweepSignerAddress();
};

describe("sweepSignerAddress", () => {
  it("derives the address the configured key will pay from", () => {
    expect(withKey(KEY)).toBe(ADDRESS);
  });

  it("accepts a key written without the 0x prefix", () => {
    expect(withKey(KEY.slice(2))).toBe(ADDRESS);
  });

  it("is null when the deployment holds no signer (§14.8)", () => {
    expect(sweepSignerAddress()).toBeNull();
  });

  it("is null rather than throwing on a malformed key", () => {
    expect(withKey("not-a-key")).toBeNull();
  });

  /** The whole point: the key must not be recoverable from what this returns. */
  it("never returns anything containing the key", () => {
    const out = withKey(KEY);
    expect(out).not.toContain(KEY.slice(2, 20));
    expect(out).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
