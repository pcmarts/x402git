/**
 * lib/tar.ts — a minimal, dependency-free ustar reader and writer.
 *
 * Tar is the *input* format: GitHub's `/tarball/{ref}` is what the snapshot
 * pipeline ingests, rooted at `<owner>-<repo>-<sha>/`. The artifact we sell is a
 * `zip` written by lib/zip.ts (PRD §6). The writer here remains for the tests,
 * which build GitHub-shaped tarballs with it, and it keeps the same determinism
 * discipline as the zip writer: every mtime, uid, gid and mode fixed, entries in
 * sorted path order.
 *
 * Only the subset of tar that GitHub emits and that we emit is implemented:
 * regular files, directories, PAX extended headers (`x`/`g`) and GNU long names
 * (`L`). Anything else is skipped on read. Nothing here executes, extracts to
 * disk, or follows a link — NG6 and the zip-slip class of bug are avoided by
 * never touching the filesystem at all.
 */

const BLOCK = 512;

export type TarEntryType = "file" | "directory";

export type TarEntry = {
  /** Path as stored, always POSIX-separated and never absolute. */
  path: string;
  type: TarEntryType;
  /** Empty for a directory. */
  body: Uint8Array;
  /** Octal file mode. Fixed on write; informational on read. */
  mode: number;
};

/** Deterministic values. A tarball's bytes must depend only on its contents. */
const FIXED_MTIME = 0;
const FIXED_MODE_FILE = 0o644;
const FIXED_MODE_DIR = 0o755;
const FIXED_EXEC_MODE = 0o755;

// --- reading -----------------------------------------------------------------

export type ReadTarOptions = {
  /** Hard cap on entries; exceeding it throws (PRD §6: 20,000 files). */
  maxEntries?: number;
  /** Hard cap on total uncompressed member bytes (PRD §6: 200 MB). */
  maxBytes?: number;
};

export class TarLimitError extends Error {
  constructor(
    message: string,
    readonly limit: "files" | "bytes",
  ) {
    super(message);
    this.name = "TarLimitError";
  }
}

/**
 * Parse a tar archive already in memory. Returns entries in archive order.
 *
 * Truncated archives throw rather than returning a partial tree: half a snapshot
 * must never be sellable.
 */
export function readTar(buf: Uint8Array, options: ReadTarOptions = {}): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let totalBytes = 0;
  let pendingPath: string | null = null;

  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK);
    if (isZeroBlock(header)) break; // end-of-archive marker
    offset += BLOCK;

    const checksum = parseOctal(header, 148, 8);
    if (checksum !== computeChecksum(header)) throw new Error("tar: header checksum mismatch");

    const size = parseOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] || 0x30);
    const dataEnd = offset + size;
    if (dataEnd > buf.length) throw new Error("tar: truncated archive");
    const body = buf.subarray(offset, dataEnd);
    offset += Math.ceil(size / BLOCK) * BLOCK;

    // PAX extended header / GNU long name: they describe the *next* entry.
    if (typeflag === "x" || typeflag === "g") {
      const path = parsePaxPath(body);
      if (typeflag === "x" && path) pendingPath = path;
      continue;
    }
    if (typeflag === "L") {
      pendingPath = decodeUtf8(body).replace(/\0+$/, "");
      continue;
    }
    if (typeflag === "K") continue; // GNU long link name; we do not keep links

    const name = pendingPath ?? joinUstarName(header);
    pendingPath = null;

    const isDir = typeflag === "5" || name.endsWith("/");
    if (typeflag !== "0" && typeflag !== "\0" && typeflag !== "5" && typeflag !== "7") {
      continue; // symlink, hardlink, device, fifo — not part of a source snapshot
    }

    totalBytes += size;
    if (options.maxBytes !== undefined && totalBytes > options.maxBytes) {
      throw new TarLimitError(`tar: archive exceeds ${options.maxBytes} uncompressed bytes`, "bytes");
    }

    // W3.6: check the cap *before* the push, so `entries.length` never exceeds `maxEntries`.
    if (options.maxEntries !== undefined && entries.length >= options.maxEntries) {
      throw new TarLimitError(`tar: archive exceeds ${options.maxEntries} entries`, "files");
    }

    entries.push({
      path: normalisePath(name),
      type: isDir ? "directory" : "file",
      body: isDir ? new Uint8Array(0) : body,
      mode: parseOctal(header, 100, 8) || (isDir ? FIXED_MODE_DIR : FIXED_MODE_FILE),
    });
  }

  return entries;
}

// --- writing -----------------------------------------------------------------

export type WriteTarEntry = {
  path: string;
  body?: Uint8Array;
  type?: TarEntryType;
  /** Preserve the executable bit only; everything else is normalised. */
  executable?: boolean;
};

/**
 * Pack entries into a tar archive. Entries are emitted in sorted path order with
 * fixed metadata, so the output is a pure function of the paths and bytes.
 */
export function writeTar(entries: WriteTarEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const chunks: Uint8Array[] = [];

  for (const entry of sorted) {
    const isDir = entry.type === "directory";
    const path = isDir && !entry.path.endsWith("/") ? `${entry.path}/` : entry.path;
    const body = isDir ? new Uint8Array(0) : (entry.body ?? new Uint8Array(0));
    const mode = isDir ? FIXED_MODE_DIR : entry.executable ? FIXED_EXEC_MODE : FIXED_MODE_FILE;

    const split = splitUstarName(path);
    if (!split) {
      // Too long for name+prefix: emit a PAX extended header carrying the real path.
      const record = paxRecord("path", path);
      chunks.push(header({ name: paxPlaceholder(path), mode: FIXED_MODE_FILE, size: record.length, typeflag: "x", prefix: "" }));
      chunks.push(pad(record));
      chunks.push(header({ name: paxPlaceholder(path), mode, size: body.length, typeflag: isDir ? "5" : "0", prefix: "" }));
      chunks.push(pad(body));
      continue;
    }

    chunks.push(header({ name: split.name, mode, size: body.length, typeflag: isDir ? "5" : "0", prefix: split.prefix }));
    if (body.length > 0) chunks.push(pad(body));
  }

  // Two zero blocks terminate the archive.
  chunks.push(new Uint8Array(BLOCK * 2));
  return concat(chunks);
}

// --- header helpers -----------------------------------------------------------

function header(fields: { name: string; mode: number; size: number; typeflag: string; prefix: string }): Uint8Array {
  const block = new Uint8Array(BLOCK);
  writeString(block, fields.name, 0, 100);
  writeOctal(block, fields.mode, 100, 8);
  writeOctal(block, 0, 108, 8); // uid
  writeOctal(block, 0, 116, 8); // gid
  writeOctal(block, fields.size, 124, 12);
  writeOctal(block, FIXED_MTIME, 136, 12);
  block.fill(0x20, 148, 156); // checksum field is spaces while summing
  block[156] = fields.typeflag.charCodeAt(0);
  writeString(block, "ustar", 257, 6);
  block[263] = 0x30;
  block[264] = 0x30; // version "00"
  writeString(block, "root", 265, 32);
  writeString(block, "root", 297, 32);
  writeString(block, fields.prefix, 345, 155);

  const sum = computeChecksum(block);
  // "%06o\0 " is what GNU tar writes and every reader accepts.
  writeString(block, sum.toString(8).padStart(6, "0"), 148, 6);
  block[154] = 0;
  block[155] = 0x20;
  return block;
}

function computeChecksum(block: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i];
  return sum;
}

function parseOctal(block: Uint8Array, offset: number, length: number): number {
  const raw = decodeUtf8(block.subarray(offset, offset + length)).replace(/\0/g, " ").trim();
  if (raw === "") return 0;
  const value = Number.parseInt(raw, 8);
  return Number.isFinite(value) ? value : 0;
}

function joinUstarName(block: Uint8Array): string {
  const name = readString(block, 0, 100);
  const prefix = readString(block, 345, 155);
  return prefix ? `${prefix}/${name}` : name;
}

function splitUstarName(path: string): { name: string; prefix: string } | null {
  const bytes = new TextEncoder().encode(path);
  if (bytes.length <= 100) return { name: path, prefix: "" };
  // Split on a "/" so that the tail fits in 100 bytes and the head in 155.
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i] !== "/") continue;
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    const prefixLen = new TextEncoder().encode(prefix).length;
    const nameLen = new TextEncoder().encode(name).length;
    if (prefixLen <= 155 && nameLen <= 100 && nameLen > 0) return { name, prefix };
  }
  return null;
}

/** A short, deterministic stand-in name for a PAX-carried path. */
function paxPlaceholder(path: string): string {
  const tail = path.slice(-90);
  return `PaxHeader/${tail}`.slice(-99);
}

function paxRecord(key: string, value: string): Uint8Array {
  const body = ` ${key}=${value}\n`;
  const bodyLen = new TextEncoder().encode(body).length;
  let len = bodyLen + 1;
  // The length prefix is part of the length, so it can need a second digit.
  while (String(len).length + bodyLen !== len) len = String(len).length + bodyLen;
  return new TextEncoder().encode(`${len}${body}`);
}

function parsePaxPath(body: Uint8Array): string | null {
  const text = decodeUtf8(body);
  const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text);
  return match ? match[1] : null;
}

// --- byte helpers --------------------------------------------------------------

function isZeroBlock(block: Uint8Array): boolean {
  for (let i = 0; i < block.length; i++) if (block[i] !== 0) return false;
  return true;
}

function writeString(block: Uint8Array, value: string, offset: number, length: number): void {
  const bytes = new TextEncoder().encode(value);
  block.set(bytes.subarray(0, length), offset);
}

function writeOctal(block: Uint8Array, value: number, offset: number, length: number): void {
  const text = value.toString(8).padStart(length - 1, "0");
  writeString(block, text, offset, length);
}

function readString(block: Uint8Array, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return decodeUtf8(end === -1 ? slice : slice.subarray(0, end));
}

function pad(body: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil(body.length / BLOCK) * BLOCK);
  padded.set(body);
  return padded;
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

const decoder = new TextDecoder("utf-8", { fatal: false });
function decodeUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/**
 * Strip anything that could escape the archive root. Nothing here writes to disk,
 * but a path is also a manifest field and a scan finding, so it is normalised once
 * at the boundary rather than at every reader.
 */
export function normalisePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter((seg) => seg !== "" && seg !== "." && seg !== "..")
    .join("/");
}
