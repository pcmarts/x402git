/**
 * PATCH /api/listings/:id — `offered_networks` (25 Oct 2026, migration 20261025213000).
 *
 * The founder asked for a creator to switch, per listing, between the ways they can be
 * paid. The service is where that choice is checked: every network must be one this
 * deployment serves and one the creator can be paid on, each refusal names the field, and
 * `null` goes back to every rail. The listing JSON carries the choice, and its
 * `payment_options` already reflect it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { makeMockDb } from "@/lib/test/mock-db";
import { ctx, req, seedCreator, seedListing } from "@/lib/test/listings-fixtures";
import { clearStellarEnv, setStellarTestnetEnv, STELLAR_CREATOR } from "@/lib/test/stellar";

vi.mock("@/lib/github/installations", () => ({ installationAccount: vi.fn(), resolveRepo: vi.fn(), repoById: vi.fn() }));
vi.mock("@/lib/release", () => ({ cutRelease: vi.fn() }));

const { GET, PATCH } = await import("./route");

const BASE_SEPOLIA = "eip155:84532";
const ARBITRUM = "eip155:42161";
const STELLAR = "stellar:testnet";

let mock: ReturnType<typeof makeMockDb>;
let creator: Record<string, any>;
let listing: Record<string, any>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  clearStellarEnv();
  // Base Sepolia (the default primary), Arbitrum and Stellar testnet: three rails.
  setStellarTestnetEnv();
  process.env.X402_EXTRA_EVM_RAILS = '[{"network":"eip155:42161"}]';
  resetEnv();
  creator = seedCreator(mock);
  listing = seedListing(mock, creator, { offered_networks: null });
});

afterEach(() => {
  resetDb();
  vi.clearAllMocks();
  clearStellarEnv();
  delete process.env.X402_EXTRA_EVM_RAILS;
  resetEnv();
});

async function patch(body: unknown) {
  return await PATCH(req("/x", { method: "PATCH", body }), ctx(listing.id));
}

function row() {
  return mock.rows("listing").find((l) => l.id === listing.id)!;
}

describe("PATCH /api/listings/:id — offered_networks", () => {
  it("narrows the listing to the networks named, and payment_options follows at once", async () => {
    const before = await (await GET(req("/x"), ctx(listing.id))).json();
    expect(before.offered_networks).toBeNull();
    // An EVM-only creator: both EVM rails, no Stellar.
    expect(before.payment_options.map((o: { network: string }) => o.network)).toEqual([BASE_SEPOLIA, ARBITRUM]);

    const res = await patch({ offered_networks: [ARBITRUM] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.offered_networks).toEqual([ARBITRUM]);
    expect(body.payment_options.map((o: { network: string }) => o.network)).toEqual([ARBITRUM]);
    expect(row().offered_networks).toEqual([ARBITRUM]);
  });

  it("null clears it back to every rail the creator can be paid on", async () => {
    row().offered_networks = [ARBITRUM];
    const body = await (await patch({ offered_networks: null })).json();
    expect(body.offered_networks).toBeNull();
    expect(body.payment_options.map((o: { network: string }) => o.network)).toEqual([BASE_SEPOLIA, ARBITRUM]);
    expect(row().offered_networks).toBeNull();
  });

  it("stores each network once, in the deployment's rail order", async () => {
    mock.rows("creator").find((c) => c.id === creator.id)!.stellar_payout_address = STELLAR_CREATOR;
    const body = await (await patch({ offered_networks: [STELLAR, BASE_SEPOLIA, STELLAR] })).json();
    expect(body.offered_networks).toEqual([BASE_SEPOLIA, STELLAR]);
    expect(body.payment_options.map((o: { network: string }) => o.network)).toEqual([BASE_SEPOLIA, STELLAR]);
  });

  it("refuses a network this deployment does not serve, naming the field and the network", async () => {
    const res = await patch({ offered_networks: [BASE_SEPOLIA, "eip155:1"] });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("invalid_request");
    expect(body.details).toMatchObject({ field: "offered_networks", network: "eip155:1" });
    expect(body.message).toContain("eip155:1 is not a network this deployment serves");
    expect(row().offered_networks).toBeNull();
  });

  it("refuses a rail the creator cannot be paid on: Stellar with no Stellar address", async () => {
    const res = await patch({ offered_networks: [STELLAR] });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("invalid_request");
    expect(body.details).toMatchObject({ field: "offered_networks", network: STELLAR });
    expect(body.message).toContain("Stellar address");
    expect(row().offered_networks).toBeNull();
  });

  it("refuses an EVM rail for a creator whose only address is a Stellar G…", async () => {
    mock.rows("creator").find((c) => c.id === creator.id)!.payout_address = STELLAR_CREATOR;
    const res = await patch({ offered_networks: [ARBITRUM] });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain("EVM address");

    // …and Stellar alone is fine: a G identity is its own Stellar payout address.
    expect((await patch({ offered_networks: [STELLAR] })).status).toBe(200);
  });

  it("refuses an empty list: the way off sale is retire", async () => {
    const res = await patch({ offered_networks: [] });
    expect(res.status).toBe(400);
    expect((await res.json()).details).toMatchObject({ field: "offered_networks" });
  });

  it("does not let a refused rail half-save the rest of the patch", async () => {
    const res = await patch({ price_micro: "19000000", offered_networks: ["eip155:1"] });
    expect(res.status).toBe(400);
    expect(String(row().price_micro)).toBe("9000000");
  });

  it("null onto a listing that already offers everything writes nothing, even on a row from before the migration", async () => {
    delete row().offered_networks;
    const res = await patch({ price_micro: "19000000", offered_networks: null });
    expect(res.status).toBe(200);
    expect(String(row().price_micro)).toBe("19000000");
    expect("offered_networks" in row()).toBe(false);
    expect((await res.json()).offered_networks).toBeNull();
  });

  it("answers null alone with the listing as it stands, rather than 'nothing to change'", async () => {
    const res = await patch({ offered_networks: null });
    expect(res.status).toBe(200);
    expect((await res.json()).listing_id).toBe(listing.id);
  });
});
