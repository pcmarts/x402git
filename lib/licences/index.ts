/**
 * lib/licences — the FR-11 allow-list, as text.
 *
 * Rail B has no LICENSE until the creator picks one, so `POST /api/listings/:id/licence`
 * commits one from this allow-list. The attestation is the registering operator's (D4);
 * the platform only supplies the words.
 *
 * The four texts are the canonical, unmodified SPDX texts in `lib/licences/*.txt`,
 * with `[year]` and `[fullname]` left as placeholders where the licence has them. They
 * are read from disk rather than inlined so a diff of the licence text is a diff of a
 * licence file, not of a TypeScript string — and `next.config.ts` traces the directory
 * into the deployment bundle.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** FR-11. Resale-compatible, permissive or weak-copyleft. Order is the UI order. */
export const ALLOWED_SPDX = ["MIT", "Apache-2.0", "BSD-3-Clause", "MPL-2.0"] as const;

export type AllowedSpdxId = (typeof ALLOWED_SPDX)[number];

export function isAllowedSpdx(value: string): value is AllowedSpdxId {
  return (ALLOWED_SPDX as readonly string[]).includes(value);
}

const cache = new Map<AllowedSpdxId, string>();

/**
 * The raw template, placeholders intact. Memoised: the file is read once per process.
 * `process.cwd()` is the project root under `next dev`, `next build`, Vercel and vitest.
 */
export function licenceTemplate(spdx: AllowedSpdxId): string {
  const cached = cache.get(spdx);
  if (cached) return cached;
  const text = readFileSync(join(/*turbopackIgnore: true*/ process.cwd(), "lib", "licences", `${spdx}.txt`), "utf8");
  cache.set(spdx, text);
  return text;
}

/**
 * The text to commit as `LICENSE`. `[year]` and `[fullname]` are filled in; MPL-2.0 has
 * neither and is returned unchanged, which is correct — MPL carries no copyright line.
 */
export function licenceText(spdx: AllowedSpdxId, holder: string, year = new Date().getUTCFullYear()): string {
  return licenceTemplate(spdx).replace(/\[year\]/g, String(year)).replace(/\[fullname\]/g, holder);
}

/** Tests that stub the filesystem. */
export function resetLicenceCache(): void {
  cache.clear();
}
