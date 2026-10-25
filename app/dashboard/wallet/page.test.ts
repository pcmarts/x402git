/**
 * /dashboard/wallet, laid out by rail (25 Oct 2026, 23:50; founder: "show USDT0 Arb and
 * USDC Base and then USDT0 on Stellar, use the icons too, clean up the whole page, less
 * text"). Rendered as a server component to static markup: one chip per rail this
 * deployment runs, in the 402's order, each beside the short address it pays; one closed
 * disclosure per wallet; none of the retired copy (the 48 hours, the typed characters).
 */

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreatorRow } from "@/lib/db/types";
import { resetEnv } from "@/lib/env";
import { clearStellarEnv, setStellarTestnetEnv, STELLAR_CREATOR } from "@/lib/test/stellar";
import WalletPage from "./page";

const state = vi.hoisted(() => ({ creator: null as unknown }));
vi.mock("@/lib/web/current", () => ({
  currentSession: async () => ({ github: { id: 4242, login: "adrian" }, creatorId: "c", handle: "adrian", apiKey: "k" }),
  currentCreator: async () => (state.creator ? { session: {}, creator: state.creator } : null),
  signInPath: (next: string) => `/api/auth/github?next=${encodeURIComponent(next)}`,
}));
vi.mock("@/lib/web/loaders", () => ({ challengeByNonce: async () => null }));

const EVM = "0x7ae2f4c1b93de05a8814fba9c0341ed6b27c5019";

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = "https://x402git.test";
  process.env.X402_EXTRA_EVM_RAILS = '[{"network":"eip155:42161"}]';
  setStellarTestnetEnv();
  resetEnv();
});

afterEach(() => {
  clearStellarEnv();
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.X402_EXTRA_EVM_RAILS;
  resetEnv();
  state.creator = null;
});

async function render(creator: Partial<CreatorRow> | null): Promise<string> {
  state.creator = creator ? { id: "c", handle: "adrian", ...creator } : null;
  return renderToStaticMarkup(await WalletPage({ searchParams: Promise.resolve({}) }));
}

describe("/dashboard/wallet by rail", () => {
  it("lists every rail with its chip and the short address it pays, EVM first, Stellar after", async () => {
    const html = await render({ payout_address: EVM, stellar_payout_address: STELLAR_CREATOR, stellar_payout_verified_at: "2026-10-25T20:00:00.000Z" });
    const chips = [...html.matchAll(/<span class="rail-chip" data-network="([^"]+)"/g)].map((m) => m[1]);
    expect(chips).toEqual(["eip155:84532", "eip155:42161", "stellar:testnet"]);
    expect(html).toContain('src="/logos/usdt0.svg"');
    expect(html).toContain('src="/logos/arbitrum.svg"');
    expect(html).toContain('src="/logos/stellar.svg"');
    // The EVM address is shown once per EVM rail, shortened; the full value lives in the link's title.
    expect(html.split("0x7ae2…5019").length - 1).toBe(2);
    expect(html).not.toContain(`>${EVM}<`);
    expect(html).toContain(`${STELLAR_CREATOR.slice(0, 6)}…${STELLAR_CREATOR.slice(-4)}`);
    expect(html).toContain("Change the EVM wallet");
    expect(html).toContain("Change the Stellar wallet");
    expect(html).toContain("tUSDT0 allowed");
  });

  it("says 'not yet' on a rail with no wallet and offers to add it", async () => {
    const html = await render({ payout_address: STELLAR_CREATOR, stellar_payout_address: STELLAR_CREATOR });
    expect(html).toContain("Add an EVM wallet");
    expect(html).toContain("not yet");
    expect(html).toContain("Change the Stellar wallet");
  });

  it("before any bind, shows the rails with no address and one bind section per wallet", async () => {
    const html = await render(null);
    expect([...html.matchAll(/<li data-network="([^"]+)"/g)].map((m) => m[1])).toEqual(["eip155:84532", "eip155:42161", "stellar:testnet"]);
    expect(html).toContain("Connect the wallet you want to be paid at");
    expect(html).toContain("Bind by hand");
  });

  it("carries none of the retired copy", async () => {
    const html = await render({ payout_address: EVM, stellar_payout_address: STELLAR_CREATOR });
    for (const gone of ["48", "last six", "Type the", "Signed in as", "Paid in USDC at", "Freighter)"]) expect(html).not.toContain(gone);
  });
});
