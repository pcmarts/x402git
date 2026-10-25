/**
 * GET /admin/ops — the kill switches, and what is stuck.
 *
 * The one page in `/admin` that stops commerce, so it is a page of its own and not a
 * column beside a table of listings (DECISIONS.md, 2026-09-13). Each switch is a row
 * stating what it stops, and below the table one form per direction: pick the switch,
 * type its name, say why. Typing is the confirmation — a `confirm()` does not exist with
 * scripting off, and a pause should never be a reflex.
 *
 * Stuck payouts are shown and not cleared. Clearing one means proving on chain that the
 * transfer never landed, which is `scripts/ops-clear-stuck-payout.mjs`'s whole job; the
 * page names the command beside the row.
 */

import type { Metadata } from "next";
import { Notice } from "@/app/_components/notice";
import { REASON_MAX } from "@/lib/admin/controls";
import { currentNetwork } from "@/app/admin/_components/current-network";
import { clearStuckPayoutCommand } from "@/lib/admin/network";
import { requireAdmin } from "@/lib/admin/guard";
import { healthSummary, loadOpsHealth } from "@/lib/admin/ops";
import { formatDateTime } from "@/lib/web/manifest-view";
import { formatAmount } from "@/lib/web/money";

export const metadata: Metadata = { title: "Ops" };
export const dynamic = "force-dynamic";

/** What each switch stops, in the words of scripts/ops-switch.mjs. */
const STOPS: Record<string, string> = {
  registrations: "New creators, on either rail. A replayed registration that already succeeded still replays.",
  publishing: "A draft going live. Re-publishing a live listing is still a no-op.",
  payments: "Issuing a 402 and accepting a payment — callers get 503. Owners can still fetch what they bought.",
  sweeps: "Every payout, cron and forced. Purchases stay unswept for the next unpaused run.",
};

export default async function AdminOpsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string; switch?: string }>;
}) {
  const { ok, error, switch: chosen } = await searchParams;
  await requireAdmin("/admin/ops");
  const { chainId } = await currentNetwork();
  const health = await loadOpsHealth(chainId);
  const running = health.switches.filter((s) => !s.paused);

  return (
    <main>
      <h1>Ops</h1>
      <Notice ok={ok} error={error} />

      <dl>
        <dt>State</dt>
        <dd data-status={health.clear ? "pass" : "fail"}>{healthSummary(health)}</dd>
        <dt>Effect</dt>
        <dd>
          within ten seconds, everywhere <span className="muted">· no deploy</span>
        </dd>
        <dt>Not here</dt>
        <dd>
          sweep wallet balance <span className="muted">· npm run ops:status</span>
        </dd>
      </dl>

      <table className="feed">
        <caption>{`${health.switches.length} switches · times UTC · a paused endpoint answers every caller 503 and never says why`}</caption>
        <thead>
          <tr>
            <th scope="col">Switch</th>
            <th scope="col">State</th>
            <th scope="col" data-col="optional">
              Stops
            </th>
            <th scope="col" data-col="dense">
              Reason
            </th>
            <th scope="col" data-col="optional">
              Changed
            </th>
            <th scope="col">
              <span className="sr-only">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {health.switches.map((s) => (
            <tr key={s.name}>
              <td data-lead="">{s.name}</td>
              <td data-status={s.paused ? "fail" : "pass"}>{s.paused ? "paused" : "running"}</td>
              <td className="wrap written" data-col="optional">
                {STOPS[s.name] ?? "—"}
              </td>
              <td className="wrap written" data-col="dense">
                {s.paused && s.reason ? s.reason : <span className="muted">—</span>}
              </td>
              <td data-col="optional">
                {s.updated_at ? (
                  <>
                    {formatDateTime(s.updated_at)}
                    {s.updated_by ? <span className="muted"> · {s.updated_by}</span> : null}
                  </>
                ) : (
                  <span className="muted">never</span>
                )}
              </td>
              {/* A link to the form below with this switch chosen — not a button. The act
                  still happens in the form, with the name typed and a reason given. */}
              <td>
                <a href={`/admin/ops?switch=${s.name}#${s.paused ? "resume" : "pause"}`}>{s.paused ? "Resume…" : "Pause…"}</a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Two forms rather than one with a direction toggle: a pause and a resume ask for
          different things (a resume needs no reason), and a form that changes shape with a
          radio needs script to be honest about it. A form with nothing to act on does
          not render. */}
      {running.length > 0 ? (
        <section id="pause">
          <h2>Pause a switch</h2>
          <form method="post" action="/admin/ops/switch">
            <input type="hidden" name="action" value="pause" />
            <p className="field">
              <label htmlFor="pause-name">Switch</label>
              <select id="pause-name" name="name" required defaultValue={running.some((s) => s.name === chosen) ? chosen : ""}>
                <option value="" disabled>
                  Choose one
                </option>
                {running.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </select>
            </p>
            <p className="field">
              <label htmlFor="pause-reason">Reason</label>
              <input id="pause-reason" name="reason" type="text" required minLength={3} maxLength={REASON_MAX} autoComplete="off" />
              <small className="written">For operators only. Callers see the same 503 whatever this says.</small>
            </p>
            <p className="field">
              <label htmlFor="pause-confirm">Type the switch name to confirm</label>
              <input id="pause-confirm" name="confirm" type="text" required autoComplete="off" spellCheck={false} />
            </p>
            <p className="actions">
              <button type="submit">Pause it</button>
            </p>
          </form>
        </section>
      ) : null}

      {health.paused.length > 0 ? (
        <section id="resume">
          <h2>Resume a switch</h2>
          <form method="post" action="/admin/ops/switch">
            <input type="hidden" name="action" value="resume" />
            <p className="field">
              <label htmlFor="resume-name">Switch</label>
              <select id="resume-name" name="name" required defaultValue={health.paused.some((s) => s.name === chosen) ? chosen : ""}>
                <option value="" disabled>
                  Choose one
                </option>
                {health.paused.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </select>
            </p>
            <p className="field">
              <label htmlFor="resume-confirm">Type the switch name to confirm</label>
              <input id="resume-confirm" name="confirm" type="text" required autoComplete="off" spellCheck={false} />
            </p>
            <p className="actions">
              <button type="submit" data-variant="primary">
                Resume it
              </button>
            </p>
          </form>
        </section>
      ) : null}

      <section>
        <h2>Stuck payouts</h2>
        {health.stuck.length === 0 ? (
          <p className="written measure">
            <span data-status="pass">None.</span> A payout stuck at pending or broadcast blocks its creator&rsquo;s next sweep, and would
            appear here.
          </p>
        ) : (
          <table className="feed">
            <caption>
              {`${health.stuck.length} stuck · prove each unpaid, then clear it: ${clearStuckPayoutCommand(chainId)}`}
            </caption>
            <thead>
              <tr>
                <th scope="col">Created</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">
                  Amount
                </th>
                <th scope="col" data-col="wide">
                  To
                </th>
              </tr>
            </thead>
            <tbody>
              {health.stuck.map((p) => (
                <tr key={p.id}>
                  <td>{formatDateTime(p.createdAt)}</td>
                  <td data-status="fail">{p.status}</td>
                  <td className="num">{formatAmount(p.amountMicro)}</td>
                  <td data-col="wide">{p.toAddress}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
