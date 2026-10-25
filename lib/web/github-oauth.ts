/**
 * lib/web/github-oauth.ts — FR-1, the Rail A sign-in.
 *
 * Scope is `read:user` and nothing else. The App's *installation* is what grants
 * repository access (`Contents: read`, `Metadata: read`, on one repo), and the OAuth
 * token exists only to answer two questions: who is this, and which installations may
 * they choose from. FR-1's own words: never request org-wide write.
 *
 * `fetch` is a parameter on every network call so the callback route can be tested
 * without a GitHub account.
 */

import { RESERVED_HANDLES as SHARED_RESERVED_HANDLES } from "@/lib/schemas/common";

const GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN = "https://github.com/login/oauth/access_token";
const GITHUB_API = "https://api.github.com";

/** FR-1. Read-only, user-level, no repository scope. */
export const OAUTH_SCOPE = "read:user";

export function authorizeUrl(params: { clientId: string; redirectUri: string; state: string }): string {
  const url = new URL(GITHUB_AUTHORIZE);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", OAUTH_SCOPE);
  url.searchParams.set("state", params.state);
  url.searchParams.set("allow_signup", "false");
  return url.toString();
}

export type GithubUser = { id: number; login: string; name: string | null; avatar_url?: string };

export type GithubInstallation = {
  id: number;
  account: { login: string; type?: string; avatar_url?: string } | null;
  repository_selection?: "all" | "selected";
};

export type GithubRepo = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch?: string;
  description?: string | null;
  /**
   * Both are ISO-8601 on GitHub's repository payload. `pushed_at` is the last commit
   * push; `updated_at` moves for metadata too (a rename, a description, a star count on
   * some endpoints). The picker sorts and shows "last updated" from `pushed_at` first,
   * because the question a creator is answering there is "which of these did I last
   * work on", not "which row did GitHub last touch".
   */
  pushed_at?: string | null;
  updated_at?: string | null;
};

export class GithubOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubOAuthError";
  }
}

/**
 * Exchange the `code` for a user-to-server token. GitHub answers 200 with
 * `{ error, error_description }` on failure, so the status alone proves nothing.
 */
export async function exchangeCode(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const { fetchImpl = fetch } = params;
  const response = await fetchImpl(GITHUB_TOKEN, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code: params.code,
      redirect_uri: params.redirectUri,
    }),
    cache: "no-store",
  });

  const body = (await response.json().catch(() => null)) as { access_token?: string; error?: string; error_description?: string } | null;
  if (!body) throw new GithubOAuthError("GitHub returned an unreadable token response.");
  if (body.error) throw new GithubOAuthError(body.error_description ?? body.error);
  if (!body.access_token) throw new GithubOAuthError("GitHub returned no access token.");
  return body.access_token;
}

async function githubGet<T>(path: string, token: string, fetchImpl: typeof fetch = fetch): Promise<T> {
  const response = await fetchImpl(`${GITHUB_API}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    cache: "no-store",
  });
  if (!response.ok) throw new GithubOAuthError(`GitHub ${path} responded ${response.status}.`);
  return (await response.json()) as T;
}

export async function fetchUser(token: string, fetchImpl?: typeof fetch): Promise<GithubUser> {
  return githubGet<GithubUser>("/user", token, fetchImpl);
}

/** Every App installation this user can see. The picker on `/dashboard/new`. */
export async function listInstallations(token: string, fetchImpl?: typeof fetch): Promise<GithubInstallation[]> {
  const body = await githubGet<{ installations?: GithubInstallation[] }>("/user/installations?per_page=100", token, fetchImpl);
  return body.installations ?? [];
}

/** The repositories inside one installation that this user may act on. */
export async function listInstallationRepos(token: string, installationId: number, fetchImpl?: typeof fetch): Promise<GithubRepo[]> {
  const body = await githubGet<{ repositories?: GithubRepo[] }>(
    `/user/installations/${installationId}/repositories?per_page=100`,
    token,
    fetchImpl,
  );
  return body.repositories ?? [];
}

/** `https://github.com/apps/<slug>/installations/new` — where a creator adds a repo. */
export function installAppUrl(appSlug: string): string {
  return `https://github.com/apps/${appSlug}/installations/new`;
}

/**
 * FR-3: the GitHub login is reserved for its owner, so it is the handle. Lowercased,
 * and anything outside `[a-z0-9-]` collapses to a dash because a handle is a URL
 * segment. GitHub logins are already within that set, but a login is not a promise.
 */
export function handleFromLogin(login: string): string {
  const base = login
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base.length >= 2 ? base : `gh-${base}`.slice(0, 40);
}

/**
 * FR-3 again, the collision case. A handle already taken by a creator who registered
 * headlessly (no `github_user_id`) does not belong to this GitHub account, so the
 * GitHub account takes a suffixed handle rather than the platform reassigning someone
 * else's URL.
 */
export function handleCandidates(login: string): string[] {
  const base = handleFromLogin(login);
  const room = (suffix: string) => `${base.slice(0, 40 - suffix.length)}${suffix}`;
  const candidates = [base, room("-gh"), room("-gh-2"), room("-gh-3"), room("-gh-4")];
  return candidates.filter((c) => !RESERVED_HANDLES.has(c));
}

/**
 * A handle is the first path segment, and Next resolves a static segment before a
 * dynamic one. A creator holding `docs` would get an unreachable listing page rather
 * than a broken site, which is worse — it fails silently. FR-3 reserves `api v r label`
 * as slugs; this is the same rule one segment to the left. See DECISIONS.md.
 */
export const RESERVED_HANDLES = new Set<string>(SHARED_RESERVED_HANDLES);

/** A repository name → a listing slug that satisfies `Slug` (FR-3). */
export function slugFromRepoName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base.length >= 2 ? base : `repo-${base}`.slice(0, 40);
}
