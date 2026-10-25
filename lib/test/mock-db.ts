/**
 * lib/test/mock-db.ts — an in-memory stand-in for the supabase-js client.
 *
 * Unit tests must not touch the network or need real credentials. This implements the
 * slice of the supabase-js query builder this codebase actually uses, over plain
 * arrays, so a route test can assert on rows instead of mocking fetch.
 *
 * ## Usage
 *
 * The client is behind a seam, so the simplest form needs no module mocking at all:
 *
 * ```ts
 * import { afterEach, beforeEach, expect, it } from "vitest";
 * import { resetDb, setDb, type Db } from "@/lib/db";
 * import { makeMockDb } from "@/lib/test/mock-db";
 *
 * let mock: ReturnType<typeof makeMockDb>;
 *
 * beforeEach(() => {
 *   mock = makeMockDb({ creator: [{ id: "c1", handle: "adrian", payout_address: "0xabc…" }] });
 *   setDb(mock.client as unknown as Db);
 * });
 * afterEach(() => resetDb());
 *
 * it("writes a challenge", async () => {
 *   await issueChallenge("0x…");
 *   expect(mock.rows("challenge")).toHaveLength(1);
 * });
 * ```
 *
 * If you prefer module mocking (for a module that imports `db` at module scope):
 *
 * ```ts
 * const mock = makeMockDb();
 * vi.mock("@/lib/db", async (importOriginal) => ({
 *   ...(await importOriginal<typeof import("@/lib/db")>()),
 *   db: () => mock.client,
 * }));
 * ```
 *
 * ## What it supports
 *
 * `from(table)` → `select` `insert` `update` `delete` `upsert`, filtered by `eq` `neq`
 * `is` `lt` `lte` `gt` `gte` `in` `ilike` `like` `not`, shaped by `order` `limit`
 * `range`, terminated by `single` `maybeSingle` or plain `await`.
 * `rpc(name, args)` — `rate_limit_hit` is implemented; register your own with
 * `mock.setRpc(name, fn)`. `storage` is a working in-memory bucket store.
 *
 * ## What it does not support
 *
 * Joins, `select("a, b:other(*)")` embedding, `or()`, RLS, transactions, and returning
 * columns other than the whole row. `select("…")` is parsed only far enough to be
 * ignored: every query returns whole rows. If you need more, add it here rather than
 * hand-rolling a second mock — this file is the shared one.
 */

import { randomUUID } from "node:crypto";

export type Row = Record<string, any>;
export type Rows = Record<string, Row[]>;

export type PostgrestError = { message: string; code: string; details: string | null; hint: string | null };
export type Result<T> = { data: T; error: null } | { data: null; error: PostgrestError };

/** Columns that must be unique per table, mirroring the migrations. */
const UNIQUE: Record<string, string[][]> = {
  creator: [["id"], ["handle"], ["github_user_id"]],
  api_key: [["id"], ["hash"]],
  listing: [["id"], ["creator_id", "slug"]],
  release: [["id"], ["listing_id", "version"]],
  // 20261025085950 adds `(chain_id, payment_nonce)` beside the global nonce key (CORE-1);
  // 20261025090100 adds `(network, payment_nonce)`, the one the replay lookup reads by.
  purchase: [["id"], ["payment_nonce"], ["chain_id", "payment_nonce"], ["network", "payment_nonce"]],
  payout: [["id"], ["idempotency_key"]],
  challenge: [["nonce"]],
  idempotency: [["key"]],
  webhook_delivery: [["delivery_id"]],
  rate_limit: [["bucket"]],
  // migration 20260907000000: the login is the primary key, lowercase.
  admin: [["github_login"]],
  // migration 20260906000000: one row per switch, so `setSwitch`'s upsert updates it.
  ops_switch: [["name"]],
  // migration 20260914000000: one current answer per user.
  user_label: [["subject"]],
};

/**
 * Partial unique indexes: unique only over rows the predicate accepts, mirroring a
 * Postgres `create unique index … where …`. The free-purchase index (W3.7) makes the
 * grantFree path DB-idempotent without constraining paid purchases.
 */
const PARTIAL_UNIQUE: Record<string, { columns: string[]; where: (r: Row) => boolean }[]> = {
  purchase: [{ columns: ["listing_id", "release_id", "buyer_address"], where: (r) => r.kind === "free" }],
  // FR-54 `api_key_one_live_agent`: at most one unrevoked agent key per creator, so a
  // rotate that forgets to revoke the old row fails here the way it would in Postgres.
  api_key: [{ columns: ["creator_id"], where: (r) => r.kind === "agent" && (r.revoked_at ?? null) === null }],
  // FR-28 in flight (20261025090100): one open payout per creator per rail, and — while
  // one hot account pays every Stellar payout — one per Stellar network overall. Without
  // these a sweep test passes whatever the predicate (BATTLE-TEST finding 12).
  payout: [
    { columns: ["creator_id", "network"], where: (r) => IN_FLIGHT.has(String(r.status)) },
    { columns: ["network"], where: (r) => typeof r.network === "string" && r.network.startsWith("stellar:") && IN_FLIGHT.has(String(r.status)) },
  ],
};
const IN_FLIGHT = new Set(["pending", "broadcast", "in_transit"]);

/** Base Sepolia USDC, the asset every EVM test row paid (lib/env.ts `usdcAddress`). */
const TEST_EVM_ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/** Server-side defaults, so a test inserts only what it cares about. */
function defaultsFor(table: string, now: string): Row {
  switch (table) {
    case "creator":
      return {
        id: randomUUID(),
        github_user_id: null,
        wallet_mode: "linked",
        cdp_wallet_id: null,
        pending_payout_address: null,
        rebind_effective_at: null,
        abuse_contact_url: null,
        abuse_contact_email: null,
        pending_abuse_contact_url: null,
        pending_abuse_contact_email: null,
        abuse_contact_effective_at: null,
        terms_accepted_at: now,
        created_at: now,
      };
    // FR-54 (migration 20260831000000): the bearer credentials, agent and session.
    case "api_key":
      return {
        id: randomUUID(),
        kind: "agent",
        scopes: ["listings:write", "earnings:read"],
        created_at: now,
        expires_at: null,
        revoked_at: null,
        revoked_reason: null,
        last_used_at: null,
      };
    case "listing":
      return {
        id: randomUUID(),
        price_micro: "9000000",
        update_price_micro: "5000000",
        installation_id: null,
        github_repo_id: null,
        deploy_key_id: null,
        hosted_org: null,
        description: null,
        trigger_hint: null,
        licence_spdx: null,
        licence_verdict: null,
        created_at: now,
        published_at: null,
        retired_at: null,
        // Open releases (20261025160000): off unless a test says otherwise.
        open_release: false,
        public_repo_url: null,
        open_after_days: null,
        open_eligibility: null,
        // Offered rails (20261025213000): null, every rail the creator can be paid on.
        offered_networks: null,
      };
    case "release":
      return {
        id: randomUUID(),
        scan: "pending",
        licence_verdict: null,
        created_at: now,
        // Open releases (20261025160000): no promise unless a test stamps one.
        opens_at: null,
        open_licence_spdx: null,
        promise_status: null,
        promise_checked_at: null,
        opened_at: null,
        promise_evidence: null,
        open_eligibility: null,
      };
    // `chain_id` and `network` default to Base Sepolia, which is what the tests'
    // X402_NETWORK is. A seeded row without them would be invisible to the chain- and
    // network-scoped queries (20260906010000, 20261025090100) and the case under test
    // would silently become "nothing to do". Mirrors the `set_network_from_chain` trigger.
    case "purchase":
      return { id: randomUUID(), all_versions: false, granted_at: now, payout_id: null, revoked_at: null, chain_id: 84532, network: "eip155:84532", asset: TEST_EVM_ASSET };
    case "payout":
      return { id: randomUUID(), gas_micro: "0", status: "pending", created_at: now, chain_id: 84532, network: "eip155:84532", asset: TEST_EVM_ASSET };
    case "event":
    case "screening":
      return { id: Date.now() + Math.floor(Math.random() * 1000), at: now };
    case "challenge":
      return { used_at: null, created_at: now };
    case "idempotency":
      return { request_hash: null, creator_id: null, created_at: now };
    case "webhook_delivery":
      return { received_at: now };
    case "rate_limit":
      return { count: 0, window_start: now };
    case "admin":
      return { note: null, granted_by: null, granted_at: now, revoked_at: null, revoked_by: null };
    case "ops_switch":
      return { paused: false, reason: null, updated_at: now, updated_by: null };
    default:
      return {};
  }
}

type Filter = (row: Row) => boolean;

class Query implements PromiseLike<Result<any>> {
  private filters: Filter[] = [];
  private orderBy: { column: string; ascending: boolean }[] = [];
  private limitTo: number | null = null;
  private rangeFrom = 0;
  private mode: "select" | "insert" | "update" | "delete" | "upsert" = "select";
  private payload: Row[] = [];
  private returning = false;
  private cardinality: "many" | "single" | "maybe" = "many";

  constructor(
    private store: Rows,
    private table: string,
  ) {}

  // --- verbs -----------------------------------------------------------------

  select(_columns?: string): this {
    if (this.mode === "select") this.mode = "select";
    this.returning = true;
    return this;
  }

  insert(values: Row | Row[]): this {
    this.mode = "insert";
    this.payload = Array.isArray(values) ? values : [values];
    return this;
  }

  upsert(values: Row | Row[]): this {
    this.mode = "upsert";
    this.payload = Array.isArray(values) ? values : [values];
    return this;
  }

  update(values: Row): this {
    this.mode = "update";
    this.payload = [values];
    return this;
  }

  delete(): this {
    this.mode = "delete";
    return this;
  }

  // --- filters ---------------------------------------------------------------

  eq(column: string, value: unknown): this {
    return this.where((r) => looseEq(r[column], value));
  }
  neq(column: string, value: unknown): this {
    return this.where((r) => !looseEq(r[column], value));
  }
  is(column: string, value: null | boolean): this {
    return this.where((r) => (value === null ? r[column] === null || r[column] === undefined : r[column] === value));
  }
  lt(column: string, value: unknown): this {
    return this.where((r) => cmp(r[column], value) < 0);
  }
  lte(column: string, value: unknown): this {
    return this.where((r) => cmp(r[column], value) <= 0);
  }
  gt(column: string, value: unknown): this {
    return this.where((r) => cmp(r[column], value) > 0);
  }
  gte(column: string, value: unknown): this {
    return this.where((r) => cmp(r[column], value) >= 0);
  }
  in(column: string, values: unknown[]): this {
    return this.where((r) => values.some((v) => looseEq(r[column], v)));
  }
  ilike(column: string, pattern: string): this {
    const re = likeToRegExp(pattern, "i");
    return this.where((r) => typeof r[column] === "string" && re.test(r[column]));
  }
  like(column: string, pattern: string): this {
    const re = likeToRegExp(pattern, "");
    return this.where((r) => typeof r[column] === "string" && re.test(r[column]));
  }
  not(column: string, operator: string, value: unknown): this {
    if (operator === "is") return this.where((r) => !(value === null ? r[column] === null || r[column] === undefined : r[column] === value));
    return this.where((r) => !looseEq(r[column], value));
  }

  // --- shaping ---------------------------------------------------------------

  order(column: string, options?: { ascending?: boolean }): this {
    this.orderBy.push({ column, ascending: options?.ascending ?? true });
    return this;
  }
  limit(n: number): this {
    this.limitTo = n;
    return this;
  }
  range(from: number, to: number): this {
    this.rangeFrom = from;
    this.limitTo = to - from + 1;
    return this;
  }

  single(): this {
    this.cardinality = "single";
    this.returning = true;
    return this;
  }
  maybeSingle(): this {
    this.cardinality = "maybe";
    this.returning = true;
    return this;
  }

  // --- execution --------------------------------------------------------------

  then<A = Result<any>, B = never>(
    onfulfilled?: ((value: Result<any>) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }

  private where(f: Filter): this {
    this.filters.push(f);
    return this;
  }

  private table_(): Row[] {
    this.store[this.table] ??= [];
    return this.store[this.table];
  }

  private run(): Result<any> {
    const rows = this.table_();
    const now = new Date().toISOString();

    if (this.mode === "insert" || this.mode === "upsert") {
      const inserted: Row[] = [];
      for (const value of this.payload) {
        const row = { ...defaultsFor(this.table, now), ...value };
        const clash = findClash(rows, this.table, row);
        if (clash) {
          if (this.mode === "insert") return { data: null, error: pgError("duplicate key value violates unique constraint", "23505") };
          Object.assign(clash, row);
          inserted.push(clash);
          continue;
        }
        rows.push(row);
        inserted.push(row);
      }
      return this.shape(inserted);
    }

    const matched = rows.filter((r) => this.filters.every((f) => f(r)));

    if (this.mode === "update") {
      for (const row of matched) Object.assign(row, this.payload[0]);
      return this.shape(matched);
    }

    if (this.mode === "delete") {
      for (const row of matched) {
        const i = rows.indexOf(row);
        if (i >= 0) rows.splice(i, 1);
      }
      return this.shape(matched);
    }

    let out = [...matched];
    for (const { column, ascending } of [...this.orderBy].reverse()) {
      out.sort((a, b) => (ascending ? cmp(a[column], b[column]) : cmp(b[column], a[column])));
    }
    out = out.slice(this.rangeFrom);
    if (this.limitTo !== null) out = out.slice(0, this.limitTo);
    return this.shape(out);
  }

  private shape(rows: Row[]): Result<any> {
    const copies = rows.map((r) => ({ ...r }));
    if (this.cardinality === "single") {
      if (copies.length !== 1) {
        return { data: null, error: pgError(`JSON object requested, multiple (or no) rows returned`, "PGRST116") };
      }
      return { data: copies[0], error: null };
    }
    if (this.cardinality === "maybe") {
      return { data: copies[0] ?? null, error: null };
    }
    return { data: this.returning || this.mode === "select" ? copies : null, error: null };
  }
}

// --- storage -------------------------------------------------------------------

class MockBucketApi {
  constructor(
    private buckets: Map<string, Map<string, Uint8Array | Blob>>,
    private name: string,
  ) {}

  private files(): Map<string, Uint8Array | Blob> {
    if (!this.buckets.has(this.name)) this.buckets.set(this.name, new Map());
    return this.buckets.get(this.name)!;
  }

  async upload(path: string, body: Uint8Array | Blob, options?: { upsert?: boolean }): Promise<Result<{ path: string }>> {
    if (this.files().has(path) && !options?.upsert) {
      return { data: null, error: pgError("The resource already exists", "23505") };
    }
    this.files().set(path, body);
    return { data: { path }, error: null };
  }

  async createSignedUrl(path: string, expiresIn: number, options?: { download?: string }): Promise<Result<{ signedUrl: string }>> {
    if (!this.files().has(path)) return { data: null, error: pgError("Object not found", "404") };
    const download = options?.download ? `&download=${encodeURIComponent(options.download)}` : "";
    return { data: { signedUrl: `https://storage.test/${this.name}/${path}?token=mock&expires_in=${expiresIn}${download}` }, error: null };
  }

  async remove(paths: string[]): Promise<Result<{ name: string }[]>> {
    for (const p of paths) this.files().delete(p);
    return { data: paths.map((name) => ({ name })), error: null };
  }

  async download(path: string): Promise<Result<Uint8Array | Blob>> {
    const file = this.files().get(path);
    if (!file) return { data: null, error: pgError("Object not found", "404") };
    return { data: file, error: null };
  }
}

// --- the client -----------------------------------------------------------------

export type MockDb = {
  /** Pass this to `setDb(mock.client as unknown as Db)`. */
  client: any;
  /** The raw table arrays. Mutate them freely to set up a case. */
  tables: Rows;
  rows(table: string): Row[];
  seed(table: string, rows: Row[]): void;
  reset(): void;
  /** Override or add an RPC. `rate_limit_hit` is provided. */
  setRpc(name: string, fn: (args: any) => any): void;
  /** Every RPC call made, in order. */
  rpcCalls: { name: string; args: any }[];
  storage: Map<string, Map<string, Uint8Array | Blob>>;
};

export function makeMockDb(seed: Rows = {}): MockDb {
  const tables: Rows = {};
  for (const [table, rows] of Object.entries(seed)) tables[table] = rows.map((r) => ({ ...defaultsFor(table, new Date().toISOString()), ...r }));

  const buckets = new Map<string, Map<string, Uint8Array | Blob>>();
  const knownBuckets = new Set<string>();
  const rpcCalls: { name: string; args: any }[] = [];
  const rpcs = new Map<string, (args: any) => any>();

  // The real `rate_limit_hit` is one atomic upsert; this is the same arithmetic.
  rpcs.set("rate_limit_hit", (args: { p_bucket: string; p_window_seconds: number }) => {
    tables.rate_limit ??= [];
    const now = new Date();
    const existing = tables.rate_limit.find((r) => r.bucket === args.p_bucket);
    if (!existing) {
      const row = { bucket: args.p_bucket, count: 1, window_start: now.toISOString() };
      tables.rate_limit.push(row);
      return [{ count: 1, window_start: row.window_start }];
    }
    const expired = new Date(existing.window_start).getTime() < now.getTime() - args.p_window_seconds * 1000;
    existing.count = expired ? 1 : existing.count + 1;
    if (expired) existing.window_start = now.toISOString();
    return [{ count: existing.count, window_start: existing.window_start }];
  });

  const client = {
    from(table: string) {
      return new Query(tables, table);
    },
    async rpc(name: string, args: any) {
      rpcCalls.push({ name, args });
      const fn = rpcs.get(name);
      if (!fn) return { data: null, error: pgError(`function ${name} does not exist`, "42883") };
      return { data: fn(args), error: null };
    },
    storage: {
      from(bucket: string) {
        return new MockBucketApi(buckets, bucket);
      },
      async getBucket(name: string) {
        return knownBuckets.has(name) ? { data: { name, public: false }, error: null } : { data: null, error: pgError("Bucket not found", "404") };
      },
      async createBucket(name: string) {
        knownBuckets.add(name);
        return { data: { name }, error: null };
      },
      async listBuckets() {
        return { data: [...knownBuckets].map((name) => ({ name })), error: null };
      },
    },
  };

  return {
    client,
    tables,
    rows: (table) => (tables[table] ??= []),
    seed: (table, rows) => {
      tables[table] = rows.map((r) => ({ ...defaultsFor(table, new Date().toISOString()), ...r }));
    },
    reset: () => {
      for (const key of Object.keys(tables)) delete tables[key];
      buckets.clear();
      knownBuckets.clear();
      rpcCalls.length = 0;
    },
    setRpc: (name, fn) => rpcs.set(name, fn),
    rpcCalls,
    storage: buckets,
  };
}

// --- helpers ---------------------------------------------------------------------

function pgError(message: string, code: string): PostgrestError {
  return { message, code, details: null, hint: null };
}

function findClash(rows: Row[], table: string, candidate: Row): Row | undefined {
  for (const columns of UNIQUE[table] ?? []) {
    if (columns.some((c) => candidate[c] === undefined || candidate[c] === null)) continue;
    const clash = rows.find((r) => columns.every((c) => looseEq(r[c], candidate[c])));
    if (clash) return clash;
  }
  // Partial unique indexes: only rows the predicate accepts collide, and the candidate
  // must itself satisfy the predicate to be constrained (mirrors a `where` on the index).
  for (const { columns, where } of PARTIAL_UNIQUE[table] ?? []) {
    if (!where(candidate)) continue;
    if (columns.some((c) => candidate[c] === undefined || candidate[c] === null)) continue;
    const clash = rows.find((r) => where(r) && columns.every((c) => looseEq(r[c], candidate[c])));
    if (clash) return clash;
  }
  return undefined;
}

/** PostgREST compares an int8 column to a string without complaint; so do we. */
function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a === "bigint" || typeof b === "bigint") return String(a) === String(b);
  if (typeof a === "number" || typeof b === "number") return String(a) === String(b);
  return false;
}

function cmp(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function likeToRegExp(pattern: string, flags: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${escaped}$`, flags);
}
