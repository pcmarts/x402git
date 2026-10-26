/**
 * The money page's arithmetic, which is the whole point of it. The properties that must
 * never regress: the holdback splits net into held and owed, a swept sale is neither,
 * the fee is the one that was charged, and no total is ever a float.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMoney, realisedFeePct, totalsFrom, type AdminSale } from "@/lib/admin/money";
import { resetDb, setDb, type Db } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { makeMockDb } from "@/lib/test/mock-db";

const NOW = Date.parse("2026-09-07T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const iso = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();

type Row = Pick<AdminSale, "grossMicro" | "feeMicro" | "netMicro" | "holdbackUntil" | "paidOut" | "kind" | "creatorId">;

function sale(over: Partial<Row> = {}): Row {
  return {
    grossMicro: 9_000_000n,
    feeMicro: 900_000n,
    netMicro: 8_100_000n,
    holdbackUntil: iso(-DAY), // already released
    paidOut: false,
    kind: "new",
    creatorId: "c1",
    ...over,
  };
}

describe("totalsFrom", () => {
  const opts = { buyers: 3, gasMicro: 1_000n, chainId: 84532, now: NOW };

  it("sums gross, fee and net as bigints", () => {
    const t = totalsFrom([sale(), sale()], opts);
    expect(t.grossMicro).toBe(18_000_000n);
    expect(t.feeMicro).toBe(1_800_000n);
    expect(t.netMicro).toBe(16_200_000n);
    expect(t.sales).toBe(2);
  });

  it("counts net past the holdback as owed", () => {
    const t = totalsFrom([sale({ holdbackUntil: iso(-DAY) })], opts);
    expect(t.owedMicro).toBe(8_100_000n);
    expect(t.heldMicro).toBe(0n);
  });

  it("counts net inside the holdback as held, not owed", () => {
    const t = totalsFrom([sale({ holdbackUntil: iso(3 * DAY) })], opts);
    expect(t.heldMicro).toBe(8_100_000n);
    expect(t.owedMicro).toBe(0n);
  });

  it("counts a swept sale as paid out and neither held nor owed", () => {
    const t = totalsFrom([sale({ paidOut: true, holdbackUntil: iso(-DAY) })], opts);
    expect(t.paidOutMicro).toBe(8_100_000n);
    expect(t.owedMicro).toBe(0n);
    expect(t.heldMicro).toBe(0n);
  });

  it("keeps held, owed and paid out disjoint and summing to net when nothing is blocked", () => {
    const t = totalsFrom(
      [sale({ holdbackUntil: iso(3 * DAY) }), sale({ holdbackUntil: iso(-DAY) }), sale({ paidOut: true })],
      opts,
    );
    expect(t.blockedMicro).toBe(0n);
    expect(t.heldMicro + t.owedMicro + t.paidOutMicro).toBe(t.netMicro);
  });

  it("moves owed money behind an in-flight payout into blocked, not owed", () => {
    const t = totalsFrom([sale({ creatorId: "c1" }), sale({ creatorId: "c2" })], {
      ...opts,
      blockedCreators: new Set(["c1"]),
    });
    // c1 has a payout stuck; the next sweep will skip them with `payout_in_flight`.
    expect(t.blockedMicro).toBe(8_100_000n);
    expect(t.owedMicro).toBe(8_100_000n);
    expect(t.blockedCreators).toBe(1);
  });

  it("does not block money still inside the holdback — the payout is not the reason it is waiting", () => {
    const t = totalsFrom([sale({ creatorId: "c1", holdbackUntil: iso(3 * DAY) })], {
      ...opts,
      blockedCreators: new Set(["c1"]),
    });
    expect(t.heldMicro).toBe(8_100_000n);
    expect(t.blockedMicro).toBe(0n);
  });

  it("keeps held, owed, blocked and paid out summing to net", () => {
    const t = totalsFrom(
      [
        sale({ creatorId: "c1", holdbackUntil: iso(3 * DAY) }),
        sale({ creatorId: "c1" }),
        sale({ creatorId: "c2" }),
        sale({ creatorId: "c3", paidOut: true }),
      ],
      { ...opts, blockedCreators: new Set(["c1"]) },
    );
    expect(t.heldMicro + t.owedMicro + t.blockedMicro + t.paidOutMicro).toBe(t.netMicro);
  });

  it("reports the soonest holdback still to expire", () => {
    const t = totalsFrom([sale({ holdbackUntil: iso(5 * DAY) }), sale({ holdbackUntil: iso(2 * DAY) })], opts);
    expect(t.nextReleaseAt).toBe(iso(2 * DAY));
  });

  it("has no next release when nothing is held", () => {
    expect(totalsFrom([sale({ holdbackUntil: iso(-DAY) })], opts).nextReleaseAt).toBeNull();
  });

  it("counts free grants separately from paid sales", () => {
    const t = totalsFrom([sale({ kind: "free", grossMicro: 0n, feeMicro: 0n, netMicro: 0n }), sale()], opts);
    expect(t.free).toBe(1);
    expect(t.sales).toBe(2);
    expect(t.grossMicro).toBe(9_000_000n);
  });

  it("is all zeros on an empty ledger rather than NaN", () => {
    const t = totalsFrom([], { ...opts, buyers: 0, gasMicro: 0n });
    expect(t.grossMicro).toBe(0n);
    expect(t.owedMicro).toBe(0n);
    expect(t.nextReleaseAt).toBeNull();
  });

  it("treats an unparseable holdback as already released rather than losing the money", () => {
    const t = totalsFrom([sale({ holdbackUntil: "not a date" })], opts);
    expect(t.owedMicro).toBe(8_100_000n);
  });
});

describe("realisedFeePct", () => {
  it("prints the share actually taken", () => {
    expect(realisedFeePct(9_000_000n, 900_000n)).toBe("10.0%");
  });

  it("shows the drift when truncation puts the real share under the configured one", () => {
    // A 1-cent sale: splitFee truncates 10_000 * 1000 / 10_000 = 1_000, exactly 10%.
    // A 3-cent sale at a hypothetical rate that does not divide evenly drifts down.
    expect(realisedFeePct(30_000n, 2_999n)).toBe("9.9%");
  });

  it("does not divide by zero", () => {
    expect(realisedFeePct(0n, 0n)).toBe("—");
  });
});

describe("loadMoney", () => {
  // The fixtures are dated relative to NOW and the loader windows on Date.now(); without
  // this the "last 7 days" assertions start failing a week after NOW.
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterAll(() => vi.useRealTimers());

  beforeEach(() => {
    process.env.X402_NETWORK = "base-sepolia";
    process.env.X402_EXTRA_EVM_RAILS = '[{"network":"eip155:42161"}]';
    resetEnv();
    setDb(
      makeMockDb({
        creator: [{ id: "c1", handle: "adrian", payout_address: "0xaaa", onboarded_via: "web", terms_version: "t" }],
        listing: [{ id: "l1", creator_id: "c1", slug: "alpha", source: "github" }],
        release: [{ id: "r1", listing_id: "l1", version: "1.0.0", scan: "pass" }],
        purchase: [
          {
            id: "p1", listing_id: "l1", release_id: "r1", buyer_address: "0xbuyer1",
            gross_micro: "9000000", fee_micro: "900000", net_micro: "8100000",
            kind: "new", source: "web", granted_at: iso(-2 * DAY), holdback_until: iso(5 * DAY),
            revoked_at: null, payout_id: null, tx_hash: "0xdead", chain_id: 84532, network: "eip155:84532",
          },
          {
            id: "p2", listing_id: "l1", release_id: "r1", buyer_address: "0xBUYER1",
            gross_micro: "5000000", fee_micro: "500000", net_micro: "4500000",
            kind: "update", source: "api", granted_at: iso(-20 * DAY), holdback_until: iso(-13 * DAY),
            revoked_at: null, payout_id: null, tx_hash: null, chain_id: 84532, network: "eip155:84532",
          },
          // Mainnet — must not be counted while X402_NETWORK is Sepolia.
          {
            id: "p3", listing_id: "l1", release_id: "r1", buyer_address: "0xbuyer2",
            gross_micro: "99000000", fee_micro: "9900000", net_micro: "89100000",
            kind: "new", source: "web", granted_at: iso(-DAY), holdback_until: iso(DAY),
            revoked_at: null, payout_id: null, tx_hash: null, chain_id: 8453, network: "eip155:8453",
          },
          // Arbitrum USDT0 (25 Oct 2026): a second rail of the same deployment, counted.
          {
            id: "p5", listing_id: "l1", release_id: "r1", buyer_address: "0xbuyer1",
            gross_micro: "1000000", fee_micro: "100000", net_micro: "900000",
            kind: "new", source: "web", granted_at: iso(-21 * DAY), holdback_until: iso(4 * DAY),
            revoked_at: null, payout_id: null, tx_hash: "0xarb", chain_id: 42161, network: "eip155:42161",
          },
          // Revoked — not revenue.
          {
            id: "p4", listing_id: "l1", release_id: "r1", buyer_address: "0xbuyer3",
            gross_micro: "9000000", fee_micro: "900000", net_micro: "8100000",
            kind: "new", source: "web", granted_at: iso(-DAY), holdback_until: iso(DAY),
            revoked_at: iso(0), payout_id: null, tx_hash: null, chain_id: 84532, network: "eip155:84532",
          },
        ],
        payout: [
          { id: "po1", creator_id: "c1", amount_micro: "1000000", gas_micro: "5000", to_address: "0xaaa", status: "confirmed", idempotency_key: "k1", created_at: iso(-DAY), chain_id: 84532, network: "eip155:84532" },
          // Stuck at pending: the in-flight index blocks any further sweep for c1, so
          // c1's released-but-unswept net is blocked rather than payable.
          { id: "po2", creator_id: "c1", amount_micro: "1000000", gas_micro: "9999", to_address: "0xaaa", status: "pending", idempotency_key: "k2", created_at: iso(-DAY), chain_id: 84532, network: "eip155:84532" },
        ],
      }).client as unknown as Db,
    );
  });

  afterEach(() => {
    resetDb();
    delete process.env.X402_NETWORK;
    delete process.env.X402_EXTRA_EVM_RAILS;
    resetEnv();
  });

  it("counts every rail this deployment serves (Base Sepolia and Arbitrum), never the other network, never a revoked purchase", async () => {
    const { totals } = await loadMoney("all");
    expect(totals.sales).toBe(3);
    expect(totals.grossMicro).toBe(15_000_000n);
    expect(totals.feeMicro).toBe(1_500_000n);
    expect(totals.chainId).toBe(84532);
  });

  it("treats money behind a pending payout as blocked rather than as what the next sweep pays", async () => {
    // The fixture gives c1 a `pending` payout, which the in-flight index says blocks
    // any further sweep for them — so p2's released net is not payable.
    const { totals } = await loadMoney("all");
    expect(totals.blockedMicro).toBe(4_500_000n);
    expect(totals.owedMicro).toBe(0n);
    expect(totals.blockedCreators).toBe(1);
  });

  it("counts distinct buyers case-insensitively and never returns an address", async () => {
    const { totals, sales } = await loadMoney("all");
    // `0xbuyer1` and `0xBUYER1` are one wallet.
    expect(totals.buyers).toBe(1);
    // Every amount is a bigint, so the whole shape has to be serialised by hand — which
    // is itself the money rule holding (`lib/db/types.ts`: never a float, never a Number).
    const dump = JSON.stringify(sales, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(dump.toLowerCase()).not.toContain("buyer");
  });

  it("joins the listing, creator handle and version onto each sale", async () => {
    const { sales } = await loadMoney("all");
    expect(sales[0]).toMatchObject({ handle: "adrian", slug: "alpha", version: "1.0.0" });
  });

  it("counts gas from confirmed payouts only — a pending one has spent nothing", async () => {
    const { totals } = await loadMoney("all");
    expect(totals.gasMicro).toBe(5_000n);
  });

  it("narrows to the window, and the window bounds sales not the chain filter", async () => {
    const { totals } = await loadMoney("7d");
    // Only p1 (2 days ago) is inside 7 days; p2 is 20 days old.
    expect(totals.sales).toBe(1);
    expect(totals.grossMicro).toBe(9_000_000n);
  });

  it("puts newest sales first", async () => {
    const { sales } = await loadMoney("all");
    expect(sales.map((s) => s.id)).toEqual(["p1", "p2", "p5"]);
  });


    it("scopes gross to the window but keeps owed, blocked and paid out lifetime", async () => {
      // p1 is 2 days old (held), p2 is 20 days old and released but blocked by c1's
      // pending payout. A 7-day window contains only p1.
      const week = await loadMoney("7d");
      const all = await loadMoney("all");

      // Flow narrows.
      expect(week.totals.grossMicro).toBe(9_000_000n);
      expect(all.totals.grossMicro).toBe(15_000_000n);
      expect(week.totals.sales).toBe(1);

      // Balances do not: what is blocked now is blocked regardless of the window asked for.
      expect(week.totals.blockedMicro).toBe(all.totals.blockedMicro);
      expect(week.totals.heldMicro).toBe(all.totals.heldMicro);
      expect(week.totals.owedMicro).toBe(all.totals.owedMicro);
      expect(week.totals.paidOutMicro).toBe(all.totals.paidOutMicro);
      expect(week.totals.gasMicro).toBe(all.totals.gasMicro);
    });

    it("never reports zero owed-and-blocked on a quiet window while money is actually stuck", async () => {
      const day = await loadMoney("24h");
      expect(day.totals.grossMicro).toBe(0n); // nothing settled in the last day
      expect(day.totals.blockedMicro).toBe(4_500_000n); // but this is still stuck
    });

    it("lists only the window's sales even though the balances span everything", async () => {
      const week = await loadMoney("7d");
      expect(week.sales.map((s) => s.id)).toEqual(["p1"]);
    });

  it("returns empty totals rather than throwing on an empty database", async () => {
    setDb(makeMockDb({}).client as unknown as Db);
    const { totals, sales, payouts } = await loadMoney("all");
    expect(totals.grossMicro).toBe(0n);
    expect(sales).toEqual([]);
    expect(payouts).toEqual([]);
  });
});
