/**
 * lib/admin/users.ts — everybody the platform has met, and which of them are real.
 *
 * Two kinds of user. An **account** is a `creator` row: somebody who signed up and bound
 * a payout address, on either rail, whether or not they ever listed anything. A **wallet**
 * is a buyer: an address that holds a purchase and has no account. A creator whose payout
 * address also bought something is one user, not two — their purchases are counted on the
 * account row.
 *
 * Buyer addresses are selected here, which reverses the 2026-09-07 rule that no admin
 * module reads them (DECISIONS.md, 2026-09-14). FR-40 is about *creators* never seeing
 * buyers, and that still holds: this module is reachable only behind the admin guard, and
 * nothing here reaches a creator's page, a notification or the analytics mirror.
 *
 * **Test users are hidden by default**, because most of the table is the e2e harness. A
 * user is test when an operator said so (`user_label`), otherwise when the harness made
 * them (`e2ea…`/`e2eb…`), otherwise when every on-chain thing they did happened on a
 * testnet and nothing of theirs is live. Separately, money columns count one network at a time — mainnet by default —
 * so a real creator's Sepolia test purchases are never read as revenue.
 *
 * Read-only apart from `setUserLabel`, and no import of `lib/core/access.ts`.
 */

import { recordAdminAction } from "@/lib/admin/audit";
import { creatorFlags, ROSTER_READ_LIMIT, type CreatorFlag } from "@/lib/admin/creators";
import { NETWORK_CHAIN, type Network } from "@/lib/admin/network";
import { db } from "@/lib/db";
import type { CreatorRow, ListingRow, PurchaseRow, PurchaseSource, UserLabelRow } from "@/lib/db/types";
import { toMicro } from "@/lib/db/types";
import { statusOf } from "@/lib/web/loaders";

export const ACCOUNT_LIMIT = 500;

const TESTNET_CHAINS = new Set([NETWORK_CHAIN.testnet]);

/** `scripts/e2e-fr34.mjs`: `e2e` + rail + three random bytes. */
export const HARNESS_HANDLE = /^e2e[ab][0-9a-f]{6}$/;

export type UserKind = "account" | "wallet";
export type UserVia = "web" | "api" | "mcp";
export type TestReason = "marked" | "harness" | "testnet";

export type AdminUser = {
  /** `creator:<uuid>` or `wallet:<lowercase address>` — the `user_label` key. */
  subject: string;
  kind: UserKind;
  creator: CreatorRow | null;
  /** The payout address for an account; the buying address for a wallet. */
  address: string;
  /** Sign-up for an account; first purchase, on any chain, for a wallet. */
  joinedAt: string;
  via: UserVia;
  listings: number;
  live: number;
  /** Sales of their listings on the selected network. */
  sales: number;
  grossMicro: bigint;
  /** What this address bought on the selected network. */
  purchases: number;
  spentMicro: bigint;
  lastActivityAt: string | null;
  flags: CreatorFlag[];
  test: { is: boolean; reason: TestReason | null };
};


// --- the query ------------------------------------------------------------------

export const ROLES = ["all", "creators", "buyers", "unlisted"] as const;
export type Role = (typeof ROLES)[number];

/** How a user arrived. `api` includes MCP: both are an agent, not a browser. */
export const VIAS = ["any", "web", "api"] as const;
export type Via = (typeof VIAS)[number];

export const SCOPES = ["real", "test", "everyone"] as const;
export type Scope = (typeof SCOPES)[number];

export const SORT_KEYS = ["user", "joined", "via", "listings", "sales", "gross", "bought", "last", "address", "flags"] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = "asc" | "desc";

/** Words read A→Z first; counts, money and dates read biggest or newest first. */
const TEXT_KEYS = new Set<SortKey>(["user", "via", "address"]);
export const defaultDir = (key: SortKey): SortDir => (TEXT_KEYS.has(key) ? "asc" : "desc");

export type UsersQuery = { role: Role; via: Via; scope: Scope; sort: SortKey; dir: SortDir; q: string };

export const DEFAULT_QUERY: UsersQuery = { role: "all", via: "any", scope: "real", sort: "joined", dir: "desc", q: "" };

const pick = <T extends string>(allowed: readonly T[], value: string | undefined, fallback: T): T =>
  (allowed as readonly string[]).includes(value ?? "") ? (value as T) : fallback;

export function parseUsersQuery(sp: Record<string, string | undefined>): UsersQuery {
  const sort = pick(SORT_KEYS, sp.sort, DEFAULT_QUERY.sort);
  return {
    role: pick(ROLES, sp.role, DEFAULT_QUERY.role),
    via: pick(VIAS, sp.via, DEFAULT_QUERY.via),
    scope: pick(SCOPES, sp.scope, DEFAULT_QUERY.scope),
    sort,
    dir: pick(["asc", "desc"] as const, sp.dir, defaultDir(sort)),
    q: (sp.q ?? "").trim(),
  };
}

/** The page URL for a query, with every default left out so the common links stay short. */
export function usersHref(query: UsersQuery, over: Partial<UsersQuery> = {}): string {
  const next = { ...query, ...over };
  const params = new URLSearchParams();
  if (next.role !== DEFAULT_QUERY.role) params.set("role", next.role);
  if (next.via !== DEFAULT_QUERY.via) params.set("via", next.via);
  if (next.scope !== DEFAULT_QUERY.scope) params.set("scope", next.scope);
  if (next.sort !== DEFAULT_QUERY.sort || next.dir !== defaultDir(next.sort)) params.set("sort", next.sort);
  if (next.dir !== defaultDir(next.sort)) params.set("dir", next.dir);
  if (next.q) params.set("q", next.q);
  const qs = params.toString();
  return qs ? `/admin/users?${qs}` : "/admin/users";
}

/** Clicking the sorted column flips it; clicking another starts in that column's natural order. */
export function sortToggle(query: UsersQuery, key: SortKey): Partial<UsersQuery> {
  if (query.sort === key) return { sort: key, dir: query.dir === "asc" ? "desc" : "asc" };
  return { sort: key, dir: defaultDir(key) };
}

// --- pure -----------------------------------------------------------------------

export const isCreator = (u: AdminUser) => u.live > 0;

export function applyRole(rows: readonly AdminUser[], role: Role): AdminUser[] {
  switch (role) {
    case "all":
      return [...rows];
    case "creators":
      return rows.filter(isCreator);
    case "buyers":
      return rows.filter((u) => u.purchases > 0);
    case "unlisted":
      return rows.filter((u) => u.kind === "account" && u.live === 0);
  }
}

export function applyVia(rows: readonly AdminUser[], via: Via): AdminUser[] {
  if (via === "any") return [...rows];
  return rows.filter((u) => (u.via === "web") === (via === "web"));
}

export function applyScope(rows: readonly AdminUser[], scope: Scope): AdminUser[] {
  if (scope === "everyone") return [...rows];
  return rows.filter((u) => u.test.is === (scope === "test"));
}

export function searchUsers(rows: readonly AdminUser[], q: string | undefined): AdminUser[] {
  const needle = (q ?? "").trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter((u) => (u.creator?.handle.toLowerCase().includes(needle) ?? false) || u.address.toLowerCase().includes(needle));
}

export const displayName = (u: AdminUser) => u.creator?.handle ?? u.address.toLowerCase();

const time = (iso: string | null) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : t;
};
const cmp = (a: number | bigint | string, b: number | bigint | string) =>
  typeof a === "string" && typeof b === "string" ? a.localeCompare(b) : a < b ? -1 : a > b ? 1 : 0;

/** A missing value (never active, unparseable date) sinks to the bottom in either direction. */
export function sortUsers(rows: readonly AdminUser[], key: SortKey, dir: SortDir): AdminUser[] {
  const value = (u: AdminUser): (number | bigint | string)[] | null => {
    switch (key) {
      case "user":
        return [displayName(u)];
      case "joined":
        return time(u.joinedAt) === null ? null : [time(u.joinedAt)!];
      case "via":
        return [u.via];
      case "listings":
        return [u.live, u.listings];
      case "sales":
        return [u.sales, u.grossMicro];
      case "gross":
        return [u.grossMicro, u.sales];
      case "bought":
        return [u.spentMicro, u.purchases];
      case "last":
        return time(u.lastActivityAt) === null ? null : [time(u.lastActivityAt)!];
      case "address":
        return [u.address.toLowerCase()];
      case "flags":
        return [u.flags.length + (u.test.is ? 1 : 0)];
    }
  };
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === null || vb === null) {
      if (va !== vb) return va === null ? 1 : -1;
    } else {
      for (let i = 0; i < va.length; i++) {
        const c = cmp(va[i], vb[i]);
        if (c !== 0) return c * sign;
      }
    }
    return (time(b.joinedAt) ?? 0) - (time(a.joinedAt) ?? 0) || displayName(a).localeCompare(displayName(b));
  });
}

/**
 * Testnet-only activity marks a user test only when nothing of theirs is live: a creator
 * with a live listing who has only traded on Sepolia so far is testing before mainnet,
 * not a fixture.
 */
export function testVerdict(input: {
  label: boolean | undefined;
  handle: string | null;
  chains: ReadonlySet<number>;
  live: number;
}): { is: boolean; reason: TestReason | null } {
  if (input.label !== undefined) return { is: input.label, reason: input.label ? "marked" : null };
  if (input.handle && HARNESS_HANDLE.test(input.handle)) return { is: true, reason: "harness" };
  if (input.live === 0 && input.chains.size > 0 && [...input.chains].every((c) => TESTNET_CHAINS.has(c))) {
    return { is: true, reason: "testnet" };
  }
  return { is: false, reason: null };
}

// --- the read ---------------------------------------------------------------------

export type UsersView = { rows: AdminUser[]; truncated: boolean };

type PurchaseRead = Pick<PurchaseRow, "listing_id" | "buyer_address" | "gross_micro" | "chain_id" | "source" | "granted_at">;

export async function loadUsers(net: Network, limit = ACCOUNT_LIMIT): Promise<UsersView> {
  const chainId = NETWORK_CHAIN[net];

  const [creatorRes, purchaseRes, labels] = await Promise.all([
    db().from("creator").select("*").order("created_at", { ascending: false }).limit(limit + 1),
    db()
      .from("purchase")
      .select("listing_id, buyer_address, gross_micro, chain_id, source, granted_at")
      .is("revoked_at", null)
      .limit(ROSTER_READ_LIMIT),
    loadLabels(),
  ]);
  if (creatorRes.error) throw creatorRes.error;
  if (purchaseRes.error) throw purchaseRes.error;

  const allCreators = (creatorRes.data as CreatorRow[] | null) ?? [];
  const creators = allCreators.slice(0, limit);
  const purchases = (purchaseRes.data as PurchaseRead[] | null) ?? [];
  const truncated = allCreators.length > limit || purchases.length >= ROSTER_READ_LIMIT;

  const { data: listingData, error: listingError } = creators.length
    ? await db()
        .from("listing")
        .select("id, creator_id, published_at, retired_at, created_at")
        .in("creator_id", creators.map((c) => c.id))
        .limit(ROSTER_READ_LIMIT)
    : { data: [], error: null };
  if (listingError) throw listingError;
  const listings = (listingData as ListingRow[] | null) ?? [];
  const listingsComplete = listings.length < ROSTER_READ_LIMIT;
  const ownerOf = new Map(listings.map((l) => [l.id, l.creator_id]));

  // Per creator: what their listings sold. Per address: what it bought.
  const sold = new Map<string, { chains: Set<number>; count: number; gross: bigint; last: string | null }>();
  const bought = new Map<string, { chains: Set<number>; count: number; spent: bigint; last: string | null; first: PurchaseRead; display: string }>();
  for (const p of purchases) {
    const chain = Number(p.chain_id);
    const onNet = chain === chainId;

    const owner = ownerOf.get(p.listing_id);
    if (owner) {
      const s = sold.get(owner) ?? { chains: new Set<number>(), count: 0, gross: 0n, last: null };
      s.chains.add(chain);
      if (onNet) {
        s.count += 1;
        s.gross += toMicro(p.gross_micro);
        s.last = later(s.last, p.granted_at);
      }
      sold.set(owner, s);
    }

    const addr = p.buyer_address.toLowerCase();
    const b = bought.get(addr) ?? { chains: new Set<number>(), count: 0, spent: 0n, last: null, first: p, display: p.buyer_address };
    b.chains.add(chain);
    if (time(p.granted_at) !== null && (time(b.first.granted_at) ?? Infinity) > time(p.granted_at)!) b.first = p;
    if (onNet) {
      b.count += 1;
      b.spent += toMicro(p.gross_micro);
      b.last = later(b.last, p.granted_at);
    }
    bought.set(addr, b);
  }

  const accountAddresses = new Set<string>();
  const rows: AdminUser[] = creators.map((creator) => {
    const address = creator.payout_address.toLowerCase();
    accountAddresses.add(address);
    const mine = listings.filter((l) => l.creator_id === creator.id);
    const s = sold.get(creator.id);
    const b = bought.get(address);
    let last: string | null = null;
    for (const l of mine) last = later(last, l.published_at ?? l.created_at);
    last = later(later(last, s?.last ?? null), b?.last ?? null);
    const subject = `creator:${creator.id}`;
    const live = mine.filter((l) => statusOf(l) === "live").length;
    return {
      subject,
      kind: "account",
      creator,
      address: creator.payout_address,
      joinedAt: creator.created_at,
      via: creator.onboarded_via,
      listings: mine.length,
      live,
      sales: s?.count ?? 0,
      grossMicro: s?.gross ?? 0n,
      purchases: b?.count ?? 0,
      spentMicro: b?.spent ?? 0n,
      lastActivityAt: last,
      flags: creatorFlags(creator, mine.length, Date.now(), listingsComplete),
      test: testVerdict({
        label: labels.get(subject),
        handle: creator.handle,
        chains: new Set([...(s?.chains ?? []), ...(b?.chains ?? [])]),
        live,
      }),
    } satisfies AdminUser;
  });

  // A wallet appears only on a network it bought on; one that also owns an account is that row.
  for (const [addr, b] of bought) {
    if (accountAddresses.has(addr) || b.count === 0) continue;
    const subject = `wallet:${addr}`;
    rows.push({
      subject,
      kind: "wallet",
      creator: null,
      address: b.display,
      joinedAt: b.first.granted_at,
      via: b.first.source as PurchaseSource,
      listings: 0,
      live: 0,
      sales: 0,
      grossMicro: 0n,
      purchases: b.count,
      spentMicro: b.spent,
      lastActivityAt: b.last,
      flags: [],
      test: testVerdict({ label: labels.get(subject), handle: null, chains: b.chains, live: 0 }),
    });
  }

  return { rows, truncated };
}

function later(a: string | null, b: string | null): string | null {
  if (!b || time(b) === null) return a;
  if (!a || time(a) === null) return b;
  return time(b)! > time(a)! ? b : a;
}

/**
 * Fails safe to "no labels" — most likely the migration has not run — so the page still
 * renders with the automatic verdicts rather than not at all.
 */
async function loadLabels(): Promise<Map<string, boolean>> {
  const { data, error } = await db().from("user_label").select("subject, is_test");
  if (error) {
    console.warn("[admin] could not read user_label; showing automatic test verdicts only:", error.message);
    return new Map();
  }
  return new Map(((data as Pick<UserLabelRow, "subject" | "is_test">[] | null) ?? []).map((r) => [r.subject, r.is_test]));
}

// --- the write ----------------------------------------------------------------------

const SUBJECT = /^(creator:[0-9a-f-]{36}|wallet:0x[0-9a-f]{40})$/;

export type LabelResult = { ok: true; message: string } | { ok: false; message: string };

/** Mark a user as test or as real. `by` is the session's login, never a form value. */
export async function setUserLabel(input: { subject: unknown; isTest: boolean; by: string }): Promise<LabelResult> {
  const subject = typeof input.subject === "string" ? input.subject.trim().toLowerCase() : "";
  if (!SUBJECT.test(subject)) return { ok: false, message: "That is not a user this page can label." };

  let name: string;
  let props: Record<string, unknown>;
  if (subject.startsWith("creator:")) {
    const { data, error } = await db().from("creator").select("handle").eq("id", subject.slice(8)).maybeSingle();
    if (error) throw error;
    if (!data) return { ok: false, message: "No account has that id." };
    name = (data as { handle: string }).handle;
    props = { ref: name };
  } else {
    const address = subject.slice(7);
    const { data, error } = await db().from("purchase").select("buyer_address").ilike("buyer_address", address).limit(1);
    if (error) throw error;
    if (!data || data.length === 0) return { ok: false, message: "No purchase was made from that wallet." };
    name = `${address.slice(0, 6)}…${address.slice(-4)}`;
    props = { wallet: address };
  }

  const { error } = await db()
    .from("user_label")
    .upsert({ subject, is_test: input.isTest, set_by: input.by, set_at: new Date().toISOString() }, { onConflict: "subject" });
  if (error) return { ok: false, message: `Could not save the label: ${error.message}` };

  const auditError = await recordAdminAction({ name: input.isTest ? "user_marked_test" : "user_marked_real", by: input.by, props });
  const done = input.isTest ? `${name} is marked as a test user and is hidden from the default view.` : `${name} is marked as a real user.`;
  return { ok: true, message: auditError ? `${done} The audit row did not save: ${auditError}` : done };
}
