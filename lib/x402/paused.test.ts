/**
 * The §19 payments kill switch, through `purchaseFlow` — the one sequence both the HTTP
 * route and the MCP `purchase` tool run, so a pause neither surface can walk around.
 *
 * The property under test is narrow and load-bearing: **503, never 402.** A 402 is an
 * instruction to sign an authorization against a quote, and an endpoint that has been
 * paused cannot honour one. Answering 402 while paused would have agents signing
 * payments into a wall.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { ERRORS, isApiError } from "@/lib/errors";
import { resetSwitchCache } from "@/lib/ops/switches";
import { resetScreeningCache } from "@/lib/screening";
import { seedListing, seedPurchase } from "@/lib/test/fixtures";
import { makeMockDb } from "@/lib/test/mock-db";
import { purchaseFlow } from "./flow";

let mock: ReturnType<typeof makeMockDb>;

const BUYER = "0xAAaAAAaAAaaAaaAaAaAAAAaAaAaAaAAAAaaAAaAa";

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  resetScreeningCache();
  resetSwitchCache();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
  process.env.NEXT_PUBLIC_APP_URL = "https://x402git.test";
  process.env.PLATFORM_RECEIVING_ADDRESS = "0x1111111111111111111111111111111111111111";
  process.env.X402_NETWORK = "base-sepolia";
  resetEnv();
});

afterEach(() => {
  resetDb();
  resetScreeningCache();
  resetSwitchCache();
  vi.unstubAllGlobals();
});

const pause = (name: string) => mock.seed("ops_switch", [{ name, paused: true }]);

const buy = (owner: string, slug: string, buyer: string | null = null) =>
  purchaseFlow({ owner, slug, buyer, paymentSignature: null, source: "api" });

describe("the payments kill switch", () => {
  it("answers 503 rather than 402 when paused", async () => {
    const listing = seedListing(mock, { priceMicro: "9000000" });
    pause("payments");

    await expect(buy(listing.owner, listing.slug)).rejects.toSatisfy((e: unknown) => {
      if (!isApiError(e)) return false;
      expect(e.code).toBe("paused");
      expect(e.status).toBe(503);
      return true;
    });
    expect(ERRORS.paused.status).toBe(503);
  });

  it("quotes normally when nothing is paused", async () => {
    const listing = seedListing(mock, { priceMicro: "9000000" });
    const result = await buy(listing.owner, listing.slug);
    expect(result.kind).toBe("payment_required");
  });

  it("is not tripped by another switch being on", async () => {
    const listing = seedListing(mock, { priceMicro: "9000000" });
    pause("sweeps");
    const result = await buy(listing.owner, listing.slug);
    expect(result.kind).toBe("payment_required");
  });

  /**
   * FR-19 promises a bought version stays fetchable forever. An incident is not a reason
   * to break that, and a pause is not a revocation — the switch stops money moving, not
   * access to what somebody already paid for.
   */
  it("still serves a wallet that already owns the version", async () => {
    const listing = seedListing(mock, { priceMicro: "9000000" });
    seedPurchase(mock, { listingId: listing.listingId, releaseId: listing.latest.id, buyer: BUYER });
    pause("payments");

    const result = await buy(listing.owner, listing.slug, BUYER);
    expect(result.kind).toBe("granted");
  });

  /** A $0 listing moves no money, so a payments pause has nothing to say about it. */
  it("still serves a free listing", async () => {
    const listing = seedListing(mock, { priceMicro: "0" });
    pause("payments");

    const result = await buy(listing.owner, listing.slug, BUYER);
    expect(result.kind).toBe("granted");
  });
});
