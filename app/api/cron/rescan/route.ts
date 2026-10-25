/**
 * GET /api/cron/rescan — "PRD Trust Report.md" §7, nightly at 04:00, after `reconcile`.
 *
 * A verdict is terminal; a disclosure is not. This re-reads the dependency rows of every
 * release that has bytes in Storage — OSV nightly, Socket weekly, and the rows that could
 * not run at cut time repaired first — and republishes them on `scan_report` and on
 * `manifest.computed.scan`. `release.scan` is never written here (PRD §12, FR-39).
 *
 * The shape is `sweep`'s: `requireCron`, `maxDuration = 300`, `force-dynamic`, a per-release
 * try/catch, and a JSON summary that is also recorded as an event so the run is a time
 * series rather than a log line nobody kept. The loop itself lives in `lib/scan/rescan.ts`
 * (`runRescan`) — the two queues, the Socket quota floor and the wall-clock budget are
 * decisions worth testing without a route around them.
 *
 * **`?mode=backfill`** (14 Sep 2026), behind the same `requireCron` gate and never on a
 * schedule: the operator's full re-audit of what is live. The nightly leaves a
 * `predates scanner 2026.09` row alone by design, so every listing cut before the new
 * scanner still shows a blank `capabilities` and `injection`; the backfill re-runs both over
 * the stored artifact and calls Socket whatever the weekly cadence says. `?listing=` narrows
 * it to one `owner/slug`, and that run answers with the refreshed rows so the `curl` shows
 * the result rather than a count:
 *
 *   curl -H "authorization: Bearer $CRON_SECRET" \
 *     "https://x402git.com/api/cron/rescan?mode=backfill&listing=pcmarts/acl-recovery-tracker"
 *
 * Vercel Cron calls this with no query at all, and that path is byte-identical to what it
 * was before the mode existed.
 *
 * Locally: `curl -s localhost:3000/api/cron/rescan | jq` with no `CRON_SECRET` set, or
 * `curl -s -H "authorization: Bearer $CRON_SECRET" …` when it is.
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireCron } from "@/lib/auth/cron";
import { ApiError, handle } from "@/lib/errors";
import { record } from "@/lib/events";
import { type RescanMode, listingIdByPath, runRescan } from "@/lib/scan/rescan";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const GET = handle(async (req: NextRequest) => {
  requireCron(req);

  // Anything that is not `backfill` is the nightly, including a typo. A cron whose
  // behaviour depends on a query string it does not send should have exactly one other
  // value it recognises.
  const mode: RescanMode = req.nextUrl.searchParams.get("mode") === "backfill" ? "backfill" : "nightly";
  const path = req.nextUrl.searchParams.get("listing");

  let listingId: string | undefined;
  if (path) {
    // Refused rather than ignored on the nightly: narrowing a *refresh* to one listing is a
    // different feature with a different queue, and silently sweeping the whole platform
    // when somebody asked for one listing is the wrong way to be wrong.
    if (mode !== "backfill") throw new ApiError("invalid_request", { message: "`listing` is only meaningful with `mode=backfill`." });
    listingId = (await listingIdByPath(path)) ?? undefined;
    if (!listingId) throw new ApiError("not_found", { message: `No listing at ${path}.` });
  }

  const summary = await runRescan({ mode, ...(listingId ? { listingId } : {}) });

  // The counts, not the lists: `skipped` and `errors` can be long and the event table is
  // not where a per-release reason belongs. The response body carries both in full.
  await record({
    name: "cron_rescan",
    props: {
      mode: summary.mode,
      ...(listingId ? { listing_id: listingId } : {}),
      queued: summary.queued,
      repaired: summary.repaired,
      refreshed: summary.refreshed,
      compromised: summary.compromised,
      socket_skipped: summary.socket_skipped,
      skipped: summary.skipped.length,
      errors: summary.errors.length,
      notes: summary.notes,
    },
  });

  return NextResponse.json(summary, { headers: { "cache-control": "no-store" } });
});
