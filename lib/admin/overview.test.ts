/**
 * The overview's attention list: its order is its meaning — commerce stopped, then
 * people unpaid, then breakage, then review — and an all-clear is an empty list.
 */

import { describe, expect, it } from "vitest";
import { attentionItems } from "@/lib/admin/overview";

const quiet = { paused: [], stuck: [], totals: { owedMicro: 0n, blockedCreators: 0 }, failures: [], flagged: 0, rebinding: [] };

describe("attentionItems", () => {
  it("is empty when nothing needs a human", () => {
    expect(attentionItems(quiet)).toEqual([]);
  });

  it("orders stopped commerce before unpaid people before review", () => {
    const items = attentionItems({
      ...quiet,
      flagged: 2,
      paused: [{ name: "payments", paused: true, reason: "facilitator 5xx", updated_at: "", updated_by: "pcmarts" }],
      stuck: [{ id: "p", creatorId: "c", amountMicro: 28_800_000n, toAddress: "0x", status: "pending", createdAt: "" }],
      totals: { owedMicro: 1_000_000n, blockedCreators: 1 },
    });
    expect(items.map((i) => i.action)).toEqual(["Ops", "Ops", "Review", "Money"]);
    expect(items[0]).toMatchObject({ status: "fail", text: "payments is paused — facilitator 5xx (pcmarts)" });
    expect(items[1].text).toBe("1 payout stuck, $28.80 — 1 creator not being paid");
    expect(items[2]).toMatchObject({ text: "2 listings flagged for review", href: "/admin/listings?status=review" });
  });

  it("links a rebinding creator to their own page", () => {
    expect(attentionItems({ ...quiet, rebinding: ["adrian"] })[0]).toMatchObject({ href: "/admin/creators/adrian", status: "warn" });
  });

  it("treats a kill-switch refusal as a warning and a settlement failure as a failure", () => {
    const items = attentionItems({
      ...quiet,
      failures: [
        { name: "settle_failed", cause: "insufficient_funds", count: 3, lastAt: "2026-09-13T01:00:00Z" },
        { name: "paused_block", cause: "payments", count: 9, lastAt: "2026-09-13T01:00:00Z" },
      ],
    });
    expect(items.map((i) => i.status)).toEqual(["fail", "warn"]);
  });
});
