/**
 * GET /api/cron/promises — daily. Every open release whose opening date has passed and
 * whose promise is still `pending` is checked against its public repository, once, and
 * the verdict is written with evidence (25 Oct 2026, HackMeridian; lib/release/promise.ts).
 *
 * The same check also runs on read — the listing page, the listing JSON and MCP
 * `get_listing` — so a page somebody visits flips the moment its date has passed. This
 * route is for the pages nobody visits: a buyer who comes back a month later should
 * find the verdict already recorded, not trigger it.
 *
 * One release's failure must not stop the rest, so each check is caught and reported
 * in the summary rather than thrown. A release GitHub would not answer for stays
 * `pending` with the attempt stamped, and comes round again tomorrow.
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/cron";
import { db } from "@/lib/db";
import { handle } from "@/lib/errors";
import { recordedChainId } from "@/lib/events";
import { checkPromise, duePromises } from "@/lib/release/promise";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const GET = handle(async (req: NextRequest) => {
  requireCron(req);
  const now = new Date();

  const due = await duePromises(now);
  const results: Record<string, unknown>[] = [];
  const counts = { opened_on_time: 0, overdue: 0, failed: 0 };

  for (const { release, listing } of due) {
    try {
      const checked = await checkPromise(release, listing, { now });
      const status = checked.promise_status ?? "pending";
      if (status === "opened_on_time") counts.opened_on_time += 1;
      else if (status === "overdue") counts.overdue += 1;
      results.push({
        release_id: release.id,
        listing_id: listing.id,
        version: release.version,
        public_repo_url: listing.public_repo_url ?? null,
        status,
        evidence: checked.promise_evidence ?? null,
      });
      // §10 analytics, the shape `lib/release` writes: never a buyer address.
      const { error } = await db()
        .from("event")
        .insert({ name: "promise_checked", listing_id: listing.id, props: { version: release.version, status, public_repo_url: listing.public_repo_url ?? null }, chain_id: recordedChainId() });
      if (error) console.warn("[cron/promises] could not record promise_checked:", error.message);
    } catch (e) {
      counts.failed += 1;
      results.push({ release_id: release.id, listing_id: listing.id, version: release.version, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return NextResponse.json({ ran_at: now.toISOString(), due: due.length, ...counts, results }, { headers: { "cache-control": "no-store" } });
});
