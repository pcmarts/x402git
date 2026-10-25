/**
 * What leaves for Vercel. The properties worth pinning are refusals: nothing identifying
 * ever goes, never more than two props, and nothing at all off Vercel.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const track = vi.fn(async () => undefined);
vi.mock("@vercel/analytics/server", () => ({ track }));

const { MAX_PROPS, mirrorToVercel, vercelPropsFor } = await import("@/lib/analytics/vercel");

afterEach(() => {
  delete process.env.VERCEL;
  track.mockClear();
});

describe("vercelPropsFor", () => {
  it("sends the shape of a sale and never its amount, quote or buyer", () => {
    expect(vercelPropsFor("402_issued", { kind: "new", version: "1.0.0", price_micro: "9000000", quote_id: "q_1" }, "api")).toEqual({
      kind: "new",
      source: "api",
    });
    expect(vercelPropsFor("settled", { kind: "update", gross_micro: "5000000" }, "web")).toEqual({ kind: "update", source: "web" });
  });

  it("never sends a creator or payout id from a sweep", () => {
    const out = vercelPropsFor("sweep", { creator_id: "c1", payout_id: "p1", amount_micro: "28800000", purchases: 4 });
    expect(out).toEqual({ purchases: 4 });
  });

  it("reduces reconcile to whether the books balanced", () => {
    expect(vercelPropsFor("reconcile", { variance_micro: "0", receiving_micro: "123" })).toEqual({ balanced: true });
    expect(vercelPropsFor("reconcile", { variance_micro: "-5" })).toEqual({ balanced: false });
  });

  it("sends an unknown event with no properties rather than guessing which are safe", () => {
    expect(vercelPropsFor("something_new", { creator_id: "c1", note: "free text" })).toBeUndefined();
    expect(vercelPropsFor("takedown_retired", { ref: "a/b", reason: "DMCA notice from Jane" })).toBeUndefined();
  });

  it("stays within Vercel Pro's property limit, drops objects, and truncates long strings", () => {
    for (const name of ["manifest_view", "402_issued", "settled", "free_grant", "listing_created", "release_cut"]) {
      const out = vercelPropsFor(name, { view: "human", bot: false, kind: "new", recorded: true, source: "api", key_kind: "agent", scan: "pass", licence: "pass" }, "api");
      expect(Object.keys(out ?? {}).length).toBeLessThanOrEqual(MAX_PROPS);
    }
    expect(vercelPropsFor("settle_failed", { code: { nested: true } }, null)).toBeUndefined();
    expect(vercelPropsFor("sweep_skipped", { reason: "x".repeat(400) })?.reason).toHaveLength(255);
  });
});

describe("mirrorToVercel", () => {
  it("does nothing off Vercel", () => {
    mirrorToVercel("settled", { kind: "new" }, "api");
    expect(track).not.toHaveBeenCalled();
  });

  it("tracks on Vercel with the allowed props only", () => {
    process.env.VERCEL = "1";
    mirrorToVercel("settled", { kind: "new", gross_micro: "9000000" }, "api");
    expect(track).toHaveBeenCalledWith("settled", { kind: "new", source: "api" });
  });

  it("swallows a failing track", async () => {
    process.env.VERCEL = "1";
    track.mockImplementationOnce(async () => {
      throw new Error("no request context");
    });
    expect(() => mirrorToVercel("download", {}, "api")).not.toThrow();
  });
});
