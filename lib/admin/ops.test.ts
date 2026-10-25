/**
 * The ops half of `/admin`: which switches are thrown, which payouts are stuck, and the
 * one line the tally prints for both.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { healthSummary, loadOpsHealth } from "@/lib/admin/ops";
import { resetDb, setDb, type Db } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { SWITCHES } from "@/lib/ops/switches";
import { makeMockDb } from "@/lib/test/mock-db";

describe("healthSummary", () => {
  const s = (name: string) => ({ name, paused: true, reason: null, updated_at: "", updated_by: null });

  it("says everything is live when nothing is wrong", () => {
    expect(healthSummary({ switches: SWITCHES.map((n) => s(n)), paused: [], stuck: [] })).toBe("4 switches live · no payout stuck");
  });

  it("names the paused switches rather than counting them", () => {
    expect(healthSummary({ switches: [], paused: [s("payments"), s("sweeps")], stuck: [] })).toContain("payments, sweeps PAUSED");
  });

  it("counts stuck payouts, singular and plural", () => {
    const stuck = { id: "p", creatorId: "c", amountMicro: 1n, toAddress: "0x", status: "pending", createdAt: "" };
    expect(healthSummary({ switches: [], paused: [], stuck: [stuck] })).toContain("1 payout stuck");
    expect(healthSummary({ switches: [], paused: [], stuck: [stuck, stuck] })).toContain("2 payouts stuck");
  });
});

describe("loadOpsHealth", () => {
  beforeEach(() => {
    process.env.X402_NETWORK = "base-sepolia";
    resetEnv();
  });

  afterEach(() => {
    resetDb();
    delete process.env.X402_NETWORK;
    resetEnv();
  });

  it("is clear when no switch is thrown and no payout is stuck", async () => {
    setDb(makeMockDb({ ops_switch: SWITCHES.map((name) => ({ name, paused: false })) }).client as unknown as Db);
    const health = await loadOpsHealth();
    expect(health.clear).toBe(true);
    expect(health.switches).toHaveLength(4);
  });

  it("shows every known switch even when the table has no rows for them", async () => {
    setDb(makeMockDb({}).client as unknown as Db);
    const health = await loadOpsHealth();
    expect(health.switches.map((s) => s.name)).toEqual([...SWITCHES]);
    expect(health.paused).toEqual([]);
    expect(health.clear).toBe(true);
  });

  it("reports a paused switch with the operator's reason", async () => {
    setDb(
      makeMockDb({
        ops_switch: [{ name: "payments", paused: true, reason: "facilitator down", updated_by: "pcmarts" }],
      }).client as unknown as Db,
    );
    const health = await loadOpsHealth();
    expect(health.clear).toBe(false);
    expect(health.paused).toHaveLength(1);
    expect(health.paused[0].reason).toBe("facilitator down");
  });

  it("finds pending and broadcast payouts, and ignores confirmed ones", async () => {
    setDb(
      makeMockDb({
        payout: [
          { id: "p1", creator_id: "c1", amount_micro: "8100000", to_address: "0xaaa", status: "pending", chain_id: 84532 },
          { id: "p2", creator_id: "c2", amount_micro: "4500000", to_address: "0xbbb", status: "broadcast", chain_id: 84532 },
          { id: "p3", creator_id: "c3", amount_micro: "9000000", to_address: "0xccc", status: "confirmed", chain_id: 84532 },
          { id: "p4", creator_id: "c4", amount_micro: "1000000", to_address: "0xddd", status: "failed", chain_id: 84532 },
        ],
      }).client as unknown as Db,
    );

    const health = await loadOpsHealth();
    expect(health.stuck.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
    expect(health.stuck.find((p) => p.id === "p1")?.amountMicro).toBe(8_100_000n);
    expect(health.clear).toBe(false);
  });

  it("ignores a stuck payout on another chain — a Sepolia row must not alarm mainnet", async () => {
    setDb(
      makeMockDb({
        payout: [{ id: "p1", creator_id: "c1", amount_micro: "1", to_address: "0xaaa", status: "pending", chain_id: 8453 }],
      }).client as unknown as Db,
    );
    const health = await loadOpsHealth();
    expect(health.stuck).toEqual([]);
    expect(health.chainId).toBe(84532);
  });
});

describe("degrading rather than crashing the listings page", () => {
  it("returns no stuck payouts when the payout read errors, instead of throwing", async () => {
    // A deployment without migration 20260906010000 has no `payout.chain_id` to filter
    // on. That must cost a warning line, not the whole /admin page.
    const broken = {
      from: (table: string) =>
        table === "payout"
          ? {
              select: () => ({
                eq: () => ({ in: () => ({ order: () => Promise.resolve({ data: null, error: { message: 'column "chain_id" does not exist' } }) }) }),
              }),
            }
          : { select: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) },
    };
    setDb(broken as unknown as Db);

    const health = await loadOpsHealth();
    expect(health.stuck).toEqual([]);
    expect(health.switches).toHaveLength(4);
    expect(health.clear).toBe(true);
  });
});
