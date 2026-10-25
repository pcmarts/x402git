/**
 * POST /api/webhooks/github — FR-8.1, sync without polling.
 *
 * Five properties, in the order they are enforced:
 *
 * 1. **Signature.** `X-Hub-Signature-256` over the *raw* body, compared in constant
 *    time. A bad signature is the only 401 this route can return; everything after it
 *    is a 2xx, because a route that 500s teaches GitHub to disable the hook and the
 *    creator finds out days later that nothing has shipped.
 * 2. **Freshness.** Deliveries older than five minutes are refused (FR-8.1).
 * 3. **Dedupe.** `X-GitHub-Delivery` is inserted into `webhook_delivery`, which is
 *    `UNIQUE`; a redelivery therefore cannot cut a second release.
 * 4. **Resolution by id.** The listing is found by `installation.id` + `repository.id`,
 *    **never by name** (FR-8.1) — a rename must not silently orphan a listing, and a
 *    name is attacker-influenced in a way an id is not.
 * 5. **Work inline.** V0 has no queue (§11, "deliberately not in V0"). A cut runs
 *    inside the request under the function's 300s ceiling; GitHub's own redelivery and
 *    `POST /api/listings/:id/sync` are the recovery paths (FR-8.2).
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { hitLimit } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import type { ListingRow } from "@/lib/db/types";
import { env } from "@/lib/env";
import { ApiError, describeThrown, errorResponse } from "@/lib/errors";
import { cutRelease, recordEvent, versionFromRef } from "@/lib/release";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** §11: no queue in V0, so the cut runs inline. Vercel's ceiling is 300s. */
export const maxDuration = 300;

/** FR-8.1. */
export const MAX_DELIVERY_AGE_MS = 5 * 60 * 1000;

export async function POST(req: NextRequest): Promise<Response> {
  // The raw bytes, before any parsing: the HMAC is over exactly what GitHub sent.
  const raw = await req.text();

  const secret = env().GITHUB_APP_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[webhook] GITHUB_APP_WEBHOOK_SECRET is not set; refusing every delivery");
    return errorResponse(new ApiError("invalid_signature", { message: "Webhook verification is not configured." }));
  }
  if (!verifySignature(raw, req.headers.get("x-hub-signature-256"), secret)) {
    return errorResponse(new ApiError("invalid_signature", { message: "The webhook signature did not verify." }));
  }

  // Past this line every path is a 2xx.
  const event = req.headers.get("x-github-event") ?? "";
  const deliveryId = req.headers.get("x-github-delivery") ?? "";

  try {
    const payload = JSON.parse(raw) as WebhookPayload;

    if (event === "ping") return accepted(200, { ok: true, pong: true });

    const age = deliveryAge(event, payload);
    if (age !== null && age > MAX_DELIVERY_AGE_MS) {
      return accepted(202, { ok: false, reason: "stale_delivery", age_ms: age });
    }

    if (deliveryId) {
      const fresh = await claimDelivery(deliveryId);
      if (!fresh) return accepted(200, { ok: true, reason: "duplicate_delivery" });
    }

    switch (event) {
      case "push":
        return await handlePush(payload);
      case "release":
        return await handleRelease(payload);
      case "installation":
        return await handleInstallation(payload);
      case "installation_repositories":
        return await handleInstallationRepositories(payload);
      default:
        return accepted(202, { ok: true, reason: "ignored_event", event });
    }
  } catch (e) {
    // Never a 5xx: GitHub disables a hook that keeps failing, and the failure is ours.
    console.error("[webhook] delivery failed:", describeThrown(e));
    // FR-8.2 names GitHub's own redelivery as a recovery path, and Redeliver replays the
    // *same* `X-GitHub-Delivery`. Holding the claim after a failure would make that button
    // a permanent no-op, so a delivery that recorded nothing releases its claim. Dedupe
    // still protects every delivery that got as far as a release row.
    if (deliveryId) await releaseDelivery(deliveryId);
    return accepted(202, { ok: false, reason: "error", event });
  }
}

// --- events --------------------------------------------------------------------

async function handlePush(payload: WebhookPayload): Promise<Response> {
  const ref = payload.ref ?? "";
  if (!ref.startsWith("refs/tags/")) return accepted(202, { ok: true, reason: "not_a_tag", ref });
  if (payload.deleted) return accepted(202, { ok: true, reason: "tag_deleted", ref });

  const version = versionFromRef(ref);
  if (!version) return accepted(202, { ok: true, reason: "not_a_version_tag", ref });

  const listings = await resolveListings(payload);
  if (listings.length === 0) return unknownListing(payload);

  // §9: 20 pushes/hour/repo. One delivery is one push however many listings it feeds, so
  // this is hit once, not per listing. Over the limit is still a 2xx — GitHub is not the abuser.
  const limit = await hitLimit("push", String(payload.repository?.id ?? listings[0].id));
  if (!limit.allowed) {
    for (const listing of listings) await recordEvent("release_failed", listing.id, { version, error: "rate_limited" });
    return accepted(202, { ok: false, reason: "rate_limited", retry_after_seconds: limit.retryAfterSeconds });
  }

  return cutResponse(await cutAll(listings, ref), version);
}

async function handleRelease(payload: WebhookPayload): Promise<Response> {
  if (payload.action !== "published") return accepted(202, { ok: true, reason: "ignored_action", action: payload.action });
  const tag = payload.release?.tag_name;
  if (!tag) return accepted(202, { ok: true, reason: "no_tag" });
  const version = versionFromRef(tag);
  if (!version) return accepted(202, { ok: true, reason: "not_a_version_tag", ref: tag });

  const listings = await resolveListings(payload);
  if (listings.length === 0) return unknownListing(payload);

  return cutResponse(await cutAll(listings, tag), version);
}

/**
 * Cut `ref` for each listing. One listing's failure never denies the others their release,
 * so the pipeline runs per listing and the outcomes are reported together.
 */
async function cutAll(listings: ListingRow[], ref: string): Promise<Array<{ listingId: string; result: Awaited<ReturnType<typeof cutRelease>> }>> {
  const results = [];
  for (const listing of listings) {
    results.push({ listingId: listing.id, result: await cutRelease({ listingId: listing.id, ref }) });
  }
  return results;
}

/**
 * FR-43: uninstalling the App on Rail A retires the listing.
 *
 * `deleted` only. A `suspend` is reversible on GitHub's side and retirement is terminal
 * (FR-42), so treating a suspension as an uninstall would turn a recoverable action into
 * an unrecoverable one. A suspended installation simply stops cutting releases, because
 * the token mint fails.
 */
async function handleInstallation(payload: WebhookPayload): Promise<Response> {
  if (payload.action !== "deleted") {
    return accepted(202, { ok: true, reason: "ignored_action", action: payload.action });
  }
  const installationId = payload.installation?.id;
  if (!installationId) return accepted(202, { ok: true, reason: "no_installation" });

  const retired = await retireListings({ installationId }, () => true);
  return accepted(200, { ok: true, retired });
}

/** FR-43: removing the repo from the installation is the same event for one listing. */
async function handleInstallationRepositories(payload: WebhookPayload): Promise<Response> {
  if (payload.action !== "removed") return accepted(202, { ok: true, reason: "ignored_action", action: payload.action });
  const removed = new Set((payload.repositories_removed ?? []).map((r) => String(r.id)));
  const installationId = payload.installation?.id;
  if (removed.size === 0) return accepted(202, { ok: true, reason: "nothing_removed" });

  const retired = await retireListings({ installationId }, (l) => removed.has(String(l.github_repo_id)));
  return accepted(200, { ok: true, retired });
}

// --- plumbing -------------------------------------------------------------------

/** Constant-time comparison. A length mismatch is answered without a compare. */
export function verifySignature(raw: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(raw, "utf8").digest("hex")}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * How old the delivery is, in milliseconds, or null when the payload carries no usable
 * timestamp. **Null is accepted**: refusing every event we cannot date would drop
 * `installation_repositories` and any future event type, and the delivery id already
 * makes a replay a no-op.
 */
export function deliveryAge(event: string, payload: WebhookPayload, now = Date.now()): number | null {
  const stamp =
    event === "push"
      ? // `repository.pushed_at` is the time of *this push*; `head_commit.timestamp` is the
        // time the commit was authored, which for `git tag v1.0.0 <old-sha>` can be months
        // ago. Reading the commit first refused every tag cut against an older commit as
        // `stale_delivery`, which is not what FR-8.1's five minutes means.
        (payload.repository?.pushed_at ?? payload.head_commit?.timestamp ?? null)
      : event === "release"
        ? (payload.release?.published_at ?? payload.release?.created_at ?? null)
        : event === "installation"
          ? (payload.installation?.updated_at ?? payload.installation?.created_at ?? null)
          : null;
  if (stamp === null || stamp === undefined) return null;
  // `pushed_at` is epoch seconds on the repository object and ISO-8601 everywhere else.
  const ms = typeof stamp === "number" ? stamp * 1000 : Date.parse(stamp);
  if (!Number.isFinite(ms)) return null;
  return now - ms;
}

/** Insert the delivery id. `false` means we have already handled this delivery. */
async function claimDelivery(deliveryId: string): Promise<boolean> {
  const { error } = await db().from("webhook_delivery").insert({ delivery_id: deliveryId });
  if (!error) return true;
  if (error.code === "23505") return false;
  // A broken dedupe table must not stop releases; the version UNIQUE still protects us.
  console.warn("[webhook] delivery dedupe unavailable:", error.message);
  return true;
}

/** Give the delivery id back, so GitHub's Redeliver can retry a delivery that did nothing. */
async function releaseDelivery(deliveryId: string): Promise<void> {
  try {
    await db().from("webhook_delivery").delete().eq("delivery_id", deliveryId);
  } catch (e) {
    console.warn("[webhook] could not release the delivery claim:", e instanceof Error ? e.message : String(e));
  }
}

/** FR-8.1: by `installation.id` + `repository.id`, never by name. */
/**
 * Every live listing bound to the pushed repository, oldest first.
 *
 * **Plural, and it has to be.** Nothing stops one repo from backing several listings —
 * the only uniqueness in §12 is `(creator_id, slug)` — so an installation id and a repo id
 * can legitimately match more than one row. This used to end in `.maybeSingle()`, which
 * makes PostgREST *error* on a second row rather than return it, and the throw was caught
 * by the handler's catch-all. The visible result was a `202 {"ok":false,"reason":"error"}`
 * on every tag push to that repo and no release for any of the listings — a repo that
 * silently stopped producing releases the moment it was listed twice. Measured on
 * production: `pcmarts/x402git-e2e-rail-a` had accumulated several listings across FR-34
 * runs and had stopped cutting releases entirely.
 */
async function resolveListings(payload: WebhookPayload): Promise<ListingRow[]> {
  const installationId = payload.installation?.id;
  const repositoryId = payload.repository?.id;
  if (!installationId || !repositoryId) return [];

  const { data, error } = await db()
    .from("listing")
    .select("*")
    .eq("installation_id", String(installationId))
    .eq("github_repo_id", String(repositoryId))
    .is("retired_at", null)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data as ListingRow[] | null) ?? [];
}

/**
 * Retire the listings of one installation. The installation is a **query filter**, not a
 * JS predicate: retiring is a whole-table read otherwise, and a webhook must not scan every
 * listing on the platform to answer a single uninstall.
 */
async function retireListings(
  scope: { installationId?: number },
  predicate: (listing: ListingRow) => boolean,
): Promise<number> {
  if (!scope.installationId) return 0;
  const { data, error } = await db()
    .from("listing")
    .select("*")
    .eq("installation_id", String(scope.installationId))
    .is("retired_at", null);
  if (error) throw error;
  const affected = ((data ?? []) as ListingRow[]).filter(predicate);
  const now = new Date().toISOString();
  for (const listing of affected) {
    await db().from("listing").update({ retired_at: now }).eq("id", listing.id);
    await recordEvent("listing_retired", listing.id, { reason: "installation_removed" });
  }
  return affected.length;
}

/**
 * 200 when at least one release was cut, 202 otherwise — `version_exists` is the normal
 * answer to a redelivery or a re-tag (FR-9), not a failure. The single-listing body is
 * unchanged; a repo backing several listings gets a `results[]` beside it.
 */
function cutResponse(cuts: Array<{ listingId: string; result: Awaited<ReturnType<typeof cutRelease>> }>, version: string): Response {
  const first = cuts[0].result;
  const body: Record<string, unknown> = first.ok
    ? { ok: true, version, release_id: first.release.id, scan: first.release.scan }
    : { ok: false, reason: first.code, version, message: first.message };

  if (cuts.length > 1) {
    body.ok = cuts.some((c) => c.result.ok);
    body.results = cuts.map((c) => ({
      listing_id: c.listingId,
      ...(c.result.ok ? { release_id: c.result.release.id, scan: c.result.release.scan } : { reason: c.result.code, message: c.result.message }),
    }));
  }

  return accepted(cuts.some((c) => c.result.ok) ? 200 : 202, body);
}

/** An unknown listing is logged and accepted (202), never an error (FR-8.1). */
function unknownListing(payload: WebhookPayload): Response {
  console.info("[webhook] no listing for installation=%s repo=%s", payload.installation?.id, payload.repository?.id);
  return accepted(202, { ok: true, reason: "unknown_listing" });
}

function accepted(status: number, body: Record<string, unknown>): Response {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

// --- payload ---------------------------------------------------------------------

export type WebhookPayload = {
  action?: string;
  ref?: string;
  deleted?: boolean;
  head_commit?: { timestamp?: string } | null;
  installation?: { id?: number; created_at?: string | number; updated_at?: string | number };
  repository?: { id?: number; pushed_at?: string | number; name?: string; full_name?: string };
  repositories_removed?: { id?: number; name?: string }[];
  release?: { tag_name?: string; published_at?: string; created_at?: string; body?: string | null; draft?: boolean };
};
