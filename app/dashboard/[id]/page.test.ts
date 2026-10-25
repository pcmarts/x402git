/**
 * /dashboard/:id, "Where you get paid" (25 Oct 2026, HackMeridian; founder: "we should have
 * the option to switch between" payout addresses on the listing, not only a link to the
 * wallet page).
 *
 * Rendered as a server component to static markup, so what is asserted is what `curl`
 * gets with scripting off: one row per rail this deployment runs, each with its chip, the
 * short address it pays out to and an Offer box, all inside the one form that Save posts.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import type { CreatorRow } from "@/lib/db/types";
import { resetEnv } from "@/lib/env";
import { seedListing } from "@/lib/test/fixtures";
import { makeMockDb } from "@/lib/test/mock-db";
import { clearStellarEnv, setStellarTestnetEnv, STELLAR_CREATOR } from "@/lib/test/stellar";
import ListingDashboardPage from "./page";
import { WhereYouGetPaid } from "./where-you-get-paid";

const state = vi.hoisted(() => ({ creator: null as unknown }));
vi.mock("@/lib/web/dashboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/web/dashboard")>()),
  requireDashboard: async () => ({ creator: state.creator }),
}));

const EVM_PAYOUT = "0x7ae2f4c1b93de05a8814fba9c0341ed6b27c5019";

let mock: ReturnType<typeof makeMockDb>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  clearStellarEnv();
  process.env.NEXT_PUBLIC_APP_URL = "https://x402git.test";
  // Base Sepolia (the default primary), Arbitrum, and Stellar testnet.
  process.env.X402_EXTRA_EVM_RAILS = '[{"network":"eip155:42161"}]';
  setStellarTestnetEnv();
  resetEnv();
});

afterEach(() => {
  resetDb();
  clearStellarEnv();
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.X402_EXTRA_EVM_RAILS;
  resetEnv();
});

async function render(seed: Parameters<typeof seedListing>[1], creatorPatch: Partial<CreatorRow> = {}): Promise<string> {
  const seeded = seedListing(mock, seed);
  state.creator = Object.assign(mock.rows("creator").find((c) => c.id === seeded.creatorId) as unknown as CreatorRow, creatorPatch);
  const page = await ListingDashboardPage({ params: Promise.resolve({ id: seeded.listingId }), searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(page);
}

/** The block, cut out of the page. */
function block(html: string): string {
  const start = html.indexOf('<section id="get-paid">');
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</section>", start));
}

/** The `<tr>` for one network. */
function row(html: string, network: string): string {
  const start = html.indexOf(`<tr data-network="${network}">`);
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</tr>", start));
}

/** The row's checkbox, as its attributes: React orders them as it likes. */
function box(rowHtml: string): { name?: string; value?: string; checked: boolean; disabled: boolean; label?: string } {
  const tag = rowHtml.match(/<input type="checkbox"[^>]*>/)?.[0];
  expect(tag).toBeTruthy();
  const attr = (n: string) => tag!.match(new RegExp(`\\b${n}="([^"]*)"`))?.[1];
  return { name: attr("name"), value: attr("value"), checked: attr("checked") !== undefined, disabled: attr("disabled") !== undefined, label: attr("aria-label") };
}

describe("/dashboard/:id — Where you get paid", () => {
  it("sits inside the one form, so Save changes carries it", async () => {
    const html = await render({ payoutAddress: EVM_PAYOUT, stellarPayoutAddress: STELLAR_CREATOR });
    const form = html.slice(html.indexOf('<form id="listing-form"'), html.indexOf("</form>", html.indexOf('<form id="listing-form"')));
    expect(form).toContain("Where you get paid");
    expect(form).toContain('<input type="hidden" name="offered_networks_shown" value="1"/>');
  });

  it("has one row per rail, each with its chip, the short address it lands at and a ticked Offer box", async () => {
    const html = block(await render({ payoutAddress: EVM_PAYOUT, stellarPayoutAddress: STELLAR_CREATOR }));

    const base = row(html, "eip155:84532");
    expect(base).toContain("USDC on Base Sepolia");
    expect(base).toContain("<code>0x7ae2…5019</code>");
    expect(box(base)).toEqual({ name: "offered_networks[]", value: "eip155:84532", checked: true, disabled: false, label: "Offer USDC on Base Sepolia" });

    const arbitrum = row(html, "eip155:42161");
    expect(arbitrum).toContain("USDT0 on Arbitrum");
    expect(arbitrum).toContain("<code>0x7ae2…5019</code>");
    expect(box(arbitrum)).toMatchObject({ value: "eip155:42161", checked: true, disabled: false });

    const stellar = row(html, "stellar:testnet");
    expect(stellar).toContain("on Stellar testnet");
    expect(stellar).toContain(`<code>${STELLAR_CREATOR.slice(0, 6)}…${STELLAR_CREATOR.slice(-4)}</code>`);
    expect(box(stellar)).toMatchObject({ value: "stellar:testnet", checked: true, disabled: false });

    expect(html).toContain("Buyers see only the offered ways to pay. Addresses change on <a href=\"/dashboard/wallet\">the wallet page</a>.");
  });

  it("is the only place on the page that names an address: the right-hand box has no 'Paid to'", async () => {
    const html = await render({ payoutAddress: EVM_PAYOUT, stellarPayoutAddress: STELLAR_CREATOR });
    expect(html).not.toContain("Paid to");
    expect(html).not.toContain("Change the address");
    // The EVM address appears once per EVM row (Base, Arbitrum) and nowhere else.
    expect(html.split("0x7ae2…5019").length - 1).toBe(2);
  });

  it("prints a pending 48-hour move under the address it replaces, in every row of that family", async () => {
    const html = block(
      await render(
        { payoutAddress: EVM_PAYOUT, stellarPayoutAddress: STELLAR_CREATOR },
        { pending_payout_address: "0x1111111111111111111111111111111111112222", rebind_effective_at: "2026-10-27T21:00:00.000Z" },
      ),
    );
    expect(row(html, "eip155:84532")).toContain("Moving to 0x1111…2222 on ");
    expect(row(html, "eip155:42161")).toContain("Moving to 0x1111…2222 on ");
    expect(row(html, "stellar:testnet")).not.toContain("Moving to");
  });

  it("ticks only the offered rails when the listing has chosen", async () => {
    const html = block(await render({ payoutAddress: EVM_PAYOUT, stellarPayoutAddress: STELLAR_CREATOR, offeredNetworks: ["stellar:testnet"] }));
    expect(box(row(html, "eip155:84532")).checked).toBe(false);
    expect(box(row(html, "eip155:42161")).checked).toBe(false);
    expect(box(row(html, "stellar:testnet")).checked).toBe(true);
  });

  it("a rail with no wallet of its family is unticked, disabled, and one link to the wallet page", async () => {
    const html = block(await render({ payoutAddress: EVM_PAYOUT }));
    const stellar = row(html, "stellar:testnet");
    expect(stellar).toContain("No Stellar wallet yet");
    expect(stellar).toContain('<a href="/dashboard/wallet">Add on the wallet page</a>');
    expect(box(stellar)).toMatchObject({ value: "stellar:testnet", checked: false, disabled: true });
    // The EVM rows are unaffected.
    expect(box(row(html, "eip155:84532"))).toMatchObject({ checked: true, disabled: false });
  });

  it("says 'No EVM wallet yet' to a Stellar-only creator", async () => {
    const html = block(await render({ payoutAddress: STELLAR_CREATOR }));
    expect(row(html, "eip155:84532")).toContain("No EVM wallet yet");
    expect(box(row(html, "eip155:42161"))).toMatchObject({ checked: false, disabled: true });
    expect(box(row(html, "stellar:testnet"))).toMatchObject({ checked: true, disabled: false });
  });

  it("keeps the public page and agent endpoint addresses where they were", async () => {
    const html = await render({ payoutAddress: EVM_PAYOUT });
    expect(html).toContain("Public page");
    expect(html).toContain("Agent endpoint");
  });
});

describe("WhereYouGetPaid", () => {
  it("renders no Stellar row when the deployment does not run the rail", () => {
    const html = renderToStaticMarkup(
      createElement(WhereYouGetPaid, { rails: [{ network: "eip155:8453", symbol: "USDC", family: "evm", address: EVM_PAYOUT }], offered: null }),
    );
    expect(html).toContain("USDC on Base");
    expect(html).not.toContain("stellar:");
  });
});
