/**
 * The admin feed's policy, tested where it is decidable without a database: what counts
 * as a flag, what "went up" means, how the tally counts, and that the filters partition
 * the feed rather than overlapping it.
 *
 * `loadAdminFeed` itself is covered through the mock database, because the two things
 * most worth pinning about it are queries: that sales are chain-filtered, and that a
 * revoked purchase is not revenue.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adminFilter,
  applyFilter,
  applySearch,
  flagsFor,
  loadAdminFeed,
  salesSince,
  sortByWentUp,
  tallyOf,
  wentUpAt,
  type AdminListing,
} from "@/lib/admin/feed";
import { resetDb, setDb, type Db } from "@/lib/db";
import type { ListingRow, ReleaseRow } from "@/lib/db/types";
import { resetEnv } from "@/lib/env";
import { makeMockDb } from "@/lib/test/mock-db";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-07T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function listing(over: Partial<ListingRow> = {}): ListingRow {
  return {
    id: "l1",
    creator_id: "c1",
    slug: "thing",
    source: "github",
    installation_id: null,
    github_repo_id: null,
    deploy_key_id: null,
    hosted_org: null,
    price_micro: "9000000",
    update_price_micro: "5000000",
    description: null,
    trigger_hint: null,
    licence_spdx: "MIT",
    licence_verdict: "pass",
    published_at: iso(2 * DAY),
    retired_at: null,
    created_at: iso(3 * DAY),
    ...over,
  } as ListingRow;
}

function release(over: Partial<ReleaseRow> = {}): ReleaseRow {
  return { id: "r1", listing_id: "l1", version: "1.0.0", scan: "pass", created_at: iso(2 * DAY), ...over } as ReleaseRow;
}

function row(over: Partial<AdminListing> = {}): AdminListing {
  const l = over.listing ?? listing();
  return {
    listing: l,
    handle: "adrian",
    status: "live",
    newest: release(),
    sellable: release(),
    releases: 1,
    sales: 0,
    grossMicro: 0n,
    wentUpAt: wentUpAt(l),
    flags: [],
    ...over,
  };
}

describe("wentUpAt", () => {
  it("is the publish date once there is one", () => {
    expect(wentUpAt(listing({ published_at: iso(DAY), created_at: iso(5 * DAY) }))).toBe(iso(DAY));
  });

  it("falls back to creation for a draft, so a draft still has a place in the feed", () => {
    expect(wentUpAt(listing({ published_at: null, created_at: iso(5 * DAY) }))).toBe(iso(5 * DAY));
  });
});

describe("flagsFor", () => {
  it("flags nothing on a healthy live listing", () => {
    expect(flagsFor(listing(), release(), release())).toEqual([]);
  });

  it("flags a licence the gate could not clear", () => {
    expect(flagsFor(listing({ licence_verdict: "manual" }), release(), release())).toEqual(["licence"]);
    expect(flagsFor(listing({ licence_verdict: "block" }), release(), release())).toEqual(["licence"]);
  });

  it("does not flag a licence that has not been judged yet", () => {
    expect(flagsFor(listing({ licence_verdict: null, published_at: null }), release(), release())).toEqual([]);
  });

  it("flags a newest release that failed its scan, even while an older one still sells", () => {
    const failed = release({ id: "r2", version: "1.1.0", scan: "fail" });
    expect(flagsFor(listing(), failed, release())).toEqual(["scan"]);
  });

  it("flags a live listing with nothing a buyer could receive", () => {
    expect(flagsFor(listing(), release({ scan: "pending" }), null)).toEqual(["unsellable"]);
  });

  it("does not call a draft unsellable — a draft is not selling anything yet", () => {
    expect(flagsFor(listing({ published_at: null }), null, null)).toEqual([]);
  });

  it("does not call a retired listing unsellable — retirement is the point", () => {
    expect(flagsFor(listing({ retired_at: iso(DAY) }), null, null)).toEqual([]);
  });

  it("reports every flag a listing earns, not the first", () => {
    expect(flagsFor(listing({ licence_verdict: "block" }), release({ scan: "fail" }), null)).toEqual([
      "licence",
      "scan",
      "unsellable",
    ]);
  });
});

describe("sortByWentUp", () => {
  it("puts the most recent first, breaking a tie on the newer creation date", () => {
    // `a` and `c` went up at the same moment; `c` was created more recently, so it is
    // the newer listing and sorts first.
    const a = row({ listing: listing({ id: "a", published_at: iso(DAY), created_at: iso(3 * DAY) }), wentUpAt: iso(DAY) });
    const b = row({ listing: listing({ id: "b", published_at: iso(5 * DAY), created_at: iso(6 * DAY) }), wentUpAt: iso(5 * DAY) });
    const c = row({ listing: listing({ id: "c", published_at: iso(DAY), created_at: iso(2 * DAY) }), wentUpAt: iso(DAY) });

    expect(sortByWentUp([b, c, a]).map((r) => r.listing.id)).toEqual(["c", "a", "b"]);
    // Same rows in another input order give the same output: the sort is total.
    expect(sortByWentUp([a, b, c]).map((r) => r.listing.id)).toEqual(["c", "a", "b"]);
  });

  it("falls back to the id when two listings are indistinguishable by date", () => {
    const at = iso(DAY);
    const x = row({ listing: listing({ id: "x", published_at: at, created_at: at }), wentUpAt: at });
    const y = row({ listing: listing({ id: "y", published_at: at, created_at: at }), wentUpAt: at });

    expect(sortByWentUp([y, x]).map((r) => r.listing.id)).toEqual(["x", "y"]);
    expect(sortByWentUp([x, y]).map((r) => r.listing.id)).toEqual(["x", "y"]);
  });

  it("does not mutate its input", () => {
    const rows = [row({ listing: listing({ id: "a" }) }), row({ listing: listing({ id: "b" }) })];
    sortByWentUp(rows);
    expect(rows.map((r) => r.listing.id)).toEqual(["a", "b"]);
  });
});

describe("adminFilter and applyFilter", () => {
  it("reads an unknown status as all rather than as an error", () => {
    expect(adminFilter(undefined)).toBe("all");
    expect(adminFilter("nonsense")).toBe("all");
    expect(adminFilter("review")).toBe("review");
  });

  it("partitions the feed by status", () => {
    const rows = [row({ status: "live" }), row({ status: "draft" }), row({ status: "retired" })];
    expect(applyFilter(rows, "all")).toHaveLength(3);
    expect(applyFilter(rows, "live")).toHaveLength(1);
    expect(applyFilter(rows, "draft")).toHaveLength(1);
    expect(applyFilter(rows, "retired")).toHaveLength(1);
    expect(applyFilter(rows, "active").map((r) => r.status)).toEqual(["live", "draft"]);
  });

  it("falls back to the page's own default when told one", () => {
    expect(adminFilter(undefined, "active")).toBe("active");
    expect(adminFilter("retired", "active")).toBe("retired");
  });

  it("cuts review across status — a flagged draft is still something to look at", () => {
    const rows = [row({ status: "live" }), row({ status: "draft", flags: ["licence"] })];
    expect(applyFilter(rows, "review")).toHaveLength(1);
    expect(applyFilter(rows, "review")[0].status).toBe("draft");
  });
});

describe("tallyOf", () => {
  it("counts statuses, windows and distinct creators", () => {
    const rows = [
      row({ status: "live", listing: listing({ id: "a", creator_id: "c1", published_at: iso(2 * 60 * 60 * 1000) }) }),
      row({ status: "live", listing: listing({ id: "b", creator_id: "c1", published_at: iso(3 * DAY) }) }),
      // A draft created three days ago: `wentUpAt` falls back to `created_at`.
      row({ status: "draft", listing: listing({ id: "c", creator_id: "c2", published_at: null, created_at: iso(3 * DAY) }) }),
      row({ status: "retired", listing: listing({ id: "d", creator_id: "c3", published_at: iso(30 * DAY) }) }),
    ].map((r) => ({ ...r, wentUpAt: wentUpAt(r.listing) }));

    const tally = tallyOf(rows, { chainId: 84532, truncated: false, now: NOW });

    expect(tally.listings).toBe(4);
    expect(tally.live).toBe(2);
    expect(tally.draft).toBe(1);
    expect(tally.retired).toBe(1);
    expect(tally.publishedDay).toBe(1);
    // a, b and the draft c. The window counts the same `wentUpAt` the feed's column
    // prints, so a draft created inside the week is counted rather than showing a date
    // in the table and nothing in the tally.
    expect(tally.publishedWeek).toBe(3);
    expect(tally.creators).toBe(3);
    expect(tally.chainId).toBe(84532);
  });

  it("counts a draft in the window on the date the column shows for it", () => {
    const draft = row({ status: "draft", listing: listing({ id: "d", published_at: null, created_at: iso(60 * 60 * 1000) }) });
    const tally = tallyOf([{ ...draft, wentUpAt: wentUpAt(draft.listing) }], { chainId: 84532, truncated: false, now: NOW });
    expect(tally.publishedDay).toBe(1);
  });

  it("counts a listing as needing review once, however many flags it carries", () => {
    const rows = [row({ flags: ["licence", "scan"] }), row({ flags: [] })];
    expect(tallyOf(rows, { chainId: 8453, truncated: false, now: NOW }).needsReview).toBe(1);
  });
});

describe("salesSince", () => {
  it("sums only what settled inside the window", () => {
    const sales = [
      { grossMicro: 9_000_000n, at: iso(2 * DAY) },
      { grossMicro: 5_000_000n, at: iso(20 * DAY) },
    ];
    expect(salesSince(sales, NOW - 7 * DAY)).toEqual({ count: 1, grossMicro: 9_000_000n });
  });

  it("ignores an unparseable timestamp instead of counting it as now", () => {
    expect(salesSince([{ grossMicro: 1n, at: "not a date" }], NOW - 7 * DAY)).toEqual({ count: 0, grossMicro: 0n });
  });
});

describe("loadAdminFeed", () => {
  // The fixtures are dated relative to NOW and the loader windows on Date.now(); without
  // this the "last 7 days" assertions start failing a week after NOW.
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterAll(() => vi.useRealTimers());

  let mock: ReturnType<typeof makeMockDb>;

  beforeEach(() => {
    process.env.X402_NETWORK = "base-sepolia";
    resetEnv();
    mock = makeMockDb({
      creator: [
        { id: "c1", handle: "adrian", payout_address: "0x1111111111111111111111111111111111111111", onboarded_via: "web", terms_version: "t" },
        { id: "c2", handle: "agent", payout_address: "0x2222222222222222222222222222222222222222", onboarded_via: "api", terms_version: "t" },
      ],
      listing: [
        { ...listing({ id: "l1", creator_id: "c1", slug: "alpha" }) },
        { ...listing({ id: "l2", creator_id: "c2", slug: "beta", published_at: null, licence_verdict: null }) },
      ],
      release: [
        { ...release({ id: "r1", listing_id: "l1", version: "1.0.0", scan: "pass" }) },
        { ...release({ id: "r2", listing_id: "l1", version: "1.1.0", scan: "fail", created_at: iso(DAY) }) },
      ],
      purchase: [
        { id: "p1", listing_id: "l1", release_id: "r1", gross_micro: "9000000", granted_at: iso(DAY), revoked_at: null, chain_id: 84532 },
        // Mainnet: must not be counted while X402_NETWORK is Sepolia.
        { id: "p2", listing_id: "l1", release_id: "r1", gross_micro: "50000000", granted_at: iso(DAY), revoked_at: null, chain_id: 8453 },
        // Revoked: not revenue.
        { id: "p3", listing_id: "l1", release_id: "r1", gross_micro: "9000000", granted_at: iso(DAY), revoked_at: iso(0), chain_id: 84532 },
      ],
    });
    setDb(mock.client as unknown as Db);
  });

  afterEach(() => {
    resetDb();
    delete process.env.X402_NETWORK;
    resetEnv();
  });

  it("joins creators, releases and sales onto each listing", async () => {
    const { rows } = await loadAdminFeed();
    const alpha = rows.find((r) => r.listing.slug === "alpha");

    expect(alpha?.handle).toBe("adrian");
    expect(alpha?.releases).toBe(2);
    // Newest is the failed 1.1.0; what a buyer gets is still 1.0.0.
    expect(alpha?.newest?.version).toBe("1.1.0");
    expect(alpha?.sellable?.version).toBe("1.0.0");
    expect(alpha?.flags).toContain("scan");
  });

  it("counts sales on the configured chain only, and never a revoked one", async () => {
    const { rows, tally } = await loadAdminFeed();
    const alpha = rows.find((r) => r.listing.slug === "alpha");

    expect(alpha?.sales).toBe(1);
    expect(alpha?.grossMicro).toBe(9_000_000n);
    expect(tally.grossWeekMicro).toBe(9_000_000n);
    expect(tally.chainId).toBe(84532);
  });

  it("includes a draft from another creator, unpublished and unflagged", async () => {
    const { rows, tally } = await loadAdminFeed();
    const beta = rows.find((r) => r.listing.slug === "beta");

    expect(beta?.status).toBe("draft");
    expect(beta?.handle).toBe("agent");
    expect(beta?.flags).toEqual([]);
    expect(tally.creators).toBe(2);
  });

  it("returns an empty feed rather than throwing when nothing exists", async () => {
    setDb(makeMockDb({}).client as unknown as Db);
    const { rows, tally } = await loadAdminFeed();
    expect(rows).toEqual([]);
    expect(tally.listings).toBe(0);
    expect(tally.truncated).toBe(false);
  });

  it("says so when it has read only a prefix of the listings", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ...listing({ id: `x${i}`, slug: `s${i}` }) }));
    setDb(makeMockDb({ creator: [{ id: "c1", handle: "adrian", payout_address: "0x1", onboarded_via: "web", terms_version: "t" }], listing: many }).client as unknown as Db);

    const { rows, tally } = await loadAdminFeed(3);
    expect(rows).toHaveLength(3);
    expect(tally.truncated).toBe(true);
  });
});

describe("applySearch", () => {
  const rows = [
    row({ handle: "adrian", listing: listing({ id: "a", slug: "repo-digest" }) }),
    row({ handle: "examples", listing: listing({ id: "b", slug: "humanizer" }) }),
  ];

  it("returns everything for an empty or absent query", () => {
    expect(applySearch(rows, undefined)).toHaveLength(2);
    expect(applySearch(rows, "   ")).toHaveLength(2);
  });

  it("matches a slug, a handle, or the two together", () => {
    expect(applySearch(rows, "digest").map((r) => r.listing.id)).toEqual(["a"]);
    expect(applySearch(rows, "examples").map((r) => r.listing.id)).toEqual(["b"]);
    expect(applySearch(rows, "adrian/repo").map((r) => r.listing.id)).toEqual(["a"]);
  });

  it("ignores case and surrounding space", () => {
    expect(applySearch(rows, "  HUMANIZER ").map((r) => r.listing.id)).toEqual(["b"]);
  });

  it("returns nothing rather than everything when there is no match", () => {
    expect(applySearch(rows, "nothing-like-this")).toEqual([]);
  });
});

describe("flagsFor under an incomplete release read", () => {
  it("withholds unsellable when the releases may be a prefix", () => {
    // A live listing with nothing passing looks unsellable — but if the release read
    // saturated, the passing release may simply not have been read. A red flag on a
    // healthy listing is worse than a missing one.
    expect(flagsFor(listing(), null, null, false)).toEqual([]);
    expect(flagsFor(listing(), null, null, true)).toEqual(["unsellable"]);
  });

  it("still reports the flags it can prove from the rows it did read", () => {
    const failed = release({ scan: "fail" });
    expect(flagsFor(listing({ licence_verdict: "manual" }), failed, null, false)).toEqual(["licence", "scan"]);
  });

  it("defaults to a complete read, so every existing caller is unchanged", () => {
    expect(flagsFor(listing(), null, null)).toEqual(["unsellable"]);
  });
});
