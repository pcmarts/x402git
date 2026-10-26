/**
 * The guard that would have caught pointing a Base mainnet RPC at a Sepolia deployment
 * — the shape of mistake that has no symptom until the sweep broadcasts to one chain
 * while the ledger describes another.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRpcServesChain, resetChainCheck } from "./chain";
import { resetEnv } from "./env";

const reader = (chainId: number) => ({ getChainId: vi.fn(async () => chainId) });

beforeEach(() => {
  resetChainCheck();
  process.env.EVM_RPC_URL = "https://api.developer.coinbase.com/rpc/v1/base/SECRET";
  resetEnv();
});

afterEach(() => {
  delete process.env.EVM_RPC_URL;
  resetChainCheck();
  resetEnv();
});

describe("assertRpcServesChain", () => {
  it("passes when the RPC serves the configured chain", async () => {
    await expect(assertRpcServesChain(reader(8453), 8453, "sweep")).resolves.toBeUndefined();
  });

  it("refuses when it serves a different one", async () => {
    await expect(assertRpcServesChain(reader(8453), 84532, "sweep")).rejects.toThrow(/serves chain 8453.*configured for chain 84532/s);
  });

  it("names the rail's own RPC when one is passed, and memoises per URL", async () => {
    const err = await assertRpcServesChain(reader(8453), 42161, "sweep eip155:42161", "https://arb1.arbitrum.io/rpc/KEY").catch((e: Error) => e);
    expect((err as Error).message).toContain("arb1.arbitrum.io");
    expect((err as Error).message).not.toContain("KEY");
    expect((err as Error).message).not.toContain("api.developer.coinbase.com");
    // A different URL for the same chain is asked again, not answered from the primary's memo.
    const client = reader(42161);
    await assertRpcServesChain(client, 42161, "sweep", "https://a.example");
    await assertRpcServesChain(client, 42161, "sweep", "https://b.example");
    expect(client.getChainId).toHaveBeenCalledTimes(2);
  });

  /** An RPC URL is often a credential. The error names the host and never the path. */
  it("never puts the RPC URL in the error", async () => {
    const err = await assertRpcServesChain(reader(8453), 84532, "sweep").catch((e: Error) => e);
    expect((err as Error).message).toContain("api.developer.coinbase.com");
    expect((err as Error).message).not.toContain("SECRET");
  });

  it("asks once per process, not once per creator", async () => {
    const client = reader(8453);
    await assertRpcServesChain(client, 8453, "sweep");
    await assertRpcServesChain(client, 8453, "sweep");
    await assertRpcServesChain(client, 8453, "sweep");
    expect(client.getChainId).toHaveBeenCalledTimes(1);
  });

  /** A failed check must not be remembered as done — the next run has to ask again. */
  it("does not memoise a failure", async () => {
    const client = reader(8453);
    await expect(assertRpcServesChain(client, 84532, "sweep")).rejects.toThrow();
    await expect(assertRpcServesChain(client, 84532, "sweep")).rejects.toThrow();
    expect(client.getChainId).toHaveBeenCalledTimes(2);
  });

  it("names the caller, so a failing cron says which one it was", async () => {
    await expect(assertRpcServesChain(reader(1), 8453, "reconcile")).rejects.toThrow(/^reconcile:/);
  });
});
