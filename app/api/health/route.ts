/**
 * GET /api/health — is the platform answering, and can it still reach its database?
 *
 * The `status` relation of /.well-known/api-catalog (RFC 8631) has to point somewhere,
 * and an uptime check that only proves a CDN is up proves very little. So this does one
 * cheap round trip: a single indexed row from `creator`. That is the dependency every
 * paid path shares — no entitlement is read and no grant is written without it.
 *
 * What it deliberately does not do: touch the facilitator, the GitHub App or Storage.
 * A health endpoint that fans out to every third party turns their bad afternoon into
 * our outage page, and this one is public and unauthenticated. It reports what it
 * checked and nothing more.
 *
 * `degraded`, not `down`: reads served from cache and any already-signed download URL
 * keep working when the database does not, and the honest word for that is degraded.
 * The response is 200 either way — the check is the body, not the status line, so a
 * monitor reads one field instead of guessing at a 503 that could equally be a proxy.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handle } from "@/lib/errors";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const started = Date.now();
  let database: "ok" | "unreachable" = "ok";

  try {
    const { error } = await db().from("creator").select("id").limit(1);
    if (error) database = "unreachable";
  } catch {
    database = "unreachable";
  }

  return NextResponse.json(
    {
      status: database === "ok" ? "ok" : "degraded",
      checks: { database },
      latency_ms: Date.now() - started,
      time: new Date().toISOString(),
    },
    {
      headers: {
        // Never cached: a cached health check is a stale opinion.
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      },
    },
  );
});
