/**
 * /dashboard/earnings, "where it lands" (25 Oct 2026, HackMeridian W6b): one line per
 * rail with its chip, a short chip on every sale, and each payout with its chain and an
 * explorer link. Still never a buyer address or a purchase's transaction hash (FR-40).
 */

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import type { CreatorRow } from "@/lib/db/types";
import { KNOWN_EVM_RAILS, resetEnv } from "@/lib/env";
import { seedListing, seedPurchase } from "@/lib/test/fixtures";
import { makeMockDb } from "@/lib/test/mock-db";
import EarningsPage from "./page";

const state = vi.hoisted(() => ({ creator: null as unknown }));
vi.mock("@/lib/web/dashboard", () => ({ requireDashboard: async () => ({ creator: state.creator }) }));

const BUYER = "0xAAaAAAaAAaaAaaAaAaAAAAaAaAaAaAAAAaaAAaAa";
const BASE_USDC = KNOWN_EVM_RAILS["eip155:8453"].asset;
const ARB_USDT0 = KNOWN_EVM_RAILS["eip155:42161"].asset;
const PURCHASE_TX = "0x" + "ef".repeat(32);
const PAYOUT_TX = "0x" + "ab".repeat(32);

let mock: ReturnType<typeof makeMockDb>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  process.env.NEXT_PUBLIC_APP_URL = "https://x402git.test";
  process.env.X402_NETWORK = "base";
  process.env.X402_EXTRA_EVM_RAILS = JSON.stringify([{ network: "eip155:42161" }]);
  resetEnv();
});

afterEach(() => {
  resetDb();
  for (const k of ["NEXT_PUBLIC_APP_URL", "X402_NETWORK", "X402_EXTRA_EVM_RAILS"]) delete process.env[k];
  resetEnv();
});

async function render(listing?: string): Promise<string> {
  state.creator = mock.rows("creator")[0] as CreatorRow;
  return renderToStaticMarkup(await EarningsPage({ searchParams: Promise.resolve({ listing }) }));
}

function seedTwoRails() {
  const listing = seedListing(mock, { releases: [{ version: "1.0.0" }] });
  const sale = { listingId: listing.listingId, releaseId: listing.latest.id, buyer: BUYER, grantedAt: new Date(Date.now() - 30 * 86_400_000).toISOString() };
  const payoutId = "11111111-1111-1111-1111-111111111111";
  seedPurchase(mock, { ...sale, nonce: "0xbase", chainId: 8453, asset: BASE_USDC });
  seedPurchase(mock, { ...sale, nonce: "0xarb", chainId: 42161, network: "eip155:42161", asset: ARB_USDT0, grossMicro: "5000000", payoutId });
  mock.rows("payout").push({
    id: payoutId,
    creator_id: mock.rows("creator")[0].id,
    amount_micro: "4500000",
    gas_micro: "0",
    to_address: "0x2222222222222222222222222222222222222222",
    idempotency_key: "arb-1",
    tx_hash: PAYOUT_TX,
    status: "confirmed",
    created_at: new Date().toISOString(),
    chain_id: 42161,
    network: "eip155:42161",
    asset: ARB_USDT0,
  });
}

describe("/dashboard/earnings, where it lands", () => {
  it("gives each rail one line with its chip and amounts", async () => {
    seedTwoRails();
    const html = await render();

    expect(html).toContain("Where it lands");
    const lands = html.slice(html.indexOf("Where it lands"), html.indexOf("Change the address"));
    expect(lands).toContain('data-network="eip155:8453"');
    expect(lands).toContain("USDC on Base");
    expect(lands).toContain("$8.10 net · $8.10 withdrawable");
    expect(lands).toContain('data-network="eip155:42161"');
    expect(lands).toContain("USDT0 on Arbitrum");
    expect(lands).toContain("$4.50 net · $4.50 paid out");
    // The primary rail first.
    expect(lands.indexOf("USDC on Base")).toBeLessThan(lands.indexOf("USDT0 on Arbitrum"));
  });

  it("puts a short chip on each sale row, and the payout's chain and explorer link inside a closed disclosure", async () => {
    seedTwoRails();
    const html = await render();

    const sales = html.slice(html.indexOf("<h2>Sales</h2>"));
    expect(sales.match(/class="rail-chip"/g)).toHaveLength(2);
    expect(sales).toContain("USDT0 on Arbitrum");
    expect(sales).toContain("USDC on Base");

    const details = html.slice(html.indexOf("<details>"), html.indexOf("</details>"));
    expect(html).not.toContain("<details open");
    expect(details).toContain(`href="https://arbiscan.io/tx/${PAYOUT_TX}"`);
    expect(details).toContain("USDT0 on Arbitrum");
    expect(details).toContain("confirmed");
  });

  it("never shows a buyer address or a purchase's transaction hash (FR-40)", async () => {
    seedTwoRails();
    const html = (await render()).toLowerCase();
    expect(html).not.toContain(BUYER.toLowerCase().slice(2));
    expect(html).not.toContain(PURCHASE_TX);
  });

  it("has no rail lines and says so when there are no sales", async () => {
    seedListing(mock, { releases: [{ version: "1.0.0" }] });
    const html = await render();
    expect(html).not.toContain("Where it lands");
    expect(html).toContain("No sales yet.");
    expect(html).toContain("No payouts yet.");
  });
});
