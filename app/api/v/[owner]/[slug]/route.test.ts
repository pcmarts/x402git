import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { privateKeyToAccount } from "viem/accounts";
import { issueChallenge } from "@/lib/auth/challenge";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { seedListing, seedPurchase } from "@/lib/test/fixtures";
import { makeMockDb } from "@/lib/test/mock-db";
import { GET } from "./route";

const buyer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

let mock: ReturnType<typeof makeMockDb>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  process.env.NEXT_PUBLIC_APP_URL = "https://x402git.test";
  process.env.PLATFORM_RECEIVING_ADDRESS = "0x1111111111111111111111111111111111111111";
  resetEnv();
});

afterEach(() => {
  resetDb();
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.PLATFORM_RECEIVING_ADDRESS;
  resetEnv();
});

function get(headers: Record<string, string> = {}) {
  const req = new NextRequest("https://x402git.test/api/v/adrian/humanizer", {
    headers: { "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 250) + 1}`, ...headers },
  });
  return GET(req, { params: Promise.resolve({ owner: "adrian", slug: "humanizer" }) });
}

async function walletSignature() {
  const challenge = await issueChallenge(buyer.address, "wallet_ownership");
  return `${buyer.address}.${challenge.nonce}.${await buyer.signMessage({ message: challenge.message })}`;
}

describe("GET /api/v/:owner/:slug (FR-20)", () => {
  it("returns version data only without a signature", async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      owner: "adrian",
      slug: "humanizer",
      latest: "1.2.0",
      price_micro: "9000000",
      update_price_micro: "3000000",
      status: "live",
      releases_url: "https://x402git.test/api/v/adrian/humanizer/releases",
    });
    expect(body.owned).toBeUndefined();
    expect(body.entitled).toBeUndefined();
  });

  it("never answers entitlement for ?address= alone (no purchase-history oracle)", async () => {
    const seed = seedListing(mock, { releases: [{ version: "1.2.0" }] });
    seedPurchase(mock, { listingId: seed.listingId, releaseId: seed.latest.id, buyer: buyer.address });

    const req = new NextRequest(`https://x402git.test/api/v/adrian/humanizer?address=${buyer.address}`, {
      headers: { "x-forwarded-for": "10.0.0.7" },
    });
    const body = await (await GET(req, { params: Promise.resolve({ owner: "adrian", slug: "humanizer" }) })).json();
    expect(body.owned).toBeUndefined();
    expect(body.entitled).toBeUndefined();
  });

  it("answers owned / entitled / price_kind with a valid signature", async () => {
    const seed = seedListing(mock, { releases: [{ version: "1.2.0" }] });
    seedPurchase(mock, { listingId: seed.listingId, releaseId: seed.latest.id, buyer: buyer.address });

    const body = await (await get({ "x-wallet-signature": await walletSignature() })).json();
    expect(body).toMatchObject({ owned: "1.2.0", entitled: true, price_kind: "owned", price_micro: "0" });
  });

  it("quotes the update price to a holder of an older version (§7.4)", async () => {
    const seed = seedListing(mock, { releases: [{ version: "1.2.0" }, { version: "1.3.0" }] });
    seedPurchase(mock, {
      listingId: seed.listingId,
      releaseId: seed.releases[0].id,
      buyer: buyer.address,
      grantedAt: new Date(Date.now() - 60 * 86_400_000).toISOString(),
    });

    const body = await (await get({ "x-wallet-signature": await walletSignature() })).json();
    expect(body).toMatchObject({ latest: "1.3.0", owned: "1.2.0", entitled: false, price_kind: "update", price_micro: "3000000" });
  });

  it("is 404 for an unknown listing", async () => {
    expect((await get()).status).toBe(404);
  });

  it("is 401 for a malformed signature rather than a silent downgrade", async () => {
    seedListing(mock, { releases: [{ version: "1.0.0" }] });
    const res = await get({ "x-wallet-signature": "not-a-signature" });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("invalid_signature");
  });

  it("is 404 for a draft listing, which is not a public resource", async () => {
    seedListing(mock, { published: false, releases: [{ version: "1.0.0" }] });
    const res = await get();
    expect(res.status).toBe(404);
    // `/api/r` already answers not_found for a draft; publishing its version and price
    // here would confirm the slug is taken and leak unpublished pricing.
    expect(await res.text()).not.toContain("9000000");
  });

  it("still reports prices and status for a retired listing", async () => {
    seedListing(mock, { retired: true, releases: [{ version: "1.0.0" }] });
    const body = await (await get()).json();
    expect(body.status).toBe("retired");
    expect(body.latest).toBe("1.0.0");
  });
});
