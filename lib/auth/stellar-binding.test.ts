/**
 * Binding a Stellar payout address (JOURNEYS C2–C5, BUILD W2 tests 6, 7, 8, 9, 11): the
 * Horizon trustline gate, the addition-now / change-in-48h rule, and type-to-confirm.
 */

import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import type { StellarRail } from "@/lib/env";
import { STELLAR_CONTRACT_PAYER } from "@/lib/test/stellar";
import { REBIND_DELAY_HOURS } from "./step-up";
import { confirmsAddress, currentStellarPayoutAddress, inspectStellarPayoutAccount, stellarBindPatch, stellarBindReason, trustlineCopy } from "./stellar-binding";

const G = Keypair.random().publicKey();
const G2 = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const EVM = "0x2222222222222222222222222222222222222222";

/** A testnet rail priced in the mock `tUSDT0` (HACKMERIDIAN-ACCOUNTS), the shape `stellarRail()` returns. */
const rail = {
  family: "stellar",
  network: "stellar:testnet",
  chainId: null,
  asset: { code: "tUSDT0", issuer: ISSUER, contract: "CA5HAM7BFUSFV6HRLNP2HLMZS5F2TTHFA37PWV3ZUXQFREAY3DYKYF72" },
  payTo: Keypair.random().publicKey(),
  passphrase: "Test SDF Network ; September 2015",
  horizonUrl: "https://horizon.test",
  rpcUrl: "https://rpc.test",
  facilitatorUrl: "https://facilitator.test",
  facilitatorApiKey: null,
} as StellarRail;

type Balance = { asset_type: string; asset_code?: string; asset_issuer?: string; is_authorized?: boolean; balance: string };
const native: Balance = { asset_type: "native", balance: "100.0000000" };
const line = (over: Partial<Balance> = {}): Balance => ({ asset_type: "credit_alphanum12", asset_code: "tUSDT0", asset_issuer: ISSUER, is_authorized: true, balance: "0.0000000", ...over });

function horizon(status: number, body?: unknown) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("inspectStellarPayoutAccount (the trustline gate)", () => {
  it("reads /accounts/<G> and returns the meta when an authorised trustline exists", async () => {
    const { fetchImpl, calls } = horizon(200, { balances: [native, line()] });
    const now = new Date("2026-10-25T15:00:00Z");
    const out = await inspectStellarPayoutAccount(G, { fetchImpl, rail, now });
    expect(calls).toEqual([`https://horizon.test/accounts/${G}`]);
    expect(out).toEqual({
      meta: { network: "stellar:testnet", address: G, trustline: { code: "tUSDT0", issuer: ISSUER, authorized: true }, checked_at: now.toISOString() },
      verifiedAt: now.toISOString(),
    });
  });

  it("refuses an account without the trustline, naming the asset and the Freighter steps (finding 18)", async () => {
    const { fetchImpl } = horizon(200, { balances: [native, line({ asset_code: "USDC" })] });
    const err = await inspectStellarPayoutAccount(G, { fetchImpl, rail }).catch((e) => e);
    expect(err).toMatchObject({ code: "invalid_request", status: 400, details: { reason: "no_trustline", asset: { code: "tUSDT0", issuer: ISSUER }, exists: false } });
    expect(err.message).toBe(trustlineCopy(rail.asset));
    expect(err.message).toContain("allow tUSDT0");
    expect(err.message).toContain("Manage assets → Add manually");
    expect(err.message).toContain(`Issuer ${ISSUER}`);
    expect(err.message).toContain("press Refresh");
    expect(stellarBindReason(err)).toBe("no_trustline");
  });

  it("refuses a trustline the issuer has not authorised", async () => {
    const { fetchImpl } = horizon(200, { balances: [native, line({ is_authorized: false })] });
    await expect(inspectStellarPayoutAccount(G, { fetchImpl, rail })).rejects.toMatchObject({ details: { reason: "no_trustline", exists: true, authorized: false } });
  });

  it("treats a trustline Horizon reports without is_authorized as authorised (asset needs no approval)", async () => {
    const { fetchImpl } = horizon(200, { balances: [native, line({ is_authorized: undefined })] });
    await expect(inspectStellarPayoutAccount(G, { fetchImpl, rail })).resolves.toMatchObject({ meta: { trustline: { authorized: true } } });
  });

  it("names a missing account (Horizon 404) as something to fund first", async () => {
    const { fetchImpl } = horizon(404, { status: 404, title: "Resource Missing" });
    const err = await inspectStellarPayoutAccount(G, { fetchImpl, rail }).catch((e) => e);
    expect(err).toMatchObject({ code: "invalid_request", details: { reason: "account_not_found" } });
    expect(err.message).toMatch(/fund it/i);
  });

  it("fails closed with a retry message when Horizon is down or throws", async () => {
    const { fetchImpl } = horizon(504);
    await expect(inspectStellarPayoutAccount(G, { fetchImpl, rail })).rejects.toMatchObject({ code: "internal", details: { reason: "horizon_unavailable", status: 504 } });

    const throwing = vi.fn(async () => {
      throw new Error("timeout");
    }) as unknown as typeof fetch;
    await expect(inspectStellarPayoutAccount(G, { fetchImpl: throwing, rail })).rejects.toMatchObject({ code: "internal", details: { reason: "horizon_unavailable" } });
  });

  it("refuses a contract or muxed address before touching Horizon (test 11)", async () => {
    const { fetchImpl, calls } = horizon(200, { balances: [native, line()] });
    await expect(inspectStellarPayoutAccount(STELLAR_CONTRACT_PAYER, { fetchImpl, rail })).rejects.toMatchObject({ code: "invalid_request", details: { reason: "not_an_account" } });
    await expect(inspectStellarPayoutAccount("M" + G.slice(1) + "AAAAAAAAAAAAAAAA", { fetchImpl, rail })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(inspectStellarPayoutAccount(EVM, { fetchImpl, rail })).rejects.toMatchObject({ code: "invalid_request" });
    expect(calls).toHaveLength(0);
  });

  it("says so when the deployment has no Stellar rail", async () => {
    const { fetchImpl, calls } = horizon(200, {});
    await expect(inspectStellarPayoutAccount(G, { fetchImpl, rail: null })).rejects.toMatchObject({ code: "invalid_request", details: { reason: "stellar_disabled" } });
    expect(calls).toHaveLength(0);
  });
});

describe("stellarBindPatch (addition now, change in 48h)", () => {
  const now = new Date("2026-10-25T15:00:00Z");
  const inspected = { meta: { network: "stellar:testnet", address: G, trustline: { code: "tUSDT0", issuer: ISSUER, authorized: true }, checked_at: now.toISOString() }, verifiedAt: now.toISOString() };

  it("an EVM-only creator adding Stellar is live at once (C3)", () => {
    const out = stellarBindPatch({ payout_address: EVM, stellar_payout_address: null, pending_stellar_payout_address: null }, inspected, now);
    expect(out.applied).toBe("added");
    expect(out.effectiveAt).toBeNull();
    expect(out.patch).toEqual({
      stellar_payout_address: G,
      pending_stellar_payout_address: null,
      stellar_rebind_effective_at: null,
      stellar_payout_meta: inspected.meta,
      stellar_payout_verified_at: now.toISOString(),
    });
  });

  it("a creator who already has a Stellar address gets a queued change, effective in exactly 48 hours (C5)", () => {
    const out = stellarBindPatch({ payout_address: EVM, stellar_payout_address: G2, pending_stellar_payout_address: null }, inspected, now);
    expect(out.applied).toBe("queued");
    expect(out.effectiveAt).toBe(new Date(now.getTime() + REBIND_DELAY_HOURS * 3600 * 1000).toISOString());
    expect(out.patch).toMatchObject({ pending_stellar_payout_address: G, stellar_rebind_effective_at: out.effectiveAt, stellar_payout_meta: inspected.meta });
    // The live address is untouched until the delay passes (lib/payouts/stellar.ts promotes it).
    expect(out.patch).not.toHaveProperty("stellar_payout_address");
  });

  it("a Stellar-only creator (identity is the G…, BUILD H5) changing it is also a 48h change", () => {
    const out = stellarBindPatch({ payout_address: G2, stellar_payout_address: null, pending_stellar_payout_address: null }, inspected, now);
    expect(out.applied).toBe("queued");
    expect(currentStellarPayoutAddress({ payout_address: G2, stellar_payout_address: null })).toBe(G2);
  });

  it("refuses the address already bound, and one already queued", () => {
    expect(() => stellarBindPatch({ payout_address: EVM, stellar_payout_address: G, pending_stellar_payout_address: null }, inspected, now)).toThrow(/already your Stellar payout address/);
    expect(() => stellarBindPatch({ payout_address: EVM, stellar_payout_address: G2, pending_stellar_payout_address: G }, inspected, now)).toThrow(/already queued/);
  });
});

describe("confirmsAddress (type-to-confirm, test 8)", () => {
  it("accepts the whole address or its last six characters, in any case", () => {
    expect(confirmsAddress(G, G)).toBe(true);
    expect(confirmsAddress(G.toLowerCase(), G)).toBe(true);
    expect(confirmsAddress(` ${G.slice(-6).toLowerCase()} `, G)).toBe(true);
  });

  it("refuses one character off, a different length, and nothing", () => {
    const tail = G.slice(-6);
    const off = `${tail.slice(0, 5)}${tail.endsWith("A") ? "B" : "A"}`;
    expect(confirmsAddress(off, G)).toBe(false);
    expect(confirmsAddress(G.slice(-5), G)).toBe(false);
    expect(confirmsAddress(G.slice(-7), G)).toBe(false);
    expect(confirmsAddress("", G)).toBe(false);
    expect(confirmsAddress(undefined, G)).toBe(false);
    expect(confirmsAddress(G2, G)).toBe(false);
  });
});
