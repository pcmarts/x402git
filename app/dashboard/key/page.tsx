/**
 * GET /dashboard/key — the agent key, made on demand (FR-59).
 *
 * Nothing sends a creator here any more. Sign-up goes wallet → repo picker (25 Oct 2026,
 * DECISIONS.md), and this page is a link in the dashboard nav for the creator who wants
 * a key for a script or an agent. With no key, its one button creates one; after that,
 * the same button rotates.
 *
 * Only the sha256 of a key is stored (`lib/auth/api-key.ts`), so a key is on screen
 * exactly once, on the load that follows the mint, carried there in a sealed one-time
 * cookie rather than in the URL. A server component cannot clear a cookie, so its
 * `maxAge` (five minutes) retires it; every later load shows the prefix and the dates.
 *
 * The browser's own session key (D14) is minted at sign-in, is not on this page, and is
 * never affected by it — so there is nothing here to warn about, and everything that is
 * not the key or the button sits in one closed disclosure.
 */

import type { Metadata } from "next";
import { cookies } from "next/headers";
import { CopyButton } from "@/app/_components/copy-button";
import { Notice } from "@/app/_components/notice";
import { AGENT_KEY_PREFIX, DEFAULT_SCOPES } from "@/lib/auth/api-key";
import { appUrl } from "@/lib/env";
import { requireDashboard } from "@/lib/web/dashboard";
import { agentKeyFor } from "@/lib/web/loaders";
import { formatDate } from "@/lib/web/manifest-view";
import { KEY_BOX_COOKIE, openBox } from "@/lib/web/session";

export const metadata: Metadata = { title: "Agent key" };
export const dynamic = "force-dynamic";

export default async function KeyPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { ok, error } = await searchParams;
  const { creator } = await requireDashboard("/dashboard/key");

  const store = await cookies();
  const minted = openBox(store.get(KEY_BOX_COOKIE)?.value);
  const row = await agentKeyFor(creator.id);
  const scopes = (row?.scopes?.length ? row.scopes : DEFAULT_SCOPES).join(", ");

  return (
    <main>
      <h1>Agent key</h1>
      <Notice ok={ok} error={error} />

      {minted ? (
        <>
          {/* The Copy sits on the key itself (2026-09-21, founder): a creator told to
              copy their key reaches for the nearest button. */}
          <div className="snippet">
            <pre>
              <code>{minted}</code>
            </pre>
            <CopyButton value={minted} what="The agent key" />
          </div>
          <p className="written measure">Copy it now. It is shown once.</p>
          <p className="actions">
            <a href="/dashboard" data-button data-variant="primary">
              Back to listings
            </a>
          </p>
        </>
      ) : (
        <>
          {row ? (
            <p className="facts">
              <span className="computed">{`${AGENT_KEY_PREFIX}…`}</span>
              {` · created ${formatDate(row.created_at)} · last used ${row.last_used_at ? formatDate(row.last_used_at) : "never"}`}
            </p>
          ) : (
            <p className="written measure">No key yet. Scripts and agents use one to act for you.</p>
          )}
          <form method="post" action="/dashboard/key/rotate">
            <p className="actions">
              <button type="submit">{row ? "Rotate key" : "Create key"}</button>
              <a href="/dashboard">Back to listings</a>
            </p>
          </form>
        </>
      )}

      <details>
        <summary>
          <span className="label">What it does</span>
          <span className="computed">{scopes}</span>
        </summary>
        <p className="written measure">
          Sent as <code>Authorization: Bearer {AGENT_KEY_PREFIX}…</code> to the public API. It cannot move money or change your payout
          address; those need a wallet signature.
        </p>
        <p className="written measure">
          Rotating revokes the old key at once (
          <a href="/docs/errors#invalid_key">
            <code>401 invalid_key</code>
          </a>
          ). This browser is not affected. From a script, <code>POST /api/auth/rotate-key</code> with a wallet signature does the same.
        </p>
        {minted ? (
          <pre>
            <code>{`curl -s ${appUrl()}/api/listings \\\n  -H "Authorization: Bearer ${minted}"`}</code>
          </pre>
        ) : null}
      </details>
    </main>
  );
}
