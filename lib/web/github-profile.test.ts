/**
 * The repository and the person, as GitHub reports them — and what happens when it
 * does not.
 *
 * These fields are decoration over a manifest. The failure they must never cause is a
 * 500 on the one page the whole product hypothesis rests on, so the interesting tests
 * here are the sparse profile and the thrown request, not the happy path.
 *
 * The octokit is a plain object: `OctokitLike` is structural, and nothing in this suite
 * touches the network.
 */

import { describe, expect, it } from "vitest";
import type { ListingRow } from "@/lib/db/types";
import type { ManifestOutput } from "@/lib/schemas";
import {
  type OctokitLike,
  displayUrl,
  fetchOwnerProfile,
  fetchOwnerProfileById,
  fetchRepoProfile,
  listingProfile,
  ownerLoginOf,
  ownerProfileById,
  repoProfile,
  webUrl,
} from "./github-profile";

/** A public repository with every field GitHub can send. */
const FULL_REPO = {
  id: 987_654,
  name: "humanizer",
  full_name: "adrian/humanizer",
  private: false,
  description: "Rewrites machine prose.",
  homepage: "https://humanizer.dev",
  topics: ["llm", "writing", "cli"],
  language: "Python",
  default_branch: "main",
  size: 4_096,
  created_at: "2023-04-01T09:00:00Z",
  pushed_at: "2026-08-20T09:00:00Z",
  license: { spdx_id: "MIT", key: "mit" },
  open_issues_count: 7,
  stargazers_count: 412,
  forks_count: 33,
  subscribers_count: 21,
  archived: false,
  html_url: "https://github.com/adrian/humanizer",
};

const FULL_USER = {
  login: "adrian",
  name: "Adrian Vance",
  avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
  bio: "Building tools for people who write.",
  blog: "adrian.dev",
  company: "@somewhere",
  location: "Lisbon",
  twitter_username: "adrianvance",
  followers: 1_240,
  public_repos: 42,
  created_at: "2016-02-11T00:00:00Z",
  html_url: "https://github.com/adrian",
};

function octokit(answers: Record<string, unknown>): OctokitLike {
  return {
    async request(route: string) {
      if (!(route in answers)) throw new Error(`404 ${route}`);
      const data = answers[route];
      if (data instanceof Error) throw data;
      return { data };
    },
  };
}

const REPO_ROUTE = "GET /repositories/{repository_id}";
const USER_ROUTE = "GET /users/{username}";
const USER_BY_ID_ROUTE = "GET /user/{account_id}";

describe("fetchRepoProfile", () => {
  it("narrows a full public repository, counts and all", async () => {
    const repo = await fetchRepoProfile(octokit({ [REPO_ROUTE]: FULL_REPO }), 987_654);

    expect(repo).toMatchObject({
      repo_id: 987_654,
      full_name: "adrian/humanizer",
      description: "Rewrites machine prose.",
      homepage: "https://humanizer.dev/",
      topics: ["llm", "writing", "cli"],
      language: "Python",
      licence_spdx: "MIT",
      stars: 412,
      forks: 33,
      watchers: 21,
      open_issues: 7,
      private: false,
      html_url: "https://github.com/adrian/humanizer",
    });
  });

  it("hides a private repository's link and its zeroes", async () => {
    const repo = await fetchRepoProfile(
      octokit({
        [REPO_ROUTE]: {
          id: 1,
          name: "secret",
          full_name: "adrian/secret",
          private: true,
          html_url: "https://github.com/adrian/secret",
          stargazers_count: 0,
          forks_count: 0,
          subscribers_count: 0,
          open_issues_count: 0,
        },
      }),
      1,
    );

    // A private repo has zero stars because nobody can see it, not because nobody
    // liked it. A zero here is not a fact, so it is not printed.
    expect(repo?.stars).toBeNull();
    expect(repo?.forks).toBeNull();
    expect(repo?.watchers).toBeNull();
    expect(repo?.open_issues).toBeNull();
    expect(repo?.private).toBe(true);
    expect(repo?.html_url).toBeNull();
  });

  it("survives a sparse repository — nulls, not undefined fields", async () => {
    const repo = await fetchRepoProfile(octokit({ [REPO_ROUTE]: { id: 2, name: "bare", full_name: "adrian/bare" } }), 2);

    expect(repo).toMatchObject({ name: "bare", description: null, homepage: null, language: null, topics: [] });
    expect(repo?.licence_spdx).toBeNull();
  });

  it("drops NOASSERTION rather than printing it as a licence", async () => {
    const repo = await fetchRepoProfile(octokit({ [REPO_ROUTE]: { id: 3, name: "x", license: { spdx_id: "NOASSERTION" } } }), 3);
    expect(repo?.licence_spdx).toBeNull();
  });

  it("promotes a bare hostname to https and refuses a javascript: url", async () => {
    const promoted = await fetchRepoProfile(octokit({ [REPO_ROUTE]: { id: 4, name: "x", homepage: "example.com/docs" } }), 4);
    expect(promoted?.homepage).toBe("https://example.com/docs");

    const hostile = await fetchRepoProfile(octokit({ [REPO_ROUTE]: { id: 5, name: "x", homepage: "javascript:alert(1)" } }), 5);
    expect(hostile?.homepage).toBeNull();
  });
});

describe("fetchOwnerProfile", () => {
  it("narrows a full profile", async () => {
    const owner = await fetchOwnerProfile(octokit({ [USER_ROUTE]: FULL_USER }), "adrian");

    expect(owner).toMatchObject({
      login: "adrian",
      name: "Adrian Vance",
      bio: "Building tools for people who write.",
      blog: "https://adrian.dev/",
      company: "@somewhere",
      location: "Lisbon",
      twitter_username: "adrianvance",
      followers: 1_240,
      public_repos: 42,
      html_url: "https://github.com/adrian",
    });
  });

  it("survives a sparse profile and still knows the login", async () => {
    const owner = await fetchOwnerProfile(octokit({ [USER_ROUTE]: { login: "ghost" } }), "ghost");

    expect(owner?.login).toBe("ghost");
    expect(owner?.name).toBeNull();
    expect(owner?.bio).toBeNull();
    expect(owner?.followers).toBeNull();
    // A profile with no `html_url` still has a page; the login is the address.
    expect(owner?.html_url).toBe("https://github.com/ghost");
  });
});

describe("fetchOwnerProfileById", () => {
  it("resolves a stored id back to a login and a profile link", async () => {
    const owner = await fetchOwnerProfileById(octokit({ [USER_BY_ID_ROUTE]: FULL_USER }), "1");

    expect(owner).toMatchObject({ login: "adrian", name: "Adrian Vance", html_url: "https://github.com/adrian" });
  });

  it("returns null when GitHub sends no login, since there is no page to link", async () => {
    expect(await fetchOwnerProfileById(octokit({ [USER_BY_ID_ROUTE]: { id: 1 } }), 1)).toBeNull();
  });
});

describe("never breaking the page", () => {
  const listing = { installation_id: "42", hosted_org: null, github_repo_id: "987654", source: "github" as const };

  it("returns null when the listing has no repository id", async () => {
    expect(await repoProfile({ ...listing, github_repo_id: null })).toBeNull();
  });

  it("returns null when the listing has no installation to read through", async () => {
    expect(await repoProfile({ ...listing, installation_id: null, hosted_org: null })).toBeNull();
  });

  it("returns null rather than throwing when GitHub refuses", async () => {
    // No `GITHUB_APP_ID` in this process, so minting an installation client throws
    // inside `repoProfile` — which is exactly the failure the page must survive.
    expect(await repoProfile(listing)).toBeNull();
  });

  it("returns null for an id lookup when GitHub cannot be reached, or the id is not one", async () => {
    expect(await ownerProfileById("329895054")).toBeNull();
    expect(await ownerProfileById("adrian")).toBeNull();
  });

  it("throws only from the raw fetch, which is why the wrapper catches", async () => {
    await expect(fetchRepoProfile(octokit({ [REPO_ROUTE]: new Error("rate limited") }), 1)).rejects.toThrow("rate limited");
  });
});

describe("listingProfile — live first, the manifest's copy second", () => {
  const stored = {
    computed: {
      repo_meta: { full_name: "adrian/humanizer", homepage: "https://humanizer.dev/", topics: ["llm"], private: true, html_url: null },
      owner: { login: "adrian", name: "Adrian Vance", followers: 1_240 },
    },
  } as unknown as ManifestOutput;

  it("falls back to what the analyser persisted when GitHub cannot be reached", async () => {
    const listing = { installation_id: null, hosted_org: null, github_repo_id: null, source: "github" } as Pick<
      ListingRow,
      "installation_id" | "hosted_org" | "github_repo_id" | "source"
    >;

    const profile = await listingProfile(listing, stored);

    expect(profile.repo?.full_name).toBe("adrian/humanizer");
    expect(profile.owner?.name).toBe("Adrian Vance");
  });

  it("is two nulls when there is neither a live reading nor a stored one", async () => {
    const listing = { installation_id: null, hosted_org: null, github_repo_id: null, source: "github" } as Pick<
      ListingRow,
      "installation_id" | "hosted_org" | "github_repo_id" | "source"
    >;

    expect(await listingProfile(listing, null)).toEqual({ repo: null, owner: null, stats: null });
  });

  it("shows no GitHub person for a Rail B listing — the repo's owner is the platform", async () => {
    const listing = { installation_id: null, hosted_org: "x402git-hosted-01", github_repo_id: null, source: "hosted" } as Pick<
      ListingRow,
      "installation_id" | "hosted_org" | "github_repo_id" | "source"
    >;

    const profile = await listingProfile(listing, stored);
    expect(profile.owner).toBeNull();
  });
});

describe("url helpers", () => {
  it("finds the owner login in a full name", () => {
    expect(ownerLoginOf({ full_name: "adrian/humanizer" })).toBe("adrian");
    expect(ownerLoginOf({ full_name: "humanizer" })).toBeNull();
    expect(ownerLoginOf(null)).toBeNull();
  });

  it("reads a url as a place, not as a protocol", () => {
    expect(displayUrl("https://www.humanizer.dev/docs/?x=1")).toBe("humanizer.dev/docs");
    expect(displayUrl("https://humanizer.dev/")).toBe("humanizer.dev");
  });

  it("refuses anything that is not http(s) and anything without a dot", () => {
    expect(webUrl("data:text/html,hi")).toBeNull();
    expect(webUrl("localhost")).toBeNull();
    expect(webUrl("   ")).toBeNull();
    expect(webUrl(42)).toBeNull();
  });
});
