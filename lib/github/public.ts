/**
 * lib/github/public.ts — reading a *public* repository, with no credentials.
 *
 * Open releases (25 Oct 2026, HackMeridian) promise that a commit sold from a private
 * mirror will appear in the project's own public repository by a date. Checking that
 * promise means asking GitHub about a repository the platform has no installation on
 * and never will: it belongs to the project, not to the listing. The unauthenticated
 * REST API answers everything the check needs, so this module uses it and nothing else.
 *
 * Three questions, each one GET:
 *
 *   repo(owner, name)          → GET /repos/{o}/{r}          exists? public? default branch?
 *   commit(owner, name, sha)   → GET /repos/{o}/{r}/commits/{sha}   is this exact commit in it?
 *   licence(owner, name)       → GET /repos/{o}/{r}/license  which SPDX id does GitHub read?
 *
 * A 404 is an answer (`null`), never an error: "the commit is not there" is the normal
 * state of an open release before its date, and "the repository does not exist" is a
 * check that fails. Anything else — a 5xx, a rate limit, the network — throws, so a
 * caller can tell "not there" from "could not look", and never records the second as
 * the first.
 *
 * The seam (`setPublicGithub`) exists for tests and for nothing else: a test that
 * checks a promise must not reach api.github.com, and `fetch` is already stubbed to
 * other ends in the suites this runs inside.
 */

export type PublicRepo = {
  owner: string;
  name: string;
  private: boolean;
  default_branch: string | null;
  html_url: string;
};

export type PublicCommit = {
  sha: string;
  html_url: string;
};

export type PublicGithub = {
  /** The repository, or null when GitHub answers 404 (missing, or private to someone else). */
  repo(owner: string, name: string): Promise<PublicRepo | null>;
  /** The commit, or null when it is not reachable in this repository. */
  commit(owner: string, name: string, sha: string): Promise<PublicCommit | null>;
  /** GitHub's `license.spdx_id` for the repository, or null when it has no licence file. */
  licence(owner: string, name: string): Promise<string | null>;
  /** The tag that points at `sha`, if one does on the first page of tags. Best effort. */
  tagFor(owner: string, name: string, sha: string): Promise<string | null>;
};

/** `https://github.com/owner/name` → `{ owner, name }`, or null for anything else. */
export function parseGithubRepoUrl(url: string | null | undefined): { owner: string; name: string } | null {
  if (!url) return null;
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/?$/.exec(url.trim());
  if (!match) return null;
  return { owner: match[1], name: match[2].replace(/\.git$/, "") };
}

export class GithubUnreachable extends Error {
  constructor(
    readonly url: string,
    readonly status: number | null,
    detail: string,
  ) {
    super(`GitHub did not answer ${url}: ${detail}`);
    this.name = "GithubUnreachable";
  }
}

const API = "https://api.github.com";

/** The GitHub REST API over plain `fetch`, unauthenticated. */
export function fetchPublicGithub(fetchImpl: typeof fetch = fetch): PublicGithub {
  async function get(path: string): Promise<{ status: number; json: unknown }> {
    const url = `${API}${path}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          // GitHub refuses requests with no User-Agent.
          "user-agent": "x402git-open-release-check",
        },
      });
    } catch (e) {
      throw new GithubUnreachable(url, null, e instanceof Error ? e.message : String(e));
    }
    // 404 and 422 ("no commit found for SHA") are both "not there".
    if (response.status === 404 || response.status === 422) return { status: 404, json: null };
    if (!response.ok) throw new GithubUnreachable(url, response.status, `HTTP ${response.status}`);
    try {
      return { status: response.status, json: await response.json() };
    } catch (e) {
      throw new GithubUnreachable(url, response.status, e instanceof Error ? e.message : "unreadable body");
    }
  }

  return {
    async repo(owner, name) {
      const { status, json } = await get(`/repos/${owner}/${name}`);
      if (status === 404) return null;
      const data = (json ?? {}) as Record<string, unknown>;
      const login = (data.owner as { login?: string } | undefined)?.login;
      return {
        owner: typeof login === "string" ? login : owner,
        name: typeof data.name === "string" ? data.name : name,
        private: data.private === true,
        default_branch: typeof data.default_branch === "string" ? data.default_branch : null,
        html_url: typeof data.html_url === "string" ? data.html_url : `https://github.com/${owner}/${name}`,
      };
    },

    async commit(owner, name, sha) {
      const { status, json } = await get(`/repos/${owner}/${name}/commits/${sha}`);
      if (status === 404) return null;
      const data = (json ?? {}) as Record<string, unknown>;
      return {
        sha: typeof data.sha === "string" ? data.sha : sha,
        html_url: typeof data.html_url === "string" ? data.html_url : `https://github.com/${owner}/${name}/commit/${sha}`,
      };
    },

    async licence(owner, name) {
      const { status, json } = await get(`/repos/${owner}/${name}/license`);
      if (status === 404) return null;
      const spdx = ((json ?? {}) as { license?: { spdx_id?: unknown } }).license?.spdx_id;
      return typeof spdx === "string" && spdx.length > 0 ? spdx : null;
    },

    async tagFor(owner, name, sha) {
      const { status, json } = await get(`/repos/${owner}/${name}/tags?per_page=100`);
      if (status === 404 || !Array.isArray(json)) return null;
      const match = (json as { name?: unknown; commit?: { sha?: unknown } }[]).find((t) => t.commit?.sha === sha);
      return match && typeof match.name === "string" ? match.name : null;
    },
  };
}

let override: PublicGithub | null = null;

/** The reader every caller uses. Tests swap it with `setPublicGithub`. */
export function publicGithub(): PublicGithub {
  return override ?? fetchPublicGithub();
}

/** Tests only: a stub reader, or null to go back to the real one. */
export function setPublicGithub(impl: PublicGithub | null): void {
  override = impl;
}
