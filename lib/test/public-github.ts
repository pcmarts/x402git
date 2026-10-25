/**
 * lib/test/public-github.ts — a stand-in for `lib/github/public.ts`.
 *
 * The open-release checks ask GitHub about a repository the platform has no credentials
 * for, and a unit test must never do that. This is the reader with a tiny in-memory
 * GitHub behind it: which repositories exist and whether they are public, which commits
 * each holds, what licence each reads as, which tag points at which commit. Install it
 * with `setPublicGithub(stub)` and take it down with `setPublicGithub(null)`.
 *
 *   const github = stubPublicGithub({
 *     repos: { "octo/widget": { private: false } },
 *     commits: { "octo/widget": [COMMIT] },
 *     licences: { "octo/widget": "MIT" },
 *   });
 *   setPublicGithub(github);
 *
 * `fail` makes every call throw `GithubUnreachable`, for the "could not look" paths.
 * `calls` records every question asked, so a test can assert that a release whose date
 * has not passed cost nothing.
 */

import { GithubUnreachable, type PublicGithub } from "@/lib/github/public";

export type StubGithubState = {
  /** `"owner/name"` → visibility. A repo not listed here is a 404. */
  repos: Record<string, { private?: boolean; default_branch?: string }>;
  /** `"owner/name"` → the commit shas reachable in it. */
  commits: Record<string, string[]>;
  /** `"owner/name"` → GitHub's `spdx_id`, or null for no licence file. */
  licences: Record<string, string | null>;
  /** `"owner/name"` → sha → tag name. */
  tags: Record<string, Record<string, string>>;
  /** Throw on every call. */
  fail: boolean;
};

export type StubGithub = PublicGithub & StubGithubState & { calls: string[] };

export function stubPublicGithub(input: Partial<StubGithubState> = {}): StubGithub {
  const state: StubGithubState = {
    repos: input.repos ?? {},
    commits: input.commits ?? {},
    licences: input.licences ?? {},
    tags: input.tags ?? {},
    fail: input.fail ?? false,
  };
  const calls: string[] = [];

  // Reads `stub.fail`, not `state.fail`: a boolean is copied into the spread below, and a
  // test that flips `github.fail` mid-way expects the flip to take.
  function ask(what: string): void {
    calls.push(what);
    if (stub.fail) throw new GithubUnreachable(`https://api.github.com/${what}`, 503, "stubbed outage");
  }

  const stub: StubGithub = {
    ...state,
    calls,
    async repo(owner, name) {
      const key = `${owner}/${name}`;
      ask(`repos/${key}`);
      const repo = stub.repos[key];
      if (!repo) return null;
      return { owner, name, private: repo.private ?? false, default_branch: repo.default_branch ?? "main", html_url: `https://github.com/${key}` };
    },
    async commit(owner, name, sha) {
      const key = `${owner}/${name}`;
      ask(`repos/${key}/commits/${sha}`);
      if (!(stub.commits[key] ?? []).includes(sha)) return null;
      return { sha, html_url: `https://github.com/${key}/commit/${sha}` };
    },
    async licence(owner, name) {
      const key = `${owner}/${name}`;
      ask(`repos/${key}/license`);
      return stub.licences[key] ?? null;
    },
    async tagFor(owner, name, sha) {
      const key = `${owner}/${name}`;
      ask(`repos/${key}/tags`);
      return stub.tags[key]?.[sha] ?? null;
    },
  };
  return stub;
}
