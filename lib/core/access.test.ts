import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { isApiError } from "@/lib/errors";
import { PaymentRequiredBody } from "@/lib/schemas";
import { seedListing, seedPurchase } from "@/lib/test/fixtures";
import { makeMockDb } from "@/lib/test/mock-db";
import {
  findPurchaseByNonce,
  grant,
  grantFree,
  type PaymentRequiredQuote,
  quote,
  splitFee,
  toPaymentRequirements,
  updatePriceFor,
} from "./access";

const BUYER = "0xAAaAAAaAAaaAaaAaAaAAAAaAaAaAaAAAAaaAAaAa";
const OTHER = "0xBbBbBBBbbBBBbbbBbbBbbbbBBbBbbbBbBbbbBBbB";

let mock: ReturnType<typeof makeMockDb>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  process.env.NEXT_PUBLIC_APP_URL = "https://x402git.test";
  process.env.PLATFORM_RECEIVING_ADDRESS = "0x1111111111111111111111111111111111111111";
  process.env.X402_NETWORK = "base-sepolia";
  resetEnv();
});

afterEach(() => {
  resetDb();
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.PLATFORM_RECEIVING_ADDRESS;
  delete process.env.X402_NETWORK;
  resetEnv();
});

describe("splitFee", () => {
  it("takes a flat 10% of gross (D6)", () => {
    expect(splitFee(9_000_000n)).toEqual({ feeMicro: 900_000n, netMicro: 8_100_000n });
  });

  it("rounds the fee down so the creator never loses a micro-cent to rounding", () => {
    expect(splitFee(15n)).toEqual({ feeMicro: 1n, netMicro: 14n });
  });

  it("handles a free listing", () => {
    expect(splitFee(0n)).toEqual({ feeMicro: 0n, netMicro: 0n });
  });
});

describe("updatePriceFor", () => {
  it("never worsens the stamped terms (FR-16)", () => {
    expect(updatePriceFor({ updatePriceAtPurchase: 3_000_000n }, 9_000_000n)).toBe(3_000_000n);
  });

  it("passes a price cut through to existing holders", () => {
    expect(updatePriceFor({ updatePriceAtPurchase: 5_000_000n }, 2_000_000n)).toBe(2_000_000n);
  });
});

describe("quote — unavailable", () => {
  it("is not_found for an unknown owner or slug", async () => {
    expect(await quote({ owner: "nobody", slug: "nothing" }, null)).toEqual({ kind: "unavailable", code: "not_found" });
  });

  it("is no_release when nothing has passed the scan yet (§12)", async () => {
    seedListing(mock, { releases: [{ version: "1.0.0", scan: "fail" }, { version: "1.1.0", scan: "pending" }] });
    expect(await quote({ owner: "adrian", slug: "humanizer" }, null)).toEqual({ kind: "unavailable", code: "no_release" });
  });

  it("is retired for a non-holder, and still serves a holder their version (FR-43)", async () => {
    const seed = seedListing(mock, { retired: true, releases: [{ version: "1.0.0" }] });
    expect(await quote({ owner: "adrian", slug: "humanizer" }, null)).toEqual({ kind: "unavailable", code: "retired" });

    seedPurchase(mock, { listingId: seed.listingId, releaseId: seed.latest.id, buyer: BUYER });
    const held = await quote({ owner: "adrian", slug: "humanizer" }, BUYER);
    expect(held.kind).toBe("granted");
  });

  it("hides a draft listing from the public", async () => {
    seedListing(mock, { published: false });
    expect(await quote({ owner: "adrian", slug: "humanizer" }, null)).toEqual({ kind: "unavailable", code: "not_found" });
  });
});

describe("quote — new buyer", () => {
  it("quotes the listing price with reason `new`", async () => {
    seedListing(mock, { priceMicro: "9000000", releases: [{ version: "1.2.0" }] });
    const q = await quote({ owner: "adrian", slug: "humanizer" }, BUYER);
    expect(q.kind).toBe("payment_required");
    if (q.kind !== "payment_required") return;
    expect(q.priceMicro).toBe(9_000_000n);
    expect(q.reason).toBe("new");
    expect(q.ownedVersion).toBeNull();
    expect(q.releasesSince).toEqual([]);
  });

  it("exposes a free listing as a 0 price rather than a grant (FR-24)", async () => {
    seedListing(mock, { priceMicro: "0" });
    const q = await quote({ owner: "adrian", slug: "humanizer" }, BUYER);
    expect(q.kind).toBe("payment_required");
    if (q.kind !== "payment_required") return;
    expect(q.priceMicro).toBe(0n);
    expect(q.reason).toBe("new");
  });

  it("does not reveal another wallet's entitlement to an anonymous caller (FR-20)", async () => {
    const seed = seedListing(mock, { releases: [{ version: "1.0.0" }, { version: "1.1.0" }] });
    seedPurchase(mock, { listingId: seed.listingId, releaseId: seed.releases[0].id, buyer: BUYER });
    const q = await quote({ owner: "adrian", slug: "humanizer" }, null);
    expect(q.kind).toBe("payment_required");
    if (q.kind !== "payment_required") return;
    expect(q.reason).toBe("new");
    expect(q.priceMicro).toBe(9_000_000n);
  });
});

describe("quote — holder", () => {
  it("charges the stamped update price when the listing raised it (FR-16)", async () => {
    const seed = seedListing(mock, {
      updatePriceMicro: "9000000",
      releases: [{ version: "1.0.0" }, { version: "1.1.0", changelog: "em-dash runs" }],
    });
    seedPurchase(mock, {
      listingId: seed.listingId,
      releaseId: seed.releases[0].id,
      buyer: BUYER,
      updatePriceAtPurchase: "3000000",
      grantedAt: new Date(Date.now() - 60 * 86_400_000).toISOString(),
    });

    const q = await quote({ owner: "adrian", slug: "humanizer" }, BUYER);
    expect(q.kind).toBe("payment_required");
    if (q.kind !== "payment_required") return;
    expect(q.reason).toBe("update");
    expect(q.priceMicro).toBe(3_000_000n);
    expect(q.ownedVersion).toBe("1.0.0");
    expect(q.release.version).toBe("1.1.0");
  });

  it("passes a price cut through to the holder", async () => {
    const seed = seedListing(mock, {
      updatePriceMicro: "1000000",
      releases: [{ version: "1.0.0" }, { version: "1.1.0" }],
    });
    seedPurchase(mock, {
      listingId: seed.listingId,
      releaseId: seed.releases[0].id,
      buyer: BUYER,
      updatePriceAtPurchase: "3000000",
      grantedAt: new Date(Date.now() - 60 * 86_400_000).toISOString(),
    });
    const q = await quote({ owner: "adrian", slug: "humanizer" }, BUYER);
    if (q.kind !== "payment_required") throw new Error("expected payment_required");
    expect(q.priceMicro).toBe(1_000_000n);
  });

  it("carries every release-log entry between the owned version and the latest (FR-17)", async () => {
    const seed = seedListing(mock, {
      releases: [
        { version: "1.0.0", changelog: "first" },
        { version: "1.1.0", changelog: "second" },
        { version: "1.2.0", changelog: "third" },
      ],
    });
    seedPurchase(mock, {
      listingId: seed.listingId,
      releaseId: seed.releases[0].id,
      buyer: BUYER,
      grantedAt: new Date(Date.now() - 60 * 86_400_000).toISOString(),
    });
    const q = await quote({ owner: "adrian", slug: "humanizer" }, BUYER);
    if (q.kind !== "payment_required") throw new Error("expected payment_required");
    expect(q.releasesSince.map((r) => r.version)).toEqual(["1.2.0", "1.1.0"]);
    expect(q.priceMicro).toBe(3_000_000n);
  });

  it("grants a lifetime holder every later release (FR-16, all_versions)", async () => {
    const seed = seedListing(mock, { releases: [{ version: "1.0.0" }, { version: "2.0.0" }] });
    seedPurchase(mock, {
      listingId: seed.listingId,
      releaseId: seed.releases[0].id,
      buyer: BUYER,
      allVersions: true,
      grantedAt: new Date(Date.now() - 400 * 86_400_000).toISOString(),
    });
    const q = await quote({ owner: "adrian", slug: "humanizer" }, BUYER);
    expect(q.kind).toBe("granted");
    if (q.kind !== "granted") return;
    expect(q.release.version).toBe("2.0.0");
  });

  it("grants free inside the 7-day update window and charges outside it (FR-18)", async () => {
    const seed = seedListing(mock, { releases: [{ version: "1.0.0" }, { version: "1.1.0" }] });
    const purchaseId = seedPurchase(mock, {
      listingId: seed.listingId,
      releaseId: seed.releases[0].id,
      buyer: BUYER,
      kind: "update",
      grantedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    });
    expect((await quote({ owner: "adrian", slug: "humanizer" }, BUYER)).kind).toBe("granted");

    // Same buyer, same releases, one month later: now it is an update.
    const row = mock.rows("purchase").find((r) => r.id === purchaseId)!;
    row.granted_at = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const later = await quote({ owner: "adrian", slug: "humanizer" }, BUYER);
    expect(later.kind).toBe("payment_required");
    if (later.kind !== "payment_required") return;
    expect(later.reason).toBe("update");
  });

  it("does not open the free window on the initial purchase (FR-18 vs FR-34)", async () => {
    const seed = seedListing(mock, { releases: [{ version: "1.0.0" }, { version: "1.1.0" }] });
    seedPurchase(mock, {
      listingId: seed.listingId,
      releaseId: seed.releases[0].id,
      buyer: BUYER,
      kind: "new",
      grantedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const q = await quote({ owner: "adrian", slug: "humanizer" }, BUYER);
    expect(q.kind).toBe("payment_required");
    if (q.kind !== "payment_required") return;
    expect(q.reason).toBe("update");
  });
});

describe("quote — an explicit version (FR-19)", () => {
  it("grants a version the wallet owns, forever", async () => {
    const seed = seedListing(mock, { releases: [{ version: "1.0.0" }, { version: "1.1.0" }] });
    seedPurchase(mock, {
      listingId: seed.listingId,
      releaseId: seed.releases[0].id,
      buyer: BUYER,
      grantedAt: new Date(Date.now() - 900 * 86_400_000).toISOString(),
    });
    const q = await quote({ owner: "adrian", slug: "humanizer" }, BUYER, "1.0.0");
    expect(q.kind).toBe("granted");
    if (q.kind !== "granted") return;
    expect(q.release.version).toBe("1.0.0");
  });

  it("is not_entitled for a version the wallet does not own", async () => {
    const seed = seedListing(mock, { releases: [{ version: "1.0.0" }, { version: "1.1.0" }] });
    seedPurchase(mock, {
      listingId: seed.listingId,
      releaseId: seed.releases[0].id,
      buyer: OTHER,
      grantedAt: new Date(Date.now() - 900 * 86_400_000).toISOString(),
    });
    expect(await quote({ owner: "adrian", slug: "humanizer" }, BUYER, "1.0.0")).toEqual({ kind: "unavailable", code: "not_entitled" });
  });

  it("is not_found for a version that does not exist", async () => {
    seedListing(mock, { releases: [{ version: "1.0.0" }] });
    expect(await quote({ owner: "adrian", slug: "humanizer" }, BUYER, "9.9.9")).toEqual({ kind: "unavailable", code: "not_found" });
  });

  it("still serves an owned version after the listing retires (FR-46)", async () => {
    const seed = seedListing(mock, { retired: true, releases: [{ version: "1.0.0" }] });
    seedPurchase(mock, { listingId: seed.listingId, releaseId: seed.latest.id, buyer: BUYER });
    const q = await quote({ owner: "adrian", slug: "humanizer" }, BUYER, "1.0.0");
    expect(q.kind).toBe("granted");
  });
});

describe("quote_id (FR-23)", () => {
  it("changes when the listing price changes", async () => {
    seedListing(mock, { releases: [{ version: "1.0.0" }] });
    const before = await quote({ owner: "adrian", slug: "humanizer" }, BUYER);
    mock.rows("listing")[0].price_micro = "5000000";
    const after = await quote({ owner: "adrian", slug: "humanizer" }, BUYER);
    if (before.kind !== "payment_required" || after.kind !== "payment_required") throw new Error("expected payment_required");
    expect(after.quoteId).not.toBe(before.quoteId);
  });

  it("is stable when nothing changed", async () => {
    seedListing(mock, { releases: [{ version: "1.0.0" }] });
    const a = await quote({ owner: "adrian", slug: "humanizer" }, BUYER);
    const b = await quote({ owner: "adrian", slug: "humanizer" }, BUYER);
    if (a.kind !== "payment_required" || b.kind !== "payment_required") throw new Error("expected payment_required");
    expect(a.quoteId).toBe(b.quoteId);
  });
});

describe("toPaymentRequirements — the only place a 402 body is built", () => {
  it("carries the x402 v2 requirement and the platform extras (§13)", async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });
    const q = (await quote({ owner: "adrian", slug: "humanizer" }, BUYER)) as PaymentRequiredQuote;
    const { body, accepts } = toPaymentRequirements(q);

    expect(body.x402Version).toBe(2);
    expect(accepts[0]).toMatchObject({
      scheme: "exact",
      network: "eip155:84532",
      amount: "9000000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: "0x1111111111111111111111111111111111111111",
      maxTimeoutSeconds: 300,
      extra: { name: "USDC", version: "2" },
    });
    // Both spellings on the wire: v2 `amount` and PRD §13's `maxAmountRequired`.
    expect(body.accepts[0].maxAmountRequired).toBe("9000000");
    expect(body.accepts[0].resource).toBe("https://x402git.test/api/r/adrian/humanizer");
    expect(body.extra).toMatchObject({
      kind: "new",
      version: "1.2.0",
      manifest_url: "https://x402git.test/api/label/adrian/humanizer",
      update_price_micro: "3000000",
      quote_id: q.quoteId,
      // 2026-09-02: the 402 tells a reader that is not an x402 client what to do next.
      listing_url: "https://x402git.test/adrian/humanizer",
      skill_url: "https://x402git.test/.well-known/agent-skills/buy-a-repo/SKILL.md",
      mcp_url: "https://x402git.test/api/mcp",
    });
    expect(body.extra.instructions).toContain("not an error");
    expect(body.extra.instructions).toContain(body.extra.skill_url);
    expect(body.extra.instructions).toContain(body.extra.listing_url);
    // The prose names the chain `accepts[0].network` is on — Sepolia here — so a reader
    // following the words rather than the field does not sign for the wrong domain.
    expect(body.extra.instructions).toContain("on Base Sepolia");
    // §13: the description is product copy an agent reasons over.
    expect(body.accepts[0].description).toContain("adrian/humanizer");
  });

  it("produces a body that validates against the published schema (FR-33)", async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });
    const q = (await quote({ owner: "adrian", slug: "humanizer" }, BUYER)) as PaymentRequiredQuote;
    // If this fails, either the code or lib/schemas/payment.ts drifted — and the
    // OpenAPI document would then be documenting a 402 nobody sends.
    expect(() => PaymentRequiredBody.parse(toPaymentRequirements(q).body)).not.toThrow();
  });

  it("carries a validity horizon beside the quote id (FR-23)", async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });
    const q = (await quote({ owner: "adrian", slug: "humanizer" }, BUYER)) as PaymentRequiredQuote;
    const now = new Date("2026-08-29T12:00:00.000Z");
    const { body } = toPaymentRequirements(q, now);
    expect(body.extra.valid_before).toBe("2026-08-29T12:05:00.000Z");
  });

  it("names the EIP-712 domain of the asset it is actually pricing in", async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });
    const sepolia = (await quote({ owner: "adrian", slug: "humanizer" }, BUYER)) as PaymentRequiredQuote;
    expect(toPaymentRequirements(sepolia).accepts[0].extra).toEqual({ name: "USDC", version: "2" });

    // Base mainnet USDC's EIP-712 domain name is "USD Coin", not "USDC". Signing the
    // wrong one produces an authorization no token contract will honour.
    process.env.X402_NETWORK = "base";
    resetEnv();
    const mainnet = (await quote({ owner: "adrian", slug: "humanizer" }, BUYER)) as PaymentRequiredQuote;
    const { body, accepts } = toPaymentRequirements(mainnet);
    expect(accepts[0].extra).toEqual({ name: "USD Coin", version: "2" });
    expect(accepts[0].network).toBe("eip155:8453");
    expect(body.accepts[0].asset).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });

  it("names the versions and the releases on an update 402 (FR-17)", async () => {
    const seed = seedListing(mock, { releases: [{ version: "1.2.0" }, { version: "1.3.0", changelog: "faster" }] });
    seedPurchase(mock, {
      listingId: seed.listingId,
      releaseId: seed.releases[0].id,
      buyer: BUYER,
      grantedAt: new Date(Date.now() - 60 * 86_400_000).toISOString(),
    });
    const q = (await quote({ owner: "adrian", slug: "humanizer" }, BUYER)) as PaymentRequiredQuote;
    const { body } = toPaymentRequirements(q);
    expect(body.extra).toMatchObject({ kind: "update", from: "1.2.0", to: "1.3.0" });
    expect(body.extra.releases).toHaveLength(1);
    expect(body.accepts[0].description).toContain("1.2.0 → v1.3.0");

    // FR-15's wire shape, not an internal one: an agent reads these against the
    // published `ReleaseLogEntry`, and the whole body must validate (FR-33).
    expect(body.extra.releases?.[0]).toMatchObject({
      version: "1.3.0",
      tag: "refs/tags/v1.3.0",
      changelog: "faster",
      scan: "pass",
      price_micro: "9000000",
      update_price_micro: "3000000",
    });
    expect(typeof body.extra.releases?.[0].published_at).toBe("string");
    expect(() => PaymentRequiredBody.parse(body)).not.toThrow();
  });
});

describe("grant", () => {
  const settlement = { txHash: "0xdeadbeef", nonce: "0xnonce-1", amountMicro: 9_000_000n, network: "eip155:84532" };

  async function newQuote(): Promise<PaymentRequiredQuote> {
    const q = await quote({ owner: "adrian", slug: "humanizer" }, BUYER);
    if (q.kind !== "payment_required") throw new Error("expected payment_required");
    return q;
  }

  it("writes one purchase with the fee split and the 7-day holdback (D6, FR-27)", async () => {
    seedListing(mock, { releases: [{ version: "1.0.0" }] });
    const q = await newQuote();
    const purchase = await grant(q, BUYER, settlement);

    expect(purchase.grossMicro).toBe(9_000_000n);
    expect(purchase.feeMicro).toBe(900_000n);
    expect(purchase.netMicro).toBe(8_100_000n);
    expect(purchase.kind).toBe("new");
    expect(purchase.buyerAddress).toBe(BUYER.toLowerCase());
    const days = (purchase.holdbackUntil.getTime() - purchase.grantedAt.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(7);
    expect(mock.rows("purchase")).toHaveLength(1);
    expect(mock.rows("purchase")[0].tx_hash).toBe("0xdeadbeef");
  });

  it("stamps the update price in force, so later changes cannot worsen it (FR-16)", async () => {
    seedListing(mock, { updatePriceMicro: "3000000", releases: [{ version: "1.0.0" }] });
    const purchase = await grant(await newQuote(), BUYER, settlement);
    expect(purchase.updatePriceAtPurchase).toBe(3_000_000n);
    expect(purchase.allVersions).toBe(false);
  });

  it("stamps all_versions when the update price is $0 (D1)", async () => {
    seedListing(mock, { updatePriceMicro: "0", releases: [{ version: "1.0.0" }] });
    const purchase = await grant(await newQuote(), BUYER, settlement);
    expect(purchase.allVersions).toBe(true);
  });

  it("is idempotent on the nonce: the same authorization returns the same row (FR-22)", async () => {
    seedListing(mock, { releases: [{ version: "1.0.0" }] });
    const q = await newQuote();
    const first = await grant(q, BUYER, settlement);
    const second = await grant(q, BUYER, settlement);
    expect(second.id).toBe(first.id);
    expect(mock.rows("purchase")).toHaveLength(1);
    expect(await findPurchaseByNonce(settlement.nonce)).not.toBeNull();
  });

  it("rejects a nonce reused for a different listing as authorization_mismatch (§13)", async () => {
    seedListing(mock, { releases: [{ version: "1.0.0" }] });
    const other = seedListing(mock, { owner: "beth", slug: "summariser", releases: [{ version: "1.0.0" }] });
    await grant(await newQuote(), BUYER, settlement);

    const q2 = await quote({ owner: other.owner, slug: other.slug }, BUYER);
    if (q2.kind !== "payment_required") throw new Error("expected payment_required");
    await expect(grant(q2, BUYER, settlement)).rejects.toSatisfy(
      (e: unknown) => isApiError(e) && (e as { code: string }).code === "authorization_mismatch",
    );
    expect(mock.rows("purchase")).toHaveLength(1);
  });

  // CORE-1 (RED-TEAM-2026-09-21): an EIP-3009 nonce is unique per chain, and one database
  // holds Sepolia and mainnet rows. A nonce spent on chain A must never answer for chain B.
  describe("the nonce ledger is chain-scoped (CORE-1)", () => {
    const SEPOLIA = 84532;
    const MAINNET = 8453;
    // The ledger's partition key is the CAIP-2 `network` since 20261025090100; `chain_id`
    // is its EVM spelling and what `seedPurchase` still takes.
    const SEPOLIA_NET = "eip155:84532";
    const MAINNET_NET = "eip155:8453";

    it("does not find a nonce granted on chain A when looking it up on chain B", async () => {
      const seed = seedListing(mock, { releases: [{ version: "1.0.0" }] });
      seedPurchase(mock, { listingId: seed.listingId, releaseId: seed.latest.id, buyer: BUYER, nonce: "0xshared", chainId: SEPOLIA });

      expect(await findPurchaseByNonce("0xshared", SEPOLIA_NET)).not.toBeNull();
      expect(await findPurchaseByNonce("0xshared", MAINNET_NET)).toBeNull();
    });

    it("defaults to this deployment's chain, so a Sepolia purchase cannot answer a mainnet replay", async () => {
      const seed = seedListing(mock, { releases: [{ version: "1.0.0" }] });
      seedPurchase(mock, { listingId: seed.listingId, releaseId: seed.latest.id, buyer: BUYER, nonce: "0xshared", chainId: SEPOLIA });

      // The test env is Base Sepolia: the row is this chain's replay.
      expect((await findPurchaseByNonce("0xshared"))?.buyerAddress).toBe(BUYER.toLowerCase());

      // The same database read by a mainnet deployment: the Sepolia row is invisible.
      process.env.X402_NETWORK = "base";
      resetEnv();
      expect(await findPurchaseByNonce("0xshared")).toBeNull();
    });

    it("never returns another chain's row as the idempotent replay of a settle", async () => {
      const seed = seedListing(mock, { releases: [{ version: "1.0.0" }] });
      // A testnet purchase for the very listing, release and amount being paid for.
      const sepoliaRow = seedPurchase(mock, {
        listingId: seed.listingId,
        releaseId: seed.latest.id,
        buyer: BUYER,
        nonce: settlement.nonce,
        chainId: SEPOLIA,
      });

      process.env.X402_NETWORK = "base";
      resetEnv();
      const q = await newQuote();

      // Before the fix this resolved to the Sepolia row: a mainnet settle answered with a
      // testnet purchase. The global `payment_nonce` key still refuses a second row, so
      // the grant fails loudly instead of handing back the other chain's entitlement.
      await expect(grant(q, BUYER, { ...settlement, network: MAINNET_NET })).rejects.toBeDefined();
      expect(mock.rows("purchase")).toHaveLength(1);
      expect(mock.rows("purchase")[0].id).toBe(sepoliaRow);
    });

    it("stamps and finds a fresh grant on the deployment's chain", async () => {
      seedListing(mock, { releases: [{ version: "1.0.0" }] });
      process.env.X402_NETWORK = "base";
      resetEnv();

      const q = await newQuote();
      const mainnetSettlement = { ...settlement, network: MAINNET_NET };
      const purchase = await grant(q, BUYER, mainnetSettlement);
      expect(Number(mock.rows("purchase")[0].chain_id)).toBe(MAINNET);
      expect(mock.rows("purchase")[0].network).toBe(MAINNET_NET);
      expect((await findPurchaseByNonce(settlement.nonce))?.id).toBe(purchase.id);
      expect(await findPurchaseByNonce(settlement.nonce, SEPOLIA_NET)).toBeNull();
      // Idempotent on the same chain, as before.
      expect((await grant(q, BUYER, mainnetSettlement)).id).toBe(purchase.id);
      expect(mock.rows("purchase")).toHaveLength(1);
    });
  });

  it("records an update purchase as kind `update`", async () => {
    const seed = seedListing(mock, { releases: [{ version: "1.0.0" }, { version: "1.1.0" }] });
    seedPurchase(mock, {
      listingId: seed.listingId,
      releaseId: seed.releases[0].id,
      buyer: BUYER,
      grantedAt: new Date(Date.now() - 60 * 86_400_000).toISOString(),
    });
    const q = await newQuote();
    const purchase = await grant(q, BUYER, { txHash: "0xabc", nonce: "0xnonce-2", amountMicro: 3_000_000n, network: "eip155:84532" });
    expect(purchase.kind).toBe("update");
    expect(purchase.grossMicro).toBe(3_000_000n);
    expect(purchase.feeMicro).toBe(300_000n);
  });
});

describe("grantFree (FR-24)", () => {
  it("writes one row and reuses it on a re-fetch", async () => {
    seedListing(mock, { priceMicro: "0", releases: [{ version: "1.0.0" }] });
    const q = await quote({ owner: "adrian", slug: "humanizer" }, BUYER);
    if (q.kind !== "payment_required") throw new Error("expected payment_required");

    const first = await grantFree(q, BUYER);
    const second = await grantFree(q, BUYER);
    expect(second.id).toBe(first.id);
    expect(first.kind).toBe("free");
    expect(first.grossMicro).toBe(0n);
    expect(mock.rows("purchase")).toHaveLength(1);
    expect(mock.rows("purchase")[0].payment_nonce).toBeNull();
  });

  it("W1.7: two concurrent free grants for the same (listing, release, wallet) write exactly one row", async () => {
    seedListing(mock, { priceMicro: "0", releases: [{ version: "1.0.0" }] });
    const q = await quote({ owner: "adrian", slug: "humanizer" }, BUYER);
    if (q.kind !== "payment_required") throw new Error("expected payment_required");

    // The read-then-insert has no in-process lock; the DB's partial unique index
    // (kind='free') is what makes it idempotent. On the 23505 the loser re-reads the winner.
    const [a, b] = await Promise.all([grantFree(q, BUYER), grantFree(q, BUYER)]);
    expect(a.id).toBe(b.id);
    expect(mock.rows("purchase")).toHaveLength(1);
  });
});

describe("quote — the FR-18 window does not over-grant an explicit version (W1.6)", () => {
  it("denies an old version the wallet never bought, even inside the update window", async () => {
    const seed = seedListing(mock, { releases: [{ version: "1.0.0" }, { version: "1.1.0" }, { version: "1.2.0" }] });
    // Paid an update charge for 1.1.0 three days ago — inside the 7-day window.
    seedPurchase(mock, {
      listingId: seed.listingId,
      releaseId: seed.releases[1].id,
      buyer: BUYER,
      kind: "update",
      grantedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    });

    // An explicit older version the wallet never owned: the window must not grant it.
    expect(await quote({ owner: "adrian", slug: "humanizer" }, BUYER, "1.0.0")).toEqual({
      kind: "unavailable",
      code: "not_entitled",
    });

    // The same holder, same window, requesting the *latest* — still entitled (FR-18).
    const latest = await quote({ owner: "adrian", slug: "humanizer" }, BUYER);
    expect(latest.kind).toBe("granted");
    if (latest.kind !== "granted") return;
    expect(latest.release.version).toBe("1.2.0");
  });
});

describe("quote — the licence does not gate the sale (2026-09-02)", () => {
  it("sells the newest passing release even when its licence_verdict is block", async () => {
    seedListing(mock, { releases: [{ version: "1.0.0" }, { version: "1.1.0" }] });
    // The newest release has no LICENSE in its snapshot. Its secret scan passed, so it
    // sells: the licence verdict is recorded on the release and shown, not enforced.
    mock.rows("release").find((r) => r.version === "1.1.0")!.licence_verdict = "block";

    const q = await quote({ owner: "adrian", slug: "humanizer" }, BUYER);
    expect(q.kind).toBe("payment_required");
    if (q.kind !== "payment_required") return;
    expect(q.release.version).toBe("1.1.0");
  });

  it("sells a release whose licence_verdict is null", async () => {
    seedListing(mock, { releases: [{ version: "1.0.0" }] });
    mock.rows("release")[0].licence_verdict = null;
    const q = await quote({ owner: "adrian", slug: "humanizer" }, BUYER);
    expect(q.kind).toBe("payment_required");
    if (q.kind !== "payment_required") return;
    expect(q.release.version).toBe("1.0.0");
  });

  it("lets a holder re-fetch an unlicensed version they already own (FR-46)", async () => {
    const seed = seedListing(mock, { releases: [{ version: "1.0.0" }, { version: "1.1.0" }] });
    mock.rows("release").find((r) => r.version === "1.1.0")!.licence_verdict = "block";
    seedPurchase(mock, { listingId: seed.listingId, releaseId: seed.releases[1].id, buyer: BUYER });

    const q = await quote({ owner: "adrian", slug: "humanizer" }, BUYER, "1.1.0");
    expect(q.kind).toBe("granted");
    if (q.kind !== "granted") return;
    expect(q.release.version).toBe("1.1.0");
  });
});
