/**
 * lib/storage.ts — Supabase Storage (§6, D3, FR-49).
 *
 * **Two buckets, and the difference between them is the whole security model.**
 *
 * - `artifacts` is **private**. It holds the thing being sold. Access is a short-lived
 *   signed URL issued only after a purchase exists (lib/core/access.ts owns that
 *   decision — this module does not).
 * - `readme-assets` is **public**, and holds only images a README already published to
 *   the world points at. It exists because the product page renders a creator's README
 *   and a README's screenshots are part of it (FR-49). Nothing that was paid for goes
 *   in it, ever: the pipeline puts exactly the files the README references there, from
 *   a closed extension list, and by no other path.
 *
 * A public bucket serves from the Supabase host, which is a different origin from the
 * app. That is deliberate: an SVG someone uploads cannot reach this site's cookies or
 * DOM from there, whatever it contains. The app's own asset route adds
 * `Content-Security-Policy: default-src 'none'` on top for the SVG case.
 */

import { ARTIFACT_BUCKET, README_ASSET_BUCKET, db } from "@/lib/db";

let bucketEnsured = false;
let readmeBucketEnsured = false;

/** Create the private bucket on first use. Idempotent; safe to call concurrently. */
export async function ensureArtifactBucket(): Promise<void> {
  if (bucketEnsured) return;
  const storage = db().storage;
  const { data } = await storage.getBucket(ARTIFACT_BUCKET);
  if (!data) {
    const { error } = await storage.createBucket(ARTIFACT_BUCKET, { public: false });
    // A concurrent creator wins the race; that is fine.
    if (error && !/exist/i.test(error.message)) throw error;
  }
  bucketEnsured = true;
}

/**
 * Create the public README-asset bucket on first use.
 *
 * The caps travel with the bucket rather than only with the caller: 2 MB a file and the
 * six image types, so a path that somehow reached `upload` with a `.js` on it is refused
 * by the storage layer as well as by `normaliseAssetPath`.
 */
export async function ensureReadmeAssetBucket(): Promise<void> {
  if (readmeBucketEnsured) return;
  const storage = db().storage;
  const { data } = await storage.getBucket(README_ASSET_BUCKET);
  if (!data) {
    const { error } = await storage.createBucket(README_ASSET_BUCKET, {
      public: true,
      fileSizeLimit: 2 * 1024 * 1024,
      allowedMimeTypes: ["image/png", "image/jpeg", "image/gif", "image/svg+xml", "image/webp", "image/avif"],
    });
    if (error && !/exist/i.test(error.message)) throw error;
  }
  readmeBucketEnsured = true;
}

/** Test seam — lets a unit test skip the bucket round-trip. */
export function resetStorageCache(): void {
  bucketEnsured = false;
  readmeBucketEnsured = false;
}

/**
 * `readme-assets/<listing_id>/<release_id>/<path>`, relative to the public bucket.
 *
 * Keyed by release, not by listing: the README of v1.0.1 and the README of v1.0.0 may
 * point at the same filename holding different bytes, and a page that renders an old
 * release must not show the new release's screenshot.
 */
export function readmeAssetPathFor(listingId: string, releaseId: string, path: string): string {
  return `${listingId}/${releaseId}/${path}`;
}

/** Store one README image. `upsert` is true: a re-run of `sync` rewrites the same key. */
export async function putReadmeAsset(path: string, bytes: Uint8Array, contentType: string): Promise<{ path: string }> {
  await ensureReadmeAssetBucket();
  const { data, error } = await db()
    .storage.from(README_ASSET_BUCKET)
    .upload(path, bytes as unknown as Blob, { contentType, upsert: true, cacheControl: "31536000" });
  if (error) throw error;
  return { path: data?.path ?? path };
}

/** The public URL of a stored README image. No signature: the bucket is public. */
export function readmeAssetUrl(path: string): string | null {
  const { data } = db().storage.from(README_ASSET_BUCKET).getPublicUrl(path);
  return data?.publicUrl ?? null;
}

/** The bytes, for the one case the app serves itself rather than redirecting: SVG. */
export async function readReadmeAsset(path: string): Promise<Uint8Array | null> {
  const { data, error } = await db().storage.from(README_ASSET_BUCKET).download(path);
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
}

/**
 * Store a release archive. `path` is `<listing_id>/<version>/<sha256>.zip`.
 *
 * Default `upsert: false` — a release's bytes are written once (§6). W3.3: the caller may
 * pass `upsert: true`, which is safe *only* because the path is content-addressed by the
 * sha256 of the bytes. Overwriting `<sha256>.zip` with the identical re-pack is a no-op on
 * content, so a resync after a crash that orphaned the object recovers instead of wedging
 * on "already exists".
 */
export async function putArtifact(
  path: string,
  bytes: Uint8Array | ArrayBuffer | Blob,
  contentType = "application/zip",
  upsert = false,
): Promise<{ path: string }> {
  await ensureArtifactBucket();
  const body = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  const { data, error } = await db()
    .storage.from(ARTIFACT_BUCKET)
    .upload(path, body as Blob | Uint8Array, { contentType, upsert });
  if (error) throw error;
  return { path: data?.path ?? path };
}

/**
 * The bytes of a stored artifact, read by the server rather than signed for a buyer.
 *
 * Added 13 Sep 2026 for the §7 rescan cron ("PRD Trust Report.md"): re-checking a passing
 * release against today's advisories costs no GitHub call precisely because we still hold
 * the bytes, and this is how they are picked up again. `null` — not a throw — when the
 * object is gone: a failed cut's snapshot is deleted (FR-35) and `storage_path` goes null
 * with it, but a row that still names a missing object is a repair the cron skips, not an
 * error that stops the run.
 *
 * Nothing here decides who may read an artifact. That is `lib/core/access.ts` and the
 * signed URL below; this is a server-side read on a private bucket and no route exposes it.
 */
export async function readArtifact(path: string): Promise<Uint8Array | null> {
  const { data, error } = await db().storage.from(ARTIFACT_BUCKET).download(path);
  if (error || !data) return null;
  // supabase-js hands back a `Blob`. The in-memory bucket in lib/test/mock-db.ts hands back
  // whatever was uploaded, which is usually the `Uint8Array` the caller had; accept both
  // rather than making every fixture wrap its bytes.
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(await (data as Blob).arrayBuffer());
}

/**
 * Short-lived download URL. Default 300s per §7.4. `download` names the saved file, for
 * a browser following the URL rather than an agent reading it.
 */
export async function signedUrl(path: string, ttlSec = 300, download?: string): Promise<{ url: string; expiresAt: Date }> {
  const bucket = db().storage.from(ARTIFACT_BUCKET);
  const { data, error } = download ? await bucket.createSignedUrl(path, ttlSec, { download }) : await bucket.createSignedUrl(path, ttlSec);
  if (error || !data) throw error ?? new Error("createSignedUrl returned no url");
  return { url: data.signedUrl, expiresAt: new Date(Date.now() + ttlSec * 1000) };
}

export async function removeArtifact(path: string): Promise<void> {
  const { error } = await db().storage.from(ARTIFACT_BUCKET).remove([path]);
  if (error) throw error;
}

/** Alias of `removeArtifact`, for callers that prefer the delete/put symmetry. */
export const deleteArtifact = removeArtifact;
