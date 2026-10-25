import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { privateKeyToAccount } from "viem/accounts";
import { issueChallenge } from "@/lib/auth/challenge";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { seedListing, seedPurchase } from "@/lib/test/fixtures";
import { makeMockDb } from "@/lib/test/mock-db";
import { receiptPath } from "@/lib/receipts";
import { GET } from "./route";

const buyer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const OTHER = "0xBbBbBBBbbBBBbbbBbbBbbbbBBbBbbbBbBbbbBBbB";

let mock: ReturnType<typeof makeMockDb>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  process.env.NEXT_PUBLIC_APP_URL = "https://x402git.test";
  process.env.SESSION_SECRET = "test-session-secret";
  resetEnv();
});

afterEach(() => {
  resetDb();
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.SESSION_SECRET;
  resetEnv();
});

async function get(withSignature = true) {
  const headers: Record<string, string> = { "x-forwarded-for": "10.0.0.4" };
  if (withSignature) {
    const challenge = await issueChallenge(buyer.address, "wallet_ownership");
    headers["x-wallet-signature"] = `${buyer.address}.${challenge.nonce}.${await buyer.signMessage({ message: challenge.message })}`;
  }
  return GET(new NextRequest("https://x402git.test/api/entitlements", { headers }));
}

describe("GET /api/entitlements (FR-32)", () => {
  it("lists what this wallet owns, with its own receipts", async () => {
    const listing = seedListing(mock, { releases: [{ version: "1.0.0" }] });
    seedPurchase(mock, { listingId: listing.listingId, releaseId: listing.latest.id, buyer: buyer.address });

    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.address).toBe(buyer.address);
    expect(body.entitlements).toHaveLength(1);
    expect(body.entitlements[0]).toMatchObject({
      owner: "adrian",
      slug: "humanizer",
      version: "1.0.0",
      kind: "new",
      all_versions: false,
      resource_endpoint: "https://x402git.test/api/r/adrian/humanizer",
      version_endpoint: "https://x402git.test/api/r/adrian/humanizer/v/1.0.0",
    });
    // A buyer auditing its own agents is entitled to its own transaction hash (FR-32).
    expect(body.entitlements[0].tx_hash).toMatch(/^0x/);
    // …and to a receipt it can hand to somebody else. The token is minted here only.
    expect(body.entitlements[0].purchase_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.entitlements[0].receipt_url).toBe(`https://x402git.test${receiptPath(body.entitlements[0].purchase_id)}`);
    // Nothing newer exists, so there is nothing to offer.
    expect(body.entitlements[0].latest_version).toBe("1.0.0");
    expect(body.entitlements[0].update).toBeNull();
  });

  it("offers the newer release at this wallet's stamped update price (FR-16, D1)", async () => {
    const listing = seedListing(mock, { updatePriceMicro: "5000000", releases: [{ version: "1.0.0" }, { version: "1.4.0" }] });
    const v10 = listing.releases.find((r) => r.version === "1.0.0")!;
    seedPurchase(mock, { listingId: listing.listingId, releaseId: v10.id, buyer: buyer.address, updatePriceAtPurchase: "3000000" });

    const [row] = (await (await get()).json()).entitlements;
    expect(row.version).toBe("1.0.0");
    expect(row.latest_version).toBe("1.4.0");
    // min(stamped $3, current $5) = $3: the terms never worsen.
    expect(row.update).toEqual({ version: "1.4.0", price_micro: "3000000" });
  });

  it("marks an included update as free and attaches it to the newest owned row only", async () => {
    const listing = seedListing(mock, { releases: [{ version: "1.0.0" }, { version: "1.2.0" }, { version: "1.4.0" }] });
    const [v10, v12] = listing.releases;
    seedPurchase(mock, { listingId: listing.listingId, releaseId: v10.id, buyer: buyer.address, allVersions: true, grantedAt: "2026-08-01T00:00:00.000Z" });
    seedPurchase(mock, { listingId: listing.listingId, releaseId: v12.id, buyer: buyer.address, allVersions: true, grantedAt: "2026-08-10T00:00:00.000Z" });

    const rows = (await (await get()).json()).entitlements;
    const byVersion = Object.fromEntries(rows.map((r: { version: string }) => [r.version, r]));
    expect(byVersion["1.2.0"].update).toEqual({ version: "1.4.0", price_micro: "0" });
    expect(byVersion["1.0.0"].update).toBeNull();
    expect(byVersion["1.0.0"].latest_version).toBe("1.4.0");
  });

  it("offers nothing further from a retired listing, even when a newer release exists", async () => {
    const listing = seedListing(mock, { retired: true, releases: [{ version: "1.0.0" }, { version: "1.4.0" }] });
    const v10 = listing.releases.find((r) => r.version === "1.0.0")!;
    seedPurchase(mock, { listingId: listing.listingId, releaseId: v10.id, buyer: buyer.address });

    const [row] = (await (await get()).json()).entitlements;
    expect(row.latest_version).toBe("1.4.0");
    expect(row.update).toBeNull();
  });

  it("never returns another wallet's purchases", async () => {
    const listing = seedListing(mock, { releases: [{ version: "1.0.0" }] });
    seedPurchase(mock, { listingId: listing.listingId, releaseId: listing.latest.id, buyer: OTHER });

    const body = await (await get()).json();
    expect(body.entitlements).toEqual([]);
  });

  it("requires a wallet signature (FR-40)", async () => {
    const res = await get(false);
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("invalid_signature");
  });
});
