/**
 * lib/test/fixtures.ts — a listing with releases, seeded into the mock DB.
 *
 * Every money test needs the same four rows (creator, listing, release, artifact bytes)
 * and differs only in prices and history, so they are built here rather than copied.
 * The artifact is written into the mock storage bucket because a 200 from `/api/r` is a
 * signed URL, and `createSignedUrl` refuses a path that does not exist — which is the
 * behaviour we want a test to feel.
 */

import { randomUUID } from "node:crypto";
import { ARTIFACT_BUCKET } from "@/lib/db";
import type { MockDb } from "./mock-db";

export const SHA = (seed: string) => seed.padEnd(64, "0").slice(0, 64).replace(/[^0-9a-f]/g, "a");

export type SeedRelease = {
  version: string;
  createdAt?: string;
  scan?: "pending" | "pass" | "fail";
  changelog?: string;
  priceMicro?: string;
  updatePriceMicro?: string;
};

export type SeedListing = {
  owner?: string;
  slug?: string;
  priceMicro?: string;
  updatePriceMicro?: string;
  published?: boolean;
  retired?: boolean;
  payoutAddress?: string;
  /** The hash of the creator's live `agent` key (FR-54): seeded into `api_key`. */
  apiKeyHash?: string;
  releases?: SeedRelease[];
};

export type SeededListing = {
  creatorId: string;
  listingId: string;
  owner: string;
  slug: string;
  releases: { id: string; version: string; storagePath: string; artifactSha256: string }[];
  /** The newest release seeded, which is what `/api/r` sells. */
  latest: { id: string; version: string; storagePath: string; artifactSha256: string };
};

export function seedListing(mock: MockDb, input: SeedListing = {}): SeededListing {
  const owner = input.owner ?? "adrian";
  const slug = input.slug ?? "humanizer";
  const creatorId = randomUUID();
  const listingId = randomUUID();
  const now = Date.now();

  mock.rows("creator").push({
    id: creatorId,
    handle: owner,
    github_user_id: null,
    onboarded_via: "api",
    wallet_mode: "linked",
    payout_address: (input.payoutAddress ?? "0x2222222222222222222222222222222222222222").toLowerCase(),
    cdp_wallet_id: null,
    pending_payout_address: null,
    rebind_effective_at: null,
    abuse_contact_url: null,
    abuse_contact_email: null,
    pending_abuse_contact_url: null,
    pending_abuse_contact_email: null,
    abuse_contact_effective_at: null,
    terms_version: "2026-08-29",
    terms_accepted_at: new Date(now).toISOString(),
    created_at: new Date(now).toISOString(),
  });

  // FR-54: keys live in `api_key`, so a creator that is meant to authenticate needs a
  // live agent row. The default hash matches no plaintext, which is what the tests that
  // never send a bearer token want.
  mock.rows("api_key").push({
    id: randomUUID(),
    creator_id: creatorId,
    kind: "agent",
    hash: input.apiKeyHash ?? `hash-${creatorId}`,
    scopes: ["listings:write", "earnings:read"],
    created_at: new Date(now).toISOString(),
    expires_at: null,
    revoked_at: null,
    revoked_reason: null,
    last_used_at: null,
  });

  mock.rows("listing").push({
    id: listingId,
    creator_id: creatorId,
    slug,
    source: "hosted",
    installation_id: null,
    github_repo_id: null,
    deploy_key_id: null,
    price_micro: input.priceMicro ?? "9000000",
    update_price_micro: input.updatePriceMicro ?? "3000000",
    description: "Strips AI tells from prose.",
    trigger_hint: "when the draft sounds like a model wrote it",
    licence_spdx: "MIT",
    licence_verdict: "pass",
    published_at: input.published === false ? null : new Date(now).toISOString(),
    retired_at: input.retired ? new Date(now).toISOString() : null,
    created_at: new Date(now).toISOString(),
  });

  const specs = input.releases ?? [{ version: "1.0.0" }];
  const releases = specs.map((spec, index) => {
    const id = randomUUID();
    const storagePath = `${owner}/${slug}/${spec.version}.zip`;
    const artifactSha256 = SHA(`${spec.version.replace(/\./g, "")}`);
    mock.rows("release").push({
      id,
      listing_id: listingId,
      version: spec.version,
      git_ref: `refs/tags/v${spec.version}`,
      commit_sha: "0".repeat(40),
      artifact_sha256: artifactSha256,
      storage_path: storagePath,
      size_bytes: "1024",
      scan: spec.scan ?? "pass",
      scan_report: null,
      scanner_version: "2026.08.2",
      manifest: { kind: "Harness" },
      changelog: spec.changelog ?? null,
      diff_summary: null,
      price_micro_at_publish: spec.priceMicro ?? input.priceMicro ?? "9000000",
      update_price_micro_at_publish: spec.updatePriceMicro ?? input.updatePriceMicro ?? "3000000",
      analyzer_version: "0.1.0",
      created_at: spec.createdAt ?? new Date(now - (specs.length - index) * 86_400_000).toISOString(),
    });
    void mock.client.storage.from(ARTIFACT_BUCKET).upload(storagePath, new Uint8Array([1, 2, 3]), { upsert: true });
    return { id, version: spec.version, storagePath, artifactSha256 };
  });

  const passing = releases.filter((r, i) => (specs[i].scan ?? "pass") === "pass");
  return { creatorId, listingId, owner, slug, releases, latest: passing[passing.length - 1] ?? releases[releases.length - 1] };
}

export type SeedPurchase = {
  listingId: string;
  releaseId: string;
  buyer: string;
  allVersions?: boolean;
  updatePriceAtPurchase?: string;
  grossMicro?: string;
  kind?: "new" | "update" | "free";
  grantedAt?: string;
  holdbackUntil?: string;
  nonce?: string;
  payoutId?: string | null;
  revokedAt?: string | null;
  chainId?: number;
};

export function seedPurchase(mock: MockDb, input: SeedPurchase): string {
  const id = randomUUID();
  const gross = BigInt(input.grossMicro ?? "9000000");
  const fee = (gross * 1000n) / 10_000n;
  const grantedAt = input.grantedAt ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
  mock.rows("purchase").push({
    id,
    listing_id: input.listingId,
    release_id: input.releaseId,
    buyer_address: input.buyer.toLowerCase(),
    all_versions: input.allVersions ?? false,
    update_price_at_purchase: input.updatePriceAtPurchase ?? "3000000",
    kind: input.kind ?? "new",
    source: "api",
    gross_micro: gross.toString(),
    fee_micro: fee.toString(),
    net_micro: (gross - fee).toString(),
    tx_hash: "0x" + "ef".repeat(32),
    payment_nonce: input.nonce ?? null,
    granted_at: grantedAt,
    holdback_until: input.holdbackUntil ?? new Date(new Date(grantedAt).getTime() + 7 * 86_400_000).toISOString(),
    payout_id: input.payoutId ?? null,
    revoked_at: input.revokedAt ?? null,
    // Base Sepolia, matching the X402_NETWORK the tests set. The sweep queries are
    // chain-scoped (20260906010000), so a row without this is invisible to them.
    chain_id: input.chainId ?? 84532,
  });
  return id;
}
