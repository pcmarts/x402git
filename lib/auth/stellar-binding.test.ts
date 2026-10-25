/**
 * Binding a Stellar payout address (JOURNEYS C2–C5, BUILD W2 tests 6, 7, 8, 9, 11): the
 * Horizon trustline gate, the addition-now / change rule (at once by default, queued when
 * `PAYOUT_REBIND_DELAY_HOURS` is set), and
 * which requests open an empty rail (the 25 Oct 2026 one-signature addition).
 */

import { Keypair } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StellarRail } from "@/lib/env";
import { STELLAR_CONTRACT_PAYER } from "@/lib/test/stellar";
import { REBIND_DELAY_HOURS } from "./step-up";
import { currentStellarPayoutAddress, inspectStellarPayoutAccount, railBeingAdded, stellarBindPatch, stellarBindReason, trustlineCopy } from "./stellar-binding";

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

describe("stellarBindPatch (addition now; a change at once, or queued when the deployment runs a delay)", () => {
  const now = new Date("2026-10-25T15:00:00Z");
  afterEach(() => {
    delete process.env.PAYOUT_REBIND_DELAY_HOURS;
  });
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

  it("a creator who already has a Stellar address gets the change at once by default (C5, 25 Oct 2026 23:30)", () => {
    const out = stellarBindPatch({ payout_address: EVM, stellar_payout_address: G2, pending_stellar_payout_address: null }, inspected, now);
    expect(out.applied).toBe("changed");
    expect(out.effectiveAt).toBeNull();
    expect(out.patch).toMatchObject({ stellar_payout_address: G, pending_stellar_payout_address: null, stellar_rebind_effective_at: null, stellar_payout_meta: inspected.meta });
  });

  it("a creator who already has a Stellar address gets a queued change, effective in exactly 48 hours, when the deployment runs the delay (C5)", () => {
    process.env.PAYOUT_REBIND_DELAY_HOURS = "48";
    const out = stellarBindPatch({ payout_address: EVM, stellar_payout_address: G2, pending_stellar_payout_address: null }, inspected, now);
    expect(out.applied).toBe("queued");
    expect(out.effectiveAt).toBe(new Date(now.getTime() + REBIND_DELAY_HOURS * 3600 * 1000).toISOString());
    expect(out.patch).toMatchObject({ pending_stellar_payout_address: G, stellar_rebind_effective_at: out.effectiveAt, stellar_payout_meta: inspected.meta });
    // The live address is untouched until the delay passes (lib/payouts/stellar.ts promotes it).
    expect(out.patch).not.toHaveProperty("stellar_payout_address");
  });

  it("a Stellar-only creator (identity is the G…, BUILD H5) changing it is also queued under the delay", () => {
    process.env.PAYOUT_REBIND_DELAY_HOURS = "48";
    const out = stellarBindPatch({ payout_address: G2, stellar_payout_address: null, pending_stellar_payout_address: null }, inspected, now);
    expect(out.applied).toBe("queued");
    expect(currentStellarPayoutAddress({ payout_address: G2, stellar_payout_address: null })).toBe(G2);
  });

  it("refuses the address already bound, and one already queued", () => {
    expect(() => stellarBindPatch({ payout_address: EVM, stellar_payout_address: G, pending_stellar_payout_address: null }, inspected, now)).toThrow(/already your Stellar payout address/);
    expect(() => stellarBindPatch({ payout_address: EVM, stellar_payout_address: G2, pending_stellar_payout_address: G }, inspected, now)).toThrow(/already queued/);
  });
});


describe("railBeingAdded (25 Oct 2026: an empty rail opens on the new wallet's proof alone)", () => {
  const proof = { nonce: "n", signature: "s" };

  it("is `stellar` for a Stellar address on an EVM account with none (C3)", () => {
    expect(railBeingAdded({ payout_address: EVM, stellar_payout_address: null }, { stellar_payout_address: G })).toBe("stellar");
  });

  it("is null for a Stellar address when one is bound, or when the identity is itself a G… (C5: a change)", () => {
    expect(railBeingAdded({ payout_address: EVM, stellar_payout_address: G2 }, { stellar_payout_address: G })).toBeNull();
    expect(railBeingAdded({ payout_address: G2, stellar_payout_address: null }, { stellar_payout_address: G })).toBeNull();
  });

  it("is `evm` for an EVM address with its own proof on a Stellar-only account (C4)", () => {
    expect(railBeingAdded({ payout_address: G, stellar_payout_address: G }, { payout_address: EVM, payout_proof: proof })).toBe("evm");
  });

  it("is null for the EVM rebind: no proof, or an account already paid at an EVM address", () => {
    expect(railBeingAdded({ payout_address: G, stellar_payout_address: G }, { payout_address: EVM })).toBeNull();
    expect(railBeingAdded({ payout_address: EVM, stellar_payout_address: null }, { payout_address: "0x3333333333333333333333333333333333333333", payout_proof: proof })).toBeNull();
  });

  it("is null when no payout address is in the request", () => {
    expect(railBeingAdded({ payout_address: EVM, stellar_payout_address: null }, {})).toBeNull();
  });
});
