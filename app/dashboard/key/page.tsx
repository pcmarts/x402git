/**
 * GET /dashboard/key — the agent key, and the one honest thing to say about it (FR-59).
 *
 * Since D14 ("PRD Session Keys.md") this page is about **agents only**. The browser you
 * are reading it in has its own short-lived session key, minted silently at sign-in and
 * revoked at sign-out, and nothing on this page affects it — so there is no longer a
 * "this session has no key" state to explain, and no reason for a creator to rotate in
 * order to click Publish.
 *
 * Only the sha256 of a key is stored (`lib/auth/api-key.ts`), so there is no "show my
 * key" that could work. A key is on screen exactly once, on the load that follows the
 * mint, carried there in a sealed one-time cookie rather than in the URL. After that the
 * page shows what it can honestly show — the prefix, when it was made, when it was last
 * used — and offers Rotate, with what rotating costs stated plainly.
 *
 * A server component cannot clear a cookie, so nothing here deletes the one-time box.
 * Its `maxAge` (five minutes) and its own `exp` are what retire it; a reload after that
 * shows the ordinary state, which is the correct outcome either way.
 *
 * On the load that follows account creation the bind route adds `?next=`, the page
 * sign-in was headed for before the wallet detour, and the page's one primary control
 * is the way on to it — the repo picker, for a creator who installed the App first.
 */

import type { Metadata } from "next";
import { cookies } from "next/headers";
import { CopyButton } from "@/app/_components/copy-button";
import { Notice } from "@/app/_components/notice";
import { AGENT_KEY_PREFIX } from "@/lib/auth/api-key";
import { requireDashboard } from "@/lib/web/dashboard";
import { agentKeyFor } from "@/lib/web/loaders";
import { formatDate } from "@/lib/web/manifest-view";
import { safeReturnPath } from "@/lib/web/safe-redirect";
import { KEY_BOX_COOKIE, openBox } from "@/lib/web/session";

export const metadata: Metadata = { title: "Agent key" };
export const dynamic = "force-dynamic";

export default async function KeyPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string; next?: string }>;
}) {
  const { ok, error, next } = await searchParams;
  const { creator } = await requireDashboard("/dashboard/key");

  const store = await cookies();
  const minted = openBox(store.get(KEY_BOX_COOKIE)?.value);
  const row = await agentKeyFor(creator.id);
  // Set only by the wallet bind that created the account: where sign-in was headed
  // before the wallet detour. Re-validated here because a query string is anyone's.
  const onward = next ? safeReturnPath(next, "/dashboard") : null;

  return (
    <main>
      <h1>Agent key</h1>
      <Notice ok={ok} error={error} />

      <p className="written measure">
        This is the key a programme uses to act for you: <code>Authorization: Bearer {AGENT_KEY_PREFIX}…</code> against the same public
        endpoints this dashboard calls. Scopes:{" "}
        <span className="computed">{(row?.scopes ?? []).join(", ") || "—"}</span>. It cannot move money — payouts go only to your bound
        address and no route takes a destination — and it cannot change your payout address, your SSH key or delete a repository without
        a wallet signature. It is assumed it will leak one day, and the system is built for that.
      </p>

      <p className="written measure">
        You do not need it to use this dashboard. This browser signs its own requests, so nothing here breaks when you rotate.
      </p>

      {minted ? (
        <section>
          <h2>Your new key</h2>
          {/* The key carries its own Copy (2026-09-21, founder). The notice above wears the
              row's ordinary copy control, which takes the sentence it is holding, and a
              creator told to copy their key reaches for the nearest button: the control that
              hands over the key has to sit on the key. `.snippet` is the block the README
              snippet already uses, so it is inset at the field's own corner rather than
              standing beside it as a second rectangle. */}
          <div className="snippet">
            <pre>
              <code>{minted}</code>
            </pre>
            <CopyButton value={minted} what="The agent key" />
          </div>
          <p className="written measure">
            Copy it now. We store only a hash of it, so this is the last time it can be shown — if you lose it, the way back is to
            rotate again.
          </p>
          <pre>
            <code>{`curl -s ${"$"}{APP}/api/listings \\
  -H "Authorization: Bearer ${minted}"`}</code>
          </pre>
        </section>
      ) : null}

      {onward ? (
        <p className="actions">
          <a href={onward} data-button data-variant="primary">
            {onward.startsWith("/dashboard/new") ? "Pick a repository to sell" : "Continue"}
          </a>
        </p>
      ) : null}

      <section>
        <h2>{minted ? "Rotate again" : "Your key"}</h2>
        {row ? (
          <p className="facts">
            <span className="computed">{`${AGENT_KEY_PREFIX}…`}</span>
            {` · created ${formatDate(row.created_at)} · last used ${row.last_used_at ? formatDate(row.last_used_at) : "never"}`}
          </p>
        ) : (
          <p className="written measure">
            You have no live agent key. Either it has never been minted, or it was found in a repository and revoked. Rotating mints
            one.
          </p>
        )}
        {row ? (
          <p className="written measure">
            Rotating revokes that key immediately: anything still using it starts getting{" "}
            <a href="/docs/errors#invalid_key">
              <code>401 invalid_key</code>
            </a>
            . Your browser sessions — this one and any other — are not affected.
          </p>
        ) : null}
        <form method="post" action="/dashboard/key/rotate">
          <p className="actions">
            <button type="submit">{row ? "Rotate and revoke the old key" : "Mint an agent key"}</button>
            <a href="/dashboard">Back to listings</a>
          </p>
        </form>
      </section>

      <section>
        <h2>Rotating without this page</h2>
        <p className="written measure">
          A wallet signature is enough on its own: <code>POST /api/auth/rotate-key</code> takes an address, a nonce and a signature, and
          needs no existing key. That is the route to use from a script.
        </p>
      </section>
    </main>
  );
}
