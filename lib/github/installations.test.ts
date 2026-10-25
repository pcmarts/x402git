/**
 * Rail A's ownership checks, against a fake Octokit. AUTH-2 (RED-TEAM-2026-09-21): an
 * org installation proves membership and nothing more, so selling a repo needs the
 * creator's own `admin` or `maintain` role on that repo, read live from GitHub — and
 * every way that read can go wrong has to answer "no".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const app = vi.hoisted(() => ({
  request: vi.fn(),
  installationRequest: vi.fn(),
  installationOctokit: vi.fn(),
}));

vi.mock("@/lib/github/app", () => ({
  githubApp: () => ({ octokit: { request: app.request } }),
  installationOctokit: app.installationOctokit,
}));

const { REPO_ROLE_REQUIRED, SELLING_ROLES, roleCanSell, userCanSellRepo, userOwnsInstallation } = await import("./installations");

const PERMISSION = "GET /repos/{owner}/{repo}/collaborators/{username}/permission";
const REPO = { owner: "acme", name: "secret-sauce" };

/** GitHub's answer for a user holding `role_name` (and the legacy `permission` it folds into). */
function role(roleName: string, permission: string) {
  return { permission, role_name: roleName, user: { login: "member" } };
}

function githubAnswers(permission: () => unknown) {
  app.installationRequest.mockImplementation(async (route: string) => {
    if (route === PERMISSION) return { data: permission() };
    if (route === "GET /user/{account_id}") return { data: { login: "member" } };
    if (route === "GET /orgs/{org}/memberships/{username}") return { data: { state: "active" } };
    throw Object.assign(new Error(`unexpected route ${route}`), { status: 404 });
  });
}

beforeEach(() => {
  app.request.mockImplementation(async (route: string) => {
    if (route === "GET /user/{account_id}") return { data: { login: "member" } };
    throw Object.assign(new Error(`unexpected route ${route}`), { status: 404 });
  });
  app.installationOctokit.mockImplementation(async () => ({ request: app.installationRequest }));
});

afterEach(() => vi.clearAllMocks());

describe("userCanSellRepo (AUTH-2)", () => {
  it("passes an admin", async () => {
    githubAnswers(() => role("admin", "admin"));
    expect(await userCanSellRepo(42, 1234, REPO)).toBe(true);
  });

  it("passes a maintainer, whose legacy `permission` reads `write`", async () => {
    githubAnswers(() => role("maintain", "write"));
    expect(await userCanSellRepo(42, 1234, REPO)).toBe(true);
  });

  it("refuses a writer: pushing code is not permission to sell it", async () => {
    githubAnswers(() => role("write", "write"));
    expect(await userCanSellRepo(42, 1234, REPO)).toBe(false);
  });

  it("refuses triage, read and none", async () => {
    githubAnswers(() => role("triage", "read"));
    expect(await userCanSellRepo(42, 1234, REPO)).toBe(false);
    githubAnswers(() => role("read", "read"));
    expect(await userCanSellRepo(42, 1234, REPO)).toBe(false);
    githubAnswers(() => ({ permission: "none", role_name: "none", user: null }));
    expect(await userCanSellRepo(42, 1234, REPO)).toBe(false);
  });

  it("refuses when GitHub answers 404 (a repo the installation cannot see, or a non-collaborator)", async () => {
    githubAnswers(() => {
      throw Object.assign(new Error("Not Found"), { status: 404 });
    });
    expect(await userCanSellRepo(42, 1234, REPO)).toBe(false);
  });

  it("fails closed on a network error", async () => {
    githubAnswers(() => {
      throw new TypeError("fetch failed");
    });
    expect(await userCanSellRepo(42, 1234, REPO)).toBe(false);
  });

  it("fails closed when the installation token cannot be minted", async () => {
    app.installationOctokit.mockRejectedValue(new Error("installation suspended"));
    expect(await userCanSellRepo(42, 1234, REPO)).toBe(false);
  });

  it("fails closed when the stored user id no longer resolves to a login", async () => {
    app.installationRequest.mockImplementation(async (route: string) => {
      if (route === "GET /user/{account_id}") throw Object.assign(new Error("Not Found"), { status: 404 });
      return { data: role("admin", "admin") };
    });
    expect(await userCanSellRepo(42, 1234, REPO)).toBe(false);

    app.installationRequest.mockImplementation(async (route: string) => ({ data: route === "GET /user/{account_id}" ? {} : role("admin", "admin") }));
    expect(await userCanSellRepo(42, 1234, REPO)).toBe(false);
    expect(app.installationRequest).not.toHaveBeenCalledWith(PERMISSION, expect.anything());
  });

  it("never asks the App JWT for the login: auth-app refuses non-App routes without an installation", async () => {
    githubAnswers(() => role("admin", "admin"));
    expect(await userCanSellRepo(42, 1234, REPO)).toBe(true);
    expect(app.request).not.toHaveBeenCalled();
  });

  it("refuses an empty owner or name without asking GitHub", async () => {
    githubAnswers(() => role("admin", "admin"));
    expect(await userCanSellRepo(42, 1234, { owner: "", name: "secret-sauce" })).toBe(false);
    expect(await userCanSellRepo(42, 1234, { owner: "acme", name: "" })).toBe(false);
    expect(app.installationRequest).not.toHaveBeenCalled();
  });

  it("asks about the current login, on the one repo, through the installation's own token", async () => {
    githubAnswers(() => role("admin", "admin"));
    await userCanSellRepo(42, 1234, REPO);

    expect(app.installationRequest).toHaveBeenCalledWith("GET /user/{account_id}", { account_id: 1234 });
    expect(app.installationOctokit).toHaveBeenCalledWith(42);
    expect(app.installationRequest).toHaveBeenCalledWith(PERMISSION, { owner: "acme", repo: "secret-sauce", username: "member" });
  });
});

describe("roleCanSell", () => {
  it("reads `role_name` first, because `permission` folds maintain into write", () => {
    expect(roleCanSell({ roleName: "maintain", permission: "write" })).toBe(true);
    expect(roleCanSell({ roleName: "write", permission: "write" })).toBe(false);
  });

  it("refuses a custom role built on maintain: its name is its own and its base reads write", () => {
    expect(roleCanSell({ roleName: "release-manager", permission: "write" })).toBe(false);
  });

  it("accepts a bare legacy admin and refuses an empty answer", () => {
    expect(roleCanSell({ roleName: null, permission: "admin" })).toBe(true);
    expect(roleCanSell({ roleName: null, permission: null })).toBe(false);
  });

  it("names the required roles in the one refusal message", () => {
    expect([...SELLING_ROLES]).toEqual(["admin", "maintain"]);
    expect(REPO_ROLE_REQUIRED).toContain("admin or maintain");
  });
});

describe("userOwnsInstallation", () => {
  const org = { installationId: 42, accountId: 99, accountLogin: "acme", accountType: "Organization" };

  it("decides a user installation on id equality", async () => {
    const user = { installationId: 42, accountId: 1234, accountLogin: "member", accountType: "User" };
    expect(await userOwnsInstallation(1234, user)).toBe(true);
    expect(await userOwnsInstallation(5678, user)).toBe(false);
  });

  it("decides an org installation on active membership, and fails closed", async () => {
    githubAnswers(() => role("read", "read"));
    expect(await userOwnsInstallation(1234, org)).toBe(true);

    app.installationRequest.mockRejectedValue(new TypeError("fetch failed"));
    expect(await userOwnsInstallation(1234, org)).toBe(false);
  });
});
