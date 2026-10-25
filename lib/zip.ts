/**
 * lib/zip.ts — a minimal, dependency-free zip writer (and a reader for verification).
 *
 * PRD §6 requires the artifact to be a `zip` whose root directory is
 * `<slug>-<version>/`, with `.git` excluded. GitHub hands us a tarball, so the bytes
 * are re-packed here — and the bytes we re-pack are the bytes we hash, scan and sell
 * (§14.5). That makes determinism a requirement, not a nicety: the same tree must
 * always produce the same `artifact_sha256`. Every timestamp, uid and mode we write
 * is therefore fixed, entries are emitted in sorted path order, and per-file deflate
 * runs at one fixed level.
 *
 * Zip was chosen over tar.gz because every desktop OS opens it without a second tool
 * (DECISIONS.md, 2026-08-30). The §6 caps — 200 MB extracted, 20,000 files — keep
 * archives far below the zip64 thresholds, so zip64 is deliberately not implemented:
 * exceeding a classic-zip field throws rather than truncating. Nothing here executes,
 * extracts to disk, or follows a link; like lib/tar.ts, the filesystem is never touched.
 */

import { deflateRawSync, inflateRawSync } from "node:zlib";
import { TarLimitError, normalisePath } from "@/lib/tar";

export type ZipEntryType = "file" | "directory";

export type ZipEntry = {
  /** Path as stored, POSIX-separated, never absolute; no trailing `/` on directories. */
  path: string;
  type: ZipEntryType;
  /** Empty for a directory. */
  body: Uint8Array;
  /** Unix permission bits from the external attributes. Fixed on write. */
  mode: number;
  /**
   * True when {@link ReadZipOptions.inflate} said this entry was not wanted, so `body` is
   * empty because nothing was decompressed — not because the file is. A reader that cares
   * about bytes must check this; a reader that only wanted a path list need not.
   */
  skipped?: boolean;
  /** The uncompressed size the central directory declares, whether or not it was inflated. */
  size: number;
};

/** Deterministic values. An archive's bytes must depend only on its contents. */
const FIXED_MODE_FILE = 0o644;
const FIXED_MODE_DIR = 0o755;
const FIXED_EXEC_MODE = 0o755;
// The zip epoch. DOS dates cannot express anything earlier, and a real mtime would
// make the same tree hash differently on every run.
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = 0x21; // 1980-01-01
const DEFLATE_LEVEL = 9;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const VERSION_MADE_BY = (3 << 8) | 20; // unix attributes, spec 2.0
const VERSION_NEEDED = 20;
const FLAG_UTF8 = 0x0800;

// --- writing -----------------------------------------------------------------

export type WriteZipEntry = {
  path: string;
  body?: Uint8Array;
  type?: ZipEntryType;
  /** Preserve the executable bit only; everything else is normalised. */
  executable?: boolean;
};

/**
 * Pack entries into a zip archive. Entries are emitted in sorted path order with
 * fixed metadata, so the output is a pure function of the paths and bytes.
 *
 * Each file is deflated at a fixed level and stored raw instead when deflate does
 * not help — both choices are functions of the bytes alone, so determinism holds.
 */
export function writeZip(entries: WriteZipEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (sorted.length > 0xffff) throw new Error("zip: too many entries for a classic zip (zip64 not implemented)");

  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of sorted) {
    const isDir = entry.type === "directory";
    const path = isDir && !entry.path.endsWith("/") ? `${entry.path}/` : entry.path;
    const name = new TextEncoder().encode(path);
    const body = isDir ? new Uint8Array(0) : (entry.body ?? new Uint8Array(0));

    const deflated = body.length > 0 ? new Uint8Array(deflateRawSync(body, { level: DEFLATE_LEVEL })) : new Uint8Array(0);
    const useDeflate = deflated.length < body.length;
    const data = useDeflate ? deflated : body;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(body);

    if (body.length > 0xffffffff || data.length > 0xffffffff) {
      throw new Error("zip: entry too large for a classic zip (zip64 not implemented)");
    }

    const unixMode = isDir ? 0o40000 | FIXED_MODE_DIR : 0o100000 | (entry.executable ? FIXED_EXEC_MODE : FIXED_MODE_FILE);
    const externalAttrs = (unixMode << 16) >>> 0 | (isDir ? 0x10 : 0);

    const local = new Uint8Array(30 + name.length);
    const lv = view(local);
    lv.setUint32(0, SIG_LOCAL, true);
    lv.setUint16(4, VERSION_NEEDED, true);
    lv.setUint16(6, FLAG_UTF8, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, FIXED_DOS_TIME, true);
    lv.setUint16(12, FIXED_DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, body.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true); // extra length
    local.set(name, 30);
    locals.push(local, data);

    const central = new Uint8Array(46 + name.length);
    const cv = view(central);
    cv.setUint32(0, SIG_CENTRAL, true);
    cv.setUint16(4, VERSION_MADE_BY, true);
    cv.setUint16(6, VERSION_NEEDED, true);
    cv.setUint16(8, FLAG_UTF8, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, FIXED_DOS_TIME, true);
    cv.setUint16(14, FIXED_DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, body.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true); // extra length
    cv.setUint16(32, 0, true); // comment length
    cv.setUint16(34, 0, true); // disk number
    cv.setUint16(36, 0, true); // internal attributes
    cv.setUint32(38, externalAttrs, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);

    offset += local.length + data.length;
    if (offset > 0xffffffff) throw new Error("zip: archive too large for a classic zip (zip64 not implemented)");
  }

  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = view(eocd);
  ev.setUint32(0, SIG_EOCD, true);
  ev.setUint16(4, 0, true); // disk number
  ev.setUint16(6, 0, true); // central directory disk
  ev.setUint16(8, sorted.length, true);
  ev.setUint16(10, sorted.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true); // comment length

  return concat([...locals, ...centrals, eocd]);
}

// --- reading -----------------------------------------------------------------

/**
 * Caps and a selector, with the same contract `readTar` has (lib/tar.ts) — over-cap throws
 * `TarLimitError`, which is the class `snapshot()` already turns into `RepoTooLargeError`.
 * One limit error for both archive readers, so a caller reading either does not have to
 * learn two names for the same refusal.
 *
 * Added 13 Sep 2026: `readZip` inflated every entry of a stored artifact eagerly, which is
 * a zip bomb waiting for the §7 rescan cron to read it back. Both caps are decided from the
 * *central directory* — the declared entry count and declared uncompressed sizes — so
 * nothing is decompressed before the archive has been refused.
 */
export type ReadZipOptions = {
  /** Hard cap on entries; exceeding it throws (PRD §6: 20,000 files). */
  maxEntries?: number;
  /** Hard cap on total declared uncompressed bytes (PRD §6: 200 MB). */
  maxBytes?: number;
  /**
   * Inflate only the entries whose path this accepts. Everything else comes back as an
   * entry with `skipped: true` and an empty `body`, so a caller still sees the whole file
   * list and pays for nothing it did not ask for. The path is the one *stored* in the
   * archive, wrapper directory and all.
   */
  inflate?: (path: string) => boolean;
};

/**
 * Parse a zip archive already in memory, walking the central directory. Bodies are
 * inflated and checked against their recorded size and CRC — a mismatch throws,
 * because this reader exists to verify what the writer sold, not to be lenient.
 */
export function readZip(buf: Uint8Array, options: ReadZipOptions = {}): ZipEntry[] {
  const eocdAt = findEocd(buf);
  const bv = view(buf);
  const count = bv.getUint16(eocdAt + 10, true);
  let at = bv.getUint32(eocdAt + 16, true);

  if (options.maxEntries !== undefined && count > options.maxEntries) {
    throw new TarLimitError(`zip: archive exceeds ${options.maxEntries} entries`, "files");
  }

  const entries: ZipEntry[] = [];
  let totalBytes = 0;
  for (let i = 0; i < count; i++) {
    if (bv.getUint32(at, true) !== SIG_CENTRAL) throw new Error("zip: bad central directory entry");
    const method = bv.getUint16(at + 10, true);
    const crc = bv.getUint32(at + 16, true);
    const compressedSize = bv.getUint32(at + 20, true);
    const uncompressedSize = bv.getUint32(at + 24, true);
    const nameLen = bv.getUint16(at + 28, true);
    const extraLen = bv.getUint16(at + 30, true);
    const commentLen = bv.getUint16(at + 32, true);
    const externalAttrs = bv.getUint32(at + 38, true);
    const localAt = bv.getUint32(at + 42, true);
    const rawName = new TextDecoder("utf-8", { fatal: false }).decode(buf.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;

    if (bv.getUint32(localAt, true) !== SIG_LOCAL) throw new Error("zip: bad local header");
    const dataAt = localAt + 30 + bv.getUint16(localAt + 26, true) + bv.getUint16(localAt + 28, true);
    if (dataAt + compressedSize > buf.length) throw new Error("zip: truncated archive");
    const raw = buf.subarray(dataAt, dataAt + compressedSize);

    const isDir = rawName.endsWith("/") || (externalAttrs & 0x10) !== 0;

    // The bytes cap is counted off the *declared* sizes, before a single call to
    // `inflateRawSync` — a cap checked after decompression is not a zip-bomb defence, which
    // is the rule lib/snapshot.ts states and this reader now keeps too.
    totalBytes += uncompressedSize;
    if (options.maxBytes !== undefined && totalBytes > options.maxBytes) {
      throw new TarLimitError(`zip: archive exceeds ${options.maxBytes} uncompressed bytes`, "bytes");
    }

    // Wanted, or only counted? A caller that named the handful of files it reads pays the
    // inflate for those and walks past everything else at central-directory speed.
    const wanted = !isDir && (options.inflate?.(rawName) ?? true);

    let body: Uint8Array;
    if (!wanted) body = new Uint8Array(0);
    else if (method === 8) body = new Uint8Array(inflateRawSync(raw));
    else if (method === 0) body = new Uint8Array(raw);
    else throw new Error(`zip: unsupported compression method ${method}`);

    if (wanted) {
      if (body.length !== uncompressedSize) throw new Error("zip: size mismatch");
      if (crc32(body) !== crc) throw new Error("zip: crc mismatch");
    }

    const mode = (externalAttrs >>> 16) & 0o777;
    entries.push({
      path: normalisePath(rawName),
      type: isDir ? "directory" : "file",
      body,
      mode: mode || (isDir ? FIXED_MODE_DIR : FIXED_MODE_FILE),
      size: uncompressedSize,
      ...(isDir || wanted ? {} : { skipped: true }),
    });
  }
  return entries;
}

/** The end-of-central-directory record, scanning back past a possible comment. */
function findEocd(buf: Uint8Array): number {
  const bv = view(buf);
  const stop = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (bv.getUint32(i, true) === SIG_EOCD) return i;
  }
  throw new Error("zip: end of central directory not found");
}

// --- byte helpers --------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
