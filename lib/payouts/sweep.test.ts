import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import type { CreatorRow } from "@/lib/db/types";
import { resetEnv } from "@/lib/env";
import { resetScreeningCache } from "@/lib/screening";
import { seedListing, seedPurchase } from "@/lib/test/fixtures";
import { makeMockDb } from "@/lib/test/mock-db";
import { creatorsWithBalance, sweepCreator } from "./sweep";

const BUYER = "0xAAaAAAaAAaaAaaAaAaAAAAaAaAaAaAAAAaaAAaAa";
const PAYOUT = "0x2222222222222222222222222222222222222222";

let mock: ReturnType<typeof makeMockDb>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  resetScreeningCache();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
  process.env.PLATFORM_RECEIVING_ADDRESS = "0x1111111111111111111111111111111111111111";
  process.env.X402_NETWORK = "base-sepolia";
  delete process.env.SWEEP_WALLET_PRIVATE_KEY;
  resetEnv();
});

afterEach(() => {
  resetDb();
  resetScreeningCache();
  vi.unstubAllGlobals();
  delete process.env.PLATFORM_RECEIVING_ADDRESS;
  delete process.env.X402_NETWORK;
  resetEnv();
});

function creator(): CreatorRow {
  return mock.rows("creator")[0] as CreatorRow;
}

/** One released sale of $9 gross → $8.10 net, past its holdback. */
function seedReleasedSale(grossMicro = "9000000") {
  const listing = seedListing(mock, { payoutAddress: PAYOUT, releases: [{ version: "1.0.0" }] });
  seedPurchase(mock, {
    listingId: listing.listingId,
    releaseId: listing.latest.id,
    buyer: BUYER,
    grossMicro,
    grantedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
  });
  return listing;
}

describe("sweepCreator (FR-26, FR-28)", () => {
  it("writes the pending payout row before it broadcasts anything", async () => {
    seedReleasedSale();
    const order: string[] = [];

    const result = await sweepCreator(creator(), {
      broadcast: async () => {
        order.push(`payout_rows=${mock.rows("payout").length}`);
        order.push(`status=${mock.rows("payout")[0].status}`);
        return "0xabc";
      },
      confirm: async () => ({ status: "success" }),
    });

    expect(order).toEqual(["payout_rows=1", "status=pending"]);
    expect(result.status).toBe("confirmed");
    expect(result.amountMicro).toBe(8_100_000n);
    expect(result.toAddress).toBe(PAYOUT.toLowerCase());
    expect(mock.rows("payout")[0].tx_hash).toBe("0xabc");
    // The purchases are only stamped once the receipt confirms.
    expect(mock.rows("purchase")[0].payout_id).toBe(result.payoutId);
  });

  it("skips with no_sweep_signer when this deployment holds no key, leaving the row pending (§14.8)", async () => {
    seedReleasedSale();
    const result = await sweepCreator(creator());

    expect(result.skipped).toBe("no_sweep_signer");
    expect(result.status).toBe("pending");
    expect(mock.rows("payout")).toHaveLength(1);
    expect(mock.rows("payout")[0].status).toBe("pending");
    expect(mock.rows("payout")[0].tx_hash ?? null).toBeNull();
    // Nothing was marked as paid.
    expect(mock.rows("purchase")[0].payout_id).toBeNull();
    expect(mock.rows("event").find((e) => e.name === "sweep_skipped")?.props).toMatchObject({ reason: "no_signer" });
  });

  it("freezes on a sanctions hit and never opens a payout (FR-38)", async () => {
    seedReleasedSale();
    resetScreeningCache();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([PAYOUT.toLowerCase()]), { status: 200 })));

    const result = await sweepCreator(creator(), { broadcast: async () => "0xnope", confirm: async () => ({ status: "success" }) });
    expect(result.skipped).toBe("sanctioned");
    expect(mock.rows("payout")).toHaveLength(0);
    expect(mock.rows("screening")[0].hit).toBe(true);
  });

  it("a non-confirmed payout row blocks the creator (FR-28)", async () => {
    seedReleasedSale();
    mock.rows("payout").push({
      id: "11111111-1111-1111-1111-111111111111",
      creator_id: creator().id,
      amount_micro: "1000",
      gas_micro: "0",
      to_address: PAYOUT.toLowerCase(),
      idempotency_key: "earlier",
      tx_hash: null,
      status: "broadcast",
      created_at: new Date().toISOString(),
      // The in-flight guard is per creator *per rail* (20260906010000, 20261025090100): a
      // row without this rail's network is another rail's problem and must not block here.
      chain_id: 84532,
      network: "eip155:84532",
    });

    const result = await sweepCreator(creator(), { broadcast: async () => "0xabc", confirm: async () => ({ status: "success" }) });
    expect(result.skipped).toBe("payout_in_flight");
    expect(mock.rows("payout")).toHaveLength(1);
  });

  it("does nothing when everything is still inside the holdback (FR-27)", async () => {
    const listing = seedListing(mock, { payoutAddress: PAYOUT, releases: [{ version: "1.0.0" }] });
    seedPurchase(mock, { listingId: listing.listingId, releaseId: listing.latest.id, buyer: BUYER, grantedAt: new Date().toISOString() });

    const result = await sweepCreator(creator(), { broadcast: async () => "0xabc", confirm: async () => ({ status: "success" }) });
    expect(result.skipped).toBe("nothing_to_sweep");
    expect(mock.rows("payout")).toHaveLength(0);
  });

  it("marks the payout failed on a reverted receipt and pays nothing out", async () => {
    seedReleasedSale();
    const result = await sweepCreator(creator(), { broadcast: async () => "0xdead", confirm: async () => ({ status: "reverted" }) });

    expect(result.status).toBe("failed");
    expect(mock.rows("payout")[0].status).toBe("failed");
    expect(mock.rows("purchase")[0].payout_id).toBeNull();
  });

  it("retries a reverted payout with a fresh row instead of wedging the balance forever", async () => {
    seedReleasedSale();
    const failed = await sweepCreator(creator(), { broadcast: async () => "0xdead", confirm: async () => ({ status: "reverted" }) });
    expect(failed.status).toBe("failed");

    // A revert moved no money, so the same purchase set may be swept again.
    const retried = await sweepCreator(creator(), { broadcast: async () => "0xbeef", confirm: async () => ({ status: "success" }) });
    expect(retried.skipped).toBeUndefined();
    expect(retried.status).toBe("confirmed");
    expect(retried.payoutId).not.toBe(failed.payoutId);
    expect(mock.rows("purchase")[0].payout_id).toBe(retried.payoutId);
  });

  it("stops retrying after repeated reverts and reports the wedge for an operator", async () => {
    seedReleasedSale();
    const revert = { broadcast: async () => "0xdead" as const, confirm: async () => ({ status: "reverted" as const }) };
    for (let i = 0; i < 4; i++) {
      const r = await sweepCreator(creator(), revert);
      expect(r.status).toBe("failed");
    }

    const exhausted = await sweepCreator(creator(), { broadcast: async () => "0xbeef", confirm: async () => ({ status: "success" }) });
    expect(exhausted.skipped).toBe("payout_retries_exhausted");
    // Four failed rows, no fifth attempt, and nothing was ever double-paid.
    expect(mock.rows("payout")).toHaveLength(4);
    expect(mock.rows("purchase")[0].payout_id).toBeNull();
  });

  it("is idempotent on the purchase set: a repeated sweep collides on the key", async () => {
    seedReleasedSale();
    const first = await sweepCreator(creator(), { broadcast: async () => "0xaaa", confirm: async () => ({ status: "success" }) });
    // The purchases are stamped now, so a second sweep finds nothing.
    const second = await sweepCreator(creator(), { broadcast: async () => "0xbbb", confirm: async () => ({ status: "success" }) });

    expect(second.skipped).toBe("nothing_to_sweep");
    expect(mock.rows("payout")).toHaveLength(1);
    expect(mock.rows("payout")[0].id).toBe(first.payoutId);
  });

  it("broadcasts once when two sweeps race the same purchase set (FR-28)", async () => {
    seedReleasedSale();
    const broadcasts: string[] = [];
    const broadcast = async ({ to }: { to: `0x${string}` }) => {
      broadcasts.push(to);
      return "0xabc" as `0x${string}`;
    };
    const confirm = async () => ({ status: "success" as const });

    // The cron and a manual POST /api/payouts/sweep, interleaved: both pass the
    // in-flight check, and the unique idempotency key decides which one may pay.
    const [first, second] = await Promise.all([
      sweepCreator(creator(), { broadcast, confirm }),
      sweepCreator(creator(), { broadcast, confirm }),
    ]);

    expect(broadcasts).toHaveLength(1);
    expect(mock.rows("payout")).toHaveLength(1);
    const outcomes = [first, second];
    expect(outcomes.filter((r) => r.status === "confirmed")).toHaveLength(1);
    expect(outcomes.filter((r) => r.skipped === "payout_in_flight")).toHaveLength(1);
  });

  it("sweeps to the old address during the 48h rebind delay, and to the new one after (FR-5, §7.6)", async () => {
    const NEW = "0x3333333333333333333333333333333333333333";
    const listing = seedReleasedSale();
    const row = creator();
    row.pending_payout_address = NEW;
    row.rebind_effective_at = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

    const seen: string[] = [];
    const broadcast = async ({ to }: { to: `0x${string}` }) => {
      seen.push(to);
      return "0xabc" as `0x${string}`;
    };
    const confirm = async () => ({ status: "success" as const });

    await sweepCreator(creator(), { broadcast, confirm });
    expect(seen).toEqual([PAYOUT.toLowerCase()]);
    expect(creator().payout_address).toBe(PAYOUT.toLowerCase());

    // The delay passes, a later sale releases, and the next sweep follows the rebind.
    seedPurchase(mock, {
      listingId: listing.listingId,
      releaseId: listing.latest.id,
      buyer: BUYER,
      nonce: "0xsecond",
      grantedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    });
    creator().rebind_effective_at = new Date(Date.now() - 1000).toISOString();

    await sweepCreator(creator(), { broadcast, confirm });
    expect(seen[1]).toBe(NEW);
    expect(creator().payout_address).toBe(NEW);
    expect(creator().pending_payout_address).toBeNull();
  });

  it("never sends anywhere but the bound payout address (FR-26)", async () => {
    seedReleasedSale();
    const seen: string[] = [];
    await sweepCreator(creator(), {
      broadcast: async ({ to }) => {
        seen.push(to);
        return "0xabc";
      },
      confirm: async () => ({ status: "success" }),
    });
    expect(seen).toEqual([PAYOUT.toLowerCase()]);
  });

  it("W1.1: a stamp failure after a confirmed receipt leaves the payout blocking, and no double-pay", async () => {
    const listing = seedReleasedSale();

    // Inject a failure into the second write of the *old* order — the `stampPayout` that
    // sets `purchase.payout_id`. Under the new stamp-then-confirm order this write is
    // first, so the throw leaves the payout at `broadcast` (blocking) rather than at
    // `confirmed` with unstamped purchases.
    const realFrom = mock.client.from.bind(mock.client);
    let failStamp = true;
    mock.client.from = (table: string) => {
      const q = realFrom(table);
      if (table !== "purchase") return q;
      const origUpdate = q.update.bind(q);
      q.update = (values: Record<string, unknown>) => {
        if (failStamp && values && Object.hasOwn(values, "payout_id")) {
          failStamp = false;
          const failing = {
            in: () => failing,
            eq: () => failing,
            then: (onF: (r: unknown) => unknown, onR?: (e: unknown) => unknown) =>
              Promise.resolve({ data: null, error: { code: "XX000", message: "stamp write failed", details: null, hint: null } }).then(onF, onR),
          };
          return failing;
        }
        return origUpdate(values);
      };
      return q;
    };

    await expect(
      sweepCreator(creator(), { broadcast: async () => "0xaaa", confirm: async () => ({ status: "success" }) }),
    ).rejects.toThrow();

    // Blocking, non-terminal — not a `confirmed` payout with unstamped purchases.
    expect(mock.rows("payout")).toHaveLength(1);
    expect(mock.rows("payout")[0].status).toBe("broadcast");
    expect(mock.rows("purchase")[0].payout_id).toBeNull();

    // A later sale releases; the re-sweep must not re-pay the first set.
    seedPurchase(mock, {
      listingId: listing.listingId,
      releaseId: listing.latest.id,
      buyer: BUYER,
      nonce: "0xsecond",
      grantedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    });
    const broadcasts: string[] = [];
    const resweep = await sweepCreator(creator(), {
      broadcast: async () => {
        broadcasts.push("x");
        return "0xbbb";
      },
      confirm: async () => ({ status: "success" }),
    });
    expect(resweep.skipped).toBe("payout_in_flight");
    expect(broadcasts).toHaveLength(0);
  });

  it("W1.2: an indeterminate broadcast throw leaves the payout blocking (not failed) and blocks a re-sweep", async () => {
    seedReleasedSale();

    const result = await sweepCreator(creator(), {
      broadcast: async () => {
        throw new Error("rpc timeout after the transfer may have been accepted");
      },
      confirm: async () => ({ status: "success" }),
    });

    // Left `pending` — blocking, non-terminal — never terminal `failed`, and no tx hash invented.
    expect(result.status).toBe("pending");
    expect(mock.rows("payout")).toHaveLength(1);
    expect(mock.rows("payout")[0].status).toBe("pending");
    expect(mock.rows("payout")[0].tx_hash ?? null).toBeNull();
    expect(mock.rows("purchase")[0].payout_id).toBeNull();
    expect(mock.rows("event").some((e) => e.name === "sweep_indeterminate")).toBe(true);

    // The in-flight payout blocks the creator until an ops/reconcile action clears it.
    const again = await sweepCreator(creator(), { broadcast: async () => "0xbbb", confirm: async () => ({ status: "success" }) });
    expect(again.skipped).toBe("payout_in_flight");
  });
});

describe("creatorsWithBalance", () => {
  it("names only creators with something released", async () => {
    seedReleasedSale();
    const withNothing = seedListing(mock, { owner: "beth", slug: "summariser", releases: [{ version: "1.0.0" }] });
    seedPurchase(mock, {
      listingId: withNothing.listingId,
      releaseId: withNothing.latest.id,
      buyer: BUYER,
      grantedAt: new Date().toISOString(),
    });

    const creators = await creatorsWithBalance(new Date());
    expect(creators.map((c) => c.handle)).toEqual(["adrian"]);
  });
});
