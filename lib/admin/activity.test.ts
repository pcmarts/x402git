/**
 * The funnel and the failure grouping.
 *
 * The property this file exists to protect: **`viewsPerPurchase` is null, not zero, when
 * views have not been recorded.** PRODUCT.md calls it the number that decides the whole
 * product, manifest views were not instrumented until 2026-09-07, and a page that prints
 * `0.0` for "we have not measured this" is a page that answers the founder's central
 * question with a fabrication.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bySourceFrom, describeProps, failuresFrom, funnelFrom, loadActivity, MANIFEST_VIEW_SINCE, viewsCoverWindow } from "@/lib/admin/activity";
import { resetDb, setDb, type Db } from "@/lib/db";
import type { EventRow } from "@/lib/db/types";
import { resetEnv } from "@/lib/env";
import { makeMockDb } from "@/lib/test/mock-db";

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function ev(name: string, over: Partial<EventRow> = {}): EventRow {
  return { id: Math.random(), name, listing_id: null, buyer_address: null, source: null, props: null, at: iso(DAY), ...over } as EventRow;
}

describe("funnelFrom", () => {
  it("counts each step", () => {
    const f = funnelFrom([ev("manifest_view"), ev("manifest_view"), ev("402_issued"), ev("settled"), ev("download")]);
    expect(f.views).toBe(2);
    expect(f.issued).toBe(1);
    expect(f.settled).toBe(1);
    expect(f.downloads).toBe(1);
  });

  it("computes checkout conversion as settled over quoted", () => {
    const f = funnelFrom([ev("402_issued"), ev("402_issued"), ev("402_issued"), ev("402_issued"), ev("settled")]);
    expect(f.conversion).toBe("25.0%");
  });

  it("has a null conversion rather than a division by zero when nothing was quoted", () => {
    expect(funnelFrom([ev("manifest_view")]).conversion).toBeNull();
  });

  it("gives views per purchase once both exist and the window is covered", () => {
    const events = [...Array(10)].map(() => ev("manifest_view")).concat([ev("settled"), ev("settled")]);
    expect(funnelFrom(events, MANIFEST_VIEW_SINCE + 1).viewsPerPurchase).toBe("5.0");
  });

  /** The one that matters: unmeasured must not read as measured-and-zero. */
  it("is null, not zero, when no view was ever recorded", () => {
    expect(funnelFrom([ev("402_issued"), ev("settled")], MANIFEST_VIEW_SINCE + 1).viewsPerPurchase).toBeNull();
  });

  it("is null when there are views but nothing has sold — not Infinity", () => {
    expect(funnelFrom([ev("manifest_view"), ev("manifest_view")], MANIFEST_VIEW_SINCE + 1).viewsPerPurchase).toBeNull();
  });
});

describe("failuresFrom", () => {
  it("groups by the event's own cause key and counts", () => {
    const groups = failuresFrom([
      ev("settle_failed", { props: { code: "insufficient_funds" } }),
      ev("settle_failed", { props: { code: "insufficient_funds" } }),
      ev("settle_failed", { props: { code: "nonce_reused" } }),
    ]);
    expect(groups[0]).toMatchObject({ name: "settle_failed", cause: "insufficient_funds", count: 2 });
    expect(groups[1]).toMatchObject({ cause: "nonce_reused", count: 1 });
  });

  it("reads the right prop per event type", () => {
    const groups = failuresFrom([
      ev("paused_block", { props: { switch: "payments" } }),
      ev("sweep_skipped", { props: { reason: "payout_in_flight" } }),
    ]);
    expect(groups.map((g) => g.cause).sort()).toEqual(["payments", "payout_in_flight"]);
  });

  it("ignores events that are not failures", () => {
    expect(failuresFrom([ev("settled"), ev("download"), ev("manifest_view")])).toEqual([]);
  });

  it("says unknown rather than dropping a failure with no cause recorded", () => {
    expect(failuresFrom([ev("settle_failed", { props: null })])[0].cause).toBe("unknown");
  });

  it("keeps the most recent occurrence as lastAt", () => {
    const groups = failuresFrom([
      ev("settle_failed", { props: { code: "x" }, at: iso(5 * DAY) }),
      ev("settle_failed", { props: { code: "x" }, at: iso(DAY) }),
    ]);
    expect(groups[0].lastAt).toBe(iso(DAY));
  });

  it("puts the most frequent cause first — the top row is the thing to fix", () => {
    const groups = failuresFrom([
      ev("settle_failed", { props: { code: "rare" } }),
      ...Array(3).fill(null).map(() => ev("paused_block", { props: { switch: "payments" } })),
    ]);
    expect(groups[0].cause).toBe("payments");
  });
});

describe("bySourceFrom", () => {
  it("splits quotes and payments by surface", () => {
    const rows = bySourceFrom([
      ev("402_issued", { source: "web" }),
      ev("402_issued", { source: "web" }),
      ev("settled", { source: "web" }),
      ev("402_issued", { source: "mcp" }),
      ev("settled", { source: "mcp" }),
    ]);
    expect(rows.find((r) => r.source === "web")).toEqual({ source: "web", issued: 2, settled: 1 });
    expect(rows.find((r) => r.source === "mcp")).toEqual({ source: "mcp", issued: 1, settled: 1 });
  });

  it("buckets an unattributed event rather than dropping it", () => {
    expect(bySourceFrom([ev("settled", { source: null })])[0].source).toBe("unknown");
  });
});

describe("describeProps", () => {
  it("flattens to key=value pairs", () => {
    expect(describeProps({ code: "nonce_reused", version: "1.0.0" })).toBe("code=nonce_reused version=1.0.0");
  });

  it("drops anything shaped like an address, whatever the convention says", () => {
    expect(describeProps({ to: "0x2cac7b3c4201e0707dad1e0086b2ed9b25812a03", ok: true })).toBe("ok=true");
  });

  it("truncates a long value instead of blowing out the column", () => {
    expect(describeProps({ note: "x".repeat(80) })).toHaveLength("note=".length + 38);
  });

  it("is empty for nothing at all", () => {
    expect(describeProps(null)).toBe("");
    expect(describeProps({ a: null, b: "" })).toBe("");
  });
});

describe("loadActivity", () => {
  beforeEach(() => {
    process.env.X402_NETWORK = "base-sepolia";
    resetEnv();
    setDb(
      makeMockDb({
        creator: [{ id: "c1", handle: "adrian", payout_address: "0xaaa", onboarded_via: "web", terms_version: "t" }],
        listing: [{ id: "l1", creator_id: "c1", slug: "alpha", source: "github" }],
        event: [
          { id: 1, name: "manifest_view", listing_id: "l1", source: null, props: { view: "human" }, chain_id: 84532, at: iso(DAY) },
          { id: 2, name: "402_issued", listing_id: "l1", source: "web", props: { kind: "new" }, chain_id: 84532, at: iso(DAY) },
          { id: 3, name: "settled", listing_id: "l1", source: "web", props: { kind: "new" }, chain_id: 84532, at: iso(DAY) },
          { id: 4, name: "settle_failed", listing_id: "l1", source: "api", props: { code: "insufficient_funds" }, chain_id: 84532, at: iso(2 * DAY) },
          { id: 5, name: "manifest_view", listing_id: "l1", source: null, props: { view: "agent" }, chain_id: 84532, at: iso(40 * DAY) },
          // The other network, and a script's operator event with no chain: neither is this chain's activity.
          { id: 6, name: "settled", listing_id: "l1", source: "api", props: { kind: "new" }, chain_id: 8453, at: iso(DAY) },
          { id: 7, name: "manifest_view", listing_id: "l1", source: null, props: { view: "human" }, chain_id: 8453, at: iso(DAY) },
          { id: 8, name: "takedown_retired", listing_id: "l1", source: null, props: {}, chain_id: null, at: iso(DAY) },
        ],
      }).client as unknown as Db,
    );
  });

  afterEach(() => {
    resetDb();
    delete process.env.X402_NETWORK;
    resetEnv();
  });

  it("bounds the funnel to the window", async () => {
    const week = await loadActivity("7d");
    expect(week.funnel.views).toBe(1); // the 40-day-old view is outside
    const all = await loadActivity("all");
    expect(all.funnel.views).toBe(2);
  });

  it("joins the listing and creator handle onto the stream", async () => {
    const { stream } = await loadActivity("all");
    const settled = stream.find((e) => e.name === "settled");
    expect(settled).toMatchObject({ slug: "alpha", handle: "adrian", source: "web" });
  });

  it("groups the failure with its code", async () => {
    const { failures } = await loadActivity("7d");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ name: "settle_failed", cause: "insufficient_funds", count: 1 });
  });

  it("counts distinct listings viewed", async () => {
    expect((await loadActivity("all")).listingsViewed).toBe(1);
  });

  it("reads one chain: the configured one by default, or the one it is asked for", async () => {
    const sepolia = await loadActivity("all");
    expect(sepolia.funnel).toMatchObject({ settled: 1, views: 2 });
    expect(sepolia.stream.some((e) => e.name === "takedown_retired")).toBe(false);

    const mainnet = await loadActivity("all", undefined, { chainId: 8453 });
    expect(mainnet.funnel).toMatchObject({ settled: 1, views: 1, issued: 0, failed: 0 });
  });

  it("returns an empty view rather than throwing when nothing has happened", async () => {
    setDb(makeMockDb({}).client as unknown as Db);
    const view = await loadActivity("7d");
    expect(view.stream).toEqual([]);
    expect(view.funnel.settled).toBe(0);
    expect(view.funnel.viewsPerPurchase).toBeNull();
  });
});

describe("viewsCoverWindow — the guard on the hypothesis metric", () => {
  const AFTER = MANIFEST_VIEW_SINCE + 60_000;
  const BEFORE = MANIFEST_VIEW_SINCE - 60_000;

  it("is false for all time, which always reaches back past the instrumentation", () => {
    expect(viewsCoverWindow(null)).toBe(false);
  });

  it("is false for a window that opens before views were recorded", () => {
    expect(viewsCoverWindow(BEFORE)).toBe(false);
  });

  it("is true once the window opens after it", () => {
    expect(viewsCoverWindow(AFTER)).toBe(true);
    expect(viewsCoverWindow(MANIFEST_VIEW_SINCE)).toBe(true);
  });

  /**
   * The bug this guard exists for, caught on the real dashboard: four views recorded
   * minutes ago over eighteen purchases from the last thirty days printed "0.2", which
   * is not a small number — it is a meaningless one.
   */
  it("refuses the ratio when the window predates instrumentation, however many views exist", () => {
    const events = [...Array(4)].map(() => ev("manifest_view")).concat([...Array(18)].map(() => ev("settled")));
    expect(funnelFrom(events, BEFORE).viewsPerPurchase).toBeNull();
    expect(funnelFrom(events, null).viewsPerPurchase).toBeNull();
    // Same events, a window that starts after instrumentation: now it is real.
    expect(funnelFrom(events, AFTER).viewsPerPurchase).toBe("0.2");
  });
});

describe("crawlers are counted but never in the ratio", () => {
  const COVERED = MANIFEST_VIEW_SINCE + 1;

  it("splits bot views out of the view count", () => {
    const f = funnelFrom(
      [
        ev("manifest_view", { props: { view: "human", bot: false } }),
        ev("manifest_view", { props: { view: "human", bot: true } }),
        ev("manifest_view", { props: { view: "agent", bot: true } }),
      ],
      COVERED,
    );
    expect(f.views).toBe(1);
    expect(f.botViews).toBe(2);
  });

  it("keeps crawlers out of views per purchase — the denominator would be robots.txt working", () => {
    const events = [
      ...Array(4).fill(null).map(() => ev("manifest_view", { props: { bot: false } })),
      ...Array(96).fill(null).map(() => ev("manifest_view", { props: { bot: true } })),
      ev("settled"),
      ev("settled"),
    ];
    // 4 human views over 2 sales, not 100 over 2.
    expect(funnelFrom(events, COVERED).viewsPerPurchase).toBe("2.0");
  });

  it("counts a view recorded before the flag existed as human rather than dropping it", () => {
    const f = funnelFrom([ev("manifest_view", { props: { view: "human" } }), ev("settled")], COVERED);
    expect(f.views).toBe(1);
    expect(f.botViews).toBe(0);
  });

  it("excludes a crawler-only listing from listingsViewed", async () => {
    setDb(
      makeMockDb({
        creator: [{ id: "c1", handle: "adrian", payout_address: "0xa", onboarded_via: "web", terms_version: "t" }],
        listing: [
          { id: "l1", creator_id: "c1", slug: "alpha", source: "github" },
          { id: "l2", creator_id: "c1", slug: "beta", source: "github" },
        ],
        event: [
          { id: 1, name: "manifest_view", listing_id: "l1", props: { bot: false }, chain_id: 84532, at: iso(DAY) },
          { id: 2, name: "manifest_view", listing_id: "l2", props: { bot: true }, chain_id: 84532, at: iso(DAY) },
        ],
      }).client as unknown as Db,
    );
    expect((await loadActivity("7d")).listingsViewed).toBe(1);
  });
});
