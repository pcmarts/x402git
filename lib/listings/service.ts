/**
 * lib/listings/service.ts — every creator operation on a listing, in one module.
 *
 * The routes in `app/api/listings/**` are thin on purpose: they authenticate, parse and
 * rate-limit, then call one function from here. That is D9 taken seriously — the web
 * dashboard and the headless agent reach the same code, so they cannot diverge.
 *
 *   const listing = await createListing(creator, body);
 *   await publishListing(creator, listing.listing_id);
 *
 * Rules this module is responsible for:
 * - **Money is bigint micro-USDC and is never rounded** (FR-12). `9000001` in, `9000001`
 *   out. Every read goes through `toMicro`, every write through `fromMicro`.
 * - **Ownership is a 404, not a 403.** Another creator's listing id must be
 *   indistinguishable from one that does not exist, or the ids become an oracle.
 * - **Retire is terminal** (FR-43). Once `retired_at` is set, every mutation is `410`.
 * - **Snapshots are the product** (FR-44). Deleting a repo never deletes a release
 *   somebody bought.
 * - **Mutations are attributed** (FR-61). A creator now has two kinds of bearer key, so
 *   every event a mutation writes records which one authenticated it — the reason the
 *   functions that write events take an `AuthedCreator` rather than a bare `CreatorRow`.
 */

import { createHash } from "node:crypto";
import { mirrorToVercel } from "@/lib/analytics/vercel";
import type { AuthedCreator } from "@/lib/auth/api-key";
import { chainLabel } from "@/lib/buy-links";
import { payoutRailsFor } from "@/lib/core/access";
import { db } from "@/lib/db";
import { recordedChainId } from "@/lib/events";
import type { ApiKeyKind, CreatorRow, ListingRow, PurchaseRow, ReleaseRow } from "@/lib/db/types";
import { fromMicro, toMicro } from "@/lib/db/types";
import { inviteCodes, paymentNetworks } from "@/lib/env";
import { ApiError } from "@/lib/errors";
import { record } from "@/lib/events";
import { isPaused } from "@/lib/ops/switches";
import { archiveHostedRepo, commitLicenceFile, DeployKeyRejected, deleteHostedRepo, hostedRepoName, provisionHostedRepo, rotateDeployKey } from "@/lib/github/hosted";
import {
  installationAccount,
  REPO_ROLE_REQUIRED,
  repoById,
  resolveRepo,
  SELLING_ROLES,
  userCanSellRepo,
  userOwnsInstallation,
} from "@/lib/github/installations";
import { parseGithubRepoUrl } from "@/lib/github/public";
import { isAllowedSpdx, type AllowedSpdxId } from "@/lib/licences";
import { notifyAdmin } from "@/lib/notify";
import { cutRelease } from "@/lib/release";
import { normalizeReport } from "@/lib/scan/report";
import {
  CreatorScanReport,
  type CreatorScanReportOutput,
  DEFAULT_PRICE_MICRO,
  DEFAULT_UPDATE_PRICE_MICRO,
  MIN_PRICE_MICRO,
  micro,
  OPEN_RELEASE_MAX_DAYS,
  RESERVED_SLUGS,
  Slug,
  type CreateListingInput,
  type PatchListingInput,
  type SyncInput,
} from "@/lib/schemas";
import { removeArtifact } from "@/lib/storage";
import { endpointsFor, latestReleaseView, listingView, statusOf } from "./view";
import { notifyIndexNow } from "@/lib/indexnow";

/** D2c. Three unpublished listings per creator; the cap is the anti-spam mechanism. */
export const MAX_UNPUBLISHED_LISTINGS = 3;

/**
 * D2c. A listing gets one hosted repo. Nothing checks this at runtime because nothing
 * can violate it: a `listing` row holds a single `github_repo_id`. GitHub enforces the
 * key half of it (§14.6) — one public key cannot be a deploy key on two repositories.
 */
export const MAX_HOSTED_REPOS_PER_UNPUBLISHED_LISTING = 1;

export type PublishBlocking = "no_release" | "scan_pending" | "scan_failed" | "licence_block" | "description_missing" | "public_repo";

// ---------------------------------------------------------------------------
// Loading and ownership
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The creator's listing, or `not_found`.
 *
 * A malformed id, an id that does not exist and another creator's id all return the
 * same 404. That is deliberate: `403` on someone else's id would confirm it exists.
 */
export async function loadOwnedListing(creator: Pick<CreatorRow, "id">, listingId: string): Promise<ListingRow> {
  if (!UUID.test(listingId)) throw new ApiError("not_found");

  const { data, error } = await db().from("listing").select("*").eq("id", listingId).maybeSingle();
  if (error) throw error;

  const listing = data as ListingRow | null;
  if (!listing || listing.creator_id !== creator.id) throw new ApiError("not_found");
  return listing;
}

/** FR-43: retire is terminal, so every mutation after it is `410 retired`. */
function assertNotRetired(listing: ListingRow): void {
  if (listing.retired_at) {
    throw new ApiError("retired", { message: "This listing was retired. Retirement is terminal; create a new listing under a new slug." });
  }
}

/** FR-9: the newest release with `scan = pass`. Nothing else is sellable. */
async function latestPassingRelease(listingId: string): Promise<ReleaseRow | null> {
  const { data, error } = await db()
    .from("release")
    .select("*")
    .eq("listing_id", listingId)
    .eq("scan", "pass")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return ((data as ReleaseRow[] | null) ?? [])[0] ?? null;
}

/**
 * The newest release of any verdict, so a creator can read the report of the release that
 * *failed* ("PRD Trust Report.md" §4.4). `latestPassingRelease` deliberately cannot
 * answer this: the release that sells is the one whose report nobody needs.
 */
async function newestRelease(listingId: string): Promise<ReleaseRow | null> {
  const { data, error } = await db()
    .from("release")
    .select("*")
    .eq("listing_id", listingId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return ((data as ReleaseRow[] | null) ?? [])[0] ?? null;
}

/**
 * `release.scan_report` as the creator's `CreatorScanReport`, or null.
 *
 * Three defences, because this reads a jsonb column written by four scanner generations:
 * `normalizeReport` lifts a v1 row to v2 (and can throw on a blob that is neither),
 * `safeParse` drops one that still does not fit, and the zod object strips every key the
 * schema does not name — which is what keeps `checks[].socket_scan_id` out of a response
 * even though the stored row carries it (§4.2).
 */
function creatorScanReport(release: ReleaseRow | null): CreatorScanReportOutput | null {
  if (!release || !release.scan_report) return null;
  try {
    const normalised = normalizeReport(release.scan_report as Parameters<typeof normalizeReport>[0]);
    const parsed = CreatorScanReport.safeParse(normalised);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * §10. Analytics only; never in the request's critical path, never fatal.
 *
 * FR-61: the mutation records which kind of key authenticated it, so "did a human on the
 * dashboard or an agent retire this listing?" has an answer. `keyKind` is positional and
 * required rather than one more optional prop, because attribution that can be forgotten
 * is attribution that will be. It rides in the existing `props` jsonb — the amendment is
 * explicit that no domain table gains a column for this ("PRD Session Keys.md" FR-61).
 */
async function recordEvent(name: string, listingId: string, keyKind: ApiKeyKind, props?: Record<string, unknown>): Promise<void> {
  const { error } = await db()
    .from("event")
    .insert({ name, listing_id: listingId, props: { ...(props ?? {}), key_kind: keyKind }, chain_id: recordedChainId() });
  if (error) console.warn(`[listings] could not record ${name}:`, error.message);
  mirrorToVercel(name, { ...(props ?? {}), key_kind: keyKind });
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export type CreatedListing = ReturnType<typeof createListingResponse>;

function createListingResponse(listing: ListingRow, handle: string, remote: string | null, fingerprints: string[] | null, defaultBranch: string | null) {
  const view = listingView(listing, handle, null);
  return {
    listing_id: listing.id,
    owner: handle,
    slug: listing.slug,
    status: view.status,
    source: listing.source,
    remote,
    ssh_host_key_fingerprints: fingerprints ?? undefined,
    default_branch: defaultBranch ?? undefined,
    pricing: view.pricing,
    endpoints: view.endpoints,
  };
}

/**
 * FR-3, FR-7, D2c. Create a listing in `draft`.
 *
 * Rail B provisions the repo *before* the row is inserted, because a repo with no row
 * is a leak we can clean up and a row with no repo is a listing that can never be
 * pushed to. If the insert fails the repo is removed again.
 */
export async function createListing(creator: AuthedCreator, input: CreateListingInput) {
  const slug = Slug.parse(input.slug);
  await assertSlugAvailable(creator, slug);
  await assertUnpublishedCap(creator);

  const priceMicro = input.price_micro === undefined ? DEFAULT_PRICE_MICRO : micro.parse(input.price_micro);
  const updatePriceMicro = input.update_price_micro === undefined ? DEFAULT_UPDATE_PRICE_MICRO : micro.parse(input.update_price_micro);
  assertPrices(priceMicro, updatePriceMicro);
  // Before any repo is provisioned, so a refusal here has nothing to roll back.
  const offered = input.offered_networks === undefined ? null : offeredNetworksValue(creator, input.offered_networks);

  const row: Record<string, unknown> = {
    creator_id: creator.id,
    slug,
    source: input.source,
    // FR-12: whatever the caller asked for, to the micro-USDC. No rounding, ever.
    price_micro: fromMicro(priceMicro),
    update_price_micro: fromMicro(updatePriceMicro),
    description: input.description ?? null,
    trigger_hint: input.trigger_hint ?? null,
    // Only a narrowing is written; null is the column's default and means "every rail".
    ...(offered ? { offered_networks: offered } : {}),
  };

  let remote: string | null = null;
  let fingerprints: string[] | null = null;
  let defaultBranch: string | null = null;
  let provisioned: { org: string; name: string; deployKeyId: number } | null = null;
  // The repository being sold, so an open release cannot name it as the place it opens.
  let own: { owner: string; name: string } | null = null;

  if (input.source === "hosted") {
    if (!input.ssh_public_key) {
      throw new ApiError("invalid_request", {
        message: "`ssh_public_key` is required for a hosted listing: it becomes this repo's write deploy key.",
        details: { field: "ssh_public_key" },
      });
    }
    assertRailBAllowed(creator);

    const repo = await provisionHostedRepo({ handle: creator.handle, slug, sshPublicKey: input.ssh_public_key }).catch(rejectedKey);
    provisioned = { org: repo.org, name: repo.name, deployKeyId: repo.deployKeyId };

    row.installation_id = String(repo.installationId);
    row.github_repo_id = String(repo.repoId);
    row.deploy_key_id = String(repo.deployKeyId);
    row.hosted_org = repo.org;

    remote = repo.remote;
    fingerprints = repo.sshHostKeyFingerprints;
    defaultBranch = repo.defaultBranch;
    own = { owner: repo.org, name: repo.name };
  } else {
    const { installationId, repoId, owner, name } = await resolveRailARepo(creator, input);
    row.installation_id = String(installationId);
    row.github_repo_id = String(repoId);
    own = { owner, name };
  }

  // Open releases (25 Oct 2026): validated against the row about to be written. After
  // the repo is provisioned, because the check needs to know which repository is being
  // sold; a refusal here rolls the repo back below like any other failed insert would.
  if (hasOpenReleaseFields(input)) {
    try {
      Object.assign(row, openReleasePatch(null, input, own));
    } catch (e) {
      if (provisioned) await rollbackProvisioning(provisioned);
      throw e;
    }
  }

  const { data, error } = await db().from("listing").insert(row).select("*").single();
  if (error) {
    if (provisioned) await rollbackProvisioning(provisioned);
    // 23505 = unique_violation on (creator_id, slug): someone raced us to the slug.
    if (error.code === "23505") throw slugTaken(slug, false);
    throw error;
  }

  const listing = data as ListingRow;
  await recordEvent("listing_created", listing.id, creator.apiKey.kind, { source: listing.source, slug: listing.slug });

  // ADMIN-NOTIFICATIONS.md, 13 Sep 2026. Below the insert and below the rollback above:
  // an insert that failed took the hosted repo with it, and a phantom "new listing" for a
  // row that no longer exists is worse than no message. `rail` is D10's two rails, not the
  // `source` column — "hosted" is Rail B, anything else is a repo the creator owns.
  // Nothing here is a `visibility`: the `listing` table has no such column (PRD §12); a
  // listing is draft or live, which /admin already shows.
  await notifyAdmin({
    kind: "listing_created",
    listingId: listing.id,
    handle: creator.handle,
    slug: listing.slug,
    rail: listing.source === "hosted" ? "hosted" : "linked",
    priceMicro: toMicro(listing.price_micro),
  });

  return createListingResponse(listing, creator.handle, remote, fingerprints, defaultBranch);
}

/**
 * FR-3: unique per owner, and **never reused after retirement**. The unique index
 * enforces the first; the retired row staying put enforces the second, which is why
 * this reads the row rather than trusting the constraint alone — the message differs.
 */
async function assertSlugAvailable(creator: Pick<CreatorRow, "id">, slug: string): Promise<void> {
  if ((RESERVED_SLUGS as readonly string[]).includes(slug)) {
    throw new ApiError("invalid_request", { message: `\`${slug}\` is a reserved slug.`, details: { field: "slug", reserved: RESERVED_SLUGS } });
  }
  const { data, error } = await db().from("listing").select("*").eq("creator_id", creator.id).eq("slug", slug).maybeSingle();
  if (error) throw error;
  if (data) throw slugTaken(slug, Boolean((data as ListingRow).retired_at));
}

function slugTaken(slug: string, retired: boolean): ApiError {
  return new ApiError("invalid_request", {
    message: retired
      ? `\`${slug}\` belonged to a retired listing. Slugs are never reused (FR-3).`
      : `You already have a listing with the slug \`${slug}\`.`,
    details: { field: "slug", retired },
  });
}

/** D2c: three unpublished listings per creator. A retired draft does not count. */
async function assertUnpublishedCap(creator: Pick<CreatorRow, "id">): Promise<void> {
  const { data, error } = await db().from("listing").select("*").eq("creator_id", creator.id).is("published_at", null).is("retired_at", null);
  if (error) throw error;

  const unpublished = (data as ListingRow[] | null) ?? [];
  if (unpublished.length >= MAX_UNPUBLISHED_LISTINGS) {
    throw new ApiError("too_many_unpublished", {
      message: `You have ${unpublished.length} unpublished listings; the cap is ${MAX_UNPUBLISHED_LISTINGS}. Publish or retire one first.`,
      details: { unpublished: unpublished.length, max: MAX_UNPUBLISHED_LISTINGS },
    });
  }

  // D2c's second half — one hosted repo per unpublished listing — is enforced by the
  // shape of the table, not by a count here: a `listing` row holds a single
  // `github_repo_id`, so `hosted repos on unpublished listings <= unpublished listings`
  // is true by construction and the cap above is the only one that can bite. Counting
  // them and comparing against `3 × 1` was unreachable: the check above already returned
  // when there were three unpublished listings, so the count could never exceed two.
  // A dead branch is worse than no branch: it reads as a cap that is being enforced.
}

/**
 * D2c: Rail B registration requires an invite code in V0. The gate lives on
 * `POST /api/creators`, so by the time a creator asks for a hosted repo the proof they
 * passed it is `onboarded_via = "api"`. When no codes are configured there is no gate.
 */
function assertRailBAllowed(creator: Pick<CreatorRow, "onboarded_via">): void {
  if (inviteCodes().length === 0) return;
  if (creator.onboarded_via !== "api") {
    throw new ApiError("invite_required", {
      message: "Hosted repos (Rail B) are invite-only in V0. Register through POST /api/creators with an invite code.",
    });
  }
}

/** D2b: $0 or ≥ $0.01. The floor is technical and is never suggested (FR-12). */
function assertPrices(priceMicro: bigint, updatePriceMicro: bigint): void {
  if (priceMicro !== 0n && priceMicro < MIN_PRICE_MICRO) {
    throw new ApiError("invalid_request", { message: "`price_micro` must be 0 or at least 10000.", details: { field: "price_micro" } });
  }
  if (updatePriceMicro < 0n) {
    throw new ApiError("invalid_request", { message: "`update_price_micro` cannot be negative.", details: { field: "update_price_micro" } });
  }
}

/**
 * Rail A. Accepts `github_repo_id` directly or resolves `repo: "owner/name"` to one,
 * and refuses an installation that does not belong to this creator's GitHub account.
 *
 * The ownership check is **unconditional**. An installation id is a small integer any
 * caller can enumerate; without the check, one creator lists another's private repo
 * (the invariant `lib/github/installations.ts` exists for). A creator with no linked
 * GitHub identity therefore cannot create a Rail A listing at all — there is nothing
 * to verify the installation against — rather than skipping the verification.
 *
 * The failure is a 404, not a 403: confirming that an installation exists would let a
 * caller enumerate other people's installations.
 *
 * Owning the installation is not enough on its own (AUTH-2). For an org installation it
 * means only "is a member", and a member could otherwise list, snapshot and sell any
 * private repo the org granted the App — including ones they cannot read. So the repo
 * itself is checked too: the creator must hold `admin` or `maintain` on it, read live
 * from GitHub. Every failure of that check — a repo the installation cannot see, too
 * little access, GitHub not answering — is the same 404 with the same message, so the
 * answer never says whether a repo the caller cannot read exists. Visibility
 * (`public_repo`) is only reported to someone who passed it.
 */
async function resolveRailARepo(creator: CreatorRow, input: CreateListingInput): Promise<{ installationId: number; repoId: number; owner: string; name: string }> {
  if (creator.github_user_id === null || creator.github_user_id === undefined) {
    throw new ApiError("invalid_request", {
      message:
        "A github listing requires a linked GitHub identity, so the App installation can be verified as yours. Sign in with GitHub on the web dashboard to link one, or create a `hosted` listing instead.",
      details: { field: "source" },
    });
  }

  if (input.installation_id === undefined) {
    throw new ApiError("invalid_request", {
      message: "`installation_id` is required for a github listing. Install the GitHub App on the repo and pass its installation id.",
      details: { field: "installation_id" },
    });
  }
  const installationId = Number(input.installation_id);

  const account = await installationAccount(installationId);
  if (!(await userOwnsInstallation(creator.github_user_id, account))) {
    throw new ApiError("not_found", { message: "No such GitHub App installation for this account." });
  }

  if (input.github_repo_id === undefined && !input.repo) {
    throw new ApiError("invalid_request", {
      message: "Pass `github_repo_id`, or `repo` as \"owner/name\" and it will be resolved to one.",
      details: { field: "github_repo_id" },
    });
  }

  // Either way the repository is read from GitHub before the row is written, because
  // FR-10 needs its visibility and an id carries none. See `assertPrivate`.
  let resolved: Awaited<ReturnType<typeof repoById>>;
  try {
    resolved =
      input.github_repo_id !== undefined
        ? await repoById(installationId, Number(input.github_repo_id))
        : await resolveRepo(installationId, input.repo as string);
  } catch (e) {
    console.warn("[listings] could not read the repo for a new listing:", e instanceof Error ? e.message : String(e));
    throw repoRoleRequired();
  }

  // AUTH-2: the creator's role on this repo, before anything about the repo is reported.
  if (!(await userCanSellRepo(installationId, creator.github_user_id, { owner: resolved.owner, name: resolved.name }))) {
    throw repoRoleRequired();
  }

  assertPrivate(resolved);
  return { installationId, repoId: resolved.repoId, owner: resolved.owner, name: resolved.name };
}

/**
 * AUTH-2's one refusal, shared by listing creation and sync. A 404 like every other
 * ownership failure in this module, naming the role that is required and nothing else.
 */
function repoRoleRequired(): ApiError {
  return new ApiError("not_found", { message: REPO_ROLE_REQUIRED, details: { required_role: [...SELLING_ROLES] } });
}

/**
 * FR-10 as amended on 2026-08-30: private repositories only, on both rails.
 *
 * The picker on `/dashboard/new` only buttons private repos, and that is worth nothing
 * here — `POST /api/listings` is a creator endpoint an agent calls directly with any
 * `github_repo_id` it likes, so visibility is a fact read from GitHub, never a claim
 * taken from the request. Rail B does not go through this: the repos it provisions are
 * created private.
 */
function assertPrivate(repo: { owner: string; name: string; private: boolean }): void {
  if (repo.private) return;
  throw new ApiError("public_repo", {
    details: { repo: repo.owner && repo.name ? `${repo.owner}/${repo.name}` : undefined, visibility: "public" },
  });
}

/**
 * §14.6 / FR-33. A key GitHub will not take is a `400 invalid_request` naming the field,
 * not a `500`: "one public key, one repo" is the single mistake an agent with one SSH
 * key and two listings will make, and the error has to say so.
 */
function rejectedKey(e: unknown): never {
  if (e instanceof DeployKeyRejected) {
    throw new ApiError("invalid_request", {
      message: `GitHub rejected that public key: ${e.githubMessage} A deploy key can only be registered on one repository (§14.6), so generate a fresh key pair per listing.`,
      details: { field: "ssh_public_key" },
    });
  }
  throw e;
}

/** A provisioned repo with no row is a leak. Remove it, and never fail the caller for it. */
async function rollbackProvisioning(provisioned: { org: string; name: string; deployKeyId: number }): Promise<void> {
  try {
    await deleteHostedRepo({ owner: provisioned.org, repo: provisioned.name }, provisioned.deployKeyId);
  } catch (e) {
    console.error("[listings] orphaned hosted repo after a failed insert:", provisioned.name, e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * One listing, with the trust report on every release this creator can see here
 * ("PRD Trust Report.md" §4.4, accepted 13 Sep 2026).
 *
 * Two rows, not one: the release that sells (FR-9) and the newest release of any verdict.
 * They are usually the same row and then only `latest_release` is sent — printing the
 * same report twice would be the response answering one question in two voices. When
 * they differ, the second one is the interesting one: it is the release that failed, and
 * its report holds the path and line of the secret that failed it.
 *
 * The list route (`listListings`) does not carry reports. Forty listings would be forty
 * reports for a caller who asked for a table.
 */
export async function getListing(creator: CreatorRow, listingId: string) {
  const listing = await loadOwnedListing(creator, listingId);
  const [latest, newest] = await Promise.all([latestPassingRelease(listing.id), newestRelease(listing.id)]);
  const view = listingView(listing, creator.handle, latest, creator);
  return {
    ...view,
    latest_release: view.latest_release ? { ...view.latest_release, scan_report: creatorScanReport(latest) } : null,
    newest_release:
      newest && newest.id !== latest?.id
        ? { ...latestReleaseView(newest, creator.handle, listing.slug)!, scan_report: creatorScanReport(newest) }
        : null,
  };
}

export type ListListingsOptions = { limit?: number; cursor?: string | null };

/**
 * The creator's own listings, newest first. The cursor is the `created_at` of the last
 * row returned — opaque to the caller, and stable because it is only ever read back.
 */
export async function listListings(creator: CreatorRow, options: ListListingsOptions = {}) {
  // `?limit=abc` arrives as NaN; clamping it would leave NaN and PostgREST would answer
  // with an error the caller reads as `500 internal`. A junk limit is not a server fault.
  if (options.limit !== undefined && !Number.isFinite(options.limit)) {
    throw new ApiError("invalid_request", { message: "`limit` must be a number between 1 and 100.", details: { field: "limit" } });
  }
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 100);

  let query = db().from("listing").select("*").eq("creator_id", creator.id);
  if (options.cursor) query = query.lt("created_at", options.cursor);

  const { data, error } = await query.order("created_at", { ascending: false }).limit(limit + 1);
  if (error) throw error;

  const rows = (data as ListingRow[] | null) ?? [];
  const page = rows.slice(0, limit);
  const releases = await Promise.all(page.map((l) => latestPassingRelease(l.id)));

  return {
    listings: page.map((listing, i) => listingView(listing, creator.handle, releases[i], creator)),
    next_cursor: rows.length > limit ? new Date(page[page.length - 1].created_at).toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// Patch
// ---------------------------------------------------------------------------

/**
 * FR-12, FR-16. Price changes apply to future purchases only — existing holders keep
 * the terms stamped on their purchase row, which is why nothing here touches `purchase`.
 */
export async function patchListing(creator: CreatorRow, listingId: string, input: PatchListingInput) {
  const listing = await loadOwnedListing(creator, listingId);
  assertNotRetired(listing);

  const patch: Record<string, unknown> = {};

  if (input.price_micro !== undefined) {
    const value = micro.parse(input.price_micro);
    assertPrices(value, toMicro(listing.update_price_micro));
    patch.price_micro = fromMicro(value);
  }
  if (input.update_price_micro !== undefined) {
    const value = micro.parse(input.update_price_micro);
    assertPrices(toMicro(listing.price_micro), value);
    patch.update_price_micro = fromMicro(value);
  }
  if (input.description !== undefined) patch.description = input.description;
  if (input.trigger_hint !== undefined) patch.trigger_hint = input.trigger_hint;

  // Offered rails (25 Oct 2026). Omitted leaves them alone; null clears to "every rail".
  // A null onto a listing that already offers every rail writes nothing: the dashboard
  // sends null on every Save where every box is ticked, and that Save must not depend on
  // migration 20261025213000 having been pushed, or touch a column it does not change.
  const offeredSent = input.offered_networks !== undefined;
  if (offeredSent) {
    const offered = offeredNetworksValue(creator, input.offered_networks ?? null);
    const current = Array.isArray(listing.offered_networks) ? listing.offered_networks : null;
    if (offered !== null || current !== null) patch.offered_networks = offered;
  }

  // Open releases (25 Oct 2026). Only when one of the three fields is in the request:
  // the own-repo check may ask GitHub, and a price change should not.
  if (hasOpenReleaseFields(input)) Object.assign(patch, openReleasePatch(listing, input, await ownSourceRepo(creator, listing)));

  if (Object.keys(patch).length === 0) {
    // Asked for something that is already so: the answer is the listing as it stands.
    if (offeredSent) return listingView(listing, creator.handle, await latestPassingRelease(listing.id), creator);
    throw new ApiError("invalid_request", {
      message:
        "Nothing to change. Send at least one of price_micro, update_price_micro, description, trigger_hint, offered_networks, open_release, public_repo_url, open_after_days.",
    });
  }

  const { data, error } = await db().from("listing").update(patch).eq("id", listing.id).select("*").single();
  if (error) throw error;

  const updated = data as ListingRow;

  return listingView(updated, creator.handle, await latestPassingRelease(updated.id), creator);
}

// ---------------------------------------------------------------------------
// Offered rails (25 Oct 2026, HackMeridian; migration 20261025213000)
// ---------------------------------------------------------------------------

/**
 * `offered_networks` as it will be stored, or a refusal naming the field (founder, 25 Oct
 * 2026: a creator chooses, per listing, which of their ways to be paid it is sold on).
 *
 * - **null clears**: every rail the creator can be paid on, including ones bound or
 *   switched on later.
 * - **Served here.** Each network must be one this deployment runs (`paymentNetworks()`);
 *   anything else could never appear in a 402.
 * - **Reaches the creator.** An EVM network needs an EVM payout address and a Stellar one a
 *   Stellar address (JOURNEYS rule 4, `payoutRailsFor`). The 402 would drop such a rail
 *   anyway; the creator should hear it now, not find a listing sold on fewer rails than
 *   they ticked.
 * - **Not empty.** No offered rail is a listing off sale, and the way off sale is retire.
 *
 * Stored without repeats, in the deployment's rail order, so the row reads like the 402.
 */
export function offeredNetworksValue(creator: Pick<CreatorRow, "payout_address" | "stellar_payout_address">, input: string[] | null): string[] | null {
  if (input === null) return null;
  if (input.length === 0) {
    throw new ApiError("invalid_request", {
      message: "`offered_networks` cannot be empty. Offer at least one network, or send null to offer every rail you can be paid on.",
      details: { field: "offered_networks" },
    });
  }
  const served = paymentNetworks();
  const rails = payoutRailsFor(creator);
  for (const network of input) {
    if (!served.includes(network)) {
      throw new ApiError("invalid_request", {
        message: `\`offered_networks\`: ${network} is not a network this deployment serves. It serves ${served.join(", ")}.`,
        details: { field: "offered_networks", network },
      });
    }
    if (!rails.find((r) => r.network === network)?.address) {
      const family = network.startsWith("stellar:") ? "Stellar" : "EVM";
      throw new ApiError("invalid_request", {
        message: `\`offered_networks\`: ${chainLabel(network)} (${network}) pays out to a ${family} address, and you have none yet. Add one on the wallet page, or leave ${network} out.`,
        details: { field: "offered_networks", network },
      });
    }
  }
  const wanted = new Set(input);
  return served.filter((network) => wanted.has(network));
}

// ---------------------------------------------------------------------------
// Open releases (25 Oct 2026, HackMeridian; docs/HACKMERIDIAN-STRATEGY.md §6a)
// ---------------------------------------------------------------------------

type OpenReleaseInput = Pick<CreateListingInput, "open_release" | "public_repo_url" | "open_after_days">;

function hasOpenReleaseFields(input: OpenReleaseInput): boolean {
  return input.open_release !== undefined || input.public_repo_url !== undefined || input.open_after_days !== undefined;
}

/**
 * The open-release columns to write, validated against the row as it will stand after
 * the write (`current` is null on create). Two rules, each its own sentence:
 *
 * - **Not the repository being sold.** An open release is sold from a private mirror
 *   and opens into the project's own public repository (BUILD H6). Naming the sold repo
 *   as the place it opens would promise nothing.
 * - **Both fields, when it is on.** A promise with no place or no number of days is not
 *   one.
 *
 * `open_after_days` is a rule, not a date (founder, 25 Oct 2026): each cut stamps
 * `created_at + open_after_days` on its own release (lib/release/open.ts). So, like a
 * price (FR-16), changing it touches releases cut from now on and nothing already sold;
 * the only-earlier guard on a stamped `opens_at` lives on the release row, in the
 * database, and nothing here ever moves one.
 */
export function openReleasePatch(current: ListingRow | null, input: OpenReleaseInput, own: { owner: string; name: string } | null): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (input.open_release !== undefined) patch.open_release = input.open_release;
  if (input.public_repo_url !== undefined) patch.public_repo_url = input.public_repo_url;
  if (input.open_after_days !== undefined) patch.open_after_days = input.open_after_days;

  // `in`, not `??`: an explicit null in the request means "clear it", and `??` would read
  // that as "leave it alone" and quietly keep the old value.
  const after = {
    open_release: ("open_release" in patch ? patch.open_release : current?.open_release ?? false) as boolean,
    public_repo_url: ("public_repo_url" in patch ? patch.public_repo_url : current?.public_repo_url ?? null) as string | null,
    open_after_days: ("open_after_days" in patch ? patch.open_after_days : current?.open_after_days ?? null) as number | null,
  };

  if (after.public_repo_url && own) {
    const target = parseGithubRepoUrl(after.public_repo_url);
    if (target && target.owner.toLowerCase() === own.owner.toLowerCase() && target.name.toLowerCase() === own.name.toLowerCase()) {
      throw new ApiError("invalid_request", {
        message:
          "`public_repo_url` is the repository being sold. An open release is sold from a private repository and opens into a different, public one — list a private mirror and name the project's public repository here.",
        details: { field: "public_repo_url" },
      });
    }
  }

  if (after.open_release) {
    if (!after.public_repo_url) {
      throw new ApiError("invalid_request", {
        message: "`public_repo_url` is required for an open release: the https://github.com/owner/name the code goes public in.",
        details: { field: "public_repo_url" },
      });
    }
    if (!after.open_after_days) {
      throw new ApiError("invalid_request", {
        message: `\`open_after_days\` is required for an open release: how many days after each release is cut it goes public, 1 to ${OPEN_RELEASE_MAX_DAYS}.`,
        details: { field: "open_after_days" },
      });
    }
  }

  return patch;
}

/**
 * The repository this listing sells, as `owner/name`, or null when it cannot be known
 * right now. Rail B is the hosted org and the hosted name; Rail A is read from GitHub by
 * id. Fails open: a creator must be able to save a date while api.github.com is down,
 * and the cut re-checks the public repository against the sold commit anyway.
 */
async function ownSourceRepo(creator: Pick<CreatorRow, "handle">, listing: ListingRow): Promise<{ owner: string; name: string } | null> {
  if (listing.source === "hosted") {
    const org = listing.hosted_org;
    return org ? { owner: org, name: hostedRepoName(creator.handle, listing.slug) } : null;
  }
  if (!listing.installation_id || !listing.github_repo_id) return null;
  try {
    const repo = await repoById(listing.installation_id, listing.github_repo_id);
    return repo && typeof repo.owner === "string" && typeof repo.name === "string" ? { owner: repo.owner, name: repo.name } : null;
  } catch (e) {
    console.warn(`[listings] could not read the sold repo for ${listing.id}:`, e instanceof Error ? e.message : String(e));
    return null;
  }
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

/**
 * FR-42. `draft → live` needs a passing release, a resale-compatible licence and a
 * description. Everything that is missing comes back at once in `blocking[]`: an agent
 * that has to discover the requirements one 409 at a time is an agent that gives up.
 */
export async function publishListing(creator: AuthedCreator, listingId: string) {
  const listing = await loadOwnedListing(creator, listingId);
  assertNotRetired(listing);

  if (listing.published_at) {
    // Idempotent: publishing a live listing is not an error, it is a no-op.
    return { listing_id: listing.id, status: statusOf(listing), endpoints: endpointsFor(creator.handle, listing.slug), published_at: new Date(listing.published_at).toISOString() };
  }

  // §19 kill switch. Placed after the idempotent no-op above: re-publishing an
  // already-live listing changes nothing and stays a 200 while paused. What stops is a
  // genuine draft → live, which is the transition that puts new code on sale. This is
  // the one place both surfaces reach — the API route and the dashboard action, which
  // calls that route.
  if (await isPaused("publishing")) {
    await record({ name: "paused_block", listingId: listing.id, props: { switch: "publishing" } });
    throw new ApiError("paused");
  }

  const blocking = await publishBlockers(listing);
  if (blocking.length > 0) {
    throw new ApiError("listing_not_ready", {
      message: `This listing cannot go live yet: ${blocking.join(", ")}.`,
      details: { blocking },
    });
  }

  const publishedAt = new Date().toISOString();
  const { data, error } = await db().from("listing").update({ published_at: publishedAt }).eq("id", listing.id).select("*").single();
  if (error) throw error;

  const updated = data as ListingRow;
  await recordEvent("listing_published", updated.id, creator.apiKey.kind, { slug: updated.slug, source: updated.source });
  // The page just became real; tell the search engines rather than wait to be crawled.
  // Never fails the publish (lib/indexnow.ts).
  await notifyIndexNow([`/${creator.handle}/${updated.slug}`]);

  return {
    listing_id: updated.id,
    status: statusOf(updated),
    endpoints: endpointsFor(creator.handle, updated.slug),
    published_at: new Date(updated.published_at ?? publishedAt).toISOString(),
  };
}

/** Every reason this listing is not sellable, in the order a creator would fix them. */
export async function publishBlockers(listing: ListingRow): Promise<PublishBlocking[]> {
  const blocking: PublishBlocking[] = [];

  const { data, error } = await db().from("release").select("*").eq("listing_id", listing.id);
  if (error) throw error;
  const releases = (data as ReleaseRow[] | null) ?? [];

  // `scan_pending` and `scan_failed` are two different instructions, and until 2026-09-01
  // this said `scan_pending` for both. A terminal `fail` reported as "still scanning" tells
  // an agent to wait for something that will never happen, and tells a creator the one
  // thing that is not true — that there is nothing to do yet. `fail` is terminal (§12), so
  // the answer is a new version, not a retry. The dashboard has always drawn the
  // distinction (lib/web/loaders.ts); this is the API catching up to it.
  if (releases.length === 0) blocking.push("no_release");
  else if (!releases.some((r) => r.scan === "pass")) {
    blocking.push(releases.some((r) => r.scan === "fail") ? "scan_failed" : "scan_pending");
  }

  // The licence does not block publish. FR-42 required `pass` until 2026-09-02, when the
  // founder took the gate off for the first release: the verdict is still computed on
  // every cut and still shown on the manifest and the dashboard, but it stops preventing
  // anything (DECISIONS.md, "The licence gate is a signal, not a gate"). What it never
  // did was establish that the seller *owns* the code, which is the exposure D4 bounds —
  // so what it bought was never worth the listings it refused.

  // FR-51: both are required, and both are badged self_reported on the manifest.
  if (!listing.description || !listing.trigger_hint) blocking.push("description_missing");

  // FR-10: private only. Creation checked it; publish checks it again because
  // visibility belongs to the repository, not to the listing, and a creator can flip it
  // in the minutes between the two.
  if (await repoWentPublic(listing)) blocking.push("public_repo");

  return blocking;
}

/**
 * True only when GitHub says, right now, that a Rail A listing's repo is public.
 *
 * Fails open on purpose. A dead installation token or an hour of api.github.com being
 * unreachable must not turn a genuinely private listing into one that can never be
 * published — that is a phantom blocker with no action that clears it, and the creator
 * has no way to tell it apart from a real one. The creation-time gate already refused
 * the ordinary case; this only catches the repo that changed afterwards.
 */
async function repoWentPublic(listing: ListingRow): Promise<boolean> {
  if (listing.source !== "github") return false; // Rail B repos are private by construction.
  if (!listing.installation_id || !listing.github_repo_id) return false;

  try {
    const repo = await repoById(listing.installation_id, listing.github_repo_id);
    return !repo.private;
  } catch (e) {
    console.warn(`[listings] could not read repo visibility for ${listing.id}:`, e instanceof Error ? e.message : String(e));
    return false;
  }
}

// ---------------------------------------------------------------------------
// Retire
// ---------------------------------------------------------------------------

/**
 * FR-43. Stop selling. Holders keep every version they own (FR-19, FR-46), the manifest
 * and release log stay up, and a hosted repo is archived rather than deleted — read-only
 * is recoverable, gone is not.
 */
export async function retireListing(creator: AuthedCreator, listingId: string) {
  const listing = await loadOwnedListing(creator, listingId);
  assertNotRetired(listing);

  const retiredAt = new Date().toISOString();
  const { data, error } = await db().from("listing").update({ retired_at: retiredAt }).eq("id", listing.id).select("*").single();
  if (error) throw error;

  const ref = hostedRefFor(listing, creator.handle);
  if (ref) {
    try {
      await archiveHostedRepo(ref);
    } catch (e) {
      // The listing is retired either way. An un-archived repo is an ops chore.
      console.warn("[listings] could not archive the hosted repo:", e instanceof Error ? e.message : String(e));
    }
  }

  const updated = data as ListingRow;
  await recordEvent("listing_retired", updated.id, creator.apiKey.kind, { slug: updated.slug });
  // The page now says "no longer sold" and the offer is gone from its structured data;
  // an index that still shows it for sale is the wrong kind of discovery.
  await notifyIndexNow([`/${creator.handle}/${updated.slug}`]);

  return { listing_id: updated.id, status: statusOf(updated), retired_at: new Date(updated.retired_at ?? retiredAt).toISOString() };
}

// ---------------------------------------------------------------------------
// Delete the hosted repo
// ---------------------------------------------------------------------------

/**
 * FR-44. Remove the git repo and its deploy key. **Releases with at least one purchase
 * are retained** — they are the product, and FR-46 says a buyer never loses a purchased
 * version to a creator action. Releases nobody bought go, snapshot bytes included.
 *
 * Step-up is the route's job (FR-5); by the time this runs, the wallet has signed.
 */
export async function deleteListingRepo(creator: AuthedCreator, listingId: string) {
  const listing = await loadOwnedListing(creator, listingId);

  if (listing.source !== "hosted") {
    throw new ApiError("invalid_request", { message: "Only a hosted repo can be deleted here. A Rail A repo belongs to you, not to us." });
  }

  const ref = hostedRefFor(listing, creator.handle);
  let repoDeleted = false;
  if (ref) {
    await deleteHostedRepo(ref, listing.deploy_key_id);
    repoDeleted = true;
  }

  const { data: releaseData, error: releaseError } = await db().from("release").select("*").eq("listing_id", listing.id);
  if (releaseError) throw releaseError;
  const releases = (releaseData as ReleaseRow[] | null) ?? [];

  const { data: purchaseData, error: purchaseError } = await db().from("purchase").select("*").eq("listing_id", listing.id);
  if (purchaseError) throw purchaseError;
  const purchases = (purchaseData as PurchaseRow[] | null) ?? [];
  const soldReleaseIds = new Set(purchases.map((p) => p.release_id));

  /**
   * FR-16 / FR-46. A purchase made while the update price was $0 is stamped
   * `all_versions = true` — "lifetime, irrevocably". §12's access check reads
   * `release_id = N OR all_versions`, so that holder owns **every** release of this
   * listing, including ones no `purchase.release_id` points at and ones cut after they
   * bought. Matching on `release_id` alone would delete versions they own, which is the
   * one thing FR-46 forbids. One lifetime holder retains the whole set.
   */
  const lifetimeHolder = purchases.some((p) => p.all_versions);

  let deleted = 0;
  for (const release of releases) {
    if (lifetimeHolder || soldReleaseIds.has(release.id)) continue;
    if (release.storage_path) {
      try {
        await removeArtifact(release.storage_path);
      } catch (e) {
        console.warn("[listings] could not remove an artifact:", e instanceof Error ? e.message : String(e));
      }
    }
    const { error } = await db().from("release").delete().eq("id", release.id);
    if (error) throw error;
    deleted += 1;
  }

  const { error: clearError } = await db()
    .from("listing")
    .update({ github_repo_id: null, deploy_key_id: null, hosted_org: null })
    .eq("id", listing.id);
  if (clearError) throw clearError;

  await recordEvent("listing_repo_deleted", listing.id, creator.apiKey.kind, {
    releases_deleted: deleted,
    releases_retained: releases.length - deleted,
  });

  return {
    listing_id: listing.id,
    repo_deleted: repoDeleted,
    releases_retained: releases.length - deleted,
    releases_deleted: deleted,
  };
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/**
 * FR-8.2. Cut a version now, from a tag or a named ref. The pipeline
 * (`lib/release/cutRelease`) does the work; this maps its result onto the catalogue so
 * a caller sees the same codes here as on the webhook path.
 *
 * AUTH-2's snapshot-time check lives in `cutRelease`, not here, so that the webhook path
 * gets it too: a creator who has lost `admin`/`maintain` on the repo since listing it is
 * refused with the same 404 that listing creation gives, before any bytes are taken.
 */
export async function syncListing(creator: CreatorRow, listingId: string, input: SyncInput) {
  const listing = await loadOwnedListing(creator, listingId);
  assertNotRetired(listing);

  if (listing.github_repo_id === null) {
    throw new ApiError("not_found", { message: "This listing has no repository to sync from." });
  }

  const result = await cutRelease({ listingId: listing.id, ref: input.ref, version: input.version, notes: input.notes });
  if (!result.ok) throw releaseErrorFor(result.code, result.message);

  const release = result.release;
  return {
    release_id: release.id,
    version: release.version,
    scan: release.scan,
    git_ref: release.git_ref,
    commit_sha: release.commit_sha,
    created_at: new Date(release.created_at).toISOString(),
  };
}

function releaseErrorFor(code: "version_exists" | "repo_too_large" | "invalid_version" | "not_found" | "repo_role_required", message: string): ApiError {
  switch (code) {
    case "repo_role_required":
      return repoRoleRequired();
    case "version_exists":
      return new ApiError("version_exists", { message });
    case "repo_too_large":
      return new ApiError("repo_too_large", { message });
    case "invalid_version":
      return new ApiError("invalid_request", { message, details: { field: "version" } });
    case "not_found":
      return new ApiError("not_found", { message });
  }
}

// ---------------------------------------------------------------------------
// Licence
// ---------------------------------------------------------------------------

/**
 * FR-11, Rail B only. Commit an allow-listed LICENSE and record the verdict.
 *
 * Rail A repos are the creator's own: we read the licence they have, we do not write
 * one into their repository. D4 puts the attestation on the registering operator.
 */
export async function setListingLicence(creator: CreatorRow, listingId: string, spdx: string) {
  const listing = await loadOwnedListing(creator, listingId);
  assertNotRetired(listing);

  if (!isAllowedSpdx(spdx)) {
    throw new ApiError("invalid_request", { message: `\`${spdx}\` is not on the allow-list.`, details: { field: "spdx" } });
  }
  if (listing.source !== "hosted") {
    throw new ApiError("invalid_request", {
      message: "A LICENSE can only be committed to a hosted repo. On Rail A, commit one yourself and re-sync.",
    });
  }

  const ref = hostedRefFor(listing, creator.handle);
  if (!ref) throw new ApiError("not_found", { message: "This listing has no hosted repository." });

  const committed = await commitLicenceFile(ref, spdx as AllowedSpdxId, creator.handle);

  const { error } = await db().from("listing").update({ licence_spdx: spdx, licence_verdict: "pass" }).eq("id", listing.id);
  if (error) throw error;

  return { listing_id: listing.id, licence: { spdx, verdict: "pass" as const }, commit_sha: committed.commitSha || undefined };
}

// ---------------------------------------------------------------------------
// Deploy key rotation
// ---------------------------------------------------------------------------

/**
 * FR-7 / FR-5 / §14.6. One public key, one repo, so rotation is add-then-remove on this
 * repo alone. Step-up is the route's job.
 */
export async function rotateListingSshKey(creator: CreatorRow, listingId: string, sshPublicKey: string) {
  const listing = await loadOwnedListing(creator, listingId);
  assertNotRetired(listing);

  if (listing.source !== "hosted") {
    throw new ApiError("invalid_request", { message: "Deploy keys exist on hosted repos only. A Rail A repo uses the GitHub App installation." });
  }
  const ref = hostedRefFor(listing, creator.handle);
  if (!ref) throw new ApiError("not_found", { message: "This listing has no hosted repository." });

  const deployKeyId = await rotateDeployKey(ref, listing.deploy_key_id, sshPublicKey).catch(rejectedKey);

  const { error } = await db().from("listing").update({ deploy_key_id: String(deployKeyId) }).eq("id", listing.id);
  if (error) throw error;

  return { listing_id: listing.id, deploy_key_id: deployKeyId, fingerprint: sshKeyFingerprint(sshPublicKey) };
}

/**
 * The OpenSSH `SHA256:…` fingerprint of a public key, so a creator can check the key
 * that landed is the key they sent. Base64 body only; the comment is not part of it.
 */
export function sshKeyFingerprint(publicKey: string): string | undefined {
  const body = publicKey.trim().split(/\s+/)[1];
  if (!body) return undefined;
  try {
    return `SHA256:${createHash("sha256").update(Buffer.from(body, "base64")).digest("base64").replace(/=+$/, "")}`;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The hosted repo this listing points at, or null once FR-44 has deleted it. */
function hostedRefFor(listing: ListingRow, handle: string): { owner: string; repo: string } | null {
  if (listing.source !== "hosted" || listing.github_repo_id === null) return null;
  const org = listing.hosted_org;
  if (!org) return null;
  return { owner: org, repo: hostedRepoName(handle, listing.slug) };
}
