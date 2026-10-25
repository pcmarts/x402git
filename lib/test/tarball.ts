/**
 * lib/test/tarball.ts — build a GitHub-shaped `tar.gz` in memory.
 *
 * The snapshot path is the one place where "it works on my fixture" is not enough:
 * the bytes it produces are hashed and sold. Tests therefore build a real archive
 * with the same writer the pipeline uses, wrapped in the `<owner>-<repo>-<sha>/`
 * root directory GitHub actually emits, so the re-packing step is exercised rather
 * than assumed.
 */

import { gzipSync } from "node:zlib";
import { writeTar } from "@/lib/tar";

export type FixtureFiles = Record<string, string | Uint8Array>;

/** A tar (uncompressed) rooted at `root/`, as GitHub's tarball endpoint returns it. */
export function makeTar(files: FixtureFiles, root = "octo-widget-abc1234"): Uint8Array {
  const entries = Object.entries(files).map(([path, body]) => ({
    path: `${root}/${path}`,
    body: typeof body === "string" ? new TextEncoder().encode(body) : body,
  }));
  return writeTar([{ path: root, type: "directory" as const }, ...entries]);
}

export function makeTarball(files: FixtureFiles, root = "octo-widget-abc1234"): Uint8Array {
  return new Uint8Array(gzipSync(Buffer.from(makeTar(files, root)), { level: 9 }));
}
