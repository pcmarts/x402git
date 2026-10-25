/**
 * GET /.well-known/agent-skills/index.json — Agent Skills Discovery RFC 0.2.0.
 *
 * Two skills, both `skill-md`, both served from this origin, each with the sha256 of
 * the exact bytes at its `url` so a consumer can pin what it read. The digests are
 * computed from the served file at request time (lib/skills), not written down here.
 *
 * What is *not* here: the listings. It is tempting to publish every live listing as a
 * skill — they are skills, that is the product — but the artifact is behind a 402 and
 * the digest of a paid artifact is already published, per version, in its manifest. An
 * index that advertised URLs no consumer could fetch would be a worse document than
 * one that tells an agent how to buy them. That is what `buy-a-repo` is.
 */

import { NextResponse } from "next/server";
import { appUrl } from "@/lib/env";
import { handle } from "@/lib/errors";
import { skill, SKILL_DESCRIPTIONS, SKILL_NAMES } from "@/lib/skills";

export const dynamic = "force-dynamic";

const SCHEMA_URL = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

export function skillsIndex(base: string) {
  return {
    $schema: SCHEMA_URL,
    skills: SKILL_NAMES.map((name) => ({
      name,
      type: "skill-md" as const,
      description: SKILL_DESCRIPTIONS[name],
      url: `${base}/.well-known/agent-skills/${name}/SKILL.md`,
      digest: skill(name).digest,
    })),
  };
}

export const GET = handle(async () =>
  new NextResponse(`${JSON.stringify(skillsIndex(appUrl()), null, 2)}\n`, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
    },
  }),
);
