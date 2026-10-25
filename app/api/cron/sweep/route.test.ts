import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { resetScreeningCache } from "@/lib/screening";
import { seedListing, seedPurchase } from "@/lib/test/fixtures";
import { makeMockDb } from "@/lib/test/mock-db";
import { GET } from "./route";

const BUYER = "0xAAaAAAaAAaaAaaAaAaAAAAaAaAaAaAAAAaaAAaAa";

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
  delete process.env.CRON_SECRET;
  delete process.env.PLATFORM_RECEIVING_ADDRESS;
  delete process.env.X402_NETWORK;
  resetEnv();
});

function get(headers: Record<string, string> = {}) {
  return GET(new NextRequest("https://x402git.test/api/cron/sweep", { headers }));
}

describe("GET /api/cron/sweep", () => {
  it("requires the Vercel cron bearer token when CRON_SECRET is set", async () => {
    process.env.CRON_SECRET = "s3cret";
    resetEnv();

    expect((await get()).status).toBe(401);
    expect((await get({ authorization: "Bearer wrong" })).status).toBe(401);
    expect((await get({ authorization: "Bearer s3cret" })).status).toBe(200);
  });

  it("is open when no secret is configured, so a local run works", async () => {
    expect((await get()).status).toBe(200);
  });

  it("reports each creator it looked at, and skips the ones with no signer", async () => {
    const listing = seedListing(mock, { releases: [{ version: "1.0.0" }] });
    seedPurchase(mock, {
      listingId: listing.listingId,
      releaseId: listing.latest.id,
      buyer: BUYER,
      grantedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    });

    const body = await (await get()).json();
    expect(body.creators).toBe(1);
    expect(body.results[0]).toMatchObject({ skipped: "no_sweep_signer", status: "pending", tx_hash: null });
    expect(body.results[0].to_address).toMatch(/^0x/);
    expect(body.swept_micro).toBe("0");
    expect(mock.rows("event").map((e) => e.name)).toContain("cron_sweep");
  });
});
