"use client";

/**
 * app/_components/check-for-releases.tsx — the manual cut (FR-8.2), with the wait said out loud.
 *
 * A real `<form method="post">` to the route that calls `POST /api/listings/:id/sync`, so it
 * works with scripting off like every other control on the dashboard. What the script adds
 * is the half-minute nobody could see (founder, 25 Oct 2026: "it took ages and nothing is
 * communicated… they will just think it's broken"). The cut is one synchronous request —
 * resolve the newest tag, snapshot the tarball, read the licence and the README, scan for
 * secrets and known CVEs — and until it answers, the page it posted from does not change.
 * So the moment the form submits, the button says Checking…, a line under the head names
 * the steps in the order they run, fastest first, and a counter shows the seconds passing.
 * The counter is the point: a number that moves is the difference between "working" and
 * "broken".
 *
 * `auto` runs the check once on arrival, for the page a creator lands on straight after
 * Create listing: the first question there is "does my repo have a release?", and the
 * answer should be on its way before they find the button. The instruction travels in the
 * URL (`?check=1`); the redirect that follows the cut drops it, so a reload never re-runs it.
 *
 * **"Check for releases", not "Sync now"** (2026-09-01, founder). The old label said *when*
 * the act happens rather than what it does, and "sync" promised a two-way reconciliation
 * this route has never performed: it cuts the repository's newest uncut tag, and that is
 * all. The new label survives its own empty case, which is the one a creator meets most —
 * a check that finds nothing is still a check; a sync that syncs nothing sounds like a
 * failure.
 *
 * A real button, and a small one: it keeps the secondary rectangle every control on the
 * page wears because it commits something, and `.checks-head` shrinks it below the page's
 * standard control so that it reads as the smaller act it is beside Save and Publish.
 */

import { useEffect, useRef, useState } from "react";

export function CheckForReleases({ id, auto = false }: { id: string; auto?: boolean }) {
  const form = useRef<HTMLFormElement>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const pending = startedAt !== null;

  // Arrived from Create listing: submit once, as if the button had been pressed.
  useEffect(() => {
    if (auto && !pending) form.current?.requestSubmit();
  }, [auto, pending]);

  useEffect(() => {
    if (startedAt === null) return;
    const tick = window.setInterval(() => setElapsed(Math.round((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(tick);
  }, [startedAt]);

  return (
    <>
      <form
        ref={form}
        method="post"
        action={`/dashboard/${id}/actions/sync`}
        onSubmit={(event) => {
          // One request at a time: a second press while the first is in flight would cut
          // the same tag twice and be told `version_exists` for its trouble.
          if (pending) event.preventDefault();
          else setStartedAt(Date.now());
        }}
      >
        <button type="submit" aria-disabled={pending} data-pending={pending || undefined}>
          {pending ? "Checking…" : "Check for releases"}
        </button>
      </form>
      {pending ? (
        <p className="checking" role="status" aria-live="polite">
          <span className="elapsed">{elapsed}s</span> Reading the newest tag, then the licence and README, then the security scan. Usually under a
          minute. This page updates when it is done.
        </p>
      ) : null}
    </>
  );
}
