/**
 * GET /admin/listings/:id — one listing, everything an operator needs to act on a flag.
 *
 * The feed says *something* is wrong; this says what. Four regions, in the order the
 * question narrows:
 *
 * 1. **The tally** — status, creator, price, licence, what is selling, and the money on
 *    this listing on the configured chain.
 * 2. **Releases** — every cut, newest first, each stored one with a Download button
 *    (lib/admin/download.ts), and under each non-passing one the scan findings. This is the only reader `release.scan_report` has (docs/BACKLOG.md); a
 *    secret's path and line are shown because the reader is an operator deciding whether
 *    a notice is upheld, not the public.
 * 3. **Events** — what happened to this listing lately, views excluded.
 * 4. **Take it down** — last, below everything that should be read first, and absent on
 *    a retired listing. `revoke` stays a script and the page says why.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Notice } from "@/app/_components/notice";
import { REASON_MAX } from "@/lib/admin/controls";
import { loadListingDetail, scanSummaryOf, type ListingDetail } from "@/lib/admin/detail";
import { currentNetwork } from "@/app/admin/_components/current-network";
import { requireAdmin } from "@/lib/admin/guard";
import type { ReleaseRow } from "@/lib/db/types";
import { toMicro, toMicroOrNull } from "@/lib/db/types";
import { formatBytes, formatDate, formatDateTime } from "@/lib/web/manifest-view";
import { formatAmount, formatPrice } from "@/lib/web/money";

export const metadata: Metadata = { title: "Listing" };
export const dynamic = "force-dynamic";

const CHAIN_NAME: Record<number, string> = { 8453: "Base mainnet", 84532: "Base Sepolia" };

export default async function AdminListingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { id } = await params;
  const { ok, error } = await searchParams;
  await requireAdmin(`/admin/listings/${encodeURIComponent(id)}`);

  const detail = await loadListingDetail(id, (await currentNetwork()).chainId);
  if (!detail) notFound();
  const { listing, creator, status, releases, sellable, sales, events } = detail;
  const ref = `${creator.handle}/${listing.slug}`;
  const chain = CHAIN_NAME[detail.chainId] ?? `chain ${detail.chainId}`;

  return (
    <main>
      <p className="muted">
        <a href="/admin/listings">Listings</a> / <a href={`/admin/creators/${creator.handle}`}>{creator.handle}</a>
      </p>
      <h1>{ref}</h1>
      <Notice ok={ok} error={error} />

      <dl>
        <dt>Status</dt>
        <dd data-status={status === "live" ? "pass" : status === "retired" ? "warn" : "pending"}>
          {status}
          <span className="muted">
            {" "}
            · created {formatDate(listing.created_at)}
            {listing.published_at ? ` · published ${formatDate(listing.published_at)}` : ""}
            {listing.retired_at ? ` · retired ${formatDateTime(listing.retired_at)}` : ""}
          </span>
        </dd>
        <dt>Public page</dt>
        <dd>
          <a href={`/${ref}`} target="_blank" rel="noreferrer">
            /{ref}
          </a>
        </dd>
        <dt>Source</dt>
        <dd>{listing.source === "hosted" ? `hosted · ${listing.hosted_org ?? "org unknown"}` : "GitHub (Rail A)"}</dd>
        <dt>Price</dt>
        <dd>
          {formatPrice(toMicro(listing.price_micro))} <span className="muted">· updates {formatPrice(toMicro(listing.update_price_micro))}</span>
        </dd>
        <dt>Licence</dt>
        <dd data-status={verdictStatus(listing.licence_verdict)}>
          {listing.licence_spdx ?? "none detected"} <span className="muted">· {listing.licence_verdict ?? "no verdict"}</span>
        </dd>
        <dt>Selling</dt>
        <dd data-status={sellable ? "pass" : status === "live" ? "fail" : "pending"}>
          {sellable ? `v${sellable.version}` : "nothing — no release has passed its scan"}
        </dd>
        <dt>Sales</dt>
        <dd>
          {sales.sales} · {formatAmount(sales.grossMicro)} gross{" "}
          <span className="muted">
            ({chain}){sales.revoked > 0 ? ` · ${sales.revoked} revoked` : ""}
          </span>
        </dd>
        <dt>Creator is owed</dt>
        <dd>
          {formatAmount(sales.owedMicro)} <span className="muted">· {formatAmount(sales.heldMicro)} still in holdback</span>
        </dd>
      </dl>

      {listing.description ? (
        <p className="written measure">
          {listing.description}
          {listing.trigger_hint ? <span className="muted"> — {listing.trigger_hint}</span> : null}
        </p>
      ) : null}

      <section>
        <h2>Releases</h2>
        {releases.length === 0 ? (
          <p className="written measure">No release has been cut. Nothing can be sold until one is, and passes its scan.</p>
        ) : (
          <>
            <table className="feed">
              <caption>{`${releases.length} release${releases.length === 1 ? "" : "s"} · newest first · times UTC`}</caption>
              <thead>
                <tr>
                  <th scope="col">Version</th>
                  <th scope="col">Scan</th>
                  <th scope="col" data-col="optional">
                    Cut
                  </th>
                  <th scope="col" data-col="dense">
                    Licence
                  </th>
                  <th scope="col" className="num" data-col="optional">
                    Size
                  </th>
                  <th scope="col" data-col="wide">
                    Commit
                  </th>
                </tr>
              </thead>
              <tbody>
                {releases.map((r) => (
                  <tr key={r.id}>
                    <td data-lead="">
                      v{r.version}
                      {sellable?.id === r.id ? <span className="muted"> · selling</span> : null}
                      {/* Not a purchase, and the creator is not told; the audit log is (lib/admin/download.ts). */}
                      {r.storage_path ? (
                        <form method="post" action={`/admin/listings/${listing.id}/releases/${r.id}/download`} className="row-action">
                          <button type="submit">Download</button>
                        </form>
                      ) : null}
                    </td>
                    <td data-status={r.scan === "pass" ? "pass" : r.scan === "fail" ? "fail" : "pending"}>{r.scan}</td>
                    <td data-col="optional">{formatDateTime(r.created_at)}</td>
                    <td data-col="dense" data-status={verdictStatus(r.licence_verdict ?? null)}>
                      {r.licence_verdict ?? <span className="muted">—</span>}
                    </td>
                    <td className="num" data-col="optional">
                      {sizeOf(r)}
                    </td>
                    <td data-col="wide">{r.commit_sha.slice(0, 12)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ScanReports releases={releases} />
          </>
        )}
      </section>

      <section>
        <h2>Events</h2>
        {events.length === 0 ? (
          <p className="written measure">Nothing recorded against this listing apart from page views.</p>
        ) : (
          <table className="feed">
            <caption>{`the last ${events.length} events · views excluded · newest first · times UTC`}</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Event</th>
                <th scope="col" data-col="dense">
                  Via
                </th>
                <th scope="col" data-col="optional">
                  Detail
                </th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td>{formatDateTime(e.at)}</td>
                  <td data-status={e.name.endsWith("_failed") || e.name.startsWith("takedown_") ? "fail" : e.name === "settled" ? "pass" : undefined}>
                    {e.name}
                  </td>
                  <td data-col="dense">{e.source ?? <span className="muted">—</span>}</td>
                  <td className="wrap muted" data-col="optional">
                    {e.detail || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <Takedown detail={detail} ref_={ref} open={Boolean(error)} />
    </main>
  );
}

/**
 * A report section only where there is something to read: a release that did not pass,
 * or one that passed with findings or a gap (an OSV outage). A clean pass is one muted
 * line under the table saying what was checked — a heading, a paragraph and "No
 * findings." for the common case was three blocks of nothing.
 */
function ScanReports({ releases }: { releases: ReleaseRow[] }) {
  const worthReading = (r: ReleaseRow) => {
    const s = scanSummaryOf(r.scan_report);
    // A gap and a review flag both make a passing release worth opening
    // ("PRD Trust Report.md" §4.1, 13 Sep 2026): a vendor's model-derived flag never
    // blocks and never reaches the buyer, so an operator is the only reader it has, and
    // an `unavailable` row is a check somebody has to chase.
    return r.scan !== "pass" || s.findings.length > 0 || s.gaps.length > 0 || s.osvError !== null || s.error !== null;
  };
  const shown = releases.filter(worthReading).slice(0, 10);
  const newest = releases[0];
  const newestClean = newest && !worthReading(newest) ? scanSummaryOf(newest.scan_report) : null;
  return (
    <>
      {newestClean ? (
        <p className="written measure muted">
          v{newest.version} passed with no findings
          {newestClean.checked.length > 0 ? ` · checked ${newestClean.checked.join(", ")}` : ""}
          {newest.scanner_version ? ` · scanner ${newest.scanner_version}` : ""}.
        </p>
      ) : null}
      {shown.map((r) => {
        const report = scanSummaryOf(r.scan_report);
        return (
          <section key={r.id}>
            <h3>
              v{r.version} scan <span data-status={r.scan === "pass" ? "pass" : r.scan === "fail" ? "fail" : "pending"}>{r.scan}</span>
            </h3>
            <p className="written measure muted">
              {report.scannedAt ? `Scanned ${formatDateTime(report.scannedAt)}` : "No scan time recorded"}
              {r.scanner_version ? ` by ${r.scanner_version}` : ""}
              {report.advisoriesRefreshedAt ? `, advisories refreshed ${formatDate(report.advisoriesRefreshedAt)}` : ""}
              {report.checked.length > 0 ? `. Checked: ${report.checked.join(", ")}.` : "."}
            </p>
            {/* The admin-alert class, above everything else on the release (§4.1). A
                review flag is a classifier's opinion at 94.5% precision: it never blocks,
                it never reaches the buyer as a verdict, and an operator is the only
                reader who can decide whether it was right. Sorted into a severity list it
                would sit under every LOW CVE on the page. */}
            {report.review.length > 0 ? (
              <div data-status="warn">
                <p className="written measure">
                  {report.review.length === 1 ? "One package is" : `${report.review.length} packages are`} flagged for review by a vendor
                  classifier. Not a verdict and not blocking — decide whether it is right.
                </p>
                <ul className="written measure">
                  {report.review.map((f, i) => (
                    <li key={`${f.rule_id}:${f.package?.name ?? ""}:${i}`}>
                      <code>{f.rule_id}</code>
                      {f.package ? ` · ${f.package.name}${f.package.version ? `@${f.package.version}` : ""}${f.package.dev ? " (dev)" : ""}` : ""} —{" "}
                      {f.description}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {/* A check that could not run, named. §4.1's founder decision is that a
                vendor outage does not stop a release; the price of that is that somebody
                has to be able to see which listings are selling on a partial scan. */}
            {report.gaps.length > 0 ? (
              <p className="written measure" data-status="pending">
                Not checked:{" "}
                {report.gaps.map((c) => `${c.id}${c.reason ? ` (${c.reason})` : ""}`).join(", ")}. The rescan cron retries these.
              </p>
            ) : null}
            {report.error ? (
              <p className="written measure" data-status="warn">
                Analysis error, so the release is still pending: {report.error}
              </p>
            ) : null}
            {report.osvError ? (
              <p className="written measure" data-status="warn">
                The dependency check could not reach OSV: {report.osvError}
              </p>
            ) : null}
            {report.findings.length === 0 ? (
              <p className="written measure">{r.scan_report ? "No findings." : "No report stored."}</p>
            ) : (
              <table className="feed">
                <caption>{`${report.findings.length} finding${report.findings.length === 1 ? "" : "s"} · blocking first`}</caption>
                <thead>
                  <tr>
                    <th scope="col">Rule</th>
                    <th scope="col">Severity</th>
                    <th scope="col" data-col="optional">
                      Where
                    </th>
                    <th scope="col" data-col="dense">
                      Description
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {report.findings.map((f, i) => (
                    <tr key={`${f.rule_id}:${f.path ?? ""}:${f.line ?? ""}:${i}`}>
                      <td className="wrap" data-lead="">
                        {f.rule_id} <span className="muted">· {f.kind}</span>
                      </td>
                      <td data-status={f.blocking ? "fail" : "pending"}>
                        {f.severity}
                        {f.blocking ? " · blocks" : ""}
                      </td>
                      <td className="wrap" data-col="optional">
                        {f.path ? `${f.path}${f.line ? `:${f.line}` : ""}` : <span className="muted">—</span>}
                      </td>
                      <td className="wrap written" data-col="dense">
                        {f.description}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        );
      })}
    </>
  );
}

function Takedown({ detail, ref_, open }: { detail: ListingDetail; ref_: string; open: boolean }) {
  const revokeCommand = `node scripts/ops-takedown.mjs revoke ${ref_} --reason "…" --i-have-refunded`;

  if (detail.status === "retired") {
    return (
      <section>
        <h2>Takedown</h2>
        <p className="written measure">
          Retired, so nothing new is sold. {detail.sales.sales > 0 ? `${detail.sales.sales} purchase${detail.sales.sales === 1 ? " is" : "s are"} still live — ` : ""}
          if the artifact itself is the infringement, revoking those is a script, because each buyer has to be refunded by hand first:{" "}
          <code>{revokeCommand}</code>
        </p>
      </section>
    );
  }

  // Folded shut: the page is a report first, and opening this is a deliberate act. It
  // opens itself when a submission bounced, so the error sits beside the form it is about.
  return (
    <details className="danger" open={open}>
      <summary>Take this listing down</summary>
      <p className="written measure">This retires the listing. It cannot be undone. After it goes through:</p>
      <ul className="written measure">
        <li>No new purchases. The resource endpoint answers 410 to anyone who does not already own a version.</li>
        <li>
          Every wallet that already bought keeps every version it owns (FR-46)
          {detail.sales.sales > 0 ? ` — ${detail.sales.sales} purchase${detail.sales.sales === 1 ? "" : "s"} here` : ""}.
        </li>
        <li>The manifest page and release log stay up, marked no longer sold. The slug is never reused.</li>
        <li>The creator&rsquo;s earnings so far still sweep on the normal schedule.</li>
        <li>
          Taking access away from buyers is a separate step, and a script, because V0 has no automated refund: <code>{revokeCommand}</code>
        </li>
      </ul>
      <form method="post" action={`/admin/listings/${detail.listing.id}/takedown`}>
        <p className="field">
          <label htmlFor="reason">Reason</label>
          <input id="reason" name="reason" type="text" required minLength={3} maxLength={REASON_MAX} autoComplete="off" />
          <small className="written">The notice this answers. Written to the audit log with your GitHub login.</small>
        </p>
        <p className="field">
          <label htmlFor="confirm">Type {ref_} to confirm</label>
          <input id="confirm" name="confirm" type="text" required autoComplete="off" spellCheck={false} />
        </p>
        <p className="actions">
          <button type="submit">Retire {ref_}</button>
        </p>
      </form>
    </details>
  );
}

function sizeOf(r: ReleaseRow) {
  const bytes = toMicroOrNull(r.size_bytes);
  return bytes === null ? <span className="muted">—</span> : formatBytes(Number(bytes));
}

function verdictStatus(verdict: string | null): string {
  if (verdict === "pass") return "pass";
  if (verdict === "block") return "fail";
  if (verdict === "manual") return "warn";
  return "pending";
}
