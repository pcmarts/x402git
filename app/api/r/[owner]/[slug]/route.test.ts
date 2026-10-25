import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { privateKeyToAccount } from "viem/accounts";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { issueChallenge } from "@/lib/auth/challenge";
import { IP_CAPS, LIMITS } from "@/lib/auth/rate-limit";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { notifyAdmin } from "@/lib/notify";
import { resetScreeningCache } from "@/lib/screening";
import { seedListing, seedPurchase } from "@/lib/test/fixtures";
import { makeMockDb } from "@/lib/test/mock-db";
import { nonceHex, signatureHeader, signedSignatureHeader, stubFacilitator } from "@/lib/test/x402";
import { resetFacilitator, setFacilitator } from "@/lib/x402/server";
import { GET } from "./route";

// CORE-5: an unhandled throw on this route used to page the admin chat. The mock lets a
// test prove that a malformed payment header no longer does.
vi.mock("@/lib/notify", () => ({ notifyAdmin: vi.fn(async () => ({ delivered: true })) }));

const BUYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const buyer = privateKeyToAccount(BUYER_KEY);
const PAY_TO = "0x1111111111111111111111111111111111111111";

let mock: ReturnType<typeof makeMockDb>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  resetScreeningCache();
  // FR-38 screening reads the OFAC list over the network; a test never does.
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
  resetEnv();
});

function get(headers: Record<string, string> = {}, path = "/api/r/adrian/humanizer") {
  const req = new NextRequest(`https://x402git.test${path}`, {
    headers: { "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 250) + 1}`, ...headers },
  });
  return GET(req, { params: Promise.resolve({ owner: "adrian", slug: "humanizer" }) });
}

/** FR-20: `<address>.<nonce>.<eip191_sig>` over a fresh challenge. */
async function walletSignature(address = buyer.address) {
  const challenge = await issueChallenge(address, "wallet_ownership");
  const signature = await buyer.signMessage({ message: challenge.message });
  return `${address}.${challenge.nonce}.${signature}`;
}

function pay(amountMicro: bigint, nonce: string, from = buyer.address) {
  return signatureHeader({ from, amountMicro, nonce, payTo: PAY_TO });
}

/** A real EIP-3009 signature, for the replay path which verifies it locally (W1.4). */
function signedPay(amountMicro: bigint, nonce: string) {
  return signedSignatureHeader(BUYER_KEY, { from: buyer.address, amountMicro, nonce, payTo: PAY_TO });
}

/** W1.3: fetch the current quote_id from the 402, to echo on a priced settlement. */
async function currentQuoteId(headers: Record<string, string> = {}): Promise<string> {
  const res = await get(headers);
  return (await res.json()).extra.quote_id as string;
}

describe("GET /api/r/:owner/:slug — the 402 (FR-21)", () => {
  it("returns the x402 body and the PAYMENT-REQUIRED header when nothing is attached", async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });
    const res = await get();

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.x402Version).toBe(2);
    expect(body.accepts[0].maxAmountRequired).toBe("9000000");
    expect(body.extra.kind).toBe("new");

    const header = res.headers.get("PAYMENT-REQUIRED");
    expect(header).toBeTruthy();
    expect(decodePaymentRequiredHeader(header!).accepts[0].amount).toBe("9000000");
    expect(mock.rows("event").map((e) => e.name)).toContain("402_issued");
    expect(mock.rows("purchase")).toHaveLength(0);
  });

  it("quotes the update price and the release evidence to a holder (FR-17)", async () => {
    const seed = seedListing(mock, { releases: [{ version: "1.2.0" }, { version: "1.3.0", changelog: "faster" }] });
    seedPurchase(mock, {
      listingId: seed.listingId,
      releaseId: seed.releases[0].id,
      buyer: buyer.address,
      grantedAt: new Date(Date.now() - 60 * 86_400_000).toISOString(),
    });

    const res = await get({ "x-wallet-signature": await walletSignature() });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.extra).toMatchObject({ kind: "update", from: "1.2.0", to: "1.3.0" });
    expect(body.accepts[0].maxAmountRequired).toBe("3000000");
    expect(body.extra.releases).toHaveLength(1);
  });
});

describe("GET /api/r/:owner/:slug — settlement (FR-22)", () => {
  it("grants only after settle returns a tx hash, and answers with PAYMENT-RESPONSE", async () => {
    const seed = seedListing(mock, { releases: [{ version: "1.2.0" }] });
    const stub = stubFacilitator();
    setFacilitator(stub.client);

    const res = await get({ "payment-signature": pay(9_000_000n, nonceHex("11")), "x-quote-id": await currentQuoteId() });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.version).toBe("1.2.0");
    expect(body.artifact_sha256).toBe(seed.latest.artifactSha256);
    expect(body.download_url).toContain("storage.test");
    expect(body.version_endpoint).toBe("https://x402git.test/api/r/adrian/humanizer/v/1.2.0");

    const settlement = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!);
    expect(settlement.success).toBe(true);

    const purchase = mock.rows("purchase");
    expect(purchase).toHaveLength(1);
    expect(purchase[0].gross_micro).toBe("9000000");
    expect(purchase[0].fee_micro).toBe("900000");
    expect(purchase[0].net_micro).toBe("8100000");
    expect(purchase[0].tx_hash).toBe(settlement.transaction);
    expect(mock.rows("event").map((e) => e.name)).toContain("settled");
  });

  it("replay: the same nonce twice returns the same purchase and writes one row", async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });
    const stub = stubFacilitator();
    setFacilitator(stub.client);

    // W1.4: the replay path verifies the authorization signature locally, so this uses a
    // real EIP-3009 signature. Within REPLAY_GRANT_WINDOW_SEC of the grant, the resent
    // authorization is answered from our own ledger (crash-retry preserved).
    const header = await signedPay(9_000_000n, nonceHex("22"));
    const first = await get({ "payment-signature": header, "x-quote-id": await currentQuoteId() });
    expect(first.status).toBe(200);
    const second = await get({ "payment-signature": header });
    expect(second.status).toBe(200);

    expect(mock.rows("purchase")).toHaveLength(1);
    expect(second.headers.get("x-payment-replay")).toBe("true");
    // The second request never reached the facilitator: our own ledger answered it.
    expect(stub.settleCalls).toHaveLength(1);
  });

  it("authorization_mismatch: the same nonce against a different listing", async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });
    seedListing(mock, { owner: "beth", slug: "summariser", releases: [{ version: "1.0.0" }] });
    setFacilitator(stubFacilitator().client);

    const header = await signedPay(9_000_000n, nonceHex("33"));
    expect((await get({ "payment-signature": header, "x-quote-id": await currentQuoteId() })).status).toBe(200);

    const req = new NextRequest("https://x402git.test/api/r/beth/summariser", { headers: { "payment-signature": header } });
    const res = await GET(req, { params: Promise.resolve({ owner: "beth", slug: "summariser" }) });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("authorization_mismatch");
    expect(mock.rows("purchase")).toHaveLength(1);
  });

  it("price_changed: a PATCH after the quote is 409 with a fresh 402 attached (FR-23)", async () => {
    seedListing(mock, { priceMicro: "9000000", releases: [{ version: "1.2.0" }] });
    const stub = stubFacilitator();
    setFacilitator(stub.client);

    // The buyer signed $9; the creator has since raised the price to $19.
    const header = pay(9_000_000n, nonceHex("44"));
    mock.rows("listing")[0].price_micro = "19000000";

    const res = await get({ "payment-signature": header });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("price_changed");
    expect(body.details.payment_required.accepts[0].maxAmountRequired).toBe("19000000");
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    expect(stub.settleCalls).toHaveLength(0);
    expect(mock.rows("purchase")).toHaveLength(0);
  });

  it("price_changed: an echoed quote_id that is no longer current", async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });
    setFacilitator(stubFacilitator().client);
    const res = await get({ "payment-signature": pay(9_000_000n, nonceHex("45")), "x-quote-id": "q_stale" });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("price_changed");
  });

  it("insufficient_balance: the facilitator's invalidReason becomes the catalogue code, and no row is written", async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });
    const stub = stubFacilitator({ verify: { isValid: false, invalidReason: "invalid_exact_evm_insufficient_balance" } });
    setFacilitator(stub.client);

    const res = await get({ "payment-signature": pay(9_000_000n, nonceHex("55")), "x-quote-id": await currentQuoteId() });
    expect(res.status).toBe(402);
    expect((await res.json()).code).toBe("insufficient_balance");
    expect(stub.settleCalls).toHaveLength(0);
    expect(mock.rows("purchase")).toHaveLength(0);
  });

  it("settle-failure-no-grant: verify passes, settle fails, nothing is granted", async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });
    const stub = stubFacilitator({
      settle: { success: false, errorReason: "settlement_pending", transaction: "", network: "eip155:84532" },
    });
    setFacilitator(stub.client);

    const res = await get({ "payment-signature": pay(9_000_000n, nonceHex("66")), "x-quote-id": await currentQuoteId() });
    expect(res.status).toBe(402);
    expect((await res.json()).code).toBe("settlement_pending");
    expect(stub.settleCalls).toHaveLength(1);
    expect(mock.rows("purchase")).toHaveLength(0);
  });

  it("settle-failure-no-grant: a settle that throws a timeout is 504 with retry_with_same_authorization", async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });
    const timeout = new Error("facilitator settle timed out after 30000ms");
    timeout.name = "FacilitatorTimeoutError";
    setFacilitator(stubFacilitator({ settle: timeout }).client);

    const res = await get({ "payment-signature": pay(9_000_000n, nonceHex("67")), "x-quote-id": await currentQuoteId() });
    expect(res.status).toBe(504);
    const body = await res.json();
    expect(body.code).toBe("settlement_timeout");
    expect(body.details.retry_with_same_authorization).toBe(true);
    expect(mock.rows("purchase")).toHaveLength(0);
  });

  it("settle-failure-no-grant: success without a transaction hash never grants", async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });
    setFacilitator(stubFacilitator({ settle: { success: true, transaction: "", network: "eip155:84532" } }).client);

    const res = await get({ "payment-signature": pay(9_000_000n, nonceHex("68")), "x-quote-id": await currentQuoteId() });
    expect(res.status).toBe(402);
    expect((await res.json()).code).toBe("settlement_pending");
    expect(mock.rows("purchase")).toHaveLength(0);
  });
});

describe("GET /api/r/:owner/:slug — the gates before settle", () => {
  it("a sanctioned payer is 403 and never reaches the facilitator (FR-38)", async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });
    resetScreeningCache();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([buyer.address.toLowerCase()]), { status: 200 })));
    const stub = stubFacilitator();
    setFacilitator(stub.client);

    const res = await get({ "payment-signature": pay(9_000_000n, nonceHex("77")) });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("sanctioned_counterparty");
    expect(stub.verifyCalls).toHaveLength(0);
    expect(stub.settleCalls).toHaveLength(0);
    expect(mock.rows("purchase")).toHaveLength(0);
    // FR-38: the screening result is retained whatever the outcome.
    expect(mock.rows("screening")).toHaveLength(1);
  });

  it("a comprehensively sanctioned jurisdiction is 451 before any work (FR-38)", async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });
    const facilitator = stubFacilitator();
    setFacilitator(facilitator.client);

    const res = await get({ "x-vercel-ip-country": "IR", "payment-signature": pay(9_000_000n, nonceHex("beef")) });
    expect(res.status).toBe(451);
    expect((await res.json()).code).toBe("blocked_jurisdiction");
    expect(facilitator.verifyCalls).toHaveLength(0);
    expect(mock.rows("purchase")).toHaveLength(0);

    // Everywhere else is unaffected, and an absent header never blocks.
    expect((await get({ "x-vercel-ip-country": "GB" })).status).toBe(402);
  });

  it("answers a replayed authorization only to the wallet that bought it", async () => {
    const seed = seedListing(mock, { releases: [{ version: "1.2.0" }] });
    const nonce = nonceHex("dd");
    seedPurchase(mock, {
      listingId: seed.listingId,
      releaseId: seed.latest.id,
      buyer: "0x9999999999999999999999999999999999999999",
      nonce,
    });

    const res = await get({
      "x-wallet-signature": await walletSignature(),
      "payment-signature": pay(9_000_000n, nonce),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("authorization_mismatch");
  });

  it("the payer must be the wallet that signed X-Wallet-Signature (FR-20)", async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });
    const stub = stubFacilitator();
    setFacilitator(stub.client);

    const res = await get({
      "x-wallet-signature": await walletSignature(),
      "payment-signature": pay(9_000_000n, nonceHex("88"), "0x9999999999999999999999999999999999999999"),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("authorization_mismatch");
    expect(stub.verifyCalls).toHaveLength(0);
  });
});

describe("GET /api/r/:owner/:slug — free listings (FR-24)", () => {
  it("serves a $0 listing with no payment and writes no row when unsigned", async () => {
    seedListing(mock, { priceMicro: "0", releases: [{ version: "1.0.0" }] });
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).version).toBe("1.0.0");
    expect(mock.rows("purchase")).toHaveLength(0);
  });

  it("writes a purchase row when the caller signed, so re-fetch and update pricing work", async () => {
    seedListing(mock, { priceMicro: "0", releases: [{ version: "1.0.0" }] });
    const res = await get({ "x-wallet-signature": await walletSignature() });
    expect(res.status).toBe(200);
    expect(mock.rows("purchase")).toHaveLength(1);
    expect(mock.rows("purchase")[0].kind).toBe("free");
    expect(mock.rows("purchase")[0].gross_micro).toBe("0");
  });
});

describe("GET /api/r/:owner/:slug — unavailable", () => {
  it("is 410 retired for a non-holder", async () => {
    seedListing(mock, { retired: true, releases: [{ version: "1.0.0" }] });
    const res = await get();
    expect(res.status).toBe(410);
    expect((await res.json()).code).toBe("retired");
  });

  it("is 404 when no release has passed the scan", async () => {
    seedListing(mock, { releases: [{ version: "1.0.0", scan: "fail" }] });
    expect((await get()).status).toBe(404);
  });

  it("serves a holder their release without a second payment", async () => {
    const seed = seedListing(mock, { releases: [{ version: "1.0.0" }] });
    seedPurchase(mock, { listingId: seed.listingId, releaseId: seed.latest.id, buyer: buyer.address });
    const res = await get({ "x-wallet-signature": await walletSignature() });
    expect(res.status).toBe(200);
    expect(mock.rows("purchase")).toHaveLength(1);
  });
});

describe("GET /api/r/:owner/:slug — the rate limit keys on IP and address together (CORE-3)", () => {
  const ATTACKER = { "x-real-ip": "198.51.100.50" };

  it("one IP naming a buyer as `from` cannot lock that buyer out of their own requests", async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });
    // The attack: the buyer's address is public, so write it into `from` 61 times.
    for (let i = 0; i < LIMITS.resource.max; i++) {
      expect((await get({ ...ATTACKER, "payment-signature": pay(9_000_000n, nonceHex(`a${i}`)) })).status).not.toBe(429);
    }
    expect((await get({ ...ATTACKER, "payment-signature": pay(9_000_000n, nonceHex("aff")) })).status).toBe(429);

    // The buyer, from their own IP, is still quoted.
    const res = await get({ "x-real-ip": "203.0.113.9", "x-wallet-signature": await walletSignature() });
    expect(res.status).toBe(402);
    // The bucket an attacker used to be able to spend, `resource:<address>`, was never touched.
    expect(mock.rows("rate_limit").some((r) => r.bucket === `resource:${buyer.address.toLowerCase()}`)).toBe(false);
  });

  it("a new `from` on every request does not escape the per-IP cap", async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });
    for (let i = 0; i < IP_CAPS.resource.max; i++) {
      const from = `0x${(i + 1).toString(16).padStart(40, "0")}` as const;
      expect((await get({ ...ATTACKER, "payment-signature": pay(9_000_000n, nonceHex(`b${i}`), from) })).status).not.toBe(429);
    }
    const res = await get({ ...ATTACKER, "payment-signature": pay(9_000_000n, nonceHex("bff"), `0x${"c3".repeat(20)}`) });
    expect(res.status).toBe(429);
    expect((await res.json()).message).toContain("per IP");
  });
});

describe("GET /api/r/:owner/:slug — a malformed PAYMENT-SIGNATURE (CORE-5)", () => {
  const b64 = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8").toString("base64");

  /** A real payment header with one field changed. */
  function tamperedPay(edit: (payload: Record<string, any>) => void): string {
    const decoded = JSON.parse(Buffer.from(pay(9_000_000n, nonceHex("d1")), "base64").toString("utf8"));
    edit(decoded);
    return b64(decoded);
  }

  const cases: [string, () => string][] = [
    ["is not base64", () => "not-base64!!"],
    ["is not JSON", () => b64("this is not json {")],
    ["has authorization.from as a number", () => tamperedPay((p) => (p.payload.authorization.from = 1))],
    ["has from and nonce as numbers", () => tamperedPay((p) => (p.payload.authorization = { from: 1, nonce: 2 }))],
    ["has a nonce that is not hex", () => tamperedPay((p) => (p.payload.authorization.nonce = "0xnot-hex-at-all"))],
  ];

  for (const [name, header] of cases) {
    it(`gets the 402, not a 500 or an admin alert, when the header ${name}`, async () => {
      seedListing(mock, { releases: [{ version: "1.2.0" }] });
      const stub = stubFacilitator();
      setFacilitator(stub.client);
      vi.mocked(notifyAdmin).mockClear();

      const res = await get({ "payment-signature": header(), "x-quote-id": await currentQuoteId() });
      expect(res.status).toBe(402);
      expect((await res.json()).x402Version).toBe(2);

      expect(notifyAdmin).not.toHaveBeenCalled();
      expect(stub.verifyCalls).toHaveLength(0);
      expect(stub.settleCalls).toHaveLength(0);
      // Nothing the caller wrote was screened, so nothing they wrote was stored.
      expect(mock.rows("screening")).toHaveLength(0);
      expect(mock.rows("purchase")).toHaveLength(0);
    });
  }

  it("still settles a valid payload through the facilitator", async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });
    const stub = stubFacilitator();
    setFacilitator(stub.client);
    vi.mocked(notifyAdmin).mockClear();

    const res = await get({ "payment-signature": pay(9_000_000n, nonceHex("d2")), "x-quote-id": await currentQuoteId() });
    expect(res.status).toBe(200);
    expect(stub.verifyCalls).toHaveLength(1);
    expect(stub.settleCalls).toHaveLength(1);
    expect(mock.rows("purchase")).toHaveLength(1);
    // The one admin message this route sends on purpose: the sale.
    expect(vi.mocked(notifyAdmin).mock.calls.map(([event]) => event.kind)).toEqual(["payment_settled"]);
  });
});
