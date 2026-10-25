/**
 * The audit trail: script rows and click rows in one timeline, grant rows merged from
 * the `admin` table, and `by` / `via` lifted out of the detail rather than repeated in it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { entriesFromAdminRows, entryFromEvent, loadAudit, recordAdminAction, sortAudit } from "@/lib/admin/audit";
import { resetDb, setDb, type Db } from "@/lib/db";
import { notifyAdmin } from "@/lib/notify";
import { makeMockDb } from "@/lib/test/mock-db";

vi.mock("@/lib/notify", () => ({ notifyAdmin: vi.fn(async () => ({ delivered: true })) }));

beforeEach(() => vi.mocked(notifyAdmin).mockClear());

afterEach(() => {
  resetDb();
  vi.restoreAllMocks();
});

describe("entryFromEvent", () => {
  it("lifts by, via and the subject out of props", () => {
    const e = entryFromEvent({
      name: "switch_paused",
      at: "2026-09-13T03:00:00Z",
      listing_id: null,
      props: { switch: "payments", reason: "facilitator 5xx", by: "pcmarts", via: "admin" },
    });
    expect(e).toEqual({
      at: "2026-09-13T03:00:00Z",
      action: "switch_paused",
      by: "pcmarts",
      via: "admin",
      listingId: null,
      subject: "payments",
      detail: "reason=facilitator 5xx",
    });
  });

  it("reads a script's takedown row as a script row", () => {
    const e = entryFromEvent({ name: "takedown_retired", at: "2026-09-13T03:00:00Z", listing_id: "l1", props: { reason: "notice", by: "paul", ref: "a/b" } });
    expect(e).toMatchObject({ via: "script", by: "paul", subject: "a/b", listingId: "l1" });
  });
});

describe("recordAdminAction", () => {
  it("writes the row and buzzes the phone with the switch as the subject", async () => {
    const mock = makeMockDb({ event: [] });
    setDb(mock.client as unknown as Db);

    expect(await recordAdminAction({ name: "switch_paused", by: "pcmarts", props: { switch: "payments", reason: "facilitator 5xx" } })).toBeNull();

    expect(mock.rows("event")).toHaveLength(1);
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(notifyAdmin).toHaveBeenCalledWith({
      kind: "admin_action",
      action: "switch_paused",
      by: "pcmarts",
      via: "admin",
      subject: "payments",
      reason: "facilitator 5xx",
      listingId: null,
      auditError: null,
    });
  });

  it("uses the owner/slug ref as the subject on a takedown, and carries the listing", async () => {
    const mock = makeMockDb({ event: [] });
    setDb(mock.client as unknown as Db);

    await recordAdminAction({ name: "takedown_retired", by: "pcmarts", listingId: "l1", props: { ref: "acme/widgets", reason: "upheld notice" } });

    expect(notifyAdmin).toHaveBeenCalledWith({
      kind: "admin_action",
      action: "takedown_retired",
      by: "pcmarts",
      via: "admin",
      subject: "acme/widgets",
      reason: "upheld notice",
      listingId: "l1",
      auditError: null,
    });
  });

  it("still buzzes when the insert failed, carrying the error — the phone is then the record", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setDb({
      from() {
        throw new Error("database is down");
      },
    } as unknown as Db);

    expect(await recordAdminAction({ name: "switch_resumed", by: "pcmarts", props: { switch: "sweeps" } })).toBe("database is down");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyAdmin).mock.calls[0][0]).toMatchObject({ action: "switch_resumed", subject: "sweeps", reason: null, auditError: "database is down" });
  });

  it("reads props defensively — a missing or non-string subject is a dash, not a crash", async () => {
    const mock = makeMockDb({ event: [] });
    setDb(mock.client as unknown as Db);

    await recordAdminAction({ name: "takedown_revoked", by: "pcmarts", props: { ref: 7 as unknown as string } });

    expect(vi.mocked(notifyAdmin).mock.calls[0][0]).toMatchObject({ subject: "—", reason: null });
  });
});

describe("entriesFromAdminRows", () => {
  it("makes one entry per grant and a second per revoke", () => {
    const out = entriesFromAdminRows([
      { github_login: "a", note: null, granted_by: "pcmarts", granted_at: "2026-09-01T00:00:00Z", revoked_at: null, revoked_by: null },
      { github_login: "b", note: "contractor", granted_by: "pcmarts", granted_at: "2026-09-02T00:00:00Z", revoked_at: "2026-09-03T00:00:00Z", revoked_by: "pcmarts" },
    ]);
    expect(out.map((e) => `${e.action}:${e.subject}`)).toEqual(["admin_granted:a", "admin_granted:b", "admin_revoked:b"]);
  });
});

describe("sortAudit", () => {
  it("puts newest first and unparseable dates last", () => {
    const mk = (at: string) => ({ at, action: "x", by: null, via: "admin" as const, listingId: null, subject: null, detail: "" });
    expect(sortAudit([mk("garbage"), mk("2026-09-01T00:00:00Z"), mk("2026-09-02T00:00:00Z")]).map((e) => e.at)).toEqual([
      "2026-09-02T00:00:00Z",
      "2026-09-01T00:00:00Z",
      "garbage",
    ]);
  });
});

describe("loadAudit", () => {
  it("reads only operator events and merges the admin table", async () => {
    const mock = makeMockDb({
      event: [
        { id: 1, name: "settled", at: "2026-09-13T00:00:00Z", listing_id: "l1", props: {} },
        { id: 2, name: "switch_paused", at: "2026-09-12T00:00:00Z", listing_id: null, props: { switch: "sweeps", by: "pcmarts", via: "admin" } },
      ],
      admin: [{ github_login: "pcmarts", note: null, granted_by: "migration", granted_at: "2026-09-07T00:00:00Z", revoked_at: null, revoked_by: null }],
    });
    setDb(mock.client as unknown as Db);
    const { entries, truncated } = await loadAudit();
    expect(truncated).toBe(false);
    expect(entries.map((e) => e.action)).toEqual(["switch_paused", "admin_granted"]);
  });
});
