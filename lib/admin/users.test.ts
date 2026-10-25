/**
 * The users roster: who counts as test, how accounts and buyer wallets merge, which
 * network the money is read on, and that the URL round-trips every view.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb, setDb, type Db } from "@/lib/db";
import type { CreatorRow } from "@/lib/db/types";
import { makeMockDb } from "@/lib/test/mock-db";
import {
  applyRole,
  applyScope,
  applyVia,
  loadUsers,
  parseUsersQuery,
  setUserLabel,
  sortToggle,
  sortUsers,
  testVerdict,
  usersHref,
  DEFAULT_QUERY,
  type AdminUser,
} from "@/lib/admin/users";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-14T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const ADRIAN = "0x1111111111111111111111111111111111111111";
const BUYER = "0xAbCdEf0000000000000000000000000000000001";
const TEST_BUYER = "0x2222222222222222222222222222222222222222";

function creator(over: Partial<CreatorRow> = {}): CreatorRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    handle: "adrian",
    github_user_id: 1,
    onboarded_via: "web",
    wallet_mode: "linked",
    payout_address: ADRIAN,
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

const purchase = (over: Record<string, unknown>) => ({
  id: `p${Math.random()}`,
  release_id: "r1",
  kind: "new",
  source: "web",
  gross_micro: "9000000",
  revoked_at: null,
  granted_at: iso(DAY),
  ...over,
});

describe("testVerdict", () => {
  const none = new Set<number>();

  it("takes an operator's label over everything else, in both directions", () => {
    expect(testVerdict({ label: false, handle: "e2ea12b797", chains: new Set([84532]), live: 0 })).toEqual({ is: false, reason: null });
    expect(testVerdict({ label: true, handle: "adrian", chains: new Set([8453]), live: 2 })).toEqual({ is: true, reason: "marked" });
  });

  it("recognises a harness handle, live listing or not", () => {
    expect(testVerdict({ label: undefined, handle: "e2eb3aa7a8", chains: none, live: 1 })).toEqual({ is: true, reason: "harness" });
    expect(testVerdict({ label: undefined, handle: "e2e-fan", chains: none, live: 0 }).is).toBe(false);
  });

  it("calls testnet-only activity test, and any mainnet activity real", () => {
    expect(testVerdict({ label: undefined, handle: "stalled", chains: new Set([84532]), live: 0 })).toEqual({ is: true, reason: "testnet" });
    expect(testVerdict({ label: undefined, handle: "stalled", chains: new Set([84532, 8453]), live: 0 }).is).toBe(false);
  });

  it("keeps a creator with something live, who has only traded on testnet so far, real", () => {
    expect(testVerdict({ label: undefined, handle: "pcmarts", chains: new Set([84532]), live: 2 }).is).toBe(false);
  });

  it("does not call a brand-new user with no activity test", () => {
    expect(testVerdict({ label: undefined, handle: "newcomer", chains: none, live: 0 }).is).toBe(false);
  });
});

describe("the query", () => {
  it("falls back to the defaults for anything it does not recognise", () => {
    expect(parseUsersQuery({ role: "nope", sort: "drop table", net: "moon" })).toEqual(DEFAULT_QUERY);
  });

  it("starts a text column A→Z and a number column biggest first", () => {
    expect(parseUsersQuery({ sort: "user" }).dir).toBe("asc");
    expect(parseUsersQuery({ sort: "gross" }).dir).toBe("desc");
  });

  it("writes the default view as the bare path and round-trips every other one", () => {
    expect(usersHref(DEFAULT_QUERY)).toBe("/admin/users");
    const q = { role: "buyers", via: "web", scope: "test", sort: "user", dir: "desc", q: "0xab" } as const;
    const href = usersHref(DEFAULT_QUERY, q);
    const params = Object.fromEntries(new URL(href, "http://x").searchParams);
    expect(parseUsersQuery(params)).toEqual(q);
  });

  it("flips the active column and opens a new one in its natural direction", () => {
    expect(sortToggle(DEFAULT_QUERY, "joined")).toEqual({ sort: "joined", dir: "asc" });
    expect(sortToggle(DEFAULT_QUERY, "user")).toEqual({ sort: "user", dir: "asc" });
  });
});

describe("loadUsers", () => {
  beforeEach(() => {
    setDb(
      makeMockDb({
        creator: [
          creator(),
          creator({ id: "00000000-0000-0000-0000-000000000002", handle: "e2ea12b797", onboarded_via: "api", payout_address: "0x3333333333333333333333333333333333333333", created_at: iso(2 * DAY) }),
        ],
        listing: [
          { id: "l1", creator_id: "00000000-0000-0000-0000-000000000001", slug: "alpha", source: "github", published_at: iso(3 * DAY), retired_at: null, created_at: iso(9 * DAY) },
        ],
        purchase: [
          purchase({ listing_id: "l1", buyer_address: BUYER, chain_id: 8453, gross_micro: "9000000" }),
          purchase({ listing_id: "l1", buyer_address: BUYER.toLowerCase(), chain_id: 8453, gross_micro: "5000000", source: "api" }),
          purchase({ listing_id: "l1", buyer_address: TEST_BUYER, chain_id: 84532 }),
          purchase({ listing_id: "l1", buyer_address: TEST_BUYER, chain_id: 84532, revoked_at: iso(0) }),
          // The creator buying from themselves with their payout address: one user, not two.
          purchase({ listing_id: "l1", buyer_address: ADRIAN, chain_id: 8453, gross_micro: "1000000" }),
        ],
        user_label: [],
      }).client as unknown as Db,
    );
  });

  afterEach(() => resetDb());

  it("counts money on the selected network only, never a revoked purchase", async () => {
    const main = await loadUsers("mainnet");
    const adrian = main.rows.find((u) => u.creator?.handle === "adrian")!;
    expect(adrian.sales).toBe(3);
    expect(adrian.grossMicro).toBe(15_000_000n);

    const test = await loadUsers("testnet");
    expect(test.rows.find((u) => u.creator?.handle === "adrian")!.sales).toBe(1);
  });

  it("merges a buyer's addresses case-insensitively and folds a creator's own buys into the account", async () => {
    const { rows } = await loadUsers("mainnet");
    const wallets = rows.filter((u) => u.kind === "wallet");
    expect(wallets).toHaveLength(1);
    expect(wallets[0]).toMatchObject({ purchases: 2, spentMicro: 14_000_000n, via: "web" });
    expect(rows.find((u) => u.creator?.handle === "adrian")).toMatchObject({ purchases: 1, spentMicro: 1_000_000n });
  });

  it("shows a wallet only on a network it bought on, and marks a testnet-only one test", async () => {
    expect((await loadUsers("mainnet")).rows.some((u) => u.address === TEST_BUYER)).toBe(false);
    const wallet = (await loadUsers("testnet")).rows.find((u) => u.address === TEST_BUYER)!;
    expect(wallet.test).toEqual({ is: true, reason: "testnet" });
  });

  it("hides the harness account from the real view", async () => {
    const { rows } = await loadUsers("mainnet");
    expect(applyScope(rows, "real").map((u) => u.creator?.handle ?? "wallet")).toEqual(["adrian", "wallet"]);
    expect(applyScope(rows, "test").map((u) => u.creator?.handle)).toEqual(["e2ea12b797"]);
  });

  it("lets a label override the automatic verdict", async () => {
    await setUserLabel({ subject: "creator:00000000-0000-0000-0000-000000000002", isTest: false, by: "pcmarts" });
    const { rows } = await loadUsers("mainnet");
    expect(rows.find((u) => u.creator?.handle === "e2ea12b797")!.test.is).toBe(false);
  });

  it("still renders when the label table is missing", async () => {
    const mock = makeMockDb({ creator: [creator()] });
    setDb(mock.client as unknown as Db);
    const { rows } = await loadUsers("mainnet");
    expect(rows).toHaveLength(1);
  });
});

describe("setUserLabel", () => {
  let mock: ReturnType<typeof makeMockDb>;
  beforeEach(() => {
    mock = makeMockDb({ creator: [creator()], purchase: [purchase({ listing_id: "l1", buyer_address: BUYER, chain_id: 8453 })], user_label: [], event: [] });
    setDb(mock.client as unknown as Db);
  });
  afterEach(() => resetDb());

  it("labels an account and writes an audit row naming the handle", async () => {
    const result = await setUserLabel({ subject: "creator:00000000-0000-0000-0000-000000000001", isTest: true, by: "pcmarts" });
    expect(result.ok).toBe(true);
    expect(mock.rows("user_label")).toMatchObject([{ is_test: true, set_by: "pcmarts" }]);
    expect(mock.rows("event")).toMatchObject([{ name: "user_marked_test", props: { ref: "adrian", by: "pcmarts", via: "admin" } }]);
  });

  it("labels a wallet by its lowercase address, and relabelling replaces the answer", async () => {
    const subject = `wallet:${BUYER.toLowerCase()}`;
    await setUserLabel({ subject, isTest: true, by: "pcmarts" });
    await setUserLabel({ subject: subject.toUpperCase().replace("WALLET", "wallet"), isTest: false, by: "pcmarts" });
    expect(mock.rows("user_label")).toMatchObject([{ subject, is_test: false }]);
  });

  it("refuses a subject that is not a user", async () => {
    expect((await setUserLabel({ subject: "creator:00000000-0000-0000-0000-00000000ffff", isTest: true, by: "x" })).ok).toBe(false);
    expect((await setUserLabel({ subject: `wallet:${TEST_BUYER}`, isTest: true, by: "x" })).ok).toBe(false);
    expect((await setUserLabel({ subject: "'; drop table", isTest: true, by: "x" })).ok).toBe(false);
    expect(mock.rows("user_label")).toEqual([]);
  });
});

describe("roles and sorting", () => {
  const user = (over: Partial<AdminUser>): AdminUser => ({
    subject: "creator:x",
    kind: "account",
    creator: creator(),
    address: ADRIAN,
    joinedAt: iso(DAY),
    via: "web",
    listings: 0,
    live: 0,
    sales: 0,
    grossMicro: 0n,
    purchases: 0,
    spentMicro: 0n,
    lastActivityAt: null,
    flags: [],
    test: { is: false, reason: null },
    ...over,
  });

  const a = user({ subject: "a", creator: creator({ handle: "amy" }), live: 2, listings: 2, grossMicro: 5n, lastActivityAt: iso(DAY) });
  const b = user({ subject: "b", creator: creator({ handle: "bob" }), via: "api", grossMicro: 50n });
  const w = user({ subject: "w", kind: "wallet", creator: null, via: "mcp", purchases: 1, lastActivityAt: iso(2 * DAY) });

  it("defines a creator as an account with something live, and API as anything not web", () => {
    expect(applyRole([a, b, w], "creators")).toEqual([a]);
    expect(applyRole([a, b, w], "unlisted")).toEqual([b]);
    expect(applyRole([a, b, w], "buyers")).toEqual([w]);
    expect(applyVia([a, b, w], "api")).toEqual([b, w]);
    expect(applyVia([a, b, w], "any")).toEqual([a, b, w]);
  });

  it("combines type and arrival, so web-signup creators are one view", () => {
    expect(applyVia(applyRole([a, b, w], "creators"), "web")).toEqual([a]);
    expect(applyVia(applyRole([a, b, w], "creators"), "api")).toEqual([]);
  });

  it("sorts bigint money correctly in both directions", () => {
    expect(sortUsers([a, b, w], "gross", "desc").map((u) => u.subject)).toEqual(["b", "a", "w"]);
    expect(sortUsers([a, b, w], "gross", "asc").map((u) => u.subject)).toEqual(["w", "a", "b"]);
  });

  it("sinks never-active users to the bottom whichever way last activity is sorted", () => {
    expect(sortUsers([b, a, w], "last", "desc").map((u) => u.subject)).toEqual(["a", "w", "b"]);
    expect(sortUsers([b, a, w], "last", "asc").map((u) => u.subject)).toEqual(["w", "a", "b"]);
  });
});
