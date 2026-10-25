/**
 * lib/db/types.ts — Row types mirroring supabase/migrations/*.sql exactly.
 *
 * PostgREST hands `bigint` (int8) back as a JSON number *or* a string depending on
 * magnitude and server config, and accepts a string on write. Money is micro-USDC and
 * must never round-trip through a float, so:
 *
 *   read : toMicro(row.price_micro)      -> bigint
 *   write: { price_micro: fromMicro(v) } -> string
 *
 * Never do arithmetic on the raw column value.
 */

export type Uuid = string;
/** ISO-8601 timestamptz as PostgREST returns it. */
export type Timestamptz = string;
/** int8 as it arrives over the wire. */
export type BigIntWire = string | number;

export type WalletMode = "linked" | "custodial";
export type OnboardedVia = "web" | "api";
export type ListingSource = "github" | "hosted";
export type LicenceVerdict = "pass" | "manual" | "block";
/**
 * FR-2/FR-4/FR-5/FR-20: what a signed challenge authorises. A signature is bound to one
 * purpose so a login proof cannot be replayed as a payout-address change. See
 * lib/auth/challenge.ts.
 */
export type ChallengePurpose = "address_proof" | "step_up" | "rotate_key" | "wallet_ownership";
export type ScanStatus = "pending" | "pass" | "fail";
export type PurchaseKind = "new" | "update" | "free";
export type PurchaseSource = "web" | "api" | "mcp";
/**
 * `in_transit` (migration 20261025090000): the transfer has left our account and has not
 * yet arrived. Only a bridged payout uses it; it counts as in flight for the FR-28 guard.
 */
export type PayoutStatus = "pending" | "broadcast" | "in_transit" | "confirmed" | "failed";

/**
 * CAIP-2 network id, the ledger's partition key since migration 20261025090100
 * (`eip155:8453`, `eip155:84532`, `stellar:testnet`, `stellar:pubnet`). Every read that
 * sums, counts or looks up purchases or payouts for *this* deployment filters on it.
 */
export type NetworkId = `eip155:${number}` | "stellar:testnet" | "stellar:pubnet" | (string & {});

/** PRD §8.1 FR-4. */
export type ApiScope = "listings:write" | "earnings:read";

/**
 * D14 / FR-54 ("PRD Session Keys.md"): the two kinds of bearer credential. `agent` is
 * the long-lived `x4c_live_…` key a programme holds; `session` is the short-lived
 * `x4s_live_…` key minted silently when a human signs in, one per browser session.
 */
export type ApiKeyKind = "agent" | "session";

/**
 * FR-54 (migration 20260831000000). Only the sha256 hash is stored, so a database leak
 * yields no usable key. Rows are never deleted — a revoked or expired row is the audit
 * record FR-61 reads `kind` and `last_used_at` off.
 */
export type ApiKeyRow = {
  id: Uuid;
  creator_id: Uuid;
  kind: ApiKeyKind;
  hash: string;
  scopes: string[];
  created_at: Timestamptz;
  /** Null for `agent` keys; a `session` key always has one (table CHECK). */
  expires_at: Timestamptz | null;
  revoked_at: Timestamptz | null;
  /** e.g. `found_in_repository`, `rotated`, `signed_out`. */
  revoked_reason: string | null;
  last_used_at: Timestamptz | null;
};

export type CreatorRow = {
  id: Uuid;
  handle: string;
  github_user_id: BigIntWire | null;
  onboarded_via: OnboardedVia;
  wallet_mode: WalletMode;
  payout_address: string;
  cdp_wallet_id: string | null;
  pending_payout_address: string | null;
  rebind_effective_at: Timestamptz | null;
  abuse_contact_url: string | null;
  abuse_contact_email: string | null;
  /** FR-5: the abuse contact also changes on a 48h delay (migration 0300). */
  pending_abuse_contact_url: string | null;
  pending_abuse_contact_email: string | null;
  abuse_contact_effective_at: Timestamptz | null;
  terms_version: string;
  terms_accepted_at: Timestamptz;
  created_at: Timestamptz;
  /**
   * The Stellar rail (migration 20261025090100). `payout_address` may itself be a `G…`
   * for a Stellar-only creator (BUILD H5); these hold a *second* address when a creator
   * has both. Same 48-hour rebind rule as the EVM one. Optional in the type only because
   * pre-migration fixtures construct rows without them.
   */
  stellar_payout_address?: string | null;
  pending_stellar_payout_address?: string | null;
  stellar_rebind_effective_at?: Timestamptz | null;
  /** `{ network, trustline: { code, issuer, authorized }, checked_at }` from bind time. */
  stellar_payout_meta?: unknown | null;
  stellar_payout_verified_at?: Timestamptz | null;
};

export type ListingRow = {
  id: Uuid;
  creator_id: Uuid;
  slug: string;
  source: ListingSource;
  installation_id: BigIntWire | null;
  github_repo_id: BigIntWire | null;
  deploy_key_id: BigIntWire | null;
  /** D10: the hosted org a Rail B repo lives in (migration 0400). Null on Rail A. */
  hosted_org: string | null;
  price_micro: BigIntWire;
  update_price_micro: BigIntWire;
  description: string | null;
  trigger_hint: string | null;
  licence_spdx: string | null;
  licence_verdict: LicenceVerdict | null;
  published_at: Timestamptz | null;
  retired_at: Timestamptz | null;
  created_at: Timestamptz;
  /**
   * Open releases (migrations 20261025160000 and 20261025200000). The listing-level offer:
   * each release goes public in `public_repo_url` `open_after_days` days after it is cut;
   * the cut stamps the resulting `opens_at` on the release. `open_eligibility` is the last
   * listing-time check. Optional in the type only because pre-migration fixtures construct
   * rows without them.
   */
  open_release?: boolean;
  public_repo_url?: string | null;
  open_after_days?: number | null;
  open_eligibility?: unknown | null;
  /**
   * Migration 20261025213000 (25 Oct 2026). Which rails this listing is sold on, as CAIP-2
   * networks; null is every rail its creator can be paid on (`lib/core/access.ts#railsFor`).
   * Optional for the same reason as the four above.
   */
  offered_networks?: string[] | null;
};

/** Migration 20261025160000. What the promise-kept check concluded for one release. */
export type PromiseStatus = "pending" | "opened_on_time" | "overdue" | "not_open" | "ineligible";

export type ReleaseRow = {
  id: Uuid;
  listing_id: Uuid;
  version: string;
  git_ref: string;
  commit_sha: string;
  artifact_sha256: string | null;
  storage_path: string | null;
  size_bytes: BigIntWire | null;
  scan: ScanStatus;
  scan_report: unknown | null;
  scanner_version: string | null;
  manifest: unknown | null;
  changelog: string | null;
  diff_summary: unknown | null;
  price_micro_at_publish: BigIntWire;
  update_price_micro_at_publish: BigIntWire;
  analyzer_version: string | null;
  /** FR-50 (migration 0400): significant git blob SHAs, for blob-overlap originality. */
  blob_shas: string[] | null;
  /**
   * FR-36: the licence gate verdict for *this release's* snapshot, stamped at cut. A
   * release with `'block'` (no LICENSE / incompatible) is not sellable even if secrets
   * pass; NULL (pre-migration) and `'pass'`/`'manual'` sell. See lib/core/access.ts.
   */
  licence_verdict?: LicenceVerdict | null;
  created_at: Timestamptz;
  /**
   * Open releases (migration 20261025160000): the promise stamped at cut. `opens_at` is at
   * most 90 days after `created_at` and can only move earlier (both enforced in the
   * database). `promise_evidence` is `{ ref, html_url, licence, checked_url }`.
   */
  opens_at?: Timestamptz | null;
  open_licence_spdx?: string | null;
  promise_status?: PromiseStatus | null;
  promise_checked_at?: Timestamptz | null;
  opened_at?: Timestamptz | null;
  promise_evidence?: unknown | null;
  open_eligibility?: unknown | null;
};

export type PurchaseRow = {
  id: Uuid;
  listing_id: Uuid;
  release_id: Uuid;
  buyer_address: string;
  all_versions: boolean;
  update_price_at_purchase: BigIntWire;
  kind: PurchaseKind;
  source: PurchaseSource;
  gross_micro: BigIntWire;
  fee_micro: BigIntWire;
  net_micro: BigIntWire;
  tx_hash: string | null;
  payment_nonce: string | null;
  granted_at: Timestamptz;
  holdback_until: Timestamptz;
  payout_id: Uuid | null;
  revoked_at: Timestamptz | null;
  /**
   * Which rail this settled on (migration 20261025090100). One Supabase project serves
   * Base Sepolia, Base mainnet and now Stellar, so *every* query that sums, counts or
   * looks up purchases must filter on it — an unfiltered sum reads testnet traffic as
   * revenue, and the sweep would pay real money for it. NOT NULL; a BEFORE INSERT
   * trigger fills it from `chain_id` for code that predates the column.
   */
  network: NetworkId;
  /**
   * Which token was paid: the ERC-20 or SAC contract address (USDT0 T5). USDC and USDT0
   * are both $1 here and never converted; a payout is always in the asset received.
   * Nullable only for EVM rows the trigger could not attribute.
   */
  asset?: string | null;
  /**
   * The EVM spelling of `network` (migration 20260906010000), kept for the admin and
   * reconcile reads that still filter on it. **Null on Stellar.** Optional in the type
   * only because pre-migration code paths construct rows without it.
   */
  chain_id?: BigIntWire | null;
};

export type PayoutRow = {
  id: Uuid;
  creator_id: Uuid;
  amount_micro: BigIntWire;
  gas_micro: BigIntWire;
  to_address: string;
  idempotency_key: string;
  tx_hash: string | null;
  status: PayoutStatus;
  created_at: Timestamptz;
  /** As on `purchase` — see the notes there. Migration 20261025090100. */
  network: NetworkId;
  asset?: string | null;
  /** Null on Stellar. Migration 20260906010000. */
  chain_id?: BigIntWire | null;
};

export type EventRow = {
  id: BigIntWire;
  name: string;
  listing_id: Uuid | null;
  buyer_address: string | null;
  source: PurchaseSource | null;
  props: unknown | null;
  /** Migration 20260914010000. Null on operator events written by scripts. */
  chain_id: BigIntWire | null;
  /** Migration 20261025090100. The rail; null where `chain_id` is null. */
  network?: NetworkId | null;
  at: Timestamptz;
};

/** FR-38, 5-year retention. */
export type ScreeningRow = {
  id: BigIntWire;
  address: string;
  context: "bind" | "sweep" | "settle" | (string & {});
  hit: boolean;
  provider: string;
  raw: unknown | null;
  at: Timestamptz;
};

// --- ops tables (20260829000100_ops.sql) ------------------------------------

/** FR-20 / FR-2 / FR-4: single-use 5-minute challenges. */
export type ChallengeRow = {
  nonce: string;
  address: string;
  message: string;
  /** What the signature authorises; a mismatch is rejected. Optional until W2.2 wires every caller. */
  purpose?: ChallengePurpose;
  /** The operand the signature authorises — `rebind:<new address>` on a payout rebind. */
  context?: string | null;
  /** Migration 20261025090100: the key that signed (a `G…` for SEP-53). Equals `address` for EVM. */
  signer?: string | null;
  expires_at: Timestamptz;
  used_at: Timestamptz | null;
  created_at: Timestamptz;
};

/** FR-2: 24h Idempotency-Key replay on POST /api/creators. */
export type IdempotencyRow = {
  key: string;
  creator_id: Uuid | null;
  route: string;
  request_hash: string | null;
  status: number;
  response: unknown;
  created_at: Timestamptz;
};

/** FR-8: webhook delivery replay protection. */
export type WebhookDeliveryRow = {
  delivery_id: string;
  received_at: Timestamptz;
};

/** §9 rate limits, fixed window. */
export type RateLimitRow = {
  bucket: string;
  count: number;
  window_start: Timestamptz;
};

/**
 * Who may read `/admin` (migration 20260907000000). Granted and revoked from
 * `/admin/people`; unioned with the immutable `ADMIN_GITHUB_LOGINS` root list. Logins
 * are stored lowercase, and rows are never deleted — a revoked row is the audit record.
 */
export type AdminRow = {
  github_login: string;
  note: string | null;
  granted_by: string | null;
  granted_at: Timestamptz;
  revoked_at: Timestamptz | null;
  revoked_by: string | null;
};

/** Migration 20260914000000: an operator's test/real override for one user. */
export type UserLabelRow = {
  /** `creator:<uuid>` or `wallet:<lowercase address>`. */
  subject: string;
  is_test: boolean;
  set_by: string;
  set_at: Timestamptz;
};

export type Tables = {
  creator: CreatorRow;
  admin: AdminRow;
  user_label: UserLabelRow;
  api_key: ApiKeyRow;
  listing: ListingRow;
  release: ReleaseRow;
  purchase: PurchaseRow;
  payout: PayoutRow;
  event: EventRow;
  screening: ScreeningRow;
  challenge: ChallengeRow;
  idempotency: IdempotencyRow;
  webhook_delivery: WebhookDeliveryRow;
  rate_limit: RateLimitRow;
};

export type TableName = keyof Tables;

// --- micro-USDC conversion ---------------------------------------------------

/**
 * Read an int8 column as bigint. Rejects floats and non-integers loudly rather
 * than silently truncating money.
 */
export function toMicro(v: BigIntWire | bigint | null | undefined): bigint {
  const out = toMicroOrNull(v);
  if (out === null) throw new TypeError("toMicro: value is null/undefined; use toMicroOrNull");
  return out;
}

export function toMicroOrNull(v: BigIntWire | bigint | null | undefined): bigint | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new TypeError("toMicro: refusing a non-integer number (money is never a float)");
    if (!Number.isSafeInteger(v)) throw new TypeError("toMicro: number exceeds MAX_SAFE_INTEGER; PostgREST should have sent a string");
    return BigInt(v);
  }
  const s = v.trim();
  if (!/^-?\d+$/.test(s)) throw new TypeError("toMicro: not an integer string");
  return BigInt(s);
}

/** Write a bigint to an int8 column. Strings survive JSON without precision loss. */
export function fromMicro(v: bigint | number): string {
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new TypeError("fromMicro: refusing a non-integer number");
    return String(v);
  }
  return v.toString();
}
