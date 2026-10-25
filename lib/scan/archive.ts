/**
 * lib/scan/archive.ts — what an artifact in Storage actually *is*, decided by its first
 * bytes ("PRD Trust Report.md" §7, 14 Sep 2026).
 *
 * The artifact we sell has been a zip since DECISIONS 2026-08-30 ("Zip, not tar.gz"), and
 * §7's reader was written against that and only that. The three `examples/*` releases cut
 * on 30 Aug 2026 are still `<listing>/<version>/<sha>.tar.gz`, so the first trust-report
 * backfill met all three as `artifact unreadable: zip: end of central directory not found`
 * and skipped them — a storage-format detail arriving on a live listing page as a release
 * nobody has ever scanned.
 *
 * **Magic bytes, not the storage path.** The path is a naming convention, and a convention
 * is exactly the thing that was wrong: `1f 8b` is gzip (RFC 1952), `50 4b 03 04` is a zip
 * local file header, and an artifact that is neither is refused rather than guessed at.
 * The same sniff decides what `socketFullScan` uploads a pre-zip artifact *as*, since
 * Socket's archive endpoint takes `.tar`, `.tar.gz` and `.zip` and reads the filename.
 *
 * The caps are the §6 pair on both paths and they are checked *during* decompression —
 * `readZip` off the central directory before a byte is inflated, `gunzipCapped` chunk by
 * chunk. This module is handed an object out of Storage and asked to decompress it, and
 * "we wrote it ourselves" is not a defence a decompressor gets to rely on.
 *
 * Nothing here writes an archive, extracts to disk or follows a link — the rule the two
 * readers under it already keep (NG6, lib/tar.ts).
 */

import { MAX_EXTRACTED_BYTES, MAX_FILES } from "@/lib/analysis";
import { MAX_COMPRESSED_BYTES, gunzipCapped } from "@/lib/snapshot";
import { readTar } from "@/lib/tar";
import { readZip } from "@/lib/zip";

/** The two things a stored artifact can be: today's zip, and the pre-30-Aug-2026 tarball. */
export type ArchiveFormat = "zip" | "tar.gz";

/**
 * gzip (RFC 1952) is `1f 8b`; a zip begins with a local file header, `50 4b 03 04`. Null
 * for anything else, which the callers read as "this is not an artifact" rather than as a
 * format to attempt.
 */
export function archiveFormat(bytes: Uint8Array): ArchiveFormat | null {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return "tar.gz";
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return "zip";
  return null;
}

/** A file entry, in archive order, with its path exactly as the archive stores it. */
export type ArchiveEntry = {
  /** The stored path, wrapper directory and all. Stripping it is the caller's job. */
  path: string;
  /** Empty when `skipped`. */
  body: Uint8Array;
  /**
   * True when {@link ReadArtifactEntriesOptions.inflate} said this entry was not wanted.
   * A reader that cares about bytes must check it; a reader counting files need not.
   */
  skipped: boolean;
};

export type ReadArtifactEntriesOptions = {
  /** Hard cap on entries (PRD §6: 20,000 files). Defaults to `MAX_FILES`. */
  maxEntries?: number;
  /** Hard cap on uncompressed bytes (PRD §6: 200 MB). Defaults to `MAX_EXTRACTED_BYTES`. */
  maxBytes?: number;
  /**
   * Keep only the bodies whose stored path this accepts; everything else comes back
   * `skipped` with an empty body, so the caller still sees the whole file list.
   *
   * The zip path never inflates what it is not asked for. The tar path cannot make that
   * saving — a tar is a stream of headers and bodies and finding the next header means
   * walking past this one — but it can and does skip the *decode*, which is the expensive
   * half for the manifests-only read this exists for.
   */
  inflate?: (path: string) => boolean;
};

const EMPTY = new Uint8Array(0);

/**
 * The file entries of a stored artifact, whichever of the two formats it is.
 *
 * Async because the gzip path is: `gunzipCapped` (lib/snapshot.ts) is the streaming,
 * counted decompressor the snapshot pipeline already reads GitHub's tarballs with, and
 * reusing it means the pre-zip artifacts are read under exactly the caps their own cut
 * enforced. A zip is parsed synchronously and the promise resolves immediately.
 *
 * GitHub's `pax_global_header` is dropped here rather than downstream, for the same reason
 * `snapshot()` drops it: it is not a file, and leaving it in would defeat the shared-root
 * test the caller runs to find the wrapper directory.
 */
export async function readArtifactEntries(
  bytes: Uint8Array,
  options: ReadArtifactEntriesOptions = {},
): Promise<{ entries: ArchiveEntry[]; format: ArchiveFormat }> {
  const format = archiveFormat(bytes);
  const maxEntries = options.maxEntries ?? MAX_FILES;
  const maxBytes = options.maxBytes ?? MAX_EXTRACTED_BYTES;
  const wanted = options.inflate ?? (() => true);

  if (format === "zip") {
    const entries = readZip(bytes, { maxEntries, maxBytes, inflate: wanted })
      .filter((e) => e.type === "file")
      .map((e) => ({ path: e.path, body: e.body, skipped: e.skipped === true }));
    return { entries, format };
  }

  if (format === "tar.gz") {
    const raw = await gunzipCapped(bytes, maxBytes, MAX_COMPRESSED_BYTES);
    const entries = readTar(raw, { maxEntries, maxBytes })
      .filter((e) => e.type === "file" && e.path !== "pax_global_header")
      .map((e) => (wanted(e.path) ? { path: e.path, body: e.body, skipped: false } : { path: e.path, body: EMPTY, skipped: true }));
    return { entries, format };
  }

  // Not a format, so not a guess. The caller turns this into `artifact unreadable: …`,
  // which is the honest row for an object that is not an artifact at all.
  throw new Error("archive: not a zip or a gzip archive");
}
