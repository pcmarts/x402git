/**
 * lib/web/github-profile.ts — the product page's reading of the repository and the
 * person behind a listing.
 *
 * The requests and the narrowing live in `lib/github/profile.ts`, which knows nothing
 * about Next and is shared with the analyser. This module is the three things the page
 * needs on top of that: a cache, a promise never to throw, and the rule for choosing
 * between the live reading and the copy the manifest persisted at release time.
 *
 * **It never breaks the page.** Every exported path returns `null` on any failure — a
 * missing installation, a revoked token, a deleted repository, a rate limit, a
 * malformed field. The page renders nothing where a profile would have been. This is
 * context over a manifest, and context that can 500 a product page is not worth having.
 *
 * **Caching.** `unstable_cache` at `revalidate: 3600`, keyed by repository id and by
 * login. Next 16 prefers the `use cache` directive, but that needs the `cacheComponents`
 * flag, which changes the rendering model of every route in the app — and this page is
 * `force-dynamic` because it reads a session. One hour is right for a field a creator
 * edits on GitHub and expects to see here the same morning, and it keeps a listing page
 * an agent fetches a hundred times a day down to one GitHub call an hour.
 */

import { unstable_cache } from "next/cache";
import type { ListingRow } from "@/lib/db/types";
import { currentHostedOrg, installationOctokit } from "@/lib/github/app";
import { hostedInstallationId } from "@/lib/github/hosted";
import {
  type OctokitLike,
  type OwnerProfile,
  type OwnerStats,
  type RepoProfile,
  fetchOwnerProfile,
  fetchOwnerProfileById,
  fetchOwnerStats,
  fetchRepoProfile,
} from "@/lib/github/profile";
import type { ManifestOutput } from "@/lib/schemas";

export type { OctokitLike, OwnerProfile, OwnerStats, RepoProfile } from "@/lib/github/profile";
export { displayUrl, fetchOwnerProfile, fetchOwnerProfileById, fetchOwnerStats, fetchRepoProfile, narrowOwner, narrowRepo, webUrl } from "@/lib/github/profile";

/** One hour. Long enough that an agent's hundredth fetch costs nothing, short enough
 *  that a creator who fixes their bio sees it the same morning. */
export const PROFILE_TTL_SECONDS = 3600;

const cachedRepo = unstable_cache(
  async (installationId: string, repoId: string): Promise<RepoProfile | null> => {
    const octokit = await installationOctokit(installationId);
    return await fetchRepoProfile(octokit as unknown as OctokitLike, repoId);
  },
  ["github-repo-profile"],
  { revalidate: PROFILE_TTL_SECONDS },
);

const cachedOwner = unstable_cache(
  async (installationId: string, login: string): Promise<OwnerProfile | null> => {
    const octokit = await installationOctokit(installationId);
    return await fetchOwnerProfile(octokit as unknown as OctokitLike, login);
  },
  ["github-owner-profile"],
  { revalidate: PROFILE_TTL_SECONDS },
);

const cachedOwnerById = unstable_cache(
  async (installationId: string, githubUserId: string): Promise<OwnerProfile | null> => {
    const octokit = await installationOctokit(installationId);
    return await fetchOwnerProfileById(octokit as unknown as OctokitLike, githubUserId);
  },
  ["github-owner-profile-by-id"],
  { revalidate: PROFILE_TTL_SECONDS },
);

/**
 * The star and repository totals behind the creator card. Three REST calls at worst,
 * once an hour per login — the same budget and the same cache window as the profile it
 * sits beside, because a creator who publishes a repository today expects the count
 * beside their avatar to move the same morning and not sooner.
 */
const cachedStats = unstable_cache(
  async (installationId: string, login: string): Promise<OwnerStats | null> => {
    const octokit = await installationOctokit(installationId);
    return await fetchOwnerStats(octokit as unknown as OctokitLike, login);
  },
  ["github-owner-stats"],
  { revalidate: PROFILE_TTL_SECONDS },
);

/** Just enough of a listing row to find the installation and the repository. */
export type ProfileListing = Pick<ListingRow, "installation_id" | "hosted_org" | "github_repo_id" | "source">;

/**
 * Rail A reads through the creator's own installation; Rail B through the hosted org's,
 * which D10 says is discovered rather than configured. A listing with neither — a
 * fixture, or one whose installation was uninstalled — has no profile, and that is a
 * `null`, not an error.
 */
export async function installationForListing(listing: Pick<ProfileListing, "installation_id" | "hosted_org">): Promise<string | null> {
  if (listing.installation_id !== null && listing.installation_id !== undefined) return String(listing.installation_id);
  if (!listing.hosted_org) return null;
  try {
    return String(await hostedInstallationId(listing.hosted_org));
  } catch {
    return null;
  }
}

/** The repository behind a listing, or null. Never throws. */
export async function repoProfile(listing: ProfileListing): Promise<RepoProfile | null> {
  if (listing.github_repo_id === null || listing.github_repo_id === undefined) return null;
  try {
    const installationId = await installationForListing(listing);
    if (!installationId) return null;
    return await cachedRepo(installationId, String(listing.github_repo_id));
  } catch {
    return null;
  }
}

/** The creator's public GitHub profile, or null. Never throws. */
export async function ownerProfile(login: string, listing: Pick<ProfileListing, "installation_id" | "hosted_org">): Promise<OwnerProfile | null> {
  if (!login.trim()) return null;
  try {
    const installationId = await installationForListing(listing);
    if (!installationId) return null;
    return await cachedOwner(installationId, login.trim());
  } catch {
    return null;
  }
}

/**
 * A creator's GitHub profile by the id on their row, or null. Never throws. Read through
 * the current hosted org's installation, not a listing's: a creator who signed up and
 * never listed anything has no installation of their own, and they are exactly the
 * person an admin wants to look up.
 */
export async function ownerProfileById(githubUserId: string | number): Promise<OwnerProfile | null> {
  const id = String(githubUserId).trim();
  if (!/^\d+$/.test(id)) return null;
  try {
    const installationId = String(await hostedInstallationId(currentHostedOrg()));
    return await cachedOwnerById(installationId, id);
  } catch {
    return null;
  }
}

/** The creator's public repository and star totals, or null. Never throws. */
export async function ownerStats(login: string, listing: Pick<ProfileListing, "installation_id" | "hosted_org">): Promise<OwnerStats | null> {
  if (!login.trim()) return null;
  try {
    const installationId = await installationForListing(listing);
    if (!installationId) return null;
    return await cachedStats(installationId, login.trim());
  } catch {
    return null;
  }
}

export type ListingProfile = { repo: RepoProfile | null; owner: OwnerProfile | null; stats: OwnerStats | null };

/**
 * What the page renders: live first, the manifest's copy second.
 *
 * The live reading is the truth — a creator who adds a website today should see it
 * today — but a release published two years ago must not lose its context because the
 * installation was removed, so the analyser persists a copy at release time
 * (`Manifest.computed.repo_meta` / `.owner`) and that copy is the fallback. Object by
 * object, not field by field: half a live profile mixed with half a stale one is a
 * claim nobody made.
 */
export async function listingProfile(listing: ProfileListing, manifest: ManifestOutput | null): Promise<ListingProfile> {
  const stored = manifest?.computed ?? null;
  const repo = (await repoProfile(listing)) ?? stored?.repo_meta ?? null;

  // A Rail B repository lives in a platform-owned org, so its GitHub "owner" is us, not
  // the creator. There is nobody to profile and the page falls back to the handle.
  const login = listing.source === "hosted" ? null : (ownerLoginOf(repo) ?? stored?.owner?.login ?? null);
  const owner = login ? ((await ownerProfile(login, listing)) ?? stored?.owner ?? null) : null;

  // Deliberately live-only, with no manifest fallback: a star total is a number that
  // moves every day, and a copy of it taken at release time would be presented as
  // today's count while being a year old. Absent beats stale for a moving figure.
  const stats = login ? await ownerStats(login, listing) : null;

  return { repo, owner, stats };
}

/** `octocat/hello-world` → `octocat`. The repository's owner is the person to profile. */
export function ownerLoginOf(repo: RepoProfile | null | undefined): string | null {
  const full = repo?.full_name;
  if (!full || !full.includes("/")) return null;
  const login = full.slice(0, full.indexOf("/")).trim();
  return login.length > 0 ? login : null;
}
