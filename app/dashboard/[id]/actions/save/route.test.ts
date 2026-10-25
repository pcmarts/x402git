/**
 * POST /dashboard/:id/actions/save — the "Where you get paid" boxes (25 Oct 2026).
 *
 * The rule under test is the mapping, ticked boxes to `offered_networks`: every rail the
 * creator can be paid on ticked is `null` (so the listing follows rails added later),
 * anything less is the list, none ticked is refused in words, and a form that did not
 * show the rows leaves the field out of the PATCH entirely.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreatorRow } from "@/lib/db/types";
import { resetEnv } from "@/lib/env";
import { clearStellarEnv, setStellarTestnetEnv, STELLAR_CREATOR } from "@/lib/test/stellar";

const state = vi.hoisted(() => ({
  creator: null as unknown,
  calls: [] as { method: string; path: string; body: Record<string, unknown> }[],
}));

vi.mock("@/lib/web/dashboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/web/dashboard")>()),
  requireActor: async () => ({ session: {}, creator: state.creator, apiKey: "x4s_live_test" }),
}));
vi.mock("@/lib/web/api-client", () => ({
  creatorApi: async (options: { method: string; path: string; body: Record<string, unknown> }) => {
    state.calls.push(options);
    return { ok: true, status: 200, data: { description: "Strips AI tells.", trigger_hint: "when prose sounds generated" } };
  },
}));

const { POST } = await import("./route");

const LISTING_ID = "22222222-2222-4222-8222-222222222222";
const EVM_PAYOUT = "0x2222222222222222222222222222222222222222";

function creator(overrides: Partial<CreatorRow> = {}): CreatorRow {
  return { id: "c1", handle: "adrian", payout_address: EVM_PAYOUT, stellar_payout_address: STELLAR_CREATOR, ...overrides } as CreatorRow;
}

async function save(ticked: string[] | null, shown = true): Promise<Response> {
  const form = new FormData();
  form.set("price_choice", "9000000");
  form.set("update_choice", "3000000");
  form.set("open_release", "0");
  if (shown) form.set("offered_networks_shown", "1");
  for (const network of ticked ?? []) form.append("offered_networks[]", network);
  const req = new Request(`https://x402git.test/dashboard/${LISTING_ID}/actions/save`, { method: "POST", body: form });
  return await POST(req, { params: Promise.resolve({ id: LISTING_ID }) });
}

function sent(): Record<string, unknown> {
  expect(state.calls).toHaveLength(1);
  return state.calls[0].body;
}

beforeEach(() => {
  state.calls = [];
  state.creator = creator();
  clearStellarEnv();
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
});

describe("POST /dashboard/:id/actions/save — offered_networks", () => {
  it("every payable rail ticked is null, so the listing follows rails added later", async () => {
    const res = await save(["eip155:84532", "eip155:42161", "stellar:testnet"]);
    expect(res.status).toBe(303);
    expect(sent()).toHaveProperty("offered_networks", null);
    expect(new URL(res.headers.get("location")!).searchParams.get("ok")).toMatch(/^Saved\./);
  });

  it("all ticked means every rail the creator can be paid on, not every row: a disabled row does not count", async () => {
    state.creator = creator({ stellar_payout_address: null });
    await save(["eip155:84532", "eip155:42161"]);
    expect(sent()).toHaveProperty("offered_networks", null);
  });

  it("anything less is the list of what was ticked", async () => {
    await save(["eip155:42161", "stellar:testnet"]);
    expect(sent().offered_networks).toEqual(["eip155:42161", "stellar:testnet"]);
  });

  it("none ticked is refused, and nothing is sent", async () => {
    const res = await save([]);
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("Offer at least one way to get paid. Nothing was saved.");
    expect(state.calls).toHaveLength(0);
  });

  it("a form without the rows leaves offered_networks out of the PATCH", async () => {
    await save(null, false);
    expect(sent()).not.toHaveProperty("offered_networks");
    // The rest of the form still saves.
    expect(sent().price_micro).toBe("9000000");
  });

  it("a creator no rail can pay (every box disabled) still saves the price, without the field", async () => {
    clearStellarEnv();
    resetEnv();
    state.creator = creator({ payout_address: STELLAR_CREATOR, stellar_payout_address: null });
    await save([]);
    expect(sent()).not.toHaveProperty("offered_networks");
  });
});
