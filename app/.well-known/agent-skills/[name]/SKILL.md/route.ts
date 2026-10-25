/**
 * GET /.well-known/agent-skills/{name}/SKILL.md — the skill itself, as markdown.
 *
 * The bytes here are the bytes the index digests (lib/skills). `ETag` is that same
 * digest, so a consumer that pinned one can revalidate with `If-None-Match` and be told
 * "unchanged" without re-reading a document it already has.
 */

import { NextResponse } from "next/server";
import { handle } from "@/lib/errors";
import { isSkillName, skill } from "@/lib/skills";

export const dynamic = "force-dynamic";

export const GET = handle(async (_req: Request, ctx: { params: Promise<{ name: string }> }) => {
  const { name } = await ctx.params;
  if (!isSkillName(name)) {
    return new NextResponse("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  const { text, digest } = skill(name);
  return new NextResponse(text, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      etag: `"${digest}"`,
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
});
