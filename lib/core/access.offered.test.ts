/**
 * lib/core/access.offered.test.ts — a listing's own choice of rails (25 Oct 2026,
 * migration 20261025213000; founder: "we should have the option to switch between").
 *
 * `listing.offered_networks` narrows the rails `railsFor` would offer. The rule under test
 * is the single-source one: the 402's `accepts` and `payment_options` read the same filter,
 * so an agent reading the listing JSON can still predict the 402 exactly. Null is today's
 * behaviour, byte for byte; a filter that leaves nothing is the existing "no rail" 503.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import type { CreatorRow, ListingRow } from "@/lib/db/types";
import { resetEnv } from "@/lib/env";
import { isApiError } from "@/lib/errors";
import { PaymentRequiredBody } from "@/lib/schemas";
import { seedListing } from "@/lib/test/fixtures";
import { makeMockDb } from "@/lib/test/mock-db";
import { clearStellarEnv, setStellarTestnetEnv, STELLAR_CREATOR, STELLAR_TESTNET_USDC } from "@/lib/test/stellar";
import { paymentOptionsFor, type PaymentRequiredQuote, payoutRailsFor, quote, toPaymentRequirements } from "./access";

const EVM_PAYOUT = "0x2222222222222222222222222222222222222222";
const NOW = new Date("2026-10-25T21:30:00.000Z");
const TWO_DOLLARS = { priceMicro: "2000000", releases: [{ version: "1.2.0" }] };
const BASE_SEPOLIA = "eip155:84532";
const ARBITRUM = "eip155:42161";
const STELLAR = "stellar:testnet";

let mock: ReturnType<typeof makeMockDb>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  clearStellarEnv();
  process.env.NEXT_PUBLIC_APP_URL = "https://x402git.test";
  process.env.PLATFORM_RECEIVING_ADDRESS = "0x1111111111111111111111111111111111111111";
  process.env.X402_NETWORK = "base-sepolia";
  resetEnv();
});

afterEach(() => {
  resetDb();
  clearStellarEnv();
  for (const k of ["NEXT_PUBLIC_APP_URL", "PLATFORM_RECEIVING_ADDRESS", "X402_NETWORK", "X402_EXTRA_EVM_RAILS"]) delete process.env[k];
  resetEnv();
});

/** Base Sepolia, Arbitrum and Stellar testnet, all three running. */
function threeRails(): void {
  setStellarTestnetEnv();
  process.env.X402_EXTRA_EVM_RAILS = '[{"network":"eip155:42161"}]';
  resetEnv();
}

async function quoteFor(owner = "adrian", slug = "humanizer"): Promise<PaymentRequiredQuote> {
  const q = await quote({ owner, slug }, null);
  if (q.kind !== "payment_required") throw new Error(`expected payment_required, got ${q.kind}`);
  return q;
}

function rowsOf(seeded: { creatorId: string; listingId: string }): { creator: CreatorRow; listing: ListingRow } {
  return {
    creator: mock.rows("creator").find((c) => c.id === seeded.creatorId) as unknown as CreatorRow,
    listing: mock.rows("listing").find((l) => l.id === seeded.listingId) as unknown as ListingRow,
  };
}

function setOffered(listingId: string, offered: string[] | null): void {
  const row = mock.rows("listing").find((l) => l.id === listingId)!;
  row.offered_networks = offered;
}

describe("offered_networks narrows the rails, in the 402 and in payment_options alike", () => {
  it("null is every rail the creator can be paid on: today's three, in today's order", async () => {
    threeRails();
    const seeded = seedListing(mock, { ...TWO_DOLLARS, payoutAddress: EVM_PAYOUT, stellarPayoutAddress: STELLAR_CREATOR });
    const { creator, listing } = rowsOf(seeded);

    expect(listing.offered_networks).toBeNull();
    expect(paymentOptionsFor(creator, listing).map((o) => o.network)).toEqual([BASE_SEPOLIA, ARBITRUM, STELLAR]);
    expect(toPaymentRequirements(await quoteFor(), NOW).accepts.map((a) => a.network)).toEqual([BASE_SEPOLIA, ARBITRUM, STELLAR]);
  });

  it("a row from before the migration (no key at all) offers everything, like null", async () => {
    threeRails();
    const seeded = seedListing(mock, { ...TWO_DOLLARS, payoutAddress: EVM_PAYOUT, stellarPayoutAddress: STELLAR_CREATOR });
    delete mock.rows("listing").find((l) => l.id === seeded.listingId)!.offered_networks;
    const { creator, listing } = rowsOf(seeded);

    expect(paymentOptionsFor(creator, listing).map((o) => o.network)).toEqual([BASE_SEPOLIA, ARBITRUM, STELLAR]);
    expect(toPaymentRequirements(await quoteFor(), NOW).accepts).toHaveLength(3);
  });

  it("an array offers only those networks, and the 402 and payment_options agree entry for entry", async () => {
    threeRails();
    const seeded = seedListing(mock, { ...TWO_DOLLARS, payoutAddress: EVM_PAYOUT, stellarPayoutAddress: STELLAR_CREATOR, offeredNetworks: [ARBITRUM, STELLAR] });
    const { creator, listing } = rowsOf(seeded);

    const options = paymentOptionsFor(creator, listing);
    const { body, accepts } = toPaymentRequirements(await quoteFor(), NOW);

    expect(options.map((o) => o.network)).toEqual([ARBITRUM, STELLAR]);
    expect(accepts.map((a) => a.network)).toEqual([ARBITRUM, STELLAR]);
    // The single-source rule: what the option says is what the 402 asks for.
    expect(options.map((o) => [o.network, o.asset, o.amount])).toEqual(accepts.map((a) => [a.network, a.asset, a.amount]));
    expect(accepts[1]).toMatchObject({ network: STELLAR, amount: "20000000", asset: STELLAR_TESTNET_USDC });
    expect(() => PaymentRequiredBody.parse(body)).not.toThrow();
  });

  it("a listing that leaves Base off leads with Arbitrum, and never tells the agent to sign USDC", async () => {
    threeRails();
    seedListing(mock, { ...TWO_DOLLARS, payoutAddress: EVM_PAYOUT, offeredNetworks: [ARBITRUM] });
    const { body, accepts } = toPaymentRequirements(await quoteFor(), NOW);

    expect(accepts.map((a) => a.network)).toEqual([ARBITRUM]);
    expect(accepts[0].extra).toEqual({ name: "USD₮0", version: "1" });
    // Not the deployment's primary, so its entry names its token and chain.
    expect(body.accepts[0].description).toContain("$2.00 in USDT0 on Arbitrum.");
    expect(body.extra.instructions).toContain("on Arbitrum that is an EIP-3009 USDT0 authorization");
    expect(body.extra.instructions).not.toContain("USDC");
    expect(() => PaymentRequiredBody.parse(body)).not.toThrow();
  });

  it("offering Base alone on a two-EVM-rail deployment is the one-rail Base 402, byte for byte", async () => {
    seedListing(mock, { ...TWO_DOLLARS, payoutAddress: EVM_PAYOUT });
    const q = await quoteFor();
    const before = toPaymentRequirements(q, NOW);

    process.env.X402_EXTRA_EVM_RAILS = '[{"network":"eip155:42161"}]';
    resetEnv();
    const narrowed = toPaymentRequirements({ ...q, offeredNetworks: [BASE_SEPOLIA] }, NOW);

    expect(narrowed.body).toEqual(before.body);
    expect(narrowed.accepts).toEqual(before.accepts);
  });

  it("only ever removes: a network the creator cannot be paid on is not offered just because it is named", async () => {
    threeRails();
    const seeded = seedListing(mock, { ...TWO_DOLLARS, payoutAddress: EVM_PAYOUT, offeredNetworks: [BASE_SEPOLIA, STELLAR, "eip155:1"] });
    const { creator, listing } = rowsOf(seeded);

    expect(paymentOptionsFor(creator, listing).map((o) => o.network)).toEqual([BASE_SEPOLIA]);
    expect(toPaymentRequirements(await quoteFor(), NOW).accepts.map((a) => a.network)).toEqual([BASE_SEPOLIA]);
  });

  it("a listing left with no reachable rail is the 'no rail' case: 503 paused, and payment_options is empty", async () => {
    threeRails();
    // Offered on Stellar only, and then the Stellar wallet goes away.
    const seeded = seedListing(mock, { ...TWO_DOLLARS, payoutAddress: EVM_PAYOUT, stellarPayoutAddress: STELLAR_CREATOR, offeredNetworks: [STELLAR] });
    mock.rows("creator").find((c) => c.id === seeded.creatorId)!.stellar_payout_address = null;
    const { creator, listing } = rowsOf(seeded);

    expect(paymentOptionsFor(creator, listing)).toEqual([]);
    const q = await quoteFor();
    let caught: unknown;
    try {
      toPaymentRequirements(q, NOW);
    } catch (e) {
      caught = e;
    }
    expect(isApiError(caught) && caught.code).toBe("paused");
    expect(isApiError(caught) && caught.message).toContain("offered on");
  });

  it("the same when the deployment stops running the one offered rail", async () => {
    threeRails();
    seedListing(mock, { ...TWO_DOLLARS, payoutAddress: EVM_PAYOUT, offeredNetworks: [ARBITRUM] });
    const q = await quoteFor();
    delete process.env.X402_EXTRA_EVM_RAILS;
    resetEnv();
    expect(() => toPaymentRequirements(q, NOW)).toThrow();
  });
});

describe("payoutRailsFor — the menu the dashboard offers, with where each rail pays out", () => {
  it("lists every rail this deployment runs, in 402 order, with the address of its family or null", () => {
    threeRails();
    const evmOnly = payoutRailsFor({ payout_address: EVM_PAYOUT, stellar_payout_address: null });
    expect(evmOnly).toEqual([
      { network: BASE_SEPOLIA, symbol: "USDC", family: "evm", address: EVM_PAYOUT },
      { network: ARBITRUM, symbol: "USDT0", family: "evm", address: EVM_PAYOUT },
      { network: STELLAR, symbol: "USDC", family: "stellar", address: null },
    ]);

    const both = payoutRailsFor({ payout_address: EVM_PAYOUT, stellar_payout_address: STELLAR_CREATOR });
    expect(both.map((r) => r.address)).toEqual([EVM_PAYOUT, EVM_PAYOUT, STELLAR_CREATOR]);

    // A Stellar identity is its own Stellar payout address, and has no EVM one (BUILD H5).
    const stellarOnly = payoutRailsFor({ payout_address: STELLAR_CREATOR, stellar_payout_address: null });
    expect(stellarOnly.map((r) => r.address)).toEqual([null, null, STELLAR_CREATOR]);
  });

  it("has no Stellar row on a deployment that does not run the rail", () => {
    expect(payoutRailsFor({ payout_address: EVM_PAYOUT, stellar_payout_address: STELLAR_CREATOR }).map((r) => r.network)).toEqual([BASE_SEPOLIA]);
  });
});
