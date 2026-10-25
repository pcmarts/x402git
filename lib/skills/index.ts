/**
 * lib/skills — the two public agent skills, as text.
 *
 * `buy-a-repo.md` and `sell-a-repo.md` are the two halves of the product written for
 * the reader that has no browser: how to read a manifest, pay a 402 and pull, and how
 * to go from nothing to a live listing headlessly. They are published under
 * `/.well-known/agent-skills/` per the Agent Skills Discovery RFC 0.2.0, and indexed
 * there with a `sha256:` digest so a consumer can pin what it read.
 *
 * Read from disk rather than inlined, exactly as lib/licences does, so a diff of a
 * skill is a diff of a markdown file and not of a TypeScript string. `next.config.ts`
 * traces the directory into the deployment bundle — nothing imports these files, so the
 * tracer cannot see them and the routes would 500 in production while passing every
 * local test.
 *
 * The digest is computed over the bytes actually served, not over a build-time copy of
 * them, which is the only version of that promise worth making.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const SKILL_NAMES = ["buy-a-repo", "sell-a-repo"] as const;

export type SkillName = (typeof SKILL_NAMES)[number];

export function isSkillName(value: string): value is SkillName {
  return (SKILL_NAMES as readonly string[]).includes(value);
}

/** One line each, for the discovery index. The long form is the file's own frontmatter. */
export const SKILL_DESCRIPTIONS: Record<SkillName, string> = {
  "buy-a-repo":
    "Buy paid access to a private git repository with USDC on Base over HTTP 402: read the free manifest, pay the 402, pull the artifact, and re-fetch or update what you own.",
  "sell-a-repo":
    "Publish a private git repository for sale and get paid in USDC on Base, entirely headless: register, get a private git remote, push, price, publish, and be swept to your own wallet.",
};

const cache = new Map<SkillName, { text: string; digest: string }>();

/**
 * The skill text and the sha256 of those bytes. Memoised: read once per process.
 * `process.cwd()` is the project root under `next dev`, `next build`, Vercel and vitest.
 */
export function skill(name: SkillName): { text: string; digest: string } {
  const cached = cache.get(name);
  if (cached) return cached;

  const text = readFileSync(join(/*turbopackIgnore: true*/ process.cwd(), "lib", "skills", `${name}.md`), "utf8");
  const entry = { text, digest: `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}` };
  cache.set(name, entry);
  return entry;
}

/** Tests that stub the filesystem. */
export function resetSkillCache(): void {
  cache.clear();
}
