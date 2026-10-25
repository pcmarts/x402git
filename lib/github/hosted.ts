/**
 * lib/github/hosted.ts — Rail B provisioning (FR-7, D10, §14.6).
 *
 * Rail B is the whole of G6: an agent with a wallet and an SSH key gets a private git
 * remote it can push to, with no GitHub account and no browser. That is two Octokit
 * calls — create the repo, add the deploy key — and this module is those two calls plus
 * the lifecycle that follows them (rotate, archive, delete, commit a LICENSE).
 *
 *   const repo = await provisionHostedRepo({ handle, slug, sshPublicKey });
 *   // → { repoId, deployKeyId, remote: "git@github.com:x402git-hosted-01/a1b2c3--humanizer.git", … }
 *
 * Three constraints shape it:
 *
 * - **§14.6 one public key, one repo.** GitHub rejects a deploy key already registered
 *   on another repository, so keys are per listing and rotation is delete-then-add.
 * - **§14.3 installation tokens expire in one hour.** Every call here mints a fresh
 *   installation client and throws it away. Nothing is cached but the installation *id*.
 * - **D10 the App and the hosted orgs are different accounts.** The installation id for
 *   an org is therefore discovered (`GET /orgs/{org}/installation`), never configured.
 *
 * Nothing in this module logs a key, a token or a repository's contents.
 */

import { currentHostedOrg, githubApp, installationOctokit, type InstallationOctokit } from "@/lib/github/app";
import { type AllowedSpdxId, licenceText } from "@/lib/licences";

/** Rail B repos are always created with `main` as the default branch. */
export const HOSTED_DEFAULT_BRANCH = "main";

/**
 * github.com's published SSH host keys, so a pushing agent can pin them without a
 * TOFU prompt. Source: GitHub's "SSH key fingerprints" documentation. These are
 * constants, not a lookup: fetching them over the network to verify the network is
 * circular.
 */
export const GITHUB_SSH_HOST_KEY_FINGERPRINTS = [
  "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU", // ED25519
  "SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM", // ECDSA
  "SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s", // RSA
] as const;

export function sshHostKeyFingerprints(): string[] {
  return [...GITHUB_SSH_HOST_KEY_FINGERPRINTS];
}

/** A repository in one of the platform-owned orgs. */
export type HostedRepoRef = { owner: string; repo: string };

export type ProvisionHostedRepoInput = {
  /** The creator handle — the `owner` segment of every URL (FR-3). */
  handle: string;
  slug: string;
  /** The public key that becomes this repo's write deploy key. One key, one repo (§14.6). */
  sshPublicKey: string;
  /** Override the cohort org. Defaults to `currentHostedOrg()`. */
  org?: string;
};

export type ProvisionedHostedRepo = {
  org: string;
  name: string;
  repoId: number;
  deployKeyId: number;
  /** The remote an agent pushes to. SSH, because the credential is a deploy key. */
  remote: string;
  defaultBranch: string;
  installationId: number;
  sshHostKeyFingerprints: string[];
};

/** `<handle>--<slug>`. Both halves are `[a-z0-9-]`, so `--` is an unambiguous separator. */
export function hostedRepoName(handle: string, slug: string): string {
  return `${handle}--${slug}`;
}

export function hostedRemote(org: string, name: string): string {
  return `git@github.com:${org}/${name}.git`;
}

// --- installation resolution ---------------------------------------------------

const installationIds = new Map<string, number>();

/**
 * The App's installation on a hosted org. Memoised per process: an installation id is
 * stable for the life of the installation, and this is the one lookup that would
 * otherwise happen on every provisioning call.
 */
export async function hostedInstallationId(org: string): Promise<number> {
  const cached = installationIds.get(org);
  if (cached) return cached;

  const { data } = await githubApp().octokit.request("GET /orgs/{org}/installation", { org });
  const id = Number(data.id);
  if (!Number.isFinite(id)) throw new Error(`the app is not installed on ${org}`);
  installationIds.set(org, id);
  return id;
}

/** Tests, and anything that changes GITHUB_HOSTED_ORGS. */
export function resetHostedCache(): void {
  installationIds.clear();
}

async function octokitFor(org: string): Promise<InstallationOctokit> {
  return await installationOctokit(await hostedInstallationId(org));
}

// --- provisioning ---------------------------------------------------------------

/**
 * FR-7. Create the private repo and register the deploy key.
 *
 * `auto_init` gives the repo a first commit, which matters for two reasons: a repo with
 * no commits has no default branch to push to, and `commitLicenceFile` needs a tree to
 * commit against. If the org's default branch name is not `main` the branch is renamed,
 * so the remote we hand back is the one we promised.
 */
export async function provisionHostedRepo(input: ProvisionHostedRepoInput): Promise<ProvisionedHostedRepo> {
  const org = input.org ?? currentHostedOrg();
  const name = hostedRepoName(input.handle, input.slug);
  const installationId = await hostedInstallationId(org);
  const octokit = await installationOctokit(installationId);

  const { data: repo } = await octokit.request("POST /orgs/{org}/repos", {
    org,
    name,
    private: true,
    auto_init: true,
    has_issues: false,
    has_projects: false,
    has_wiki: false,
    description: `Private source for ${input.handle}/${input.slug}`,
  });

  let defaultBranch = repo.default_branch ?? HOSTED_DEFAULT_BRANCH;
  if (defaultBranch !== HOSTED_DEFAULT_BRANCH) {
    const { data: renamed } = await octokit.request("POST /repos/{owner}/{repo}/branches/{branch}/rename", {
      owner: org,
      repo: name,
      branch: defaultBranch,
      new_name: HOSTED_DEFAULT_BRANCH,
    });
    defaultBranch = renamed.name ?? HOSTED_DEFAULT_BRANCH;
  }

  // The repo exists from here on. If the key is rejected (§14.6: already in use on
  // another repository) the repo must go with it — an orphan holds the name, and the
  // creator's retry with a fresh key would then fail on "name already exists" instead.
  let deployKeyId: number;
  try {
    deployKeyId = await addDeployKey({ owner: org, repo: name }, input.sshPublicKey, octokit);
  } catch (e) {
    try {
      await octokit.request("DELETE /repos/{owner}/{repo}", { owner: org, repo: name });
    } catch (cleanup) {
      console.error("[hosted] orphaned repo after a rejected deploy key:", name, cleanup instanceof Error ? cleanup.message : String(cleanup));
    }
    throw e;
  }

  return {
    org,
    name,
    repoId: Number(repo.id),
    deployKeyId,
    remote: hostedRemote(org, name),
    defaultBranch,
    installationId,
    sshHostKeyFingerprints: sshHostKeyFingerprints(),
  };
}

/**
 * §14.6, as GitHub reports it. `POST /repos/{owner}/{repo}/keys` answers `422` both when
 * the key is malformed and — the case §14.6 exists for — when it is already a deploy key
 * on another repository. Either way it is the caller's key that is wrong, not our
 * server, so the failure is given a type the service layer can map onto the §9 catalogue
 * instead of letting an Octokit `RequestError` fall through as `500 internal`.
 */
export class DeployKeyRejected extends Error {
  readonly githubMessage: string;
  constructor(githubMessage: string) {
    super(`GitHub rejected the deploy key: ${githubMessage}`);
    this.name = "DeployKeyRejected";
    this.githubMessage = githubMessage;
  }
}

/** `read_only: false` — the whole point is that the agent can push (FR-7). */
export async function addDeployKey(ref: HostedRepoRef, sshPublicKey: string, client?: InstallationOctokit): Promise<number> {
  const octokit = client ?? (await octokitFor(ref.owner));
  try {
    const { data } = await octokit.request("POST /repos/{owner}/{repo}/keys", {
      owner: ref.owner,
      repo: ref.repo,
      title: `x402git ${ref.repo}`,
      key: sshPublicKey.trim(),
      read_only: false,
    });
    return Number(data.id);
  } catch (e) {
    if ((e as { status?: number }).status === 422) throw new DeployKeyRejected(githubValidationMessage(e));
    throw e;
  }
}

/** The human half of a GitHub 422, without the key or the token that produced it. */
function githubValidationMessage(e: unknown): string {
  const errors = (e as { response?: { data?: { errors?: { message?: string }[] } } }).response?.data?.errors;
  const first = errors?.find((x) => typeof x.message === "string")?.message;
  return first ?? "the key was not accepted (a deploy key can only be registered on one repository).";
}

/**
 * FR-7 / FR-5. Add first, then remove: if the add fails (a duplicate key, §14.6) the
 * creator still has a working key. The old key is removed on a best-effort basis —
 * a left-behind key is an ops chore, a lost remote is an outage.
 */
export async function rotateDeployKey(ref: HostedRepoRef, oldKeyId: number | string | null, newKey: string): Promise<number> {
  const octokit = await octokitFor(ref.owner);
  const deployKeyId = await addDeployKey(ref, newKey, octokit);

  if (oldKeyId !== null && oldKeyId !== undefined) {
    try {
      await octokit.request("DELETE /repos/{owner}/{repo}/keys/{key_id}", { owner: ref.owner, repo: ref.repo, key_id: Number(oldKeyId) });
    } catch (e) {
      console.warn("[hosted] could not remove the previous deploy key:", e instanceof Error ? e.message : String(e));
    }
  }
  return deployKeyId;
}

export async function removeDeployKey(ref: HostedRepoRef, keyId: number | string): Promise<void> {
  const octokit = await octokitFor(ref.owner);
  await octokit.request("DELETE /repos/{owner}/{repo}/keys/{key_id}", { owner: ref.owner, repo: ref.repo, key_id: Number(keyId) });
}

/** FR-43. Retiring a listing archives its hosted repo: read-only, not gone. */
export async function archiveHostedRepo(ref: HostedRepoRef): Promise<void> {
  const octokit = await octokitFor(ref.owner);
  await octokit.request("PATCH /repos/{owner}/{repo}", { owner: ref.owner, repo: ref.repo, archived: true });
}

/**
 * FR-44. Remove the repo and its deploy key. The key goes first so that a failure
 * halfway through cannot leave a live write key on a repo nobody is watching.
 */
export async function deleteHostedRepo(ref: HostedRepoRef, deployKeyId?: number | string | null): Promise<void> {
  const octokit = await octokitFor(ref.owner);

  if (deployKeyId !== null && deployKeyId !== undefined) {
    try {
      await octokit.request("DELETE /repos/{owner}/{repo}/keys/{key_id}", { owner: ref.owner, repo: ref.repo, key_id: Number(deployKeyId) });
    } catch (e) {
      console.warn("[hosted] deploy key already gone:", e instanceof Error ? e.message : String(e));
    }
  }
  await octokit.request("DELETE /repos/{owner}/{repo}", { owner: ref.owner, repo: ref.repo });
}

// --- licence --------------------------------------------------------------------

export type CommitLicenceResult = { commitSha: string; path: string; spdx: AllowedSpdxId };

/**
 * FR-11. Commit `LICENSE` from the allow-list to `main` via the contents API — no
 * clone, no working tree, one call (two if the file already exists and needs its blob
 * sha to overwrite).
 *
 * `holder` is the creator handle: on Rail B that is the only name the platform has, and
 * D4 puts the warranty on the registering operator, not on us.
 */
export async function commitLicenceFile(ref: HostedRepoRef, spdx: AllowedSpdxId, holder = ref.owner): Promise<CommitLicenceResult> {
  const octokit = await octokitFor(ref.owner);
  const path = "LICENSE";
  const content = Buffer.from(licenceText(spdx, holder), "utf8").toString("base64");

  let sha: string | undefined;
  try {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: ref.owner,
      repo: ref.repo,
      path,
      ref: HOSTED_DEFAULT_BRANCH,
    });
    if (!Array.isArray(data) && "sha" in data) sha = data.sha;
  } catch {
    // 404 is the normal case: there is no LICENSE yet, which is why we are here.
  }

  const { data } = await octokit.request("PUT /repos/{owner}/{repo}/contents/{path}", {
    owner: ref.owner,
    repo: ref.repo,
    path,
    message: `Add ${spdx} LICENSE`,
    content,
    branch: HOSTED_DEFAULT_BRANCH,
    ...(sha ? { sha } : {}),
  });

  return { commitSha: data.commit?.sha ?? "", path, spdx };
}
