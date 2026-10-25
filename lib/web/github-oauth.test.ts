import { describe, expect, it } from "vitest";
import { authorizeUrl, handleCandidates, handleFromLogin, installAppUrl, OAUTH_SCOPE, slugFromRepoName } from "./github-oauth";

describe("authorizeUrl", () => {
  it("asks for read:user and nothing else (FR-1)", () => {
    const url = new URL(authorizeUrl({ clientId: "abc", redirectUri: "https://x402git.com/api/auth/github/callback", state: "s" }));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("scope")).toBe("read:user");
    expect(OAUTH_SCOPE).toBe("read:user");
    expect(url.searchParams.get("state")).toBe("s");
    expect(url.searchParams.get("client_id")).toBe("abc");
  });
});

describe("handleFromLogin", () => {
  it("lowercases and keeps a normal login intact (FR-3)", () => {
    expect(handleFromLogin("Adrian")).toBe("adrian");
    expect(handleFromLogin("a-b-1")).toBe("a-b-1");
  });

  it("collapses anything that is not a URL segment", () => {
    expect(handleFromLogin("Ad_rian.x")).toBe("ad-rian-x");
    expect(handleFromLogin("-lead-")).toBe("lead");
  });

  it("stays within the 40-character handle limit", () => {
    expect(handleFromLogin("z".repeat(80))).toHaveLength(40);
  });
});

describe("handleCandidates", () => {
  it("offers the plain login first, then a -gh suffix", () => {
    expect(handleCandidates("adrian").slice(0, 2)).toEqual(["adrian", "adrian-gh"]);
  });

  it("never offers a handle that is a route segment", () => {
    // `/docs` is a real page; a creator holding it would have an unreachable listing.
    expect(handleCandidates("docs")).not.toContain("docs");
    expect(handleCandidates("docs")[0]).toBe("docs-gh");
    expect(handleCandidates("dashboard")).not.toContain("dashboard");
    expect(handleCandidates("api")).not.toContain("api");
  });

  it("keeps every suffixed candidate within 40 characters", () => {
    for (const candidate of handleCandidates("z".repeat(80))) expect(candidate.length).toBeLessThanOrEqual(40);
  });
});

describe("slugFromRepoName", () => {
  it("makes a repository name into a valid slug", () => {
    expect(slugFromRepoName("Humanizer")).toBe("humanizer");
    expect(slugFromRepoName("my_cool.repo")).toBe("my-cool-repo");
  });
});

describe("installAppUrl", () => {
  it("points at the per-repository install page", () => {
    expect(installAppUrl("x402git")).toBe("https://github.com/apps/x402git/installations/new");
  });
});
