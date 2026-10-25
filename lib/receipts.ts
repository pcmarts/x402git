/**
 * lib/receipts.ts — a buyer's receipt: the purchase row, said in full, behind a
 * capability link.
 *
 * Until 2026-08-30 a purchase produced an entitlement row and nothing a buyer could look
 * at, link to or expense. The payment is already public on-chain, so the receipt is not
 * a new fact; it is the join a buyer would otherwise make by hand — tx hash to listing
 * to version to the sha256 of the bytes they were sold.
 *
 * **Access is a capability URL, not a session.** `GET /api/entitlements` answers only to
 * a wallet signature (FR-32, FR-40), and it is the one place `receipt_url` is minted, so
 * a receipt link starts in the hands of the wallet that paid. The token is an HMAC of
 * the purchase id under a key derived from the session secret: unguessable, stateless,
 * and — like a Gumroad receipt link — shareable by choice. Whoever holds the link can
 * read the receipt; nobody can enumerate them. A creator never receives one, because
 * `/api/earnings` carries neither the purchase id nor the token (FR-40).
 *
 * Nothing here decides a price or grants anything. The download itself still goes
 * through `/purchases` and a fresh wallet signature (FR-19).
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { type Purchase, toPurchase } from "@/lib/core/access";
import { db } from "@/lib/db";
import type { CreatorRow, ListingRow, PurchaseRow, ReleaseRow } from "@/lib/db/types";
import { appUrl, sessionSecret } from "@/lib/env";

const TOKEN_LENGTH = 32;

function receiptKey(): Buffer {
  return createHash("sha256").update(`x402git:receipt:${sessionSecret()}`, "utf8").digest();
}

/** The capability half of a receipt URL. Deterministic, so a lost link can be re-read from `/purchases`. */
export function receiptToken(purchaseId: string): string {
  return createHmac("sha256", receiptKey()).update(purchaseId, "utf8").digest("base64url").slice(0, TOKEN_LENGTH);
}

export function verifyReceiptToken(purchaseId: string, token: string | null | undefined): boolean {
  if (!token || token.length !== TOKEN_LENGTH) return false;
  const expected = Buffer.from(receiptToken(purchaseId), "utf8");
  const given = Buffer.from(token, "utf8");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function receiptPath(purchaseId: string): string {
  return `/receipts/${purchaseId}?t=${receiptToken(purchaseId)}`;
}

export function receiptUrl(purchaseId: string): string {
  return `${appUrl()}${receiptPath(purchaseId)}`;
}

export type Receipt = {
  purchase: Purchase;
  owner: string;
  slug: string;
  listing: Pick<ListingRow, "retired_at" | "published_at" | "licence_spdx">;
  release: Pick<ReleaseRow, "version" | "commit_sha" | "artifact_sha256" | "size_bytes" | "scanner_version" | "created_at">;
  /** The licence as it stood in the release that was sold, falling back to the listing's current one. */
  licenceSpdx: string | null;
};

/** The joined receipt, or null when any part of it is missing. Does not check the token. */
export async function loadReceipt(purchaseId: string): Promise<Receipt | null> {
  const { data: purchaseData, error: purchaseError } = await db().from("purchase").select("*").eq("id", purchaseId).limit(1);
  if (purchaseError) throw purchaseError;
  const purchaseRow = ((purchaseData as PurchaseRow[] | null) ?? [])[0];
  if (!purchaseRow) return null;

  const { data: listingData, error: listingError } = await db().from("listing").select("*").eq("id", purchaseRow.listing_id).limit(1);
  if (listingError) throw listingError;
  const listing = ((listingData as ListingRow[] | null) ?? [])[0];
  if (!listing) return null;

  const { data: releaseData, error: releaseError } = await db().from("release").select("*").eq("id", purchaseRow.release_id).limit(1);
  if (releaseError) throw releaseError;
  const release = ((releaseData as ReleaseRow[] | null) ?? [])[0];
  if (!release) return null;

  const { data: creatorData, error: creatorError } = await db().from("creator").select("*").eq("id", listing.creator_id).limit(1);
  if (creatorError) throw creatorError;
  const creator = ((creatorData as CreatorRow[] | null) ?? [])[0];
  if (!creator) return null;

  const manifest = (release.manifest ?? null) as { licence?: { spdx?: string | null } } | null;
  const licenceSpdx = manifest?.licence?.spdx ?? listing.licence_spdx ?? null;

  return {
    purchase: toPurchase(purchaseRow),
    owner: creator.handle,
    slug: listing.slug,
    listing: { retired_at: listing.retired_at, published_at: listing.published_at, licence_spdx: listing.licence_spdx },
    release: {
      version: release.version,
      commit_sha: release.commit_sha,
      artifact_sha256: release.artifact_sha256,
      size_bytes: release.size_bytes,
      scanner_version: release.scanner_version,
      created_at: release.created_at,
    },
    licenceSpdx,
  };
}
