/**
 * The outcome of the last form POST, read back out of the query string.
 *
 * Every dashboard mutation is a POST to a route handler that redirects with `?ok=` or
 * `?error=`, so the result survives a reload, is visible to `curl`, and needs no
 * JavaScript and no session write. `role="status"` and `role="alert"` are load-bearing:
 * PRODUCT.md requires payment and wallet outcomes to be announced.
 *
 * The message sits on the sunken ground with a Copy beside it (2026-09-01, founder).
 * These sentences name tags, versions and repositories — "the newest tag on owner/name is
 * v1.0.0, and v1.0.0 has already been cut" — and the next thing a creator does with one
 * is paste it somewhere: into a terminal to check, into an agent to fix, into a message
 * asking why. It is the same copy row every other value on this page wears, for the same
 * reason: it is a value you hand to something else.
 *
 * The text is server HTML and the button is not — `CopyButton` renders only after mount —
 * so `curl` and a reader with scripting off get the whole sentence and lose only the
 * shortcut. The `role` stays on the paragraph that holds the words, not on the row, so
 * what is announced is the message and never the word "Copy".
 */

import { CopyButton } from "@/app/_components/copy-button";

export function Notice({ ok, error, blocking }: { ok?: string; error?: string; blocking?: string }) {
  const reasons = (blocking ?? "").split(",").map((r) => r.trim()).filter(Boolean);

  return (
    <>
      {ok ? <Message text={ok} role="status" status="pass" what="The message" /> : null}
      {error ? <Message text={error} role="alert" status="fail" what="The message" /> : null}
      {reasons.length > 0 ? (
        <ul role="alert">
          {reasons.map((reason) => (
            <li key={reason} data-status="fail">
              <a href={`/docs/errors#${reason}`}>{reason}</a> — {BLOCKING_COPY[reason] ?? "This has to be resolved before publishing."}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/**
 * One outcome: the sentence on the sunken ground, and the button that takes it.
 *
 * `.copyline` is the row the addresses and the agent prompts already use, so a creator
 * meets one copy affordance on this page rather than two that behave differently. The
 * message wraps rather than fading to one line the way a URL does — a sentence clipped
 * at the row's edge would be a sentence you cannot read, which is the opposite of what a
 * notice is for.
 */
function Message({
  text,
  role,
  status,
  what,
}: {
  text: string;
  role: "status" | "alert";
  status: "pass" | "fail";
  what: string;
}) {
  return (
    <div className="copyline notice-line">
      <code>
        <span role={role} data-status={status}>
          {text}
        </span>
      </code>
      <CopyButton value={text} what={what} />
    </div>
  );
}

/**
 * FR-42's gates, each said as the thing to do rather than the state to be in.
 *
 * Exported because the listing dashboard prints the same gates as a standing checklist
 * rather than only as the reason a POST bounced, and a gate that reads one way in the
 * error and another way in the checklist is two gates to the creator.
 */
export const BLOCKING_COPY: Record<string, string> = {
  // No `licence_block`: the licence stopped blocking publish on 2026-09-02, so no route
  // emits it and no checklist row asks for it.
  scan_pending: "The scan has not finished. Nothing is sold until it passes.",
  // The third state, from "PRD Trust Report.md" §4.4 (13 Sep 2026): the scan ran, and one
  // check could not. OSV is the single source for the blocking CVE decision, so a gap
  // there leaves the release pending rather than selling on the checks that did run —
  // which is a different sentence from "the scan has not finished", and reads as a stall
  // rather than a fault when it is neither.
  scan_pending_osv: "The known-vulnerability check could not run; retrying. Nothing to fix — the release goes on sale when it answers.",
  // The five blocking classes, named ("PRD Trust Report.md" §4.1). Before the report was
  // readable this was the only place a creator learned what the scan could even be about;
  // it now sits above a report that names the finding, its rule and its path and line, so
  // it names the classes and points at the section rather than guessing on their behalf.
  scan_failed:
    "The last release failed its scan — a secret, a HIGH or CRITICAL dependency CVE, a dependency known to be malicious, hidden-Unicode instruction smuggling, or a size limit. The report below names which one, and where. Fix it in the repository, then push a new tag: a scan verdict is final, so the same version cannot be re-scanned.",
  description_missing: "Write the description and the trigger hint below.",
  derivative_of: "This artifact overlaps an existing listing too closely to publish.",
  no_release: "Push a tag, or press Check for releases, to cut the first release.",
  public_repo: "This repository is public now. Make it private on GitHub, then publish — only private repositories can be sold.",
};
