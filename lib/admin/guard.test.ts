/**
 * The admin allow-list, tested as a policy rather than as a request.
 *
 * `requireAdmin` throws Next's `redirect`/`notFound` control-flow errors and reads a
 * cookie, so what is worth pinning here is the predicate it decides on — and the one
 * property that must never regress: **an empty list admits nobody**.
 *
 * How the list is *built* — the root half unioned with the `admin` table, and the
 * fail-safe when the table cannot be read — is `lib/admin/people.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { isAdminLogin, isSameOrigin } from "@/lib/admin/guard";

describe("isSameOrigin", () => {
  const ours = ["https://x402git.com", "https://x402git.com/admin/ops/switch"];

  it("admits our own origin and an absent header", () => {
    expect(isSameOrigin("https://x402git.com", ours)).toBe(true);
    expect(isSameOrigin(null, ours)).toBe(true);
  });

  it("refuses another site, a lookalike, and an opaque origin", () => {
    expect(isSameOrigin("https://evil.example", ours)).toBe(false);
    expect(isSameOrigin("https://x402git.com.evil.example", ours)).toBe(false);
    expect(isSameOrigin("null", ours)).toBe(false);
  });
});
import { adminGithubLogins, resetEnv } from "@/lib/env";

describe("isAdminLogin", () => {
  it("admits a login on the list", () => {
    expect(isAdminLogin("root-operator", ["root-operator"])).toBe(true);
  });

  it("matches case-insensitively, because GitHub does", () => {
    expect(isAdminLogin("Root-Operator", ["root-operator"])).toBe(true);
    expect(isAdminLogin("root-operator", ["Root-Operator"])).toBe(true);
  });

  it("tolerates whitespace from a comma-separated env var", () => {
    expect(isAdminLogin("root-operator", [" root-operator "])).toBe(true);
    expect(isAdminLogin(" root-operator ", ["root-operator"])).toBe(true);
  });

  it("refuses a login that is not on the list", () => {
    expect(isAdminLogin("someone-else", ["root-operator"])).toBe(false);
  });

  it("refuses everybody when the list is empty — this gate fails closed", () => {
    expect(isAdminLogin("root-operator", [])).toBe(false);
  });

  it("accepts a Set, which is what activeAdminLogins returns", () => {
    expect(isAdminLogin("root-operator", new Set(["root-operator"]))).toBe(true);
    expect(isAdminLogin("stranger", new Set(["root-operator"]))).toBe(false);
  });

  it("refuses an absent or blank login, so an empty list entry can never match one", () => {
    expect(isAdminLogin(undefined, ["root-operator"])).toBe(false);
    expect(isAdminLogin(null, [""])).toBe(false);
    expect(isAdminLogin("", [""])).toBe(false);
    expect(isAdminLogin("   ", ["", "root-operator"])).toBe(false);
  });

  it("does not match a prefix or a substring", () => {
    expect(isAdminLogin("root-operato", ["root-operator"])).toBe(false);
    expect(isAdminLogin("root-operatorx", ["root-operator"])).toBe(false);
  });
});

describe("adminGithubLogins — the root half", () => {
  it("is empty when the variable is unset", () => {
    delete process.env.ADMIN_GITHUB_LOGINS;
    resetEnv();
    expect(adminGithubLogins()).toEqual([]);
  });

  it("is empty when the variable is blank or only separators", () => {
    process.env.ADMIN_GITHUB_LOGINS = " , ,";
    resetEnv();
    expect(adminGithubLogins()).toEqual([]);
    delete process.env.ADMIN_GITHUB_LOGINS;
    resetEnv();
  });

  it("splits, trims and lowercases a list", () => {
    process.env.ADMIN_GITHUB_LOGINS = "Root-Operator, second-operator ";
    resetEnv();
    expect(adminGithubLogins()).toEqual(["root-operator", "second-operator"]);
    delete process.env.ADMIN_GITHUB_LOGINS;
    resetEnv();
  });
});
