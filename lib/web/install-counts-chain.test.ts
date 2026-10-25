/**
 * An install count is the most public number this product computes, and PRODUCT.md's
 * central claim rests on it being honest. One database serves both networks, so at the
 * mainnet cutover the listing pages were briefly ready to publish eighteen testnet
 * purchases as installs — the exact inflation FR-40's rules exist to refuse.
 *
 * Entitlement has the same shape and a sharper edge: a wallet that bought on Sepolia
 * would have read as owning the version on mainnet, and been handed the artifact free.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { owned } from "@/lib/core/access";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { seedListing, seedPurchase } from "@/lib/test/fixtures";
import { makeMockDb } from "@/lib/test/mock-db";
import { installCount } from "./loaders";

const BASE_SEPOLIA = 84532;
const BASE_MAINNET = 8453;
const WALLET = "0xAAaAAAaAAaaAaaAaAaAAAAaAaAaAaAAAAaaAAaAa";

let mock: ReturnType<typeof makeMockDb>;
let listing: ReturnType<typeof seedListing>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  process.env.NEXT_PUBLIC_APP_URL = "https://x402git.test";
  listing = seedListing(mock);
});

afterEach(() => {
  resetDb();
  delete process.env.X402_NETWORK;
  resetEnv();
});

const on = (network: string) => {
  process.env.X402_NETWORK = network;
  resetEnv();
};

const buy = (chainId: number, buyer = WALLET) =>
  seedPurchase(mock, { listingId: listing.listingId, releaseId: listing.latest.id, buyer, chainId });

describe("installs and entitlement do not cross chains", () => {
  it("counts an install made on this chain", async () => {
    on("base-sepolia");
    buy(BASE_SEPOLIA);
    expect(await installCount(listing.listingId)).toBe(1);
  });

  it("does not publish another chain's purchases as installs", async () => {
    on("base");
    buy(BASE_SEPOLIA);
    buy(BASE_SEPOLIA, "0xBbBbBBBbbBBBbbbBbbBbbbbBBbBbbbBbBbbbBBbB");
    expect(await installCount(listing.listingId)).toBe(0);
  });

  it("counts only this chain's share when the ledger holds both", async () => {
    on("base");
    buy(BASE_MAINNET);
    buy(BASE_SEPOLIA, "0xBbBbBBBbbBBBbbbBbbBbbbbBBbBbbbBbBbbbBBbB");
    expect(await installCount(listing.listingId)).toBe(1);
  });

  it("reports a purchase made on this chain as owned", async () => {
    on("base-sepolia");
    buy(BASE_SEPOLIA);
    expect(await owned(WALLET)).toHaveLength(1);
  });

  /** The sharp edge: a testnet purchase must not unlock the mainnet artifact. */
  it("does not report another chain's purchase as owned", async () => {
    on("base");
    buy(BASE_SEPOLIA);
    expect(await owned(WALLET)).toHaveLength(0);
  });
});
