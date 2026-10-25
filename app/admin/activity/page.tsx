/**
 * GET /admin/activity — is it converting, and what is failing.
 *
 * The §10 `event` table has been written since the first release and read by nothing.
 * This is the read. Three regions:
 *
 * 1. **The funnel.** View → 402 issued → settled. The middle step is the one the
 *    product actually instruments, and `settled / issued` is the checkout conversion
 *    rate: of the callers who were quoted a price, how many paid.
 * 2. **Failures, grouped by cause.** "Eleven failures" is a number; "eleven
 *    `insufficient_funds`" is an instruction. Sorted so the top row is the thing to fix.
 * 3. **The stream.** The last sixty events, as they happened.
 *
 * The page is deliberately explicit about one thing it cannot yet answer. PRODUCT.md
 * names *manifest views per purchase* as the number that decides the product's whole
 * hypothesis, and nothing recorded a manifest view until 2026-09-07. The ratio is
 * therefore null rather than zero until views accumulate, and the page says so — a
 * denominator that started yesterday would make the most important number on the site a
 * lie, and printing "0.0" would be worse than printing nothing.
 */

import type { Metadata } from "next";
import { EVENT_LIMIT, loadActivity, type ActivityEvent, type FailureGroup } from "@/lib/admin/activity";
import { currentNetwork } from "@/app/admin/_components/current-network";
import { requireAdmin } from "@/lib/admin/guard";
import { WindowStrip } from "@/app/admin/_components/window-strip";
import { adminWindow, WINDOW_LABEL } from "@/lib/admin/window";
import { formatDate, formatDateTime } from "@/lib/web/manifest-view";

export const metadata: Metadata = { title: "Activity" };
export const dynamic = "force-dynamic";

export default async function AdminActivityPage({ searchParams }: { searchParams: Promise<{ window?: string; views?: string }> }) {
  const { window: windowParam, views } = await searchParams;
  await requireAdmin("/admin/activity");

  const window = adminWindow(windowParam, "7d");
  const streamViews = views === "1";
  const { funnel, failures, bySource, stream, listingsViewed, truncated, viewsCoverWindow } = await loadActivity(window, undefined, {
    chainId: (await currentNetwork()).chainId,
    streamViews,
  });

  return (
    <main>
      <h1>Activity</h1>

      <WindowStrip current={window} base="/admin/activity" />

      <dl>
        <dt>Manifest views</dt>
        <dd>
          {funnel.views === 0 && funnel.botViews === 0 ? (
            <span className="muted">not recorded in this window</span>
          ) : (
            <>
              {funnel.views} <span className="muted">across {listingsViewed} listings</span>
              {/* Crawlers are counted and shown, but never in the ratio: robots.txt
                  invites indexing, so this number is expected to be large and is not a
                  measure of interest. */}
              {funnel.botViews > 0 ? <span className="muted"> · {funnel.botViews} by crawlers, excluded</span> : null}
            </>
          )}
        </dd>
        <dt>Prices quoted</dt>
        <dd>
          {funnel.issued} <span className="muted">402s issued</span>
        </dd>
        <dt>Paid</dt>
        <dd data-status={funnel.settled > 0 ? "pass" : "pending"}>
          {funnel.settled}
          {funnel.failed > 0 ? <span className="muted"> · {funnel.failed} failed to settle</span> : null}
          {funnel.free > 0 ? <span className="muted"> · {funnel.free} free</span> : null}
        </dd>
        <dt>Checkout conversion</dt>
        <dd>{funnel.conversion ?? <span className="muted">nothing was quoted</span>}</dd>
        <dt>Views per purchase</dt>
        {/* PRODUCT.md's hypothesis metric, and the one number on this site most worth
            refusing to guess at. Null until the window lies entirely after views were
            instrumented — see the note below. */}
        <dd>
          {funnel.viewsPerPurchase ?? (
            <span className="muted">{viewsCoverWindow ? "needs views and sales in the same window" : "not measurable over this window"}</span>
          )}
        </dd>
        <dt>Downloads</dt>
        <dd>{funnel.downloads}</dd>
      </dl>

      {/* One line, not a paragraph: the reason is stable and an operator reads it once. */}
      {viewsCoverWindow ? null : (
        <p className="written measure muted">
          Views per purchase is blank on purpose: views were first recorded 2026-09-07 and cannot be backfilled, so it appears only for a
          window that starts after that.
        </p>
      )}

      {truncated ? (
        <p className="written measure" data-status="warn">
          This window holds more events than the page reads in one go, so every count above — the funnel, the conversion rate and the
          failure list — describes the newest {EVENT_LIMIT.toLocaleString()} events, not the whole window. Narrow the window for a
          complete answer.
        </p>
      ) : null}

      <section>
        <h2>Failing</h2>
        {failures.length === 0 ? (
          <p className="written measure">
            {/* Only a complete read may claim nothing failed. A truncated one has not
                looked at the whole window and must not print a green all-clear. */}
            {truncated ? (
              <>
                No failure in the newest events read — but this window was truncated, so this is not an all-clear. Narrow the window to be
                sure.
              </>
            ) : (
              <>
                <span data-status="pass">Nothing failed in this window.</span> Settlement errors, requests refused by a kill switch, and
                sweeps that did not move money would all appear here, grouped by cause.
              </>
            )}
          </p>
        ) : (
          <table className="feed">
            <caption>{`${failures.length} distinct cause${failures.length === 1 ? "" : "s"} · most frequent first · ${WINDOW_LABEL[window].toLowerCase()}`}</caption>
            <thead>
              <tr>
                <th scope="col">Event</th>
                <th scope="col">Cause</th>
                <th scope="col" className="num">
                  Count
                </th>
                <th scope="col" data-col="optional">
                  Last seen
                </th>
              </tr>
            </thead>
            <tbody>
              {failures.map((f) => (
                <FailureRow key={`${f.name}:${f.cause}`} failure={f} />
              ))}
            </tbody>
          </table>
        )}
      </section>

      {bySource.length > 0 ? (
        <section>
          <h2>Where it comes from</h2>
          <table className="feed">
            <caption>{`quotes and payments by surface · ${WINDOW_LABEL[window].toLowerCase()}`}</caption>
            <thead>
              <tr>
                <th scope="col">Surface</th>
                <th scope="col" className="num">
                  Quoted
                </th>
                <th scope="col" className="num">
                  Paid
                </th>
                <th scope="col" className="num">
                  Conversion
                </th>
              </tr>
            </thead>
            <tbody>
              {bySource.map((row) => (
                <tr key={row.source}>
                  <td>{row.source}</td>
                  <td className="num">{row.issued}</td>
                  <td className="num">{row.settled}</td>
                  <td className="num">
                    {row.issued > 0 ? `${((row.settled / row.issued) * 100).toFixed(0)}%` : <span className="muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <section>
        <h2>Stream</h2>
        {stream.length === 0 ? (
          <p className="written measure">Nothing has happened in this window{streamViews ? "" : " apart from page views"}.</p>
        ) : (
          <table className="feed">
            <caption>
              {`the last ${stream.length} events · newest first · times UTC · `}
              {streamViews ? (
                <a href={`/admin/activity?window=${window}`}>hide page views</a>
              ) : (
                <a href={`/admin/activity?window=${window}&views=1`}>include page views</a>
              )}
            </caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Event</th>
                <th scope="col" data-col="optional">
                  Listing
                </th>
                <th scope="col" data-col="dense">
                  Via
                </th>
                <th scope="col" data-col="dense">
                  Detail
                </th>
              </tr>
            </thead>
            <tbody>
              {stream.map((event) => (
                <StreamRow key={event.id} event={event} />
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

/**
 * A failure name is a verdict, so it takes verdict ink — the same rule as a scan. Warn
 * ink, not fail, for the rows where nothing actually broke: a kill switch did its job, a
 * sweep was skipped, a vendor classifier raised a flag somebody should look at, or Socket
 * ran out of quota ("PRD Trust Report.md" §4.1 — none of those failed a release). The
 * label under the name is the one line that says what the slug means.
 */
function FailureRow({ failure }: { failure: FailureGroup }) {
  const warn = failure.name === "paused_block" || failure.name === "release_scan_review" || failure.name === "release_scan_socket_quota";
  return (
    <tr>
      <td data-status={warn ? "warn" : "fail"} data-lead="">
        {failure.name}
        {failure.label ? <small className="muted">{failure.label}</small> : null}
      </td>
      <td className="wrap">{failure.cause}</td>
      <td className="num">{failure.count}</td>
      <td data-col="optional">{formatDateTime(failure.lastAt)}</td>
    </tr>
  );
}

function StreamRow({ event }: { event: ActivityEvent }) {
  return (
    <tr>
      <td>
        {formatDate(event.at)} <span data-col="optional">{formatDateTime(event.at).slice(11, 16)}</span>
      </td>
      <td data-status={statusOfEvent(event.name)} data-lead="">
        {event.name}
      </td>
      <td className="wrap" data-col="optional">
        {event.slug && event.handle ? (
          <a href={`/${event.handle}/${event.slug}`} target="_blank" rel="noreferrer">
            {event.handle}/{event.slug}
          </a>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td data-col="dense">{event.source ?? <span className="muted">—</span>}</td>
      <td className="wrap muted" data-col="dense">
        {event.detail || "—"}
      </td>
    </tr>
  );
}

/**
 * Money landing is the one thing on this page worth the accent; anything that failed
 * takes verdict ink; everything else is ordinary traffic and stays in ink.
 */
function statusOfEvent(name: string): string | undefined {
  if (name === "settled" || name === "sweep") return "pass";
  if (name.endsWith("_failed") || name === "sweep_indeterminate") return "fail";
  if (name === "paused_block" || name === "sweep_skipped") return "warn";
  return undefined;
}
