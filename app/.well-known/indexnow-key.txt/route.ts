/**
 * GET /<key>.txt — the IndexNow key, for the engine to verify. (This file's route is
 * `/.well-known/indexnow-key.txt`; next.config.ts rewrites `/<INDEXNOW_KEY>.txt` here,
 * because IndexNow only trusts a key file at the root for URLs across the whole site —
 * see lib/indexnow.ts.)
 *
 * IndexNow proves a ping came from the site by fetching `keyLocation` and comparing its
 * body to the key in the ping. The key is not a secret in any useful sense — it is
 * published by design. With no key configured this is a 404, and so is any `?key=`
 * that is not the configured one (the rewrite never sends one; the check is belt and
 * braces for a direct call).
 */

import { type NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { handle } from "@/lib/errors";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  const key = env().INDEXNOW_KEY;
  const asked = req.nextUrl.searchParams.get("key");
  if (!key || (asked !== null && asked !== key)) return new NextResponse(null, { status: 404 });
  return new NextResponse(key, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
});
