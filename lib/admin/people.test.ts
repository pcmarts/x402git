/**
 * The admin roster's policy. The properties worth pinning are all refusals:
 *
 * - the root list cannot be edited from inside the app, in either direction;
 * - nobody can revoke themselves;
 * - an unreadable `admin` table yields *fewer* admins, never more.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeAdminLogins,
  adminRows,
  grantAdmin,
  isRoot,
  normaliseLogin,
  revokeAdmin,
  rootLogins,
  rosterOf,
} from "@/lib/admin/people";
import { resetDb, setDb, type Db } from "@/lib/db";
import type { AdminRow } from "@/lib/db/types";
import { resetEnv } from "@/lib/env";
import { notifyAdmin } from "@/lib/notify";
import { makeMockDb } from "@/lib/test/mock-db";

vi.mock("@/lib/notify", () => ({ notifyAdmin: vi.fn(async () => ({ delivered: true })) }));

function row(over: Partial<AdminRow> = {}): AdminRow {
  return {
    github_login: "someone",
    note: null,
    granted_by: "pcmarts",
    granted_at: "2026-09-01T00:00:00.000Z",
    revoked_at: null,
    revoked_by: null,
    ...over,
  };
}

const setRoots = (v: string | undefined) => {
  if (v === undefined) delete process.env.ADMIN_GITHUB_LOGINS;
  else process.env.ADMIN_GITHUB_LOGINS = v;
  resetEnv();
};

describe("normaliseLogin", () => {
  it("accepts a plain login and lowercases it", () => {
    expect(normaliseLogin("PCMarts")).toBe("pcmarts");
    expect(normaliseLogin("  octocat  ")).toBe("octocat");
  });

  it("accepts the forms somebody actually pastes", () => {
    expect(normaliseLogin("@octocat")).toBe("octocat");
    expect(normaliseLogin("https://github.com/octocat")).toBe("octocat");
    expect(normaliseLogin("https://www.github.com/octocat/")).toBe("octocat");
  });

  it("allows single inner hyphens, which GitHub does", () => {
    expect(normaliseLogin("second-operator")).toBe("second-operator");
    expect(normaliseLogin("a-b-c")).toBe("a-b-c");
  });

  it("refuses what is not a GitHub login", () => {
    expect(normaliseLogin("")).toBeNull();
    expect(normaliseLogin(undefined)).toBeNull();
    expect(normaliseLogin("paul@example.com")).toBeNull();
    expect(normaliseLogin("Paul Martin")).toBeNull();
    expect(normaliseLogin("-leading")).toBeNull();
    expect(normaliseLogin("trailing-")).toBeNull();
    expect(normaliseLogin("double--hyphen")).toBeNull();
    expect(normaliseLogin("a".repeat(40))).toBeNull();
  });

  it("accepts the longest login GitHub allows and refuses one character more", () => {
    expect(normaliseLogin("a".repeat(39))).toBe("a".repeat(39));
    expect(normaliseLogin("a".repeat(40))).toBeNull();
  });
});

describe("rootLogins / isRoot", () => {
  afterEach(() => setRoots(undefined));

  it("is empty when the variable is unset, so this half admits nobody", () => {
    setRoots(undefined);
    expect(rootLogins()).toEqual([]);
    expect(isRoot("pcmarts")).toBe(false);
  });

  it("matches case-insensitively", () => {
    setRoots("PCMarts");
    expect(isRoot("pcmarts")).toBe(true);
    expect(isRoot("PCMARTS")).toBe(true);
    expect(isRoot("someone")).toBe(false);
  });
});

describe("rosterOf", () => {
  it("puts root logins first and marks them", () => {
    const roster = rosterOf([row({ github_login: "granted" })], ["pcmarts"]);
    expect(roster.map((p) => p.login)).toEqual(["pcmarts", "granted"]);
    expect(roster[0].root).toBe(true);
    expect(roster[1].root).toBe(false);
  });

  it("shows a login that is both root and a row exactly once, as root", () => {
    const roster = rosterOf([row({ github_login: "pcmarts" })], ["pcmarts"]);
    expect(roster).toHaveLength(1);
    expect(roster[0].root).toBe(true);
    expect(roster[0].row).not.toBeNull();
  });

  it("sorts revoked rows after live ones", () => {
    const roster = rosterOf(
      [row({ github_login: "gone", revoked_at: "2026-09-02T00:00:00.000Z" }), row({ github_login: "here" })],
      [],
    );
    expect(roster.map((p) => p.login)).toEqual(["here", "gone"]);
    expect(roster[1].live).toBe(false);
  });

  it("treats a root login as live even with no row at all", () => {
    const roster = rosterOf([], ["pcmarts"]);
    expect(roster[0]).toMatchObject({ login: "pcmarts", root: true, live: true, row: null });
  });
});

describe("grant, revoke and the live set", () => {
  let mock: ReturnType<typeof makeMockDb>;

  beforeEach(() => {
    setRoots("pcmarts");
    mock = makeMockDb({ admin: [{ github_login: "pcmarts", granted_by: "migration:20260907000000" }] });
    setDb(mock.client as unknown as Db);
    vi.mocked(notifyAdmin).mockClear();
  });

  afterEach(() => {
    resetDb();
    setRoots(undefined);
  });

  it("unions the root list with unrevoked rows", async () => {
    await grantAdmin("second-operator", "pcmarts", "ops");
    const live = await activeAdminLogins();
    expect([...live].sort()).toEqual(["pcmarts", "second-operator"]);
  });

  it("drops a revoked row from the live set", async () => {
    await grantAdmin("second-operator", "pcmarts", null);
    await revokeAdmin("second-operator", "pcmarts");
    expect([...(await activeAdminLogins())]).toEqual(["pcmarts"]);
  });

  it("keeps the revoked row as the audit record rather than deleting it", async () => {
    await grantAdmin("second-operator", "pcmarts", null);
    await revokeAdmin("second-operator", "pcmarts");

    const rows = await adminRows();
    const gone = rows.find((r) => r.github_login === "second-operator");
    expect(gone).toBeDefined();
    expect(gone?.revoked_at).toBeTruthy();
    expect(gone?.revoked_by).toBe("pcmarts");
  });

  it("records who granted, from the caller and not the form", async () => {
    await grantAdmin("second-operator", "pcmarts", "on call");
    const granted = (await adminRows()).find((r) => r.github_login === "second-operator");
    expect(granted?.granted_by).toBe("pcmarts");
    expect(granted?.note).toBe("on call");
  });

  it("normalises on the way in, so a pasted URL becomes a login", async () => {
    const result = await grantAdmin("https://github.com/Second-Operator", "pcmarts", null);
    expect(result).toEqual({ ok: true, login: "second-operator" });
    expect((await adminRows()).some((r) => r.github_login === "second-operator")).toBe(true);
  });

  it("refuses a grant that is not a GitHub login", async () => {
    const result = await grantAdmin("paul@example.com", "pcmarts", null);
    expect(result.ok).toBe(false);
    expect((await adminRows()).length).toBe(1);
  });

  it("refuses to grant a root login, which is not this table's to give", async () => {
    const result = await grantAdmin("pcmarts", "pcmarts", null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("ADMIN_GITHUB_LOGINS");
  });

  it("refuses to revoke a root login, which is not this table's to take", async () => {
    const result = await revokeAdmin("pcmarts", "someone-else");
    expect(result.ok).toBe(false);
    // Still admitted: the environment is what decides, and it did not change.
    expect((await activeAdminLogins()).has("pcmarts")).toBe(true);
  });

  it("refuses to let anybody revoke themselves", async () => {
    await grantAdmin("second-operator", "pcmarts", null);
    const result = await revokeAdmin("second-operator", "second-operator");
    expect(result.ok).toBe(false);
    expect((await activeAdminLogins()).has("second-operator")).toBe(true);
  });

  it("refuses to re-grant a live admin, so the audit record is never overwritten", async () => {
    await grantAdmin("second-operator", "pcmarts", "on call");
    const again = await grantAdmin("second-operator", "someone-else", "different note");

    expect(again.ok).toBe(false);
    const row = (await adminRows()).find((r) => r.github_login === "second-operator");
    // Who actually let them in, and when, survives the second attempt.
    expect(row?.granted_by).toBe("pcmarts");
    expect(row?.note).toBe("on call");
  });

  it("revokes the granted row of a root login and says the env edit is still needed", async () => {
    // The migration seeds a row for pcmarts and the env also names them: both admit.
    const result = await revokeAdmin("pcmarts", "second-operator");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("still an administrator through ADMIN_GITHUB_LOGINS");

    // The row is gone, but root still admits them — which is the point of root.
    const row = (await adminRows()).find((r) => r.github_login === "pcmarts");
    expect(row?.revoked_at).toBeTruthy();
    expect((await activeAdminLogins()).has("pcmarts")).toBe(true);
  });

  it("re-granting a revoked login restores it and re-stamps who did it", async () => {
    await grantAdmin("second-operator", "pcmarts", null);
    await revokeAdmin("second-operator", "pcmarts");
    const again = await grantAdmin("second-operator", "pcmarts", "back on the team");

    expect(again.ok).toBe(true);
    const restored = (await adminRows()).find((r) => r.github_login === "second-operator");
    expect(restored?.revoked_at).toBeNull();
    expect(restored?.note).toBe("back on the team");
  });

  it("says so rather than throwing when revoking somebody who is not an admin", async () => {
    const result = await revokeAdmin("stranger", "pcmarts");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("not an administrator");
  });

  it("buzzes the phone when the roster changes, naming who did it and to whom", async () => {
    await grantAdmin("second-operator", "pcmarts", "on call");
    expect(notifyAdmin).toHaveBeenCalledWith({
      kind: "admin_action",
      action: "admin_granted",
      by: "pcmarts",
      via: "admin",
      subject: "second-operator",
      reason: "on call",
    });

    await revokeAdmin("second-operator", "pcmarts");
    expect(vi.mocked(notifyAdmin).mock.calls[1][0]).toEqual({
      kind: "admin_action",
      action: "admin_revoked",
      by: "pcmarts",
      via: "admin",
      subject: "second-operator",
      reason: null,
    });
  });

  it("says nothing when nothing changed — a refusal is not an operator action", async () => {
    await grantAdmin("paul@example.com", "pcmarts", null);
    await grantAdmin("pcmarts", "pcmarts", null);
    await revokeAdmin("stranger", "pcmarts");
    await revokeAdmin("second-operator", "second-operator");

    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  it("buzzes for the root login whose granted row was revoked, with the caveat in the reason", async () => {
    // `ok: false`, but a row was written — so the message goes, saying how far it got.
    const result = await revokeAdmin("pcmarts", "second-operator");

    expect(result.ok).toBe(false);
    expect(vi.mocked(notifyAdmin).mock.calls[0][0]).toMatchObject({
      action: "admin_revoked",
      subject: "pcmarts",
      reason: "granted row only — still an administrator through ADMIN_GITHUB_LOGINS",
    });
  });
});

describe("when the admin table cannot be read", () => {
  afterEach(() => {
    resetDb();
    setRoots(undefined);
  });

  /**
   * The property that matters: an unreadable table yields a *smaller* set of admins, not
   * a larger one. This is the opposite of `lib/ops/switches.ts`, which fails open.
   */
  it("falls back to the root list alone rather than admitting nobody or everybody", async () => {
    setRoots("pcmarts");
    const broken = {
      from: () => ({
        select: () => ({ order: () => Promise.resolve({ data: null, error: { message: "relation \"admin\" does not exist" } }) }),
      }),
    };
    setDb(broken as unknown as Db);

    expect(await adminRows()).toEqual([]);
    expect([...(await activeAdminLogins())]).toEqual(["pcmarts"]);
  });

  it("admits nobody when the table is unreadable and no root list is set", async () => {
    setRoots(undefined);
    const broken = {
      from: () => ({ select: () => ({ order: () => Promise.resolve({ data: null, error: { message: "boom" } }) }) }),
    };
    setDb(broken as unknown as Db);

    expect((await activeAdminLogins()).size).toBe(0);
  });
});
