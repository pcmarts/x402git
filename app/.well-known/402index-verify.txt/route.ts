/**
 * GET /.well-known/402index-verify.txt — proof of domain for 402 Index (402index.io).
 *
 * 402 Index is a directory of HTTP 402 endpoints (L402, x402, MPP) that agents query over
 * HTTP, RSS, Nostr and MCP. Listings registered through `POST /api/v1/register` wait for
 * admin review unless the domain is claimed: `POST /api/v1/claim` returns a private token
 * and this public hash, `POST /api/v1/claim/verify` then fetches this file. A verified
 * owner can edit or remove any listing whose hostname is x402git.com.
 *
 * The hash is public by definition; the token lives in `402index.local.json` (gitignored
 * via `*.local.json`). The file must be served directly (no redirect), under 1 KB, and
 * hold the hash alone. See docs/research/Agent Discovery Channels.md.
 */

import { NextResponse } from "next/server";
import { handle } from "@/lib/errors";

export const INDEX_402_VERIFICATION_HASH = "26fa3aca3403de267206d5d96922b0785b9855adf80f71d88013536da045a7f0";

export const GET = handle(async () => {
  return new NextResponse(INDEX_402_VERIFICATION_HASH, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
});
