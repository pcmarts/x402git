/**
 * The network switch's two pure rules: an unknown value is mainnet, and the page it
 * returns to is always an admin page on this site.
 */

import { describe, expect, it } from "vitest";
import { networkFrom, safeAdminPath } from "@/lib/admin/network";

describe("networkFrom", () => {
  it("is mainnet unless testnet is asked for exactly", () => {
    expect(networkFrom("testnet")).toBe("testnet");
    expect(networkFrom("mainnet")).toBe("mainnet");
    expect(networkFrom(undefined)).toBe("mainnet");
    expect(networkFrom("TESTNET")).toBe("mainnet");
  });
});

describe("safeAdminPath", () => {
  it("keeps an admin path and its query, from a path or a same-site referer", () => {
    expect(safeAdminPath("/admin/users?scope=everyone&sort=user")).toBe("/admin/users?scope=everyone&sort=user");
    expect(safeAdminPath("http://localhost:3000/admin/money?window=7d")).toBe("/admin/money?window=7d");
    expect(safeAdminPath("/admin")).toBe("/admin");
  });

  it("drops a stale outcome message so it is not shown again", () => {
    expect(safeAdminPath("/admin/users?ok=done&role=buyers")).toBe("/admin/users?role=buyers");
  });

  it("refuses anything that is not an admin page", () => {
    expect(safeAdminPath("/dashboard")).toBe("/admin");
    expect(safeAdminPath("/administrator")).toBe("/admin");
    expect(safeAdminPath("//evil.example/admin")).toBe("/admin");
    expect(safeAdminPath("https://evil.example/phish")).toBe("/admin");
    expect(safeAdminPath("javascript:alert(1)")).toBe("/admin");
    expect(safeAdminPath("")).toBe("/admin");
    expect(safeAdminPath(null)).toBe("/admin");
  });
});
