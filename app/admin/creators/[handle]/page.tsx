/**
 * GET /admin/creators/:handle — one creator: who they are, what they list, what they
 * have been paid, and which keys can act as them.
 *
 * The page someone opens when a creator writes in. "I have not been paid" is answered by
 * the payout address, any pending rebind, what is owed, and the payout rows with their
 * transactions. "My agent stopped working" is answered by the key table: kind, scopes,
 * last used, and — the usual culprit — `revoked_reason = found_in_repository`.
 *
 * Key hashes are never loaded into the page (lib/admin/detail.ts maps them out), and no
 * buyer address appears.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { currentNetwork } from "@/app/admin/_components/current-network";
import { loadCreatorDetail } from "@/lib/admin/detail";
import { requireAdmin } from "@/lib/admin/guard";
import { ownerProfileById } from "@/lib/web/github-profile";
import { formatDate, formatDateTime } from "@/lib/web/manifest-view";
import { formatAmount } from "@/lib/web/money";

export const metadata: Metadata = { title: "Creator" };
export const dynamic = "force-dynamic";

const CHAIN_NAME: Record<number, string> = { 8453: "Base mainnet", 84532: "Base Sepolia" };
const EXPLORER: Record<number, string> = { 8453: "https://basescan.org", 84532: "https://sepolia.basescan.org" };

export default async function AdminCreatorPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  await requireAdmin(`/admin/creators/${encodeURIComponent(handle)}`);

  const detail = await loadCreatorDetail(decodeURIComponent(handle), (await currentNetwork()).chainId);
  if (!detail) notFound();
  const { creator, listings, sales, payouts, keys } = detail;
  const chain = CHAIN_NAME[detail.chainId] ?? `chain ${detail.chainId}`;
  const explorer = EXPLORER[detail.chainId] ?? null;
  const liveAgent = keys.filter((k) => k.live && k.kind === "agent").length;
  const liveSession = keys.filter((k) => k.live && k.kind === "session").length;
  const github = creator.github_user_id ? await ownerProfileById(creator.github_user_id) : null;

  return (
    <main>
      <p className="muted">
        <a href="/admin/users">Users</a>
      </p>
      <h1>{creator.handle}</h1>

      <dl>
        <dt>Joined</dt>
        <dd>
          {formatDateTime(creator.created_at)} <span className="muted">· via {creator.onboarded_via} · terms {creator.terms_version}</span>
        </dd>
        <dt>Public page</dt>
        <dd>
          <a href={`/${creator.handle}`} target="_blank" rel="noreferrer">
            /{creator.handle}
          </a>
        </dd>
        <dt>GitHub</dt>
        <dd>
          {!creator.github_user_id ? (
            <span className="muted">not linked (headless)</span>
          ) : github ? (
            <>
              <a href={github.html_url ?? `https://github.com/${github.login}`} target="_blank" rel="noreferrer">
                @{github.login}
              </a>{" "}
              <span className="muted">
                · {github.name ? `${github.name} · ` : ""}user id {creator.github_user_id}
              </span>
            </>
          ) : (
            // The id resolves on GitHub's API even when our lookup failed; its JSON names the login.
            <>
              <a href={`https://api.github.com/user/${creator.github_user_id}`} target="_blank" rel="noreferrer">
                user id {creator.github_user_id}
              </a>{" "}
              <span className="muted">· profile lookup failed</span>
            </>
          )}
        </dd>
        <dt>Wallet</dt>
        <dd>
          {creator.wallet_mode}
          {creator.wallet_mode === "custodial" ? <span className="muted"> · the platform holds this wallet (D11)</span> : null}
        </dd>
        <dt>Payout address</dt>
        <dd className="address">
          {explorer ? (
            <a href={`${explorer}/address/${creator.payout_address}`} target="_blank" rel="noreferrer">
              {creator.payout_address}
            </a>
          ) : (
            creator.payout_address
          )}
        </dd>
        {creator.pending_payout_address ? (
          <>
            <dt>Rebinding to</dt>
            <dd data-status="warn" className="address">
              {creator.pending_payout_address}{" "}
              <span className="muted">
                · effective {formatDateTime(creator.rebind_effective_at)} — lands at the next payout after that, not at that moment
              </span>
            </dd>
          </>
        ) : null}
        <dt>Abuse contact</dt>
        <dd>
          {creator.abuse_contact_email || creator.abuse_contact_url ? (
            [creator.abuse_contact_email, creator.abuse_contact_url].filter(Boolean).join(" · ")
          ) : (
            <span className="muted">none given</span>
          )}
          {creator.pending_abuse_contact_email || creator.pending_abuse_contact_url ? (
            <span className="muted"> · changing {formatDate(creator.abuse_contact_effective_at)}</span>
          ) : null}
        </dd>
        <dt>Sales</dt>
        <dd>
          {sales.sales} · {formatAmount(sales.grossMicro)} gross · {formatAmount(sales.netMicro)} theirs <span className="muted">({chain})</span>
        </dd>
        <dt>Unpaid</dt>
        <dd data-status={sales.owedMicro > 0n ? "warn" : undefined}>
          {formatAmount(sales.owedMicro)} owed now <span className="muted">· {formatAmount(sales.heldMicro)} in holdback</span>
        </dd>
        <dt>Keys</dt>
        <dd>
          {liveAgent} agent · {liveSession} session <span className="muted">live</span>
        </dd>
      </dl>

      <section>
        <h2>Listings</h2>
        {listings.length === 0 ? (
          <p className="written measure">No listings. Signed up and stopped, or an agent that never pushed.</p>
        ) : (
          <table className="feed">
            <caption>{`${listings.length} listing${listings.length === 1 ? "" : "s"} · newest first · sales on ${chain}`}</caption>
            <thead>
              <tr>
                <th scope="col">Listing</th>
                <th scope="col">Status</th>
                <th scope="col" data-col="optional">
                  Created
                </th>
                <th scope="col" className="num">
                  Sales
                </th>
                <th scope="col" className="num" data-col="optional">
                  Gross
                </th>
              </tr>
            </thead>
            <tbody>
              {listings.map(({ listing, status, sales: n, grossMicro }) => (
                <tr key={listing.id}>
                  <td className="wrap" data-lead="">
                    <a href={`/admin/listings/${listing.id}`}>{listing.slug}</a>
                  </td>
                  <td data-status={status === "live" ? "pass" : status === "retired" ? "warn" : "pending"}>{status}</td>
                  <td data-col="optional">{formatDate(listing.created_at)}</td>
                  <td className="num">{n > 0 ? n : <span className="muted">0</span>}</td>
                  <td className="num" data-col="optional">
                    {n > 0 ? formatAmount(grossMicro) : <span className="muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Payouts</h2>
        {payouts.length === 0 ? (
          <p className="written measure">No payout on {chain} yet. Net earnings sweep once the 7-day holdback passes.</p>
        ) : (
          <table className="feed">
            <caption>{`${payouts.length} payout${payouts.length === 1 ? "" : "s"} · newest first · times UTC · ${chain}`}</caption>
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
                <th scope="col" data-col="optional">
                  Tx
                </th>
              </tr>
            </thead>
            <tbody>
              {payouts.map((p) => (
                <tr key={p.id}>
                  <td>{formatDateTime(p.created_at)}</td>
                  <td data-status={p.status === "confirmed" ? "pass" : p.status === "failed" ? "fail" : "warn"}>{p.status}</td>
                  <td className="num">{formatAmount(p.amountMicro)}</td>
                  <td data-col="wide">{p.to_address}</td>
                  <td data-col="optional">
                    {p.tx_hash ? (
                      explorer ? (
                        <a href={`${explorer}/tx/${p.tx_hash}`} target="_blank" rel="noreferrer" title={p.tx_hash}>
                          {p.tx_hash.slice(0, 10)}…
                        </a>
                      ) : (
                        `${p.tx_hash.slice(0, 10)}…`
                      )
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>API keys</h2>
        {keys.length === 0 ? (
          <p className="written measure">No keys have ever been issued to this creator.</p>
        ) : (
          <table className="feed">
            <caption>{`${keys.length} key${keys.length === 1 ? "" : "s"} · newest first · times UTC · hashes are never shown`}</caption>
            <thead>
              <tr>
                <th scope="col">Kind</th>
                <th scope="col">State</th>
                <th scope="col" data-col="optional">
                  Created
                </th>
                <th scope="col" data-col="optional">
                  Last used
                </th>
                <th scope="col" data-col="dense">
                  Scopes
                </th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td data-lead="">{k.kind}</td>
                  <td data-status={k.live ? "pass" : k.revoked_reason === "found_in_repository" ? "fail" : "pending"}>
                    {k.live ? "live" : k.revoked_at ? `revoked · ${k.revoked_reason ?? "no reason"}` : "expired"}
                  </td>
                  <td data-col="optional">{formatDateTime(k.created_at)}</td>
                  <td data-col="optional">{k.last_used_at ? formatDateTime(k.last_used_at) : <span className="muted">never</span>}</td>
                  <td className="wrap" data-col="dense">
                    {k.scopes.join(", ") || <span className="muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
