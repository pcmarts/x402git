/**
 * lib/core/access.rails.test.ts — the 402 per creator, and the ledger per rail
 * (25 Oct 2026, docs/HACKMERIDIAN-BUILD.md W1 tests 1, 5, 6 and §0b B4/B5).
 *
 * The first describe is the Base rail's guarantee: `EVM_402_SNAPSHOT` below is the
 * exact body `toPaymentRequirements` produced for a $2.00 listing **before the Stellar
 * rail existed** (taken from the tree at the start of the change, `quote_id` aside, which
 * is a digest of random fixture ids). Every test in it must keep passing with the rail
 * off and with the rail on.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { isApiError } from "@/lib/errors";
import { PaymentRequiredBody } from "@/lib/schemas";
import { seedListing, seedPurchase } from "@/lib/test/fixtures";
import { makeMockDb } from "@/lib/test/mock-db";
import { clearStellarEnv, setStellarTestnetEnv, STELLAR_BUYER_ADDRESS, STELLAR_CREATOR, STELLAR_PAY_TO, STELLAR_TESTNET_USDC } from "@/lib/test/stellar";
import { findPurchaseByNonce, grant, grantFree, owned, paymentOptionsFor, type PaymentRequiredQuote, quote, toPaymentRequirements } from "./access";

const EVM_BUYER = "0xAAaAAAaAAaaAaaAaAaAAAAaAaAaAaAAAAaaAAaAa";
const EVM_PAYOUT = "0x2222222222222222222222222222222222222222";
const NOW = new Date("2026-10-25T12:00:00.000Z");
const PUBNET_USDT0 = "CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF";

/** Today's EVM 402 for a $2.00 `adrian/humanizer` v1.2.0, verbatim. `quote_id` is substituted per run. */
const EVM_402_SNAPSHOT = {
  "x402Version": 2,
  "resource": {
    "url": "https://x402git.test/api/r/adrian/humanizer",
    "description": "adrian/humanizer v1.2.0 — Harness. Strips AI tells from prose. Security scan passed; signed download, 5-minute URL.",
    "mimeType": "application/zip",
    "serviceName": "adrian/humanizer"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:84532",
      "amount": "2000000",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "payTo": "0x1111111111111111111111111111111111111111",
      "maxTimeoutSeconds": 300,
      "extra": {
        "name": "USDC",
        "version": "2"
      },
      "maxAmountRequired": "2000000",
      "resource": "https://x402git.test/api/r/adrian/humanizer",
      "description": "adrian/humanizer v1.2.0 — Harness. Strips AI tells from prose. Security scan passed; signed download, 5-minute URL.",
      "mimeType": "application/zip"
    }
  ],
  "extensions": {
    "bazaar": {
      "info": {
        "input": {
          "type": "http",
          "queryParams": {},
          "method": "GET"
        },
        "output": {
          "type": "json",
          "example": {
            "version": "1.2.0",
            "artifact_sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "download_url": "https://storage.example/adrian/humanizer/1.2.0.zip?signed=…",
            "expires_at": "2026-09-16T12:05:00.000Z",
            "version_endpoint": "https://x402git.test/api/r/adrian/humanizer/v/1.2.0",
            "manifest_url": "https://x402git.test/api/label/adrian/humanizer",
            "all_versions": false
          }
        }
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "input": {
            "type": "object",
            "properties": {
              "type": {
                "type": "string",
                "const": "http"
              },
              "method": {
                "type": "string",
                "enum": [
                  "GET"
                ]
              },
              "queryParams": {
                "type": "object",
                "properties": {}
              }
            },
            "required": [
              "type",
              "method"
            ],
            "additionalProperties": false
          },
          "output": {
            "type": "object",
            "properties": {
              "type": {
                "type": "string"
              },
              "example": {
                "type": "object",
                "properties": {
                  "version": {
                    "type": "string",
                    "description": "Semantic version of the release served."
                  },
                  "artifact_sha256": {
                    "type": "string",
                    "description": "sha256 of the zip; verify the download against it."
                  },
                  "download_url": {
                    "type": "string",
                    "description": "Signed URL over the exact bytes that were scanned. Valid five minutes."
                  },
                  "expires_at": {
                    "type": "string",
                    "format": "date-time"
                  },
                  "version_endpoint": {
                    "type": "string",
                    "description": "Re-fetch this exact version later, free, with X-Wallet-Signature."
                  },
                  "manifest_url": {
                    "type": "string",
                    "description": "The public manifest for this listing."
                  },
                  "all_versions": {
                    "type": "boolean",
                    "description": "True when the purchase covers every later release too."
                  }
                },
                "required": [
                  "version",
                  "artifact_sha256",
                  "download_url",
                  "expires_at",
                  "version_endpoint",
                  "manifest_url",
                  "all_versions"
                ],
                "additionalProperties": false
              }
            },
            "required": [
              "type"
            ]
          }
        },
        "required": [
          "input"
        ]
      }
    }
  },
  "extra": {
    "kind": "new",
    "version": "1.2.0",
    "manifest_url": "https://x402git.test/api/label/adrian/humanizer",
    "scan_badge_url": "https://x402git.test/api/label/adrian/humanizer#scan",
    "update_price_micro": "3000000",
    "quote_id": "q_2d6b5b3acee7e4d274fc36702dbaed36",
    "valid_before": "2026-10-25T12:05:00.000Z",
    "instructions": "This is an x402 paywall, not an error. To buy: sign the `accepts` entry whose `network` is yours — on Base Sepolia that is an EIP-3009 USDC authorization signed with your own wallet — then GET https://x402git.test/api/r/adrian/humanizer again with the payment in the PAYMENT-SIGNATURE header and extra.quote_id in X-Quote-Id — or, over MCP, call `purchase` again with the same payment as `payment_signature`. The full procedure is at https://x402git.test/.well-known/agent-skills/buy-a-repo/SKILL.md; the same tools are an MCP server at https://x402git.test/api/mcp. No wallet? A person can buy at https://x402git.test/adrian/humanizer, and the free manifest at https://x402git.test/api/label/adrian/humanizer shows what is inside before anyone pays.",
    "listing_url": "https://x402git.test/adrian/humanizer",
    "skill_url": "https://x402git.test/.well-known/agent-skills/buy-a-repo/SKILL.md",
    "mcp_url": "https://x402git.test/api/mcp"
  }
};

/** The canonical `accepts` the facilitator is called with, verbatim. */
const EVM_CANONICAL_SNAPSHOT = [
  {
    "scheme": "exact",
    "network": "eip155:84532",
    "amount": "2000000",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "payTo": "0x1111111111111111111111111111111111111111",
    "maxTimeoutSeconds": 300,
    "extra": {
      "name": "USDC",
      "version": "2"
    }
  }
];

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
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.PLATFORM_RECEIVING_ADDRESS;
  delete process.env.X402_NETWORK;
  delete process.env.X402_EXTRA_EVM_RAILS;
  resetEnv();
});

function stellarOn(): void {
  setStellarTestnetEnv();
  resetEnv();
}

async function quoteFor(owner = "adrian", slug = "humanizer", buyer: string | null = null): Promise<PaymentRequiredQuote> {
  const q = await quote({ owner, slug }, buyer);
  if (q.kind !== "payment_required") throw new Error(`expected payment_required, got ${q.kind}`);
  return q;
}

const TWO_DOLLARS = { priceMicro: "2000000", releases: [{ version: "1.2.0" }] };

describe("the Base rail is unchanged (snapshot taken before the Stellar rail)", () => {
  function expectSnapshot(q: PaymentRequiredQuote) {
    const { body, accepts } = toPaymentRequirements(q, NOW);
    expect(body).toEqual({ ...EVM_402_SNAPSHOT, extra: { ...EVM_402_SNAPSHOT.extra, quote_id: q.quoteId } });
    expect(accepts).toEqual(EVM_CANONICAL_SNAPSHOT);
  }

  it("an EVM creator's 402 is byte-identical with the Stellar rail off", async () => {
    seedListing(mock, { ...TWO_DOLLARS, payoutAddress: EVM_PAYOUT });
    expectSnapshot(await quoteFor());
  });

  it("… and byte-identical with the Stellar rail on: an EVM-only creator gets Base only (F7, CROSS_CHAIN_PAYOUTS=off)", async () => {
    stellarOn();
    seedListing(mock, { ...TWO_DOLLARS, payoutAddress: EVM_PAYOUT });
    expectSnapshot(await quoteFor());
  });

  it("… even with CROSS_CHAIN_PAYOUTS=on: the switch is read, not acted on (W5 deferred)", async () => {
    stellarOn();
    process.env.CROSS_CHAIN_PAYOUTS = "on";
    resetEnv();
    seedListing(mock, { ...TWO_DOLLARS, payoutAddress: EVM_PAYOUT });
    expectSnapshot(await quoteFor());
  });
});

describe("paymentOptionsFor / toPaymentRequirements — one accept per rail the creator can be paid on (JOURNEYS rule 4)", () => {
  it("a Stellar-only creator's 402 has no Base entry, and the Stellar entry is BUILD §3.4 exactly", async () => {
    stellarOn();
    seedListing(mock, { ...TWO_DOLLARS, payoutAddress: STELLAR_CREATOR });
    const q = await quoteFor();
    const { body, accepts } = toPaymentRequirements(q, NOW);

    expect(accepts).toEqual([
      {
        scheme: "exact",
        network: "stellar:testnet",
        amount: "20000000",
        asset: STELLAR_TESTNET_USDC,
        payTo: STELLAR_PAY_TO,
        maxTimeoutSeconds: 300,
        extra: { areFeesSponsored: true },
      },
    ]);
    expect(body.accepts).toHaveLength(1);
    expect(body.accepts[0]).toMatchObject({
      ...accepts[0],
      maxAmountRequired: "20000000",
      resource: "https://x402git.test/api/r/adrian/humanizer",
      mimeType: "application/zip",
    });
    // Same product copy as the EVM entry, naming the configured symbol and the network.
    expect(body.accepts[0].description).toBe(`${EVM_402_SNAPSHOT.accepts[0].description} $2.00 in USDC on Stellar testnet.`);
    expect(body.accepts.some((a) => a.network.startsWith("eip155:"))).toBe(false);
    // The prose follows the fields: no EIP-3009 instruction for a listing Base cannot pay.
    expect(body.extra.instructions).toContain("npx x402git-stellar buy adrian/humanizer");
    expect(body.extra.instructions).not.toContain("EIP-3009");
    expect(() => PaymentRequiredBody.parse(body)).not.toThrow();
  });

  it("a creator with both addresses gets two accepts, EVM first, with the EVM entry equal to the snapshot (H10)", async () => {
    stellarOn();
    seedListing(mock, { ...TWO_DOLLARS, payoutAddress: EVM_PAYOUT, stellarPayoutAddress: STELLAR_CREATOR });
    const q = await quoteFor();
    const { body, accepts } = toPaymentRequirements(q, NOW);

    expect(body.accepts).toHaveLength(2);
    expect(body.accepts[0]).toEqual(EVM_402_SNAPSHOT.accepts[0]);
    expect(accepts[0]).toEqual(EVM_CANONICAL_SNAPSHOT[0]);
    expect(accepts[1]).toMatchObject({ network: "stellar:testnet", amount: "20000000", asset: STELLAR_TESTNET_USDC, extra: { areFeesSponsored: true } });
    // The Base sentence first and intact, the Stellar alternative appended.
    expect(body.extra.instructions.startsWith(EVM_402_SNAPSHOT.extra.instructions)).toBe(true);
    expect(body.extra.instructions).toContain("Or on Stellar:");
    expect(() => PaymentRequiredBody.parse(body)).not.toThrow();
  });

  it("a Stellar-only creator on a deployment without the rail cannot be quoted: 503 paused, never a Base entry", async () => {
    seedListing(mock, { ...TWO_DOLLARS, payoutAddress: STELLAR_CREATOR });
    const q = await quoteFor();
    expect(() => toPaymentRequirements(q, NOW)).toThrow();
    try {
      toPaymentRequirements(q, NOW);
    } catch (e) {
      expect(isApiError(e) && e.code).toBe("paused");
    }
  });

  it("paymentOptionsFor is the same decision for the listing JSON, MCP and the page", async () => {
    stellarOn();
    const both = seedListing(mock, { ...TWO_DOLLARS, payoutAddress: EVM_PAYOUT, stellarPayoutAddress: STELLAR_CREATOR });
    const creator = mock.rows("creator").find((c) => c.id === both.creatorId)!;
    const listing = mock.rows("listing").find((l) => l.id === both.listingId)!;

    const options = paymentOptionsFor(creator as never, listing as never);
    expect(options.map((o) => [o.network, o.asset, o.asset_symbol, o.amount])).toEqual([
      ["eip155:84532", "0x036CbD53842c5426634e7929541eC2318f3dCF7e", "USDC", "2000000"],
      ["stellar:testnet", STELLAR_TESTNET_USDC, "USDC", "20000000"],
    ]);
    expect(options[1].how).toContain("npx x402git-stellar buy adrian/humanizer");

    // EVM-only → Base only; Stellar-only → Stellar only; a G identity counts as a Stellar address.
    expect(paymentOptionsFor({ ...creator, stellar_payout_address: null } as never, listing as never).map((o) => o.network)).toEqual(["eip155:84532"]);
    expect(paymentOptionsFor({ ...creator, payout_address: STELLAR_CREATOR, stellar_payout_address: null } as never, listing as never).map((o) => o.network)).toEqual([
      "stellar:testnet",
    ]);

    // Rail off: the Stellar option disappears everywhere at once.
    clearStellarEnv();
    resetEnv();
    expect(paymentOptionsFor(creator as never, listing as never).map((o) => o.network)).toEqual(["eip155:84532"]);
    expect(paymentOptionsFor({ ...creator, payout_address: STELLAR_CREATOR, stellar_payout_address: null } as never, listing as never)).toEqual([]);
  });
});

describe("grant — a Stellar settlement is stamped on its own rail", () => {
  const nonce = `stellar:stellar:testnet:${STELLAR_BUYER_ADDRESS}:123456789`;
  const settlement = { txHash: "a".repeat(64), nonce, amountMicro: 2_000_000n, network: "stellar:testnet" };

  it("writes network, asset and a null chain_id, an upper-case buyer, a stellar: nonce and the 10% fee", async () => {
    stellarOn();
    seedListing(mock, { ...TWO_DOLLARS, payoutAddress: STELLAR_CREATOR });
    const q = await quoteFor();

    // Handed the lower-cased spelling on purpose: the stored one must be the strkey (H11).
    const purchase = await grant(q, STELLAR_BUYER_ADDRESS.toLowerCase(), settlement);
    expect(purchase.buyerAddress).toBe(STELLAR_BUYER_ADDRESS);
    expect(purchase.network).toBe("stellar:testnet");
    expect(purchase.asset).toBe(STELLAR_TESTNET_USDC);
    expect(purchase.feeMicro).toBe(200_000n);
    expect(purchase.netMicro).toBe(1_800_000n);

    const row = mock.rows("purchase")[0];
    expect(row).toMatchObject({ network: "stellar:testnet", asset: STELLAR_TESTNET_USDC, chain_id: null, buyer_address: STELLAR_BUYER_ADDRESS });
    expect(String(row.payment_nonce)).toMatch(/^stellar:/);

    // Found on its own rail, invisible on the EVM one (BATTLE-TEST finding 1).
    expect((await findPurchaseByNonce(nonce, "stellar:testnet"))?.id).toBe(purchase.id);
    expect(await findPurchaseByNonce(nonce)).toBeNull();
    // Idempotent on the nonce, as on Base.
    expect((await grant(q, STELLAR_BUYER_ADDRESS, settlement)).id).toBe(purchase.id);
    expect(mock.rows("purchase")).toHaveLength(1);
  });

  it("refuses a settlement on a network this deployment does not serve (testnet deployment, pubnet settle)", async () => {
    stellarOn();
    seedListing(mock, { ...TWO_DOLLARS, payoutAddress: STELLAR_CREATOR });
    const q = await quoteFor();
    await expect(grant(q, STELLAR_BUYER_ADDRESS, { ...settlement, network: "stellar:pubnet" })).rejects.toSatisfy(
      (e: unknown) => isApiError(e) && e.code === "authorization_mismatch",
    );
    expect(mock.rows("purchase")).toHaveLength(0);
  });

  it("refuses a payer whose address family is not the settlement's rail (the row would fail the CHECK after the money moved)", async () => {
    stellarOn();
    seedListing(mock, { ...TWO_DOLLARS, payoutAddress: EVM_PAYOUT, stellarPayoutAddress: STELLAR_CREATOR });
    const q = await quoteFor();
    await expect(grant(q, EVM_BUYER, settlement)).rejects.toSatisfy((e: unknown) => isApiError(e) && e.code === "authorization_mismatch");
    await expect(grant(q, STELLAR_BUYER_ADDRESS, { ...settlement, network: "eip155:84532" })).rejects.toSatisfy(
      (e: unknown) => isApiError(e) && e.code === "authorization_mismatch",
    );
    expect(mock.rows("purchase")).toHaveLength(0);
  });

  it("with the rail off, a Stellar settlement is refused rather than stamped on the EVM chain", async () => {
    seedListing(mock, { ...TWO_DOLLARS, payoutAddress: EVM_PAYOUT });
    const q = await quoteFor();
    await expect(grant(q, STELLAR_BUYER_ADDRESS, settlement)).rejects.toSatisfy((e: unknown) => isApiError(e) && e.code === "authorization_mismatch");
  });
});

describe("entitlement reads partition on network, so a Stellar buyer owns what they bought (BATTLE-TEST finding 1, JOURNEYS rule 7)", () => {
  it("a G buyer's purchase makes quote() granted and appears in owned()", async () => {
    stellarOn();
    const seed = seedListing(mock, { ...TWO_DOLLARS, payoutAddress: STELLAR_CREATOR });
    seedPurchase(mock, {
      listingId: seed.listingId,
      releaseId: seed.latest.id,
      buyer: STELLAR_BUYER_ADDRESS,
      network: "stellar:testnet",
      asset: STELLAR_TESTNET_USDC,
      grossMicro: "2000000",
      nonce: `stellar:stellar:testnet:${STELLAR_BUYER_ADDRESS}:1`,
    });

    const q = await quote({ owner: "adrian", slug: "humanizer" }, STELLAR_BUYER_ADDRESS);
    expect(q.kind).toBe("granted");
    expect((await owned(STELLAR_BUYER_ADDRESS)).map((p) => p.network)).toEqual(["stellar:testnet"]);
    // Lower-cased on the way in is still the same wallet.
    expect((await quote({ owner: "adrian", slug: "humanizer" }, STELLAR_BUYER_ADDRESS.toLowerCase())).kind).toBe("granted");
    // The EVM buyer holds nothing here, and a pubnet row is not a testnet entitlement.
    expect((await quote({ owner: "adrian", slug: "humanizer" }, EVM_BUYER)).kind).toBe("payment_required");
  });

  it("a Stellar row on the other Stellar network, or one in another asset, is not this deployment's entitlement", async () => {
    stellarOn();
    const seed = seedListing(mock, { ...TWO_DOLLARS, payoutAddress: STELLAR_CREATOR });
    seedPurchase(mock, { listingId: seed.listingId, releaseId: seed.latest.id, buyer: STELLAR_BUYER_ADDRESS, network: "stellar:pubnet", asset: PUBNET_USDT0 });
    expect((await quote({ owner: "adrian", slug: "humanizer" }, STELLAR_BUYER_ADDRESS)).kind).toBe("payment_required");
    expect(await owned(STELLAR_BUYER_ADDRESS)).toEqual([]);
  });

  it("with the rail off, a Stellar wallet owns nothing here rather than throwing", async () => {
    const seed = seedListing(mock, { ...TWO_DOLLARS, payoutAddress: EVM_PAYOUT });
    seedPurchase(mock, { listingId: seed.listingId, releaseId: seed.latest.id, buyer: STELLAR_BUYER_ADDRESS, network: "stellar:testnet" });
    expect((await quote({ owner: "adrian", slug: "humanizer" }, STELLAR_BUYER_ADDRESS)).kind).toBe("payment_required");
    expect(await owned(STELLAR_BUYER_ADDRESS)).toEqual([]);
  });
});

// --- a second EVM rail: USDT0 on Arbitrum (25 Oct 2026, docs/HACKMERIDIAN-EVM-USDT0-RAIL.md §2) ---

const ARBITRUM_USDT0 = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9";
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

function arbitrumOn(): void {
  process.env.X402_EXTRA_EVM_RAILS = '[{"network":"eip155:42161","facilitatorUrl":"https://api.cdp.coinbase.com/platform/v2/x402"}]';
  resetEnv();
}

describe("a second EVM rail: one accept and one option per EVM rail, the primary first", () => {
  /** The Arbitrum canonical requirement, exactly: the same payee and micro amount, its own token and domain. */
  const ARBITRUM_CANONICAL = {
    scheme: "exact",
    network: "eip155:42161",
    amount: "2000000",
    asset: ARBITRUM_USDT0,
    payTo: "0x1111111111111111111111111111111111111111",
    maxTimeoutSeconds: 300,
    extra: { name: "USD₮0", version: "1" },
  };

  it("a creator with both address families gets Base, Arbitrum and Stellar, in that order", async () => {
    stellarOn();
    arbitrumOn();
    seedListing(mock, { ...TWO_DOLLARS, payoutAddress: EVM_PAYOUT, stellarPayoutAddress: STELLAR_CREATOR });
    const { body, accepts } = toPaymentRequirements(await quoteFor(), NOW);

    expect(accepts.map((a) => a.network)).toEqual(["eip155:84532", "eip155:42161", "stellar:testnet"]);
    expect(body.accepts.map((a) => a.network)).toEqual(["eip155:84532", "eip155:42161", "stellar:testnet"]);
    // Base is untouched, byte for byte.
    expect(accepts[0]).toEqual(EVM_CANONICAL_SNAPSHOT[0]);
    expect(body.accepts[0]).toEqual(EVM_402_SNAPSHOT.accepts[0]);
    // Arbitrum: its own token and EIP-712 domain, the same receiving address, micro amount.
    expect(accepts[1]).toEqual(ARBITRUM_CANONICAL);
    expect(body.accepts[1]).toEqual({
      ...ARBITRUM_CANONICAL,
      maxAmountRequired: "2000000",
      resource: "https://x402git.test/api/r/adrian/humanizer",
      description: `${EVM_402_SNAPSHOT.accepts[0].description} $2.00 in USDT0 on Arbitrum.`,
      mimeType: "application/zip",
    });
    expect(accepts[2]).toMatchObject({ network: "stellar:testnet", amount: "20000000", asset: STELLAR_TESTNET_USDC });

    // The Base sentence first and intact, Arbitrum in one clause, then the Stellar alternative.
    const instructions = body.extra.instructions;
    expect(instructions.startsWith(EVM_402_SNAPSHOT.extra.instructions)).toBe(true);
    expect(instructions).toContain(
      `${EVM_402_SNAPSHOT.extra.instructions} Also payable in USDT0 on Arbitrum: sign the eip155:42161 entry the same way, as an EIP-3009 USDT0 authorization. Or on Stellar:`,
    );
    expect(() => PaymentRequiredBody.parse(body)).not.toThrow();
  });

  it("an EVM-only creator gets Base then Arbitrum; a Stellar-only creator gets no EVM entry at all", async () => {
    stellarOn();
    arbitrumOn();
    seedListing(mock, { ...TWO_DOLLARS, payoutAddress: EVM_PAYOUT });
    const evmOnly = toPaymentRequirements(await quoteFor(), NOW);
    expect(evmOnly.accepts).toEqual([EVM_CANONICAL_SNAPSHOT[0], ARBITRUM_CANONICAL]);
    expect(evmOnly.body.extra.instructions).not.toContain("Or on Stellar:");

    seedListing(mock, { ...TWO_DOLLARS, owner: "stella", slug: "tool", payoutAddress: STELLAR_CREATOR });
    const stellarOnly = toPaymentRequirements(await quoteFor("stella", "tool"), NOW);
    expect(stellarOnly.accepts.map((a) => a.network)).toEqual(["stellar:testnet"]);
    expect(stellarOnly.body.extra.instructions).not.toContain("Arbitrum");
  });

  it("payment_options carries both EVM rails with their own symbols, and needs no receiving address", async () => {
    stellarOn();
    arbitrumOn();
    const both = seedListing(mock, { ...TWO_DOLLARS, payoutAddress: EVM_PAYOUT, stellarPayoutAddress: STELLAR_CREATOR });
    const creator = mock.rows("creator").find((c) => c.id === both.creatorId)!;
    const listing = mock.rows("listing").find((l) => l.id === both.listingId)!;

    // A page renders where no payout configuration exists (`evmChains()`, not `evmRails()`).
    delete process.env.PLATFORM_RECEIVING_ADDRESS;
    resetEnv();
    const options = paymentOptionsFor(creator as never, listing as never);
    expect(options.map((o) => [o.network, o.asset, o.asset_symbol, o.amount])).toEqual([
      ["eip155:84532", BASE_SEPOLIA_USDC, "USDC", "2000000"],
      ["eip155:42161", ARBITRUM_USDT0, "USDT0", "2000000"],
      ["stellar:testnet", STELLAR_TESTNET_USDC, "USDC", "20000000"],
    ]);
    expect(options[0].how).toBe("Sign the eip155:84532 entry of accepts as an EIP-3009 USDC authorization on Base Sepolia and retry with it in PAYMENT-SIGNATURE.");
    expect(options[1].how).toBe("Sign the eip155:42161 entry of accepts as an EIP-3009 USDT0 authorization on Arbitrum and retry with it in PAYMENT-SIGNATURE.");
  });
});

describe("grant — an Arbitrum settlement is stamped on Arbitrum, in USDT0", () => {
  const nonce = `0x${"a7".repeat(32)}`;
  const settlement = { txHash: `0x${"cd".repeat(32)}`, nonce, amountMicro: 2_000_000n, network: "eip155:42161" };

  it("writes network eip155:42161, chain_id 42161 and the USDT0 address, and the buyer owns it on the next quote", async () => {
    arbitrumOn();
    seedListing(mock, { ...TWO_DOLLARS, payoutAddress: EVM_PAYOUT });
    const q = await quoteFor();

    const purchase = await grant(q, EVM_BUYER, settlement);
    expect(purchase).toMatchObject({ network: "eip155:42161", asset: ARBITRUM_USDT0, buyerAddress: EVM_BUYER.toLowerCase(), grossMicro: 2_000_000n, feeMicro: 200_000n });
    expect(mock.rows("purchase")[0]).toMatchObject({ network: "eip155:42161", chain_id: 42161, asset: ARBITRUM_USDT0, payment_nonce: nonce });

    // The replay ledger is per network: found on Arbitrum, not on the primary chain.
    expect((await findPurchaseByNonce(nonce, "eip155:42161"))?.id).toBe(purchase.id);
    expect(await findPurchaseByNonce(nonce)).toBeNull();
    // Idempotent on the nonce, as on Base.
    expect((await grant(q, EVM_BUYER, settlement)).id).toBe(purchase.id);
    expect(mock.rows("purchase")).toHaveLength(1);

    // An EVM wallet owns what it bought on any EVM rail this deployment serves, or the next
    // 402 would ask it to pay again for what it just paid for on Arbitrum.
    expect((await quote({ owner: "adrian", slug: "humanizer" }, EVM_BUYER)).kind).toBe("granted");
    expect((await owned(EVM_BUYER)).map((p) => p.network)).toEqual(["eip155:42161"]);
  });

  it("refuses an Arbitrum settlement on a deployment that does not run the rail", async () => {
    seedListing(mock, { ...TWO_DOLLARS, payoutAddress: EVM_PAYOUT });
    const q = await quoteFor();
    await expect(grant(q, EVM_BUYER, settlement)).rejects.toSatisfy((e: unknown) => isApiError(e) && e.code === "authorization_mismatch");
    expect(mock.rows("purchase")).toHaveLength(0);
  });

  it("refuses a Stellar payer on the Arbitrum rail (the row would fail the CHECK after the money moved)", async () => {
    stellarOn();
    arbitrumOn();
    seedListing(mock, { ...TWO_DOLLARS, payoutAddress: EVM_PAYOUT, stellarPayoutAddress: STELLAR_CREATOR });
    const q = await quoteFor();
    await expect(grant(q, STELLAR_BUYER_ADDRESS, settlement)).rejects.toSatisfy((e: unknown) => isApiError(e) && e.code === "authorization_mismatch");
  });

  it("an Arbitrum row is not an entitlement on a deployment without the rail (the cutover rule, per network)", async () => {
    const seed = seedListing(mock, { ...TWO_DOLLARS, payoutAddress: EVM_PAYOUT });
    seedPurchase(mock, { listingId: seed.listingId, releaseId: seed.latest.id, buyer: EVM_BUYER, network: "eip155:42161", chainId: 42161, asset: ARBITRUM_USDT0, grossMicro: "2000000" });
    expect((await quote({ owner: "adrian", slug: "humanizer" }, EVM_BUYER)).kind).toBe("payment_required");
    expect(await owned(EVM_BUYER)).toEqual([]);
  });

  it("a free grant is still stamped on the primary chain: a $0 hand-over has no settlement to say otherwise", async () => {
    arbitrumOn();
    seedListing(mock, { priceMicro: "0", updatePriceMicro: "0", payoutAddress: EVM_PAYOUT, releases: [{ version: "1.0.0" }] });
    const q = await quoteFor();
    const purchase = await grantFree(q, EVM_BUYER);
    expect(purchase.network).toBe("eip155:84532");
    expect(mock.rows("purchase")[0]).toMatchObject({ network: "eip155:84532", chain_id: 84532, asset: BASE_SEPOLIA_USDC });
  });
});
