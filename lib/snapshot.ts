/**
 * lib/snapshot.ts — snapshot before you sell (PRD §6, §14.5, FR-35, FR-36).
 *
 * §6 chose option C — snapshot on release, signed URL on payment — for two reasons
 * that both live in this file. Proxying GitHub's tarball at purchase time would put
 * GitHub in the payment path, and it would let a creator push malware *after* the scan
 * and before the sale. So the bytes are fetched once, here, and the bytes we hash are
 * the bytes we scan are the bytes we sell.
 *
 * GitHub's tarball roots at `<owner>-<repo>-<sha>/`; §6 requires a `zip` rooted at
 * `<slug>-<version>/`. That means re-packing, which makes `artifact_sha256` a hash of
 * *our* bytes, so lib/zip.ts writes fixed metadata in sorted order and the same tree
 * always produces the same hash. `.git` is excluded and the LICENSE is carried
 * through (FR-36).
 *
 * The caps are enforced during decompression, not after: a 200 MB limit checked once
 * the buffer exists is not a zip-bomb defence.
 */

import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import { MAX_EXTRACTED_BYTES, MAX_FILES, RepoTooLargeError } from "@/lib/analysis";
import { contentKind, decodeText, isLicenceFile, stripNul } from "@/lib/analysis/files";
import { isNulSensitivePath } from "@/lib/scan/injection";
import { putArtifact } from "@/lib/storage";
import { type TarEntry, TarLimitError, readTar } from "@/lib/tar";
import { writeZip } from "@/lib/zip";

/** Compressed input ceiling. A tarball this big is not a source repository. */
export const MAX_COMPRESSED_BYTES = 300 * 1024 * 1024;

/**
 * Per-file ceiling for the decoded text we hand the *analyser* (classifier, word count,
 * dependency-manifest parsing); a larger text file is truncated for those purposes only.
 * The secret scanner never sees this cap — it reads the full bytes of every file (W3.1).
 */
const MAX_SCANNED_FILE_BYTES = 4 * 1024 * 1024;

/** Per-file ceiling for a retained README image, and the total across all of them. */
const MAX_RETAINED_FILE_BYTES = 2 * 1024 * 1024;
const MAX_RETAINED_BYTES = 20 * 1024 * 1024;

export type TarballSource = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer;

export type SnapshotInput = {
  /** Where the bytes come from. `githubTarball()` builds this from an installation Octokit. */
  source: TarballSource;
  /** Storage layout: `artifacts/<listing_id>/<version>/<sha256>.zip`. */
  listingId: string;
  /** Root directory of the re-packed archive is `<slug>-<version>/` (§6). */
  slug: string;
  version: string;
  /** Skip the upload; used by the analysis-only paths and by tests. */
  upload?: boolean;
  /**
   * FR-49: repository-relative paths whose bytes to hold on to — the images the README
   * references. The tarball is streamed once and thrown away, so a file not named here
   * is gone by the time anybody wants it; naming it costs its size in memory and
   * nothing else. Capped by the caller, and by `MAX_RETAINED_BYTES` here.
   */
  retainPaths?: Iterable<string>;
};

export type SnapshotFile = { path: string; size: number; executable: boolean; binary: boolean };

export type SnapshotResult = {
  /** The re-packed zip archive. These are the bytes that were hashed. */
  bytes: Uint8Array;
  /** sha256 of the zip bytes (§6). */
  sha256: string;
  /** Size of the archive, i.e. `bytes.length`. */
  sizeBytes: number;
  /** Uncompressed size of the member files. */
  extractedBytes: number;
  storagePath: string;
  files: SnapshotFile[];
  fileCount: number;
  /**
   * Decoded text, for the classifier, dependency parsing, the capability inventory and the
   * injection rules. Binary files are absent, and NUL bytes are stripped (SCAN-1) — a source,
   * manifest or instruction file carrying one is here, never dropped as binary.
   */
  textFiles: Map<string, string>;
  /**
   * W3.1: the full lenient decode of the bytes of **every** packed file — binary included,
   * never truncated, NUL bytes left in. This is what the secret scanner must read: the bytes
   * that ship. The binary heuristic drives `textFiles` and the manifest but must not gate
   * detection, so a secret behind a NUL byte or past 4 MB is still seen — and the injection
   * check reads this map too, which is how it finds the NUL `textFiles` no longer has.
   */
  secretScanFiles: Map<string, string>;
  /** Total bytes across `secretScanFiles`, the whole-repo CPU guard is measured against this. */
  secretScanBytes: number;
  /** FR-36: a LICENSE at the root of the archive. */
  hasLicence: boolean;
  /**
   * The bodies of the files named by `retainPaths`, for the caller to upload. A path
   * that was asked for and is not here was either absent from the repository or over
   * the per-file ceiling; both are "no image", never a placeholder.
   */
  retained: Map<string, Uint8Array>;
  rootDir: string;
};

/** `artifacts/<listing_id>/<version>/<sha256>.zip`, relative to the private bucket. */
export function storagePathFor(listingId: string, version: string, sha256: string): string {
  return `${listingId}/${version}/${sha256}.zip`;
}

/**
 * Fetch, re-pack, hash and (by default) upload. Throws `RepoTooLargeError` when either
 * §6 cap is hit — the caller turns that into `repo_too_large` (§9).
 */
export async function snapshot(input: SnapshotInput): Promise<SnapshotResult> {
  const raw = await gunzipCapped(input.source, MAX_EXTRACTED_BYTES, MAX_COMPRESSED_BYTES);

  let entries: TarEntry[];
  try {
    entries = readTar(raw, { maxEntries: MAX_FILES, maxBytes: MAX_EXTRACTED_BYTES });
  } catch (e) {
    if (e instanceof TarLimitError) {
      throw new RepoTooLargeError(e.message, e.limit, e.limit === "files" ? MAX_FILES : MAX_EXTRACTED_BYTES);
    }
    throw e;
  }

  const rootDir = `${input.slug}-${input.version}`;
  // Directory entries and GitHub's `pax_global_header` would both defeat the shared-root
  // test, so the wrapper directory is inferred from the files alone.
  const prefix = commonRoot(entries.filter((e) => e.type === "file" && e.path !== "pax_global_header").map((e) => e.path));

  const files: SnapshotFile[] = [];
  const textFiles = new Map<string, string>();
  const secretScanFiles = new Map<string, string>();
  let secretScanBytes = 0;
  const wanted = new Set(input.retainPaths ?? []);
  const retained = new Map<string, Uint8Array>();
  let retainedBytes = 0;
  const packed: { path: string; body: Uint8Array; executable: boolean }[] = [];
  let extractedBytes = 0;
  let hasLicence = false;

  for (const entry of entries) {
    if (entry.type !== "file") continue;
    const relative = prefix && entry.path.startsWith(`${prefix}/`) ? entry.path.slice(prefix.length + 1) : entry.path;
    if (relative === "" || relative === "pax_global_header") continue;
    // `.git` is excluded by §6; GitHub's tarball does not include it, but a Rail B
    // repo re-packed from elsewhere might, and the rule is the rule.
    if (relative === ".git" || relative.startsWith(".git/")) continue;

    extractedBytes += entry.body.length;
    if (extractedBytes > MAX_EXTRACTED_BYTES) {
      throw new RepoTooLargeError(`Snapshot exceeds ${MAX_EXTRACTED_BYTES} extracted bytes.`, "bytes", extractedBytes);
    }

    // SCAN-1: one NUL byte used to make any file binary here, and a binary file never
    // reached the injection gate, the capability inventory or the dependency parser — so
    // `<!--\0-->` on line 1 of a SKILL.md, or anywhere in a package.json, switched all three
    // off and the page printed "pass". `contentKind` is git's test with a second condition (a
    // meaningful share of non-text bytes), and a source, manifest or instruction path is never
    // binary at all: a NUL there makes the file `suspicious`, which is kept as text here and
    // reported by the injection check.
    const binary = contentKind(relative, entry.body, isNulSensitivePath(relative)) === "binary";
    const executable = (entry.mode & 0o111) !== 0;
    files.push({ path: relative, size: entry.body.length, executable, binary });
    packed.push({ path: `${rootDir}/${relative}`, body: entry.body, executable });

    // W3.1: the secret scanner reads the *full* bytes of *every* file, binary or not.
    // A lenient decode never throws on invalid UTF-8; the gitleaks-style regexes match the
    // ASCII a credential is made of even when embedded in otherwise-binary bytes.
    const decoded = decodeText(entry.body);
    secretScanFiles.set(relative, decoded);
    secretScanBytes += entry.body.length;

    if (!binary) {
      const text = entry.body.length > MAX_SCANNED_FILE_BYTES ? decodeText(entry.body.subarray(0, MAX_SCANNED_FILE_BYTES)) : decoded;
      textFiles.set(relative, stripNul(text));
    }

    // A copy, not a view: `entry.body` is a subarray of the whole decompressed archive,
    // and holding one keeps all of it alive for as long as the image does.
    if (wanted.has(relative) && entry.body.length <= MAX_RETAINED_FILE_BYTES && retainedBytes + entry.body.length <= MAX_RETAINED_BYTES) {
      retained.set(relative, new Uint8Array(entry.body));
      retainedBytes += entry.body.length;
    }
    if (isLicenceFile(relative)) hasLicence = true;
  }

  if (packed.length > MAX_FILES) {
    throw new RepoTooLargeError(`Snapshot has ${packed.length} files; the cap is ${MAX_FILES}.`, "files", packed.length);
  }

  const bytes = writeZip([
    { path: rootDir, type: "directory" },
    ...packed.map((p) => ({ path: p.path, body: p.body, executable: p.executable })),
  ]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const storagePath = storagePathFor(input.listingId, input.version, sha256);

  // W3.3: content-addressed by sha256, so an identical re-pack writes identical bytes to
  // the identical path. `upsert: true` makes the write idempotent — a resync after a crash
  // that left the object behind is a no-op on content, not an "already exists" throw.
  if (input.upload !== false) await putArtifact(storagePath, bytes, "application/zip", true);

  return {
    bytes,
    sha256,
    sizeBytes: bytes.length,
    extractedBytes,
    storagePath,
    files,
    fileCount: files.length,
    textFiles,
    secretScanFiles,
    secretScanBytes,
    hasLicence,
    retained,
    rootDir,
  };
}

/**
 * `GET /repos/{o}/{r}/tarball/{ref}` through an installation token (§14.3). Octokit
 * follows the 302 to the signed codeload URL for us; asking it not to parse the body
 * hands back the stream, so nothing buffers the whole archive twice.
 */
export async function githubTarball(
  octokit: { request: (route: string, params?: Record<string, unknown>) => Promise<{ data: any }> },
  params: { owner: string; repo: string; ref: string },
): Promise<TarballSource> {
  const { data } = await octokit.request("GET /repos/{owner}/{repo}/tarball/{ref}", {
    owner: params.owner,
    repo: params.repo,
    ref: params.ref,
    request: { parseSuccessResponseBody: false },
  });
  return data as TarballSource;
}

// --- decompression --------------------------------------------------------------

/**
 * Gunzip with a running byte counter on both sides. The output cap is checked chunk by
 * chunk, which is what makes it a zip-bomb defence rather than a post-hoc assertion.
 */
export async function gunzipCapped(source: TarballSource, maxOut: number, maxIn: number): Promise<Uint8Array> {
  const gunzip = createGunzip();
  const chunks: Uint8Array[] = [];
  let outBytes = 0;
  let inBytes = 0;

  const done = new Promise<void>((resolve, reject) => {
    gunzip.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > maxOut) {
        gunzip.destroy();
        reject(new RepoTooLargeError(`Archive expands past ${maxOut} bytes.`, "bytes", outBytes));
        return;
      }
      chunks.push(new Uint8Array(chunk));
    });
    gunzip.on("end", () => resolve());
    gunzip.on("error", (e: Error) => reject(e));
    // `destroy()` with no error emits neither `end` nor `error`. Without this the
    // promise never settles and the cap check deadlocks instead of throwing.
    gunzip.on("close", () => resolve());
  });

  try {
    for await (const chunk of iterate(source)) {
      inBytes += chunk.length;
      if (inBytes > maxIn) {
        gunzip.destroy();
        throw new RepoTooLargeError(`Compressed archive exceeds ${maxIn} bytes.`, "bytes", inBytes);
      }
      if (!gunzip.write(Buffer.from(chunk))) {
        await new Promise<void>((resolve) => gunzip.once("drain", () => resolve()));
      }
    }
    gunzip.end();
    await done;
  } catch (e) {
    gunzip.destroy();
    // Surface the cap error, not the "premature close" it causes downstream.
    await done.catch(() => undefined);
    throw e;
  }

  const out = new Uint8Array(outBytes);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

async function* iterate(source: TarballSource): AsyncGenerator<Uint8Array> {
  if (source instanceof Uint8Array) {
    yield source;
    return;
  }
  if (source instanceof ArrayBuffer) {
    yield new Uint8Array(source);
    return;
  }
  if (typeof (source as ReadableStream<Uint8Array>).getReader === "function") {
    const reader = (source as ReadableStream<Uint8Array>).getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value instanceof Uint8Array ? value : new Uint8Array(value);
    }
    return;
  }
  for await (const chunk of source as AsyncIterable<Uint8Array>) {
    yield chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
  }
}

/** The single top-level directory every entry shares, if there is one. */
export function commonRoot(paths: string[]): string | null {
  let root: string | null = null;
  for (const path of paths) {
    const head = path.split("/")[0];
    if (head === path) return null; // a file at the archive root: there is no wrapper dir
    if (root === null) root = head;
    else if (root !== head) return null;
  }
  return root;
}
