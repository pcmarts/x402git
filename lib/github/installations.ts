/**
 * lib/github/installations.ts — Rail A: which installation, and which repo.
 *
 * FR-8 resolves a listing by `installation_id` + repo *id*, never by name, because a
 * repo can be renamed or transferred and a name is not a key. Creators do not think in
 * repo ids, so `POST /api/listings` accepts `repo: "owner/name"` and this module turns
 * it into one — once, at creation time.
 *
 * The ownership checks are the security-relevant half, and there are two. An
 * `installation_id` is a small integer a caller can guess; without checking that the
 * installation belongs to the creator's GitHub account, one creator could list another's
 * private repo. And an org installation covers repos that most of the org's members
 * cannot administer, so belonging to the installation is not permission to sell any one
 * repo in it: `userCanSellRepo` asks GitHub for the user's role on that repo (AUTH-2).
 */

import { githubApp, installationOctokit, type InstallationOctokit } from "@/lib/github/app";

export type InstallationAccount = {
  installationId: number;
  /** The GitHub user or org id the App is installed on. Compare against `creator.github_user_id`. */
  accountId: number | null;
  accountLogin: string | null;
  /** `"User"` or `"Organization"` — an org install is never owned by id equality. */
  accountType: string | null;
};

/** Read an installation from the App (not the installation) endpoint. */
export async function installationAccount(installationId: number | string): Promise<InstallationAccount> {
  const { data } = await githubApp().octokit.request("GET /app/installations/{installation_id}", {
    installation_id: Number(installationId),
  });
  const account = data.account as { id?: number; login?: string; slug?: string; type?: string } | null;
  return {
    installationId: Number(data.id),
    accountId: account?.id !== undefined ? Number(account.id) : null,
    accountLogin: account?.login ?? account?.slug ?? null,
    accountType: account?.type ?? (account && "slug" in account && account.slug !== undefined ? "Organization" : null),
  };
}

/**
 * Does the GitHub user own this installation?
 *
 * A user installation is owned by exactly one account: id equality decides. An org
 * installation belongs to the org, so the question becomes membership: resolve the
 * user's login from their immutable id, then ask the org (through the installation's
 * own token) whether that login is an active member. Both reads fail **closed** — a
 * network error, a renamed account or an App without `Organization members: read`
 * answers "no", never "yes".
 *
 * This answers "may this user use this installation at all", and no more. Membership
 * says nothing about any one repository in the org — an ordinary member may not even be
 * able to read it — so every repo is also put through `userCanSellRepo` (AUTH-2).
 */
export async function userOwnsInstallation(githubUserId: string | number, account: InstallationAccount): Promise<boolean> {
  if (account.accountId === null) return false;

  if (account.accountType !== "Organization") {
    return String(account.accountId) === String(githubUserId);
  }

  if (!account.accountLogin) return false;
  try {
    const octokit = await installationOctokit(account.installationId);
    const login = await currentLogin(octokit, githubUserId);
    if (!login) return false;

    const { data: membership } = await octokit.request("GET /orgs/{org}/memberships/{username}", {
      org: account.accountLogin,
      username: login,
    });
    return (membership as { state?: string }).state === "active";
  } catch {
    return false;
  }
}

/**
 * `GET /user/{account_id}` resolves the id we stored at OAuth time to the login GitHub
 * knows right now — logins can change, ids cannot. Throws on a network error; callers
 * fail closed.
 *
 * Asked through the **installation's** token, never the App JWT. `@octokit/auth-app`
 * sends the JWT only on the App's own routes (`/app`, `/app/installations/…`) and
 * insists on an installation id for every other route, so an App-authenticated
 * `GET /user/{account_id}` throws before it is sent. Verified against production on
 * 2026-10-25: the JWT form refused all 70 Rail A creators; the installation form named
 * every one. An installation token reads public user data without any extra permission.
 */
async function currentLogin(octokit: InstallationOctokit, githubUserId: string | number): Promise<string | null> {
  const { data: user } = await octokit.request("GET /user/{account_id}", {
    account_id: Number(githubUserId),
  });
  return (user as { login?: string }).login ?? null;
}

/**
 * AUTH-2: the repository roles that may put a repo up for sale, as GitHub names them in
 * `role_name`.
 *
 * `admin` and `maintain` are the roles GitHub trusts to manage a repository rather than
 * contribute to it. `write` is not here: a writer can push code, but cannot change who
 * may read the repo, and selling a snapshot to anyone with a wallet is a bigger access
 * decision than any GitHub lets a writer make. NG3 — nothing listed without explicit
 * permission to sell — reads more naturally against the managing roles than against
 * every contributor.
 */
export const SELLING_ROLES = ["admin", "maintain"] as const;

/**
 * The one refusal for every way the repo check can fail: no access, too little access,
 * a repo the installation cannot see, or GitHub not answering. One sentence for all of
 * them, so the answer never says whether a repo the caller cannot read exists.
 */
export const REPO_ROLE_REQUIRED =
  "Selling a repository requires the admin or maintain role on it. GitHub did not confirm that role for your account on this repository.";

export type RepoRole = { roleName: string | null; permission: string | null };

/**
 * Does this role clear `SELLING_ROLES`? `role_name` carries `maintain` (the legacy
 * `permission` field folds it into `write`), so it is read first. `permission: "admin"`
 * is accepted on its own because no custom role can inherit admin, so it can only mean
 * the admin role. A custom role built on `maintain` reports its own name and a `write`
 * base, and is refused: failing closed is the right side to be wrong on here.
 */
export function roleCanSell(role: RepoRole): boolean {
  if (role.roleName !== null && (SELLING_ROLES as readonly string[]).includes(role.roleName)) return true;
  return role.permission === "admin";
}

/**
 * May this GitHub user sell this repository? AUTH-2 (RED-TEAM-2026-09-21).
 *
 * Asks GitHub for the user's role on the one repo, through the installation's own token:
 * `GET /repos/{owner}/{repo}/collaborators/{username}/permission` needs only the
 * `Metadata: read` repository permission, which every GitHub App holds (and
 * `scripts/github-app-check.mjs` asserts). The role GitHub reports is the highest the
 * user holds from any source — direct, team, org or enterprise.
 *
 * Called at listing creation and again on every snapshot (`cutRelease`), because a role
 * can be taken away after a listing exists. Fails **closed**: a 404, a network error or
 * a login that no longer resolves all answer "no".
 */
export async function userCanSellRepo(
  installationId: number | string,
  githubUserId: string | number,
  repo: { owner: string; name: string },
): Promise<boolean> {
  if (!repo.owner || !repo.name) return false;
  try {
    const octokit = await installationOctokit(installationId);
    const login = await currentLogin(octokit, githubUserId);
    if (!login) return false;

    const { data } = await octokit.request("GET /repos/{owner}/{repo}/collaborators/{username}/permission", {
      owner: repo.owner,
      repo: repo.name,
      username: login,
    });
    const role = data as { role_name?: string | null; permission?: string | null };
    return roleCanSell({ roleName: role.role_name ?? null, permission: role.permission ?? null });
  } catch {
    return false;
  }
}

export type ResolvedRepo = { repoId: number; owner: string; name: string; private: boolean; defaultBranch: string };

/** `"owner/name"` → its numeric id, read through the installation that can see it. */
export async function resolveRepo(installationId: number | string, ownerAndName: string): Promise<ResolvedRepo> {
  const [owner, name] = ownerAndName.split("/");
  if (!owner || !name) throw new Error(`\`repo\` must be "owner/name", got "${ownerAndName}"`);

  const octokit = await installationOctokit(installationId);
  const { data } = await octokit.request("GET /repos/{owner}/{repo}", { owner, repo: name });
  return {
    repoId: Number(data.id),
    owner: data.owner.login,
    name: data.name,
    private: Boolean(data.private),
    defaultBranch: data.default_branch,
  };
}

/**
 * The same repo, read by the id we already store.
 *
 * `POST /api/listings` accepts `github_repo_id` directly, so the `repo: "owner/name"`
 * path is not the only way in and a repo id on its own answers no question about the
 * repository — not its name, and not, since FR-10 was amended on 2026-08-30, whether it
 * is private. This is how the visibility gate reads a repo the caller identified by id.
 *
 * `GET /repositories/{id}` is not in the typed route table, so the response is `any`;
 * every field is narrowed here rather than passed on.
 */
export async function repoById(installationId: number | string, repoId: number | string): Promise<ResolvedRepo> {
  const octokit = await installationOctokit(installationId);
  const { data } = await octokit.request("GET /repositories/{repository_id}", { repository_id: Number(repoId) });
  const repo = data as { id: number; name: string; private?: boolean; default_branch?: string; owner?: { login?: string } };
  return {
    repoId: Number(repo.id),
    owner: repo.owner?.login ?? "",
    name: repo.name,
    private: Boolean(repo.private),
    defaultBranch: repo.default_branch ?? "main",
  };
}
