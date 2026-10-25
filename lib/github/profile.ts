/**
 * lib/github/profile.ts — the repository and the person, as GitHub reports them.
 *
 * Added 2026-08-30 on the founder's direction: "pull in more stats around the
 * author/creator — official website and any metadata we can get from the GitHub
 * repo/profile". A listing page is read cold by someone deciding whether to send a
 * stranger $9, and the two questions they actually have are *what is this project* and
 * *who is this person*. GitHub answers both, for free, and we already hold an
 * installation that can ask.
 *
 * This module is the pure half: two requests and the narrowing of their answers. It
 * imports nothing from Next and holds no cache, so the analyser can call it inside the
 * release pipeline (`lib/analysis`) and the product page can call it through the cached,
 * never-throwing wrapper in `lib/web/github-profile.ts`. Both get the same objects,
 * which is the point — the manifest's persisted copy and the live reading must never be
 * two different shapes.
 *
 * Two rules hold here.
 *
 * - **None of this is a computed field.** Nothing feeds the artifact class, the scan,
 *   the licence gate or the price. It is context, set in the text face beside computed
 *   values set in mono, per The Computed / Written Rule in DESIGN.md.
 * - **A zero is not a fact.** A private repository has zero stars, zero forks and zero
 *   watchers because nobody can see it, not because nobody liked it. Counts that are
 *   zero come back `null` and render nothing rather than as a score of 0.
 */

import type { ManifestOwnerOutput, ManifestRepoMetaOutput } from "@/lib/schemas/manifest";

/** The repo's own metadata and the creator's profile share the manifest's shapes, so
 *  the live reading and the persisted copy can never drift into two different objects. */
export type RepoProfile = ManifestRepoMetaOutput;
export type OwnerProfile = ManifestOwnerOutput;

/** The slice of Octokit this module uses, structural so a test passes a plain object. */
export type OctokitLike = {
  request: (route: string, params?: Record<string, unknown>) => Promise<{ data: unknown }>;
};

// --- reading GitHub ----------------------------------------------------------

/**
 * `GET /repositories/{id}` — by id, never by name, for the same reason FR-8 resolves
 * listings by id: a repository can be renamed or transferred and a name is not a key.
 * The route is not in Octokit's typed table, so every field is narrowed here.
 */
export async function fetchRepoProfile(octokit: OctokitLike, repoId: number | string): Promise<RepoProfile | null> {
  const { data } = await octokit.request("GET /repositories/{repository_id}", { repository_id: Number(repoId) });
  return narrowRepo(data);
}

/**
 * The same narrowing over a repository payload someone else already fetched. The
 * analyser opens with `GET /repos/{owner}/{repo}` (§6, call 1) and that answer carries
 * every one of these fields, so persisting the manifest's copy costs zero extra calls.
 */
export function narrowRepo(data: unknown): RepoProfile | null {
  const repo = data as Record<string, unknown> | null;
  if (!repo || typeof repo !== "object") return null;

  const isPrivate = Boolean(repo.private);
  const licence = repo.license as { spdx_id?: unknown } | null | undefined;

  return {
    repo_id: int(repo.id) ?? undefined,
    name: str(repo.name) ?? undefined,
    full_name: str(repo.full_name) ?? undefined,
    description: str(repo.description),
    homepage: webUrl(repo.homepage),
    topics: Array.isArray(repo.topics) ? repo.topics.filter((t): t is string => typeof t === "string").slice(0, 8) : [],
    language: str(repo.language),
    default_branch: str(repo.default_branch),
    size_kb: int(repo.size),
    created_at: str(repo.created_at),
    pushed_at: str(repo.pushed_at),
    licence_spdx: spdx(licence?.spdx_id),
    open_issues: positive(repo.open_issues_count),
    stars: positive(repo.stargazers_count),
    forks: positive(repo.forks_count),
    watchers: positive(repo.subscribers_count ?? repo.watchers_count),
    archived: Boolean(repo.archived),
    private: isPrivate,
    // A private repository has no page to send a reader to; the page says so in words
    // rather than offering a link that 404s for everyone but the owner.
    html_url: isPrivate ? null : webUrl(repo.html_url),
  };
}

/**
 * `GET /users/{login}` — public, unauthenticated-capable, but read through the App's
 * installation client anyway: 60 requests an hour per IP is not a budget a serverless
 * function shares safely, and 5,000 is.
 */
export async function fetchOwnerProfile(octokit: OctokitLike, login: string): Promise<OwnerProfile | null> {
  const { data } = await octokit.request("GET /users/{username}", { username: login });
  return narrowOwner(data, login);
}

/**
 * `GET /user/{account_id}` — the same person, by the id `creator.github_user_id` holds.
 * The row keeps the id because a login can be renamed and an id cannot; this turns it
 * back into a login and a profile link for the admin creator page. The route is not in
 * Octokit's typed table, so the answer goes through the same narrowing.
 */
export async function fetchOwnerProfileById(octokit: OctokitLike, githubUserId: number | string): Promise<OwnerProfile | null> {
  const { data } = await octokit.request("GET /user/{account_id}", { account_id: Number(githubUserId) });
  return narrowOwner(data);
}

/** The same narrowing over a `GET /users/{login}` payload someone else already fetched. */
export function narrowOwner(data: unknown, fallbackLogin = ""): OwnerProfile | null {
  const user = data as Record<string, unknown> | null;
  const resolved = str(user?.login) ?? (fallbackLogin.trim() || null);
  if (!user || typeof user !== "object" || !resolved) return null;

  return {
    login: resolved,
    name: str(user.name),
    avatar_url: webUrl(user.avatar_url),
    bio: str(user.bio),
    blog: webUrl(user.blog),
    company: str(user.company),
    location: str(user.location),
    twitter_username: str(user.twitter_username),
    followers: positive(user.followers),
    public_repos: positive(user.public_repos),
    created_at: str(user.created_at),
    html_url: webUrl(user.html_url) ?? `https://github.com/${resolved}`,
  };
}

/**
 * The creator's public work, added together (added 2026-08-30 on the founder's
 * direction to put "# public repos" and "total stars across all their public repos" on
 * the creator card).
 *
 * `GET /users/{login}/repos?type=owner` returns only repositories the caller can see,
 * which through an installation token is the public ones plus any the App is installed
 * on. Forks are counted — a fork someone starred is still a repository of theirs that
 * people starred — but the star total is the honest sum of `stargazers_count`, never a
 * projection from a sample.
 *
 * **The page number is a promise about cost, not about completeness.** Three pages of a
 * hundred is 300 repositories and three REST calls, which is the ceiling this is worth.
 * Past it, `truncated` is true and the caller must say "300+" rather than print a total
 * that silently stops counting. A person with more than 300 public repositories is real
 * and a number that quietly excludes their tail is a wrong number, not a rounded one.
 */
export type OwnerStats = {
  /** Repositories counted here, which is not `OwnerProfile.public_repos` when truncated. */
  repos: number;
  /** Sum of `stargazers_count` over the repositories counted. Null when it is zero. */
  stars: number | null;
  /** True when the 300-repository ceiling was hit and the totals are floors. */
  truncated: boolean;
};

export const OWNER_REPOS_PER_PAGE = 100;
export const OWNER_REPOS_MAX_PAGES = 3;

export async function fetchOwnerStats(octokit: OctokitLike, login: string): Promise<OwnerStats | null> {
  const handle = login.trim();
  if (!handle) return null;

  let repos = 0;
  let stars = 0;
  let truncated = false;

  for (let page = 1; page <= OWNER_REPOS_MAX_PAGES; page++) {
    const { data } = await octokit.request("GET /users/{username}/repos", {
      username: handle,
      per_page: OWNER_REPOS_PER_PAGE,
      type: "owner",
      sort: "updated",
      page,
    });
    if (!Array.isArray(data)) break;

    for (const entry of data) {
      const repo = entry as Record<string, unknown>;
      // A private repository reachable through the installation is not public work and
      // must not be counted into a number labelled "public repos".
      if (repo.private === true) continue;
      repos += 1;
      stars += int(repo.stargazers_count) ?? 0;
    }

    if (data.length < OWNER_REPOS_PER_PAGE) return { repos, stars: stars > 0 ? stars : null, truncated: false };
    truncated = page === OWNER_REPOS_MAX_PAGES;
  }

  return { repos, stars: stars > 0 ? stars : null, truncated };
}

// --- narrowing ---------------------------------------------------------------

function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function int(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** A count of zero is hidden, not printed: see rule 3 in the module comment. */
function positive(value: unknown): number | null {
  const n = int(value);
  return n !== null && n > 0 ? n : null;
}

/** `NOASSERTION` is GitHub's "we could not tell", which is not a licence name. */
function spdx(value: unknown): string | null {
  const s = str(value);
  return s && s !== "NOASSERTION" ? s : null;
}

/**
 * A URL we are willing to put behind an anchor. Creator-controlled strings land here —
 * a profile `blog` field is whatever the person typed — so the scheme is checked rather
 * than assumed, and a bare `example.com` is promoted to `https://` rather than being
 * rendered as a relative link that navigates inside this site.
 */
export function webUrl(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname.includes(".")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** `https://x402git.com/docs?x=1` → `x402git.com/docs`. A link should read as a place. */
export function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
    return `${parsed.hostname.replace(/^www\./, "")}${path}`;
  } catch {
    return url;
  }
}
