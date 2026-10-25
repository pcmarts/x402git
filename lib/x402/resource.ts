/**
 * lib/x402/resource.ts — the two responses `/api/r/*` can give, built once.
 *
 * `grantBody` is the 200 of FR-22; `paymentRequired` is the 402 of FR-21 with the body
 * *and* the `PAYMENT-REQUIRED` header, because §13 says both carry it. Neither decides
 * anything: the decision was `quote`, and the 402's contents came from
 * `toPaymentRequirements`, which is still the only place a 402 body is built.
 */

import { NextResponse } from "next/server";
import type { PaymentRequirements, Purchase, Release } from "@/lib/core/access";
import { downloadUrlForRelease } from "@/lib/core/access";
import { appUrl } from "@/lib/env";
import { ApiError, type ErrorCode } from "@/lib/errors";
import { ResourceGrantResponse } from "@/lib/schemas";
import { paymentRequiredHeaders } from "./server";

export type GrantContext = { owner: string; slug: string; allVersions: boolean };

/** The 200: a signed URL over the exact bytes that were scanned, and the hash to check it. */
export async function grantBody(release: Release, ctx: GrantContext, ttlSec?: number) {
  if (!release.storagePath || !release.artifactSha256) {
    throw new ApiError("not_found", { message: "That release has no stored artifact yet." });
  }
  const { url, artifactSha256, version, expiresAt } = await downloadUrlForRelease(release, ttlSec);
  const base = appUrl();
  return ResourceGrantResponse.parse({
    version,
    artifact_sha256: artifactSha256,
    download_url: url,
    expires_at: expiresAt.toISOString(),
    version_endpoint: `${base}/api/r/${ctx.owner}/${ctx.slug}/v/${version}`,
    manifest_url: `${base}/api/label/${ctx.owner}/${ctx.slug}`,
    all_versions: ctx.allVersions,
  });
}

export function grantContext(owner: string, slug: string, purchase: Purchase | null, updatePriceMicro: bigint): GrantContext {
  return { owner, slug, allVersions: purchase ? purchase.allVersions : updatePriceMicro === 0n };
}

/**
 * A 402 (or a 409 `price_changed`) that still tells the caller exactly how to pay.
 *
 * The body is the x402 envelope; the catalogue error, when there is one, rides in
 * `extra.error` and in the `x-error-code` header so a client that only reads the x402
 * shape still learns why. FR-33's `{ code, message, docs_url }` body is used for every
 * failure that is *not* a fresh quote.
 */
export function paymentRequired(requirements: PaymentRequirements, options: { status?: number; error?: string } = {}): NextResponse {
  const body = options.error ? { ...requirements.body, error: options.error } : requirements.body;
  return NextResponse.json(body, { status: options.status ?? 402, headers: paymentRequiredHeaders(body) });
}

/** A catalogue error that also carries a fresh 402 body, for the retryable money codes. */
export function paymentError(code: ErrorCode, requirements: PaymentRequirements, options: { message?: string; details?: unknown } = {}): NextResponse {
  const err = new ApiError(code, {
    message: options.message,
    details: { ...(options.details as Record<string, unknown> | undefined), payment_required: requirements.body },
  });
  return NextResponse.json(err.toBody(), { status: err.status, headers: paymentRequiredHeaders(requirements.body) });
}
