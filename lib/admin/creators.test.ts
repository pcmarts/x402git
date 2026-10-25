/**
 * The creator roster: the flags that mark somebody waiting on something, and the two
 * money rules the feed shares — one chain only, and never a revoked purchase.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { creatorFlags, loadCreators, searchCreators, sortByJoined } from "@/lib/admin/creators";
import type { AdminCreator } from "@/lib/admin/creators";
import { resetDb, setDb, type Db } from "@/lib/db";
import type { CreatorRow } from "@/lib/db/types";
import { resetEnv } from "@/lib/env";
import { makeMockDb } from "@/lib/test/mock-db";

const NOW = Date.parse("2026-09-07T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function creator(over: Partial<CreatorRow> = {}): CreatorRow {
  return {
    id: "c1",
    handle: "adrian",
    github_user_id: 1,
    onboarded_via: "web",
    wallet_mode: "linked",
    payout_address: "0x1111111111111111111111111111111111111111",
    cdp_wallet_id: null,
    pending_payout_address: null,
    rebind_effective_at: null,
    abuse_contact_url: null,
    abuse_contact_email: null,
    pending_abuse_contact_url: null,
    pending_abuse_contact_email: null,
    abuse_contact_effective_at: null,
    terms_version: "2026-08-29",
    terms_accepted_at: iso(10 * DAY),
    created_at: iso(10 * DAY),
    ...over,
  } as CreatorRow;
}

describe("creatorFlags", () => {
  it("flags nothing for an established creator with listings", () => {
    expect(creatorFlags(creator(), 3, NOW)).toEqual([]);
  });

  it("flags a creator who signed up and never listed anything", () => {
    expect(creatorFlags(creator(), 0, NOW)).toEqual(["no-listing"]);
  });

  it("flags a rebind that is still inside its 48 hours", () => {
    const c = creator({ pending_payout_address: "0x2222222222222222222222222222222222222222", rebind_effective_at: iso(-DAY) });
    expect(creatorFlags(c, 1, NOW)).toEqual(["rebinding"]);
  });

  it("stops flagging a rebind once its effective time has passed", () => {
    const c = creator({ pending_payout_address: "0x2222222222222222222222222222222222222222", rebind_effective_at: iso(DAY) });
    expect(creatorFlags(c, 1, NOW)).toEqual([]);
  });

  it("flags a custodial wallet, which is money the platform is holding", () => {
    expect(creatorFlags(creator({ wallet_mode: "custodial" }), 1, NOW)).toEqual(["custodial"]);
  });

  it("reports every flag a creator earns", () => {
    const c = creator({
      wallet_mode: "custodial",
      pending_payout_address: "0x2222222222222222222222222222222222222222",
      rebind_effective_at: iso(-DAY),
    });
    expect(creatorFlags(c, 0, NOW)).toEqual(["no-listing", "rebinding", "custodial"]);
  });
});

describe("sortByJoined", () => {
  it("puts the newest sign-up first and tie-breaks on handle", () => {
    const rows = [
      { creator: creator({ id: "a", handle: "zed", created_at: iso(5 * DAY) }) },
      { creator: creator({ id: "b", handle: "amy", created_at: iso(DAY) }) },
      { creator: creator({ id: "c", handle: "bob", created_at: iso(DAY) }) },
    ] as AdminCreator[];

    expect(sortByJoined(rows).map((r) => r.creator.handle)).toEqual(["amy", "bob", "zed"]);
  });
});

describe("loadCreators", () => {
  beforeEach(() => {
    process.env.X402_NETWORK = "base-sepolia";
    resetEnv();
    setDb(
      makeMockDb({
        creator: [
          creator({ id: "c1", handle: "adrian", created_at: iso(10 * DAY) }),
          creator({ id: "c2", handle: "agent", onboarded_via: "api", created_at: iso(2 * DAY) }),
        ],
        listing: [
          { id: "l1", creator_id: "c1", slug: "alpha", source: "github", published_at: iso(3 * DAY), created_at: iso(9 * DAY) },
          { id: "l2", creator_id: "c1", slug: "beta", source: "github", published_at: null, created_at: iso(DAY) },
        ],
        purchase: [
          { id: "p1", listing_id: "l1", release_id: "r1", gross_micro: "9000000", revoked_at: null, chain_id: 84532 },
          { id: "p2", listing_id: "l1", release_id: "r1", gross_micro: "50000000", revoked_at: null, chain_id: 8453 },
          { id: "p3", listing_id: "l1", release_id: "r1", gross_micro: "9000000", revoked_at: iso(0), chain_id: 84532 },
        ],
      }).client as unknown as Db,
    );
  });

  afterEach(() => {
    resetDb();
    delete process.env.X402_NETWORK;
    resetEnv();
  });

  it("counts a creator's listings and how many are live", async () => {
    const { rows } = await loadCreators();
    const adrian = rows.find((r) => r.creator.handle === "adrian");
    expect(adrian?.listings).toBe(2);
    expect(adrian?.live).toBe(1);
  });

  it("counts sales on the configured chain only, and never a revoked one", async () => {
    const { rows, chainId } = await loadCreators();
    const adrian = rows.find((r) => r.creator.handle === "adrian");
    expect(adrian?.sales).toBe(1);
    expect(adrian?.grossMicro).toBe(9_000_000n);
    expect(chainId).toBe(84532);
  });

  it("shows a creator with no listings at all, flagged", async () => {
    const { rows } = await loadCreators();
    const agent = rows.find((r) => r.creator.handle === "agent");
    expect(agent?.listings).toBe(0);
    expect(agent?.lastActivityAt).toBeNull();
    expect(agent?.flags).toContain("no-listing");
  });

  it("puts the newest sign-up first", async () => {
    const { rows } = await loadCreators();
    expect(rows.map((r) => r.creator.handle)).toEqual(["agent", "adrian"]);
  });

  it("returns an empty roster rather than throwing when nobody has signed up", async () => {
    setDb(makeMockDb({}).client as unknown as Db);
    const { rows, truncated } = await loadCreators();
    expect(rows).toEqual([]);
    expect(truncated).toBe(false);
  });

  it("says so when it has read only a prefix", async () => {
    const many = Array.from({ length: 5 }, (_, i) => creator({ id: `x${i}`, handle: `h${i}` }));
    setDb(makeMockDb({ creator: many }).client as unknown as Db);
    const { rows, truncated } = await loadCreators(3);
    expect(rows).toHaveLength(3);
    expect(truncated).toBe(true);
  });
});

describe("searchCreators", () => {
  const rows = [
    { creator: creator({ id: "a", handle: "adrian", payout_address: "0xAAA111" }) },
    { creator: creator({ id: "b", handle: "examples", payout_address: "0xBBB222" }) },
  ] as AdminCreator[];

  it("returns everything for an empty query", () => {
    expect(searchCreators(rows, undefined)).toHaveLength(2);
  });

  it("matches a handle", () => {
    expect(searchCreators(rows, "adri").map((r) => r.creator.id)).toEqual(["a"]);
  });

  it("matches a payout address, case-insensitively — the field an operator pastes", () => {
    expect(searchCreators(rows, "0xbbb222").map((r) => r.creator.id)).toEqual(["b"]);
  });

  it("returns nothing rather than everything when there is no match", () => {
    expect(searchCreators(rows, "zzz")).toEqual([]);
  });
});

describe("creatorFlags under an incomplete listing read", () => {
  it("withholds no-listing when the listings may be a prefix", () => {
    expect(creatorFlags(creator(), 0, NOW, false)).toEqual([]);
    expect(creatorFlags(creator(), 0, NOW, true)).toEqual(["no-listing"]);
  });

  it("still reports flags that do not depend on the listing read", () => {
    expect(creatorFlags(creator({ wallet_mode: "custodial" }), 0, NOW, false)).toEqual(["custodial"]);
  });

  it("defaults to a complete read, so existing callers are unchanged", () => {
    expect(creatorFlags(creator(), 0, NOW)).toEqual(["no-listing"]);
  });
});
