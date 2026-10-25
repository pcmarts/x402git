/**
 * The two admin controls. What is worth pinning is mostly refusals — a wrong typed
 * confirmation, a missing reason, an overwrite of a pause already in place, a second
 * retirement — and that every action that does go through leaves an audit row with the
 * login it was given.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changeSwitch, confirmed, reasonOf, takeDownListing } from "@/lib/admin/controls";
import { resetDb, setDb, type Db } from "@/lib/db";
import { resetSwitchCache, SWITCHES, type SwitchRow } from "@/lib/ops/switches";
import { makeMockDb } from "@/lib/test/mock-db";

let mock: ReturnType<typeof makeMockDb>;

const running = (): SwitchRow[] => SWITCHES.map((name) => ({ name, paused: false, reason: null, updated_at: "", updated_by: null }));

afterEach(() => {
  resetDb();
  resetSwitchCache();
});

describe("confirmed and reasonOf", () => {
  it("matches a typed confirmation exactly, ignoring case and surrounding space", () => {
    expect(confirmed("  Payments ", "payments")).toBe(true);
    expect(confirmed("payment", "payments")).toBe(false);
    expect(confirmed(null, "payments")).toBe(false);
  });

  it("refuses a reason too short to be one", () => {
    expect(reasonOf("  ok ")).toBeNull();
    expect(reasonOf("facilitator 5xx")).toBe("facilitator 5xx");
  });
});

describe("changeSwitch", () => {
  beforeEach(() => {
    mock = makeMockDb({ ops_switch: running(), event: [] });
    setDb(mock.client as unknown as Db);
  });

  const base = { name: "payments", action: "pause", reason: "facilitator returning 5xx", confirm: "payments", by: "pcmarts", current: running() };

  it("refuses a switch that does not exist", async () => {
    const r = await changeSwitch({ ...base, name: "everything", confirm: "everything" });
    expect(r.ok).toBe(false);
  });

  it("refuses when the typed name does not match", async () => {
    const r = await changeSwitch({ ...base, confirm: "sweeps" });
    expect(r).toMatchObject({ ok: false, message: "Type payments exactly to confirm." });
    expect(mock.rows("ops_switch").find((s) => s.name === "payments")!.paused).toBe(false);
  });

  it("refuses a pause with no reason", async () => {
    const r = await changeSwitch({ ...base, reason: "" });
    expect(r.ok).toBe(false);
    expect(mock.rows("event")).toHaveLength(0);
  });

  it("refuses to overwrite a pause that is already in place", async () => {
    const current = running().map((s) => (s.name === "payments" ? { ...s, paused: true, reason: "original", updated_by: "someone" } : s));
    const r = await changeSwitch({ ...base, current });
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toContain("already paused");
  });

  it("pauses, stamps the login, and writes an audit row", async () => {
    const r = await changeSwitch(base);
    expect(r.ok).toBe(true);
    const row = mock.rows("ops_switch").find((s) => s.name === "payments")!;
    expect(row).toMatchObject({ paused: true, reason: "facilitator returning 5xx", updated_by: "pcmarts" });
    expect(mock.rows("event")).toEqual([
      expect.objectContaining({ name: "switch_paused", props: { switch: "payments", reason: "facilitator returning 5xx", by: "pcmarts", via: "admin" } }),
    ]);
  });

  it("resumes without a reason and clears the old one", async () => {
    const current = running().map((s) => (s.name === "sweeps" ? { ...s, paused: true, reason: "wallet empty" } : s));
    const r = await changeSwitch({ name: "sweeps", action: "resume", confirm: "sweeps", by: "pcmarts", current });
    expect(r.ok).toBe(true);
    expect(mock.rows("ops_switch").find((s) => s.name === "sweeps")).toMatchObject({ paused: false, reason: null });
    expect(mock.rows("event")[0]).toMatchObject({ name: "switch_resumed" });
  });
});

describe("takeDownListing", () => {
  const listingId = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    mock = makeMockDb({
      creator: [{ id: "c1", handle: "adrian", payout_address: "0xabc" }],
      listing: [{ id: listingId, creator_id: "c1", slug: "skills", published_at: "2026-09-01T00:00:00Z", retired_at: null }],
      event: [],
    });
    setDb(mock.client as unknown as Db);
  });

  it("refuses unless owner/slug is typed", async () => {
    const r = await takeDownListing({ listingId, confirm: "skills", reason: "upheld DMCA notice #1", by: "pcmarts" });
    expect(r).toMatchObject({ ok: false, message: "Type adrian/skills exactly to confirm." });
    expect(mock.rows("listing")[0].retired_at).toBeNull();
  });

  it("refuses without a reason", async () => {
    const r = await takeDownListing({ listingId, confirm: "adrian/skills", reason: "", by: "pcmarts" });
    expect(r.ok).toBe(false);
  });

  it("retires and records takedown_retired with the login, in the script's shape", async () => {
    const r = await takeDownListing({ listingId, confirm: "Adrian/Skills", reason: "upheld DMCA notice #1", by: "pcmarts" });
    expect(r.ok).toBe(true);
    expect(mock.rows("listing")[0].retired_at).toEqual(expect.any(String));
    expect(mock.rows("event")).toEqual([
      expect.objectContaining({
        name: "takedown_retired",
        listing_id: listingId,
        props: { ref: "adrian/skills", reason: "upheld DMCA notice #1", by: "pcmarts", via: "admin" },
      }),
    ]);
  });

  it("refuses a listing that is already retired, without a second audit row", async () => {
    mock.rows("listing")[0].retired_at = "2026-09-10T00:00:00Z";
    const r = await takeDownListing({ listingId, confirm: "adrian/skills", reason: "again", by: "pcmarts" });
    expect(r.ok).toBe(false);
    expect(mock.rows("event")).toHaveLength(0);
  });

  it("answers no such listing for an unknown id", async () => {
    const r = await takeDownListing({ listingId: "22222222-2222-4222-8222-222222222222", confirm: "x/y", reason: "reason", by: "pcmarts" });
    expect(r).toMatchObject({ ok: false, message: "No such listing." });
  });
});
