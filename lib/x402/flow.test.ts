/**
 * lib/x402/flow.test.ts — the two purchase-flow gates this remediation adds:
 *
 * - W1.3 (DB): `quote_id` is mandatory on a priced settlement.
 * - W1.4 (DA): a nonce-replay verifies the authorization signature locally, requires the
 *   purchasing wallet, and only serves a grant inside `REPLAY_GRANT_WINDOW_SEC`.
 *
 * `purchaseFlow` is exercised directly (the route and the MCP tool are thin shells over
 * it), with a stubbed facilitator so nothing reaches the network.
 */

import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { replayGrantWindowSec, resetEnv } from "@/lib/env";
import { isApiError } from "@/lib/errors";
import { notifyAdmin } from "@/lib/notify";
import { resetScreeningCache } from "@/lib/screening";
import { seedListing, seedPurchase } from "@/lib/test/fixtures";
import { makeMockDb } from "@/lib/test/mock-db";
import { nonceHex, signatureHeader, signedSignatureHeader, stubFacilitator } from "@/lib/test/x402";
import { purchaseFlow } from "./flow";
import { resetFacilitator, setFacilitator } from "./server";

vi.mock("@/lib/notify", () => ({ notifyAdmin: vi.fn(async () => ({ delivered: true })) }));

const BUYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const buyer = privateKeyToAccount(BUYER_KEY);
const PAY_TO = "0x1111111111111111111111111111111111111111";

let mock: ReturnType<typeof makeMockDb>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  resetScreeningCache();
  vi.mocked(notifyAdmin).mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
  process.env.NEXT_PUBLIC_APP_URL = "https://x402git.test";
  process.env.PLATFORM_RECEIVING_ADDRESS = PAY_TO;
  process.env.X402_NETWORK = "base-sepolia";
  resetEnv();
});

afterEach(() => {
  resetDb();
  resetFacilitator();
  resetScreeningCache();
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.PLATFORM_RECEIVING_ADDRESS;
  delete process.env.X402_NETWORK;
  delete process.env.REPLAY_GRANT_WINDOW_SEC;
  resetEnv();
});

/** A placeholder-signed authorization; fine for the fresh-settle path (facilitator stubbed). */
function pay(amountMicro: bigint, nonce: string, from = buyer.address) {
  return signatureHeader({ from, amountMicro, nonce, payTo: PAY_TO });
}

async function quoteIdFor(owner = "adrian", slug = "humanizer"): Promise<string> {
  const outcome = await purchaseFlow({ owner, slug, buyer: null, paymentSignature: null, source: "api" });
  if (outcome.kind !== "payment_required") throw new Error("expected payment_required");
  return outcome.requirements.quoteId;
}

describe("purchaseFlow — quote_id is mandatory on a priced settlement (W1.3 / DB)", () => {
  it("rejects a priced buy that omits quote_id, and stamps nothing", async () => {
    // The 402 quotes $9 with a $0 update price; the creator then raises the update price.
    seedListing(mock, { priceMicro: "9000000", updatePriceMicro: "0", releases: [{ version: "1.2.0" }] });
    setFacilitator(stubFacilitator().client);

    mock.rows("listing")[0].update_price_micro = "5000000";

    const outcome = await purchaseFlow({
      owner: "adrian",
      slug: "humanizer",
      buyer: null,
      paymentSignature: pay(9_000_000n, nonceHex("a1")),
      // quoteId omitted
      source: "api",
    });

    expect(outcome.kind).toBe("payment_error");
    if (outcome.kind !== "payment_error") return;
    expect(outcome.code).toBe("price_changed");
    expect(mock.rows("purchase")).toHaveLength(0);
  });

  it("settles when the correct quote_id is echoed and stamps all_versions for a $0 update price", async () => {
    seedListing(mock, { priceMicro: "9000000", updatePriceMicro: "0", releases: [{ version: "1.2.0" }] });
    const stub = stubFacilitator();
    setFacilitator(stub.client);

    const outcome = await purchaseFlow({
      owner: "adrian",
      slug: "humanizer",
      buyer: null,
      paymentSignature: pay(9_000_000n, nonceHex("a2")),
      quoteId: await quoteIdFor(),
      source: "api",
    });

    expect(outcome.kind).toBe("granted");
    expect(mock.rows("purchase")).toHaveLength(1);
    // FR-16 / D1: a $0 update price is lifetime access.
    expect(mock.rows("purchase")[0].all_versions).toBe(true);
    expect(stub.settleCalls).toHaveLength(1);
  });

  it("a free ($0) listing never requires quote_id", async () => {
    seedListing(mock, { priceMicro: "0", updatePriceMicro: "0", releases: [{ version: "1.0.0" }] });
    const outcome = await purchaseFlow({ owner: "adrian", slug: "humanizer", buyer: buyer.address, paymentSignature: null, source: "api" });
    expect(outcome.kind).toBe("granted");
  });
});

describe("purchaseFlow — a nonce-replay is not an anonymous re-download credential (W1.4 / DA)", () => {
  function seedPrior(nonce: string, grantedAt: Date, owner = "adrian", slug = "humanizer") {
    const seed = seedListing(mock, { owner, slug, priceMicro: "9000000", releases: [{ version: "1.2.0" }] });
    seedPurchase(mock, {
      listingId: seed.listingId,
      releaseId: seed.latest.id,
      buyer: buyer.address,
      grossMicro: "9000000",
      nonce,
      grantedAt: grantedAt.toISOString(),
    });
    return seed;
  }

  it("(1) a replay with no wallet signature past the window issues no fresh download", async () => {
    const nonce = nonceHex("dd01");
    const staleGrant = new Date(Date.now() - (replayGrantWindowSec() + 1) * 1000);
    seedPrior(nonce, staleGrant);

    const outcome = await purchaseFlow({
      owner: "adrian",
      slug: "humanizer",
      buyer: null,
      paymentSignature: await signedSignatureHeader(BUYER_KEY, { from: buyer.address, amountMicro: 9_000_000n, nonce, payTo: PAY_TO }),
      source: "api",
    });

    expect(outcome.kind).toBe("payment_error");
    if (outcome.kind !== "payment_error") return;
    expect(outcome.code).toBe("not_entitled");
    // It points the caller at the signed re-fetch route.
    expect(JSON.stringify(outcome.details)).toContain("/api/r/adrian/humanizer/v/1.2.0");
  });

  it("(2) a replay within the window still returns the grant (crash-retry preserved)", async () => {
    const nonce = nonceHex("dd02");
    seedPrior(nonce, new Date());

    const outcome = await purchaseFlow({
      owner: "adrian",
      slug: "humanizer",
      buyer: null,
      paymentSignature: await signedSignatureHeader(BUYER_KEY, { from: buyer.address, amountMicro: 9_000_000n, nonce, payTo: PAY_TO }),
      source: "api",
    });

    expect(outcome.kind).toBe("granted");
    if (outcome.kind !== "granted") return;
    expect(outcome.headers["x-payment-replay"]).toBe("true");
  });

  it("(3) a forged replay with an invalid signature (payer/nonce lifted from public data) is rejected", async () => {
    const nonce = nonceHex("dd03");
    seedPrior(nonce, new Date());

    // A chain-observer knows the payer, nonce and amount, but not the signature.
    await expect(
      purchaseFlow({
        owner: "adrian",
        slug: "humanizer",
        buyer: null,
        paymentSignature: pay(9_000_000n, nonce), // placeholder signature — does not verify
        source: "api",
      }),
    ).rejects.toSatisfy((e: unknown) => isApiError(e) && (e as { code: string }).code === "authorization_mismatch");

    expect(mock.rows("purchase")).toHaveLength(1); // only the original
  });
});

describe("purchaseFlow — what the operator hears (ADMIN-NOTIFICATIONS.md)", () => {
  it("reports a settlement with the chain named, and the buyer's address nowhere in it", async () => {
    seedListing(mock, { priceMicro: "9000000", updatePriceMicro: "0", releases: [{ version: "1.2.0" }] });
    setFacilitator(stubFacilitator().client);

    const outcome = await purchaseFlow({
      owner: "adrian",
      slug: "humanizer",
      buyer: null,
      paymentSignature: pay(9_000_000n, nonceHex("b1")),
      quoteId: await quoteIdFor(),
      source: "api",
    });
    expect(outcome.kind).toBe("granted");

    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(notifyAdmin).toHaveBeenCalledWith({
      kind: "payment_settled",
      listingId: mock.rows("listing")[0].id,
      handle: "adrian",
      slug: "humanizer",
      version: "1.2.0",
      grossMicro: 9_000_000n,
      purchaseKind: "new",
      source: "api",
      // X402_NETWORK is base-sepolia in this file's env; the message names the chain
      // because one project serves both (lib/admin/feed.ts §"One chain").
      chainId: 84532,
      txHash: `0x${"cd".repeat(32)}`,
    });
    // FR-40: the wallet that paid is on the purchase row and never in the message.
    // (String, not JSON: `grossMicro` is a bigint and JSON.stringify refuses one.)
    const event = Object.values(vi.mocked(notifyAdmin).mock.calls[0][0]).map(String).join(" ");
    expect(event.toLowerCase()).not.toContain(buyer.address.toLowerCase());
  });

  it("stays quiet on a $0 hand-over: a free grant is not a payment (FR-24)", async () => {
    seedListing(mock, { priceMicro: "0", updatePriceMicro: "0", releases: [{ version: "1.0.0" }] });

    const outcome = await purchaseFlow({ owner: "adrian", slug: "humanizer", buyer: buyer.address, paymentSignature: null, source: "api" });
    expect(outcome.kind).toBe("granted");
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  it("stays quiet on a 402 and on a settle that failed — nothing was sold", async () => {
    seedListing(mock, { priceMicro: "9000000", releases: [{ version: "1.2.0" }] });
    const quoteId = await quoteIdFor();
    setFacilitator(stubFacilitator({ settle: { success: false, errorReason: "insufficient_funds", network: "eip155:84532" } as never }).client);

    const outcome = await purchaseFlow({
      owner: "adrian",
      slug: "humanizer",
      buyer: null,
      paymentSignature: pay(9_000_000n, nonceHex("b2")),
      quoteId,
      source: "api",
    });

    expect(outcome.kind).toBe("payment_error");
    expect(mock.rows("purchase")).toHaveLength(0);
    expect(notifyAdmin).not.toHaveBeenCalled();
  });
});
