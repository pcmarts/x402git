/**
 * The §19 kill switches. Two behaviours carry real weight — that a switch which cannot
 * be read is off, and that a switch which is on is seen quickly — so both are tested
 * directly rather than through a route.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, setDb } from "@/lib/db";
import { makeMockDb } from "@/lib/test/mock-db";
import { allSwitches, isPaused, pausedSwitches, resetSwitchCache, setSwitch, SWITCHES } from "./switches";

let mock: ReturnType<typeof makeMockDb>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  resetSwitchCache();
});

afterEach(() => {
  resetSwitchCache();
  vi.restoreAllMocks();
});

const seed = (rows: { name: string; paused: boolean }[]) => mock.seed("ops_switch", rows);

describe("kill switches", () => {
  it("reads nothing as paused when no row exists", async () => {
    for (const name of SWITCHES) expect(await isPaused(name)).toBe(false);
  });

  it("sees a paused switch, and only that one", async () => {
    seed([
      { name: "payments", paused: true },
      { name: "sweeps", paused: false },
    ]);
    expect(await isPaused("payments")).toBe(true);
    resetSwitchCache();
    expect(await isPaused("sweeps")).toBe(false);
  });

  /**
   * The decision this module exists to get right. A table that cannot be read must not
   * be able to stop commerce: the switch is a way to halt deliberately, never a new
   * dependency that halts by accident.
   */
  it("fails open when the table cannot be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setDb({
      from() {
        throw new Error("relation \"ops_switch\" does not exist");
      },
    } as unknown as Db);

    expect(await isPaused("payments")).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("caches for ten seconds, then re-reads", async () => {
    seed([{ name: "payments", paused: true }]);
    const t0 = 1_000_000;
    expect(await isPaused("payments", t0)).toBe(true);

    // Flip it underneath the cache: still paused inside the window.
    mock.tables.ops_switch[0].paused = false;
    expect(await isPaused("payments", t0 + 9_000)).toBe(true);

    // Past the window it tells the truth again.
    expect(await isPaused("payments", t0 + 11_000)).toBe(false);
  });

  it("does not hold a stale read across an explicit reset", async () => {
    seed([{ name: "payments", paused: false }]);
    expect(await isPaused("payments")).toBe(false);
    mock.tables.ops_switch[0].paused = true;
    resetSwitchCache();
    expect(await isPaused("payments")).toBe(true);
  });

  it("returns only the paused names, not every row", async () => {
    seed([
      { name: "payments", paused: true },
      { name: "sweeps", paused: true },
      { name: "publishing", paused: false },
    ]);
    expect([...(await pausedSwitches())].sort()).toEqual(["payments", "sweeps"]);
  });

  it("lists every switch for an operator, paused or not", async () => {
    seed(SWITCHES.map((name) => ({ name, paused: false })));
    expect((await allSwitches()).map((r) => r.name).sort()).toEqual([...SWITCHES].sort());
  });

  it("writes a flip and drops the cache so the next read is the new value", async () => {
    seed([{ name: "payments", paused: false }]);
    expect(await isPaused("payments")).toBe(false);
    const row = await setSwitch("payments", true, "settlement incident", "paul");
    expect(row.paused).toBe(true);
    expect(row.reason).toBe("settlement incident");
    // No resetSwitchCache() here on purpose: setSwitch must do it itself.
    expect(await isPaused("payments")).toBe(true);
  });
});
