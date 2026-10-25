/**
 * GET /admin/users — everybody: accounts, and the wallets that bought without one.
 *
 * Replaced `/admin/creators` on 2026-09-14 (DECISIONS.md). A creator is now a filter —
 * an account with a live listing — rather than the whole page, because a buyer is a user
 * too and the old roster could not show one.
 *
 * Every control is a link or a GET form, so a filtered, sorted view is a URL: it survives
 * a reload, can be pasted to somebody else, and works with scripting off: type, how they
 * signed up, and real/test/everyone. Which network's money the columns count is the admin
 * nav's switch, shared by every admin page (lib/admin/network.ts).
 *
 * The one write is the test label, and it is a label — reversible, and it moves no money
 * and stops nothing — so it can sit on the row (lib/admin/users.ts, `setUserLabel`).
 */

import type { Metadata } from "next";
import { CopyButton } from "@/app/_components/copy-button";
import { Notice } from "@/app/_components/notice";
import { AutoSubmitSelect } from "@/app/admin/_components/auto-submit-select";
import { currentNetwork } from "@/app/admin/_components/current-network";
import { NETWORK_CHAIN, type Network } from "@/lib/admin/network";
import { CREATOR_FLAG_LABEL } from "@/lib/admin/creators";
import { requireAdmin } from "@/lib/admin/guard";
import {
  applyRole,
  applyScope,
  applyVia,
  loadUsers,
  parseUsersQuery,
  ROLES,
  SCOPES,
  searchUsers,
  sortToggle,
  sortUsers,
  usersHref,
  DEFAULT_QUERY,
  defaultDir,
  type AdminUser,
  type Role,
  type Scope,
  type SortKey,
  type TestReason,
  type UsersQuery,
  type Via,
  VIAS,
} from "@/lib/admin/users";
import { formatDate, formatDateTime } from "@/lib/web/manifest-view";
import { formatAmount } from "@/lib/web/money";
import { explorerAddressUrl } from "@/lib/web/wallet-checkout";

export const metadata: Metadata = { title: "Users" };
export const dynamic = "force-dynamic";

const ROLE_LABEL: Record<Role, string> = {
  all: "All",
  creators: "Creators",
  buyers: "Buyers",
  unlisted: "Not listed",
};

const VIA_LABEL: Record<Via, string> = { any: "Any", web: "Web", api: "API" };

const SCOPE_LABEL: Record<Scope, string> = { real: "Real", test: "Test", everyone: "Everyone" };
const NETWORK_LABEL: Record<Network, string> = { mainnet: "Mainnet", testnet: "Testnet" };
const CHAIN_NAME: Record<Network, string> = { mainnet: "Base mainnet", testnet: "Base Sepolia" };

const TEST_REASON_LABEL: Record<TestReason, string> = { marked: "marked", harness: "harness", testnet: "testnet" };

const SORT_LABEL: Record<SortKey, string> = {
  user: "by name",
  joined: "by join date",
  via: "by arrival",
  listings: "by live listings",
  sales: "by sales",
  gross: "by gross",
  bought: "by spend",
  last: "by last activity",
  address: "by address",
  flags: "by flags",
};

type Search = { role?: string; scope?: string; net?: string; sort?: string; dir?: string; q?: string; ok?: string; error?: string };

export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  await requireAdmin("/admin/users");

  const query = parseUsersQuery(sp);
  const { net } = await currentNetwork();
  const { rows, truncated } = await loadUsers(net);

  const inScope = applyScope(rows, query.scope);
  const shown = sortUsers(searchUsers(applyVia(applyRole(inScope, query.role), query.via), query.q), query.sort, query.dir);
  const here = usersHref(query);

  return (
    <main>
      <h1>Users</h1>
      <Notice ok={sp.ok} error={sp.error} />

      {truncated ? (
        <p className="written measure" data-status="warn">
          Showing the newest users only — there are more than this page reads in one go, and the counts cover what is shown.
        </p>
      ) : null}

      {/* One GET form: the dropdowns apply on change, and Search applies everything with
          scripting off. The sort rides along so filtering never resets the order. */}
      <form method="get" action="/admin/users" className="usersbar" role="search">
        {query.sort !== DEFAULT_QUERY.sort ? <input type="hidden" name="sort" value={query.sort} /> : null}
        {query.dir !== defaultDir(query.sort) ? <input type="hidden" name="dir" value={query.dir} /> : null}

        <div className="usersbar-field">
          <label htmlFor="users-q">Find</label>
          <div className="usersbar-search">
            <input id="users-q" name="q" type="search" defaultValue={query.q} placeholder="handle or address" autoComplete="off" spellCheck={false} />
            <button type="submit">Search</button>
          </div>
        </div>

        <div className="usersbar-field">
          <label htmlFor="users-role">Type</label>
          <AutoSubmitSelect id="users-role" name="role" defaultValue={query.role}>
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABEL[role]} · {applyRole(applyVia(inScope, query.via), role).length}
              </option>
            ))}
          </AutoSubmitSelect>
        </div>

        <div className="usersbar-field">
          <label htmlFor="users-via">Signed up via</label>
          <AutoSubmitSelect id="users-via" name="via" defaultValue={query.via}>
            {VIAS.map((via) => (
              <option key={via} value={via}>
                {VIA_LABEL[via]} · {applyVia(applyRole(inScope, query.role), via).length}
              </option>
            ))}
          </AutoSubmitSelect>
        </div>

        <div className="usersbar-field">
          <label htmlFor="users-scope">Show</label>
          <AutoSubmitSelect id="users-scope" name="scope" defaultValue={query.scope}>
            {SCOPES.map((scope) => (
              <option key={scope} value={scope}>
                {SCOPE_LABEL[scope]} · {applyScope(rows, scope).length}
              </option>
            ))}
          </AutoSubmitSelect>
        </div>

        {here !== "/admin/users" ? (
          <a className="usersbar-reset" href="/admin/users">
            Reset
          </a>
        ) : null}
      </form>

      {shown.length === 0 ? (
        <EmptyUsers query={query} net={net} anyone={rows.length > 0} />
      ) : (
        <table className="feed">
          <caption>{`${shown.length} user${shown.length === 1 ? "" : "s"} · ${SORT_LABEL[query.sort]} · times UTC · money on ${CHAIN_NAME[net]}`}</caption>
          <thead>
            <tr>
              <SortHead query={query} k="user" label="User" />
              <SortHead query={query} k="joined" label="Joined" col="optional" />
              <SortHead query={query} k="via" label="Via" col="dense" />
              <SortHead query={query} k="listings" label="Listings" col="optional" num />
              <SortHead query={query} k="sales" label="Sales" col="optional" num />
              <SortHead query={query} k="gross" label="Gross" col="dense" num />
              <SortHead query={query} k="bought" label="Bought" col="optional" num />
              <SortHead query={query} k="last" label="Last activity" />
              <SortHead query={query} k="address" label="Address" col="dense" />
              <SortHead query={query} k="flags" label="Flags" />
            </tr>
          </thead>
          <tbody>
            {shown.map((user) => (
              <UserRow key={user.subject} user={user} net={net} back={here} />
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

function SortHead({ query, k, label, col, num }: { query: UsersQuery; k: SortKey; label: string; col?: string; num?: boolean }) {
  const active = query.sort === k;
  return (
    <th
      scope="col"
      className={num ? "num" : undefined}
      data-col={col}
      aria-sort={active ? (query.dir === "asc" ? "ascending" : "descending") : undefined}
    >
      <a href={usersHref(query, sortToggle(query, k))} data-sort={active ? query.dir : "off"}>
        {label}
      </a>
    </th>
  );
}

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

function UserRow({ user, net, back }: { user: AdminUser; net: Network; back: string }) {
  const explorer = explorerAddressUrl(NETWORK_CHAIN[net], user.address);

  return (
    <tr>
      <td className="wrap" data-lead="">
        {user.creator ? (
          <a href={`/admin/creators/${user.creator.handle}`}>{user.creator.handle}</a>
        ) : (
          <>
            <span title={user.address}>{short(user.address)}</span> <span className="muted">wallet</span>
          </>
        )}
      </td>
      <td data-col="optional">{formatDate(user.joinedAt)}</td>
      <td data-col="dense">{user.via}</td>
      <td className="num" data-col="optional">
        {user.kind === "wallet" ? (
          <span className="muted">—</span>
        ) : user.listings > 0 ? (
          <>
            {user.listings}
            {user.live > 0 ? <span className="muted"> · {user.live} live</span> : null}
          </>
        ) : (
          <span className="muted">0</span>
        )}
      </td>
      <td className="num" data-col="optional">
        {user.sales > 0 ? user.sales : <span className="muted">{user.kind === "wallet" ? "—" : "0"}</span>}
      </td>
      <td className="num" data-col="dense">
        {user.sales > 0 ? formatAmount(user.grossMicro) : <span className="muted">—</span>}
      </td>
      <td className="num" data-col="optional">
        {user.purchases > 0 ? (
          <>
            {user.purchases} <span className="muted">· {formatAmount(user.spentMicro)}</span>
          </>
        ) : (
          <span className="muted">0</span>
        )}
      </td>
      <td>
        {user.lastActivityAt ? (
          <span title={formatDateTime(user.lastActivityAt)}>{formatDate(user.lastActivityAt)}</span>
        ) : (
          <span className="muted">never</span>
        )}
      </td>
      <td data-col="dense">
        <span className="addr">
          {explorer ? (
            <a href={explorer} target="_blank" rel="noopener noreferrer" title={`${user.address} on Basescan`}>
              {short(user.address)}
            </a>
          ) : (
            <span title={user.address}>{short(user.address)}</span>
          )}
          <CopyButton value={user.address} what="Address" />
        </span>
      </td>
      <td>
        <div className="flags">
          {user.test.is ? (
            <span data-status="pending">test{user.test.reason ? ` · ${TEST_REASON_LABEL[user.test.reason]}` : ""}</span>
          ) : null}
          {user.flags.map((flag) => (
            <span key={flag} data-status={flag === "rebinding" ? "warn" : "pending"}>
              {CREATOR_FLAG_LABEL[flag]}
            </span>
          ))}
        </div>
        {/* In the flags cell rather than a column of its own: the label is about the flag
            above it, and a tenth column pushed the table past the page's measure. */}
        <form method="post" action="/admin/users/label" className="row-action" data-col="optional">
          <input type="hidden" name="subject" value={user.subject} />
          <input type="hidden" name="test" value={user.test.is ? "0" : "1"} />
          <input type="hidden" name="back" value={back} />
          <button type="submit">{user.test.is ? "Not test" : "Mark test"}</button>
        </form>
      </td>
    </tr>
  );
}

function EmptyUsers({ query, net, anyone }: { query: UsersQuery; net: Network; anyone: boolean }) {
  if (!anyone) {
    return (
      <p className="written measure">
        Nobody yet. An account appears once it binds a payout address; a wallet appears once it buys something on{" "}
        {CHAIN_NAME[net]}.
      </p>
    );
  }
  if (query.q) {
    return (
      <p className="written measure">
        Nothing matches <code>{query.q}</code> here. <a href={usersHref(query, { q: "" })}>Clear the search</a>.
      </p>
    );
  }
  return (
    <p className="written measure">
      No {ROLE_LABEL[query.role].toLowerCase()}
      {query.via === "any" ? "" : ` who signed up via ${VIA_LABEL[query.via]}`} among {SCOPE_LABEL[query.scope].toLowerCase()} users on{" "}
      {NETWORK_LABEL[net].toLowerCase()}. <a href={usersHref(query, { role: "all", via: "any", scope: "everyone" })}>Show everyone</a>.
    </p>
  );
}
