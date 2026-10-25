/**
 * lib/test/listings-fixtures.ts — the shared setup for the `app/api/listings/**` tests.
 *
 * Seven route files need the same three things: a creator with a live `api_key` row that
 * `requireCreator` will accept (FR-54 — the key is its own row now), a listing row that
 * belongs to them, and a `NextRequest` carrying the bearer token. Duplicating that seven
 * times is how the seventh copy ends up subtly different from the first.
 *
 *   const mock = makeMockDb();
 *   setDb(mock.client as unknown as Db);
 *   const creator = seedCreator(mock);
 *   const listing = seedListing(mock, creator, { source: "hosted", hosted_org: "x402git-hosted-01" });
 *   const res = await GET(req(`/api/listings/${listing.id}`), ctx(listing.id));
 */

import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { hashApiKey } from "@/lib/auth/api-key";
import type { MockDb, Row } from "@/lib/test/mock-db";

/** A syntactically valid agent key (`x4c_live_` + 32 base62), so `looksLikeApiKey` passes. */
export const TEST_API_KEY = `x4c_live_${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6"}`;

/** A second agent key, for the "this listing belongs to someone else" cases. */
export const OTHER_API_KEY = `x4c_live_${"z9Y8x7W6v5U4t3S2r1Q0p9O8n7M6l5K4"}`;

/** A session key (FR-60: `x4s_live_`), for the paths that care which kind authenticated. */
export const TEST_SESSION_KEY = `x4s_live_${"S1e2s3S4i5O6n7K8e9Y0a1B2c3D4e5F6"}`;

export const TEST_ADDRESS = "0x00000000000000000000000000000000000000a1";

/**
 * A creator plus the live `agent` key row that authenticates them (FR-54). Pass a
 * different plaintext for a second creator, or `null` for a creator with no key at all.
 */
export function seedCreator(mock: MockDb, overrides: Row = {}, key: string | null = TEST_API_KEY): Row {
  const creator: Row = {
    id: randomUUID(),
    handle: "a1b2c3",
    onboarded_via: "api",
    wallet_mode: "linked",
    payout_address: TEST_ADDRESS,
    terms_version: "2026-08-29",
    ...overrides,
  };
  mock.rows("creator").push({ ...defaultCreatorColumns(), ...creator });
  if (key !== null) seedApiKey(mock, creator.id, { hash: hashApiKey(key) });
  return creator;
}

/** One `api_key` row. Defaults to a live agent key with both scopes. */
export function seedApiKey(mock: MockDb, creatorId: string, overrides: Row = {}): Row {
  const row: Row = {
    id: randomUUID(),
    creator_id: creatorId,
    kind: "agent",
    hash: hashApiKey(TEST_API_KEY),
    scopes: ["listings:write", "earnings:read"],
    created_at: new Date().toISOString(),
    expires_at: null,
    revoked_at: null,
    revoked_reason: null,
    last_used_at: null,
    ...overrides,
  };
  mock.rows("api_key").push(row);
  return row;
}

function defaultCreatorColumns(): Row {
  const now = new Date().toISOString();
  return {
    // A linked GitHub identity, matching the installation the Rail A fixtures mock.
    // Rail A refuses a creator without one (the installation-ownership check needs an
    // account to verify against); the test for that overrides this back to null.
    github_user_id: "1234",
    cdp_wallet_id: null,
    pending_payout_address: null,
    rebind_effective_at: null,
    abuse_contact_url: null,
    abuse_contact_email: null,
    pending_abuse_contact_url: null,
    pending_abuse_contact_email: null,
    abuse_contact_effective_at: null,
    terms_accepted_at: now,
    created_at: now,
  };
}

export function seedListing(mock: MockDb, creator: Row, overrides: Row = {}): Row {
  const now = new Date().toISOString();
  const listing: Row = {
    id: randomUUID(),
    creator_id: creator.id,
    slug: "humanizer",
    source: "github",
    installation_id: "42",
    github_repo_id: "777",
    deploy_key_id: null,
    hosted_org: null,
    price_micro: "9000000",
    update_price_micro: "5000000",
    description: null,
    trigger_hint: null,
    licence_spdx: null,
    licence_verdict: null,
    published_at: null,
    retired_at: null,
    created_at: now,
    ...overrides,
  };
  mock.rows("listing").push(listing);
  return listing;
}

export function seedRelease(mock: MockDb, listing: Row, overrides: Row = {}): Row {
  const release: Row = {
    id: randomUUID(),
    listing_id: listing.id,
    version: "1.0.0",
    git_ref: "refs/tags/v1.0.0",
    commit_sha: "a".repeat(40),
    artifact_sha256: "b".repeat(64),
    storage_path: `${"a1b2c3"}/${listing.slug}/1.0.0.zip`,
    size_bytes: "1024",
    scan: "pass",
    scan_report: null,
    scanner_version: "0.1.0",
    manifest: null,
    changelog: null,
    diff_summary: null,
    price_micro_at_publish: listing.price_micro,
    update_price_micro_at_publish: listing.update_price_micro,
    analyzer_version: "0.1.0",
    created_at: new Date().toISOString(),
    ...overrides,
  };
  mock.rows("release").push(release);
  return release;
}

export function seedPurchase(mock: MockDb, listing: Row, release: Row, overrides: Row = {}): Row {
  const purchase: Row = {
    id: randomUUID(),
    listing_id: listing.id,
    release_id: release.id,
    buyer_address: "0x00000000000000000000000000000000000000b2",
    all_versions: false,
    update_price_at_purchase: listing.update_price_micro,
    kind: "new",
    source: "api",
    gross_micro: listing.price_micro,
    fee_micro: "900000",
    net_micro: "8100000",
    tx_hash: "0x" + "c".repeat(64),
    payment_nonce: randomUUID(),
    granted_at: new Date().toISOString(),
    holdback_until: new Date(Date.now() + 7 * 86400_000).toISOString(),
    payout_id: null,
    revoked_at: null,
    ...overrides,
  };
  mock.rows("purchase").push(purchase);
  return purchase;
}

type RequestInitLike = { method?: string; body?: unknown; key?: string | null; headers?: Record<string, string> };

/** A request to `path`, authenticated with `TEST_API_KEY` unless `key` says otherwise. */
export function req(path: string, init: RequestInitLike = {}): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json", ...(init.headers ?? {}) };
  const key = init.key === undefined ? TEST_API_KEY : init.key;
  if (key !== null) headers.authorization = `Bearer ${key}`;

  return new NextRequest(`https://x402git.com${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

/** The Next 16 route context: `params` is a promise. */
export function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}
