/**
 * The open-release block on the listing page (25 Oct 2026, HackMeridian).
 *
 * Above the price, because it changes what the price buys: this release is early access
 * to code that goes public on a date, in a repository anyone can read, under the licence
 * named here. After the date, the same block says whether that happened — *Opened on
 * time*, with the public commit to follow; *Overdue*, with why; or *Not eligible*, with
 * the check that failed in plain words. Everything printed is read off stored columns
 * (`lib/listings/view.ts#openReleaseView`) after the on-read check has run, so the page,
 * the listing JSON and MCP `get_listing` say the same thing.
 *
 * Server-rendered, no script, no new CSS: the label-size heading the buy column already
 * uses for "What you get", the text face for sentences, and the status colours every
 * verdict on the site wears. It is a section beside the box, never inside it — the buy
 * box is one of the two bordered rectangles in this system and nothing nests in it.
 */

import type { OpenReleaseBlockOutput } from "@/lib/schemas";
import { formatDate } from "@/lib/web/manifest-view";

const STATUS_LABEL: Record<OpenReleaseBlockOutput["status"], string> = {
  pending: "Not yet open",
  opened_on_time: "Opened on time",
  overdue: "Overdue",
  not_open: "Not open",
  ineligible: "Not eligible",
};

function tone(status: OpenReleaseBlockOutput["status"]): "pass" | "fail" | "warn" | "pending" {
  switch (status) {
    case "opened_on_time":
      return "pass";
    case "overdue":
    case "not_open":
      return "fail";
    case "ineligible":
      return "warn";
    default:
      return "pending";
  }
}

/** `https://github.com/o/r` → `github.com/o/r`, which is how a person says it. */
function repoLabel(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

export function OpenReleaseBlock({ block, now = new Date() }: { block: OpenReleaseBlockOutput; now?: Date }) {
  const opensAt = block.opens_at ? new Date(block.opens_at) : null;
  const due = opensAt !== null && opensAt.getTime() <= now.getTime();
  const failing = block.checks.filter((c) => !c.ok);
  const status = block.status;

  return (
    <section className="open-release" aria-label="Open release" data-open-release={status}>
      <h2>Open release</h2>
      <p className="written">
        {status === "opened_on_time" && block.opened_at ? "Opened" : "Opens"}
        {opensAt ? (
          <>
            {" on "}
            <time dateTime={opensAt.toISOString()}>{formatDate(opensAt.toISOString())}</time>
          </>
        ) : null}
        {" in "}
        <a href={block.public_repo_url} target="_blank" rel="noopener">
          {repoLabel(block.public_repo_url)}
        </a>
        {block.licence ? (
          <>
            {" under "}
            <code>{block.licence}</code>
          </>
        ) : null}
        .
      </p>

      {/* The verdict, one line, in the colour every other verdict on the site wears.
          `pending` before the date is the normal state and says what happens next;
          `pending` after it means GitHub has not answered yet, which is said as such. */}
      <p className="written" data-status={tone(status)}>
        <strong>{STATUS_LABEL[status]}</strong>
        {status === "pending" ? (
          <>
            {" — "}
            {due ? "the public repository is being checked." : "you are buying it early. We check the public repository after that date."}
          </>
        ) : null}
        {status === "opened_on_time" && block.evidence_url ? (
          <>
            {" — "}
            <a href={block.evidence_url} target="_blank" rel="noopener">
              see the public commit
            </a>
          </>
        ) : null}
        {status === "overdue" ? <> — the public repository did not have this release under this licence when it was checked.</> : null}
        {status === "not_open" ? <> — this release was already public when it was cut.</> : null}
        {status === "ineligible" ? <> — it sells as a normal release.</> : null}
      </p>

      {/* Only what failed, in the sentence the check wrote. The passing checks are in
          the JSON for anyone who wants them; on the page they would be a list of
          reassurances, which is a badge with nothing behind it. */}
      {status === "ineligible" && failing.length > 0 ? (
        <ul className="written" data-open-release-checks="">
          {failing.map((check) => (
            <li key={check.id} data-status="warn">
              {check.detail}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
