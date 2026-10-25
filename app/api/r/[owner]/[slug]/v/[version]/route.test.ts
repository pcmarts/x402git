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
const other = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");

let mock: ReturnType<typeof makeMockDb>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  process.env.NEXT_PUBLIC_APP_URL = "https://x402git.test";
  resetEnv();
});

afterEach(() => {
  resetDb();
  delete process.env.NEXT_PUBLIC_APP_URL;
  resetEnv();
});

function get(version: string, headers: Record<string, string> = {}) {
  const req = new NextRequest(`https://x402git.test/api/r/adrian/humanizer/v/${version}`, {
    headers: { "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 250) + 1}`, ...headers },
  });
  return GET(req, { params: Promise.resolve({ owner: "adrian", slug: "humanizer", version }) });
}

async function walletSignature(account = buyer) {
  const challenge = await issueChallenge(account.address, "wallet_ownership");
  return `${account.address}.${challenge.nonce}.${await account.signMessage({ message: challenge.message })}`;
}

describe("GET /api/r/:owner/:slug/v/:version (FR-19)", () => {
  it("re-issues a signed URL for a version the wallet owns, years later", async () => {
    const seed = seedListing(mock, { releases: [{ version: "1.2.0" }, { version: "1.3.0" }] });
    seedPurchase(mock, {
      listingId: seed.listingId,
      releaseId: seed.releases[0].id,
      buyer: buyer.address,
      grantedAt: new Date(Date.now() - 900 * 86_400_000).toISOString(),
    });

    const res = await get("1.2.0", { "x-wallet-signature": await walletSignature() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe("1.2.0");
    expect(body.download_url).toContain("1.2.0.zip");
    // A re-fetch is never a sale.
    expect(mock.rows("purchase")).toHaveLength(1);
  });

  it("requires a wallet signature — `?address=` is not identity (FR-20)", async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });
    const res = await get("1.2.0");
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("invalid_signature");
  });

  it("is not_entitled for a wallet that does not own that version", async () => {
    const seed = seedListing(mock, { releases: [{ version: "1.2.0" }] });
    seedPurchase(mock, {
      listingId: seed.listingId,
      releaseId: seed.latest.id,
      buyer: other.address,
      grantedAt: new Date(Date.now() - 900 * 86_400_000).toISOString(),
    });
    const res = await get("1.2.0", { "x-wallet-signature": await walletSignature() });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("not_entitled");
  });

  it("keeps working after the listing is retired (FR-46)", async () => {
    const seed = seedListing(mock, { retired: true, releases: [{ version: "1.2.0" }] });
    seedPurchase(mock, { listingId: seed.listingId, releaseId: seed.latest.id, buyer: buyer.address });
    expect((await get("1.2.0", { "x-wallet-signature": await walletSignature() })).status).toBe(200);
  });
});
