/**
 * lib/auth/rate-limit.ts — the PRD §9 limits, in the database.
 *
 * A fixed window, not a sliding one: §9 asks for "5/hour/IP", a Vercel function is not
 * one long-lived process, and Redis is explicitly out of scope for V0 (§11). The
 * increment is a single SQL statement (`rate_limit_hit`), so two concurrent requests
 * cannot read the same pre-increment value.
 *
 *   await enforceLimit("registration", clientIp(req));   // throws 429 with retry-after
 *   await enforceAddressLimit("challenge", clientIp(req), address);   // per IP and per (IP, address)
 *
 * An address the caller merely *names* (a challenge request, the `from` of a payment
 * that has not settled) is never a bucket key on its own: CORE-3, CORE-4 and PAY-12 in
 * RED-TEAM-2026-09-21.md. Keyed on the address alone, anyone anywhere could spend a
 * named buyer's or creator's bucket, and a fresh address per request meant no limit at
 * all. Those routes call `enforceAddressLimit`, which adds a per-IP cap that rotating
 * the address cannot escape and counts §9's per-address number per (IP, address), so
 * another IP cannot spend it. `enforceLimit` on an address is only right where the
 * address is *proved*: an `X-Wallet-Signature` buyer on `/api/v` or `/api/entitlements`.
 *
 * Fail-open: if the counter itself errors, the request proceeds. A rate limiter that
 * takes the site down when its own table is unavailable is worse than the abuse.
 */

import { db } from "@/lib/db";
import type { ChallengePurpose } from "@/lib/db/types";
import { ApiError, describeThrown } from "@/lib/errors";

export type LimitName =
  | "registration"
  | "challenge"
  | "rotate_key"
  | "step_up"
  | "resource"
  | "version"
  | "label"
  | "push"
  | "creator_write";

/** The limits spent by an address the caller named but has not proved. See `enforceAddressLimit`. */
export type AddressLimitName = "challenge" | "rotate_key" | "step_up" | "resource";

export type Limit = { max: number; windowSec: number; per: string };

/** PRD §9, "Rate limits". */
export const LIMITS: Record<LimitName, Limit> = {
  registration: { max: 5, windowSec: 3600, per: "ip" },
  challenge: { max: 30, windowSec: 60, per: "address" },
  /**
   * PAY-12: minting a `rotate_key` challenge and `POST /api/auth/rotate-key` spend their
   * own bucket. Otherwise challenge minting (`wallet_ownership` is minted once per signed
   * re-fetch) could lock a creator out of rotating a leaked key. The number is §9's
   * challenge limit, the bucket it used to share.
   */
  rotate_key: { max: 30, windowSec: 60, per: "address" },
  /** PAY-12, like `rotate_key`: the `step_up` challenge behind a payout rebind (FR-5). */
  step_up: { max: 30, windowSec: 60, per: "address" },
  resource: { max: 60, windowSec: 60, per: "address" },
  version: { max: 600, windowSec: 60, per: "ip" },
  label: { max: 600, windowSec: 60, per: "ip" },
  push: { max: 20, windowSec: 3600, per: "repo" },
  /** Not in §9; a sane default for authenticated mutations so one key cannot flood. */
  creator_write: { max: 120, windowSec: 60, per: "creator" },
};

/**
 * The per-IP cap over each address limit (CORE-3, CORE-4). It is four times the
 * per-address number. That leaves room for a few wallets behind one NAT or agent host,
 * and stops one IP that invents a new address per request. If the cap were equal to the
 * per-address number, the per-(IP, address) bucket could never be the one that fires.
 */
export const IP_CAPS: Record<AddressLimitName, Limit> = {
  challenge: { max: 120, windowSec: 60, per: "ip" },
  rotate_key: { max: 120, windowSec: 60, per: "ip" },
  step_up: { max: 120, windowSec: 60, per: "ip" },
  resource: { max: 240, windowSec: 60, per: "ip" },
};

/** The address limit that minting a challenge for `purpose` spends (PAY-12). */
export function challengeLimit(purpose: ChallengePurpose): AddressLimitName {
  if (purpose === "rotate_key") return "rotate_key";
  if (purpose === "step_up") return "step_up";
  return "challenge";
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * An EVM address in the only form a bucket key may take: lowercase. Anything that is not
 * `0x` followed by 40 hex characters is null, so a string the caller made up never
 * becomes a key, or a `rate_limit` row, as it was sent.
 */
export function addressKey(address: unknown): string | null {
  return typeof address === "string" && EVM_ADDRESS.test(address) ? address.toLowerCase() : null;
}

export type LimitResult = { allowed: boolean; count: number; limit: number; retryAfterSeconds: number };

/**
 * Count one hit against `<name>:<key>` and report whether it is over the limit.
 * Never throws for a database problem — see the fail-open note above.
 */
export async function hitLimit(name: LimitName, key: string, now = new Date()): Promise<LimitResult> {
  return await hitBucket(`${name}:${key}`, LIMITS[name], now);
}

async function hitBucket(bucket: string, limit: Limit, now: Date): Promise<LimitResult> {
  let count = 0;
  let windowStart = now;
  try {
    const { data, error } = await db().rpc("rate_limit_hit", { p_bucket: bucket, p_window_seconds: limit.windowSec });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return { allowed: true, count: 0, limit: limit.max, retryAfterSeconds: 0 };
    count = Number(row.count);
    windowStart = new Date(row.window_start);
  } catch (e) {
    console.warn("[rate-limit] counter unavailable, allowing:", describeThrown(e));
    return { allowed: true, count: 0, limit: limit.max, retryAfterSeconds: 0 };
  }

  const elapsed = Math.floor((now.getTime() - windowStart.getTime()) / 1000);
  const retryAfterSeconds = Math.max(1, limit.windowSec - Math.max(0, elapsed));
  return { allowed: count <= limit.max, count, limit: limit.max, retryAfterSeconds };
}

/** As `hitLimit`, but throws `rate_limited` with `retry_after_seconds` when over. */
export async function enforceLimit(name: LimitName, key: string, now = new Date()): Promise<LimitResult> {
  const result = await hitLimit(name, key, now);
  if (!result.allowed) throw rateLimited(result, LIMITS[name].windowSec, LIMITS[name].per);
  return result;
}

/**
 * CORE-3 / CORE-4 / PAY-12: the limit for an address the caller named but has not
 * proved. Two buckets are counted, the per-IP one first:
 *
 * - `<name>:ip:<ip>` against `IP_CAPS[name]`. A new address per request does not escape
 *   it. Once it is spent the per-address bucket is not touched, so rotating addresses
 *   cannot create unbounded `rate_limit` rows either.
 * - `<name>:ip:<ip>:address:<address>` against `LIMITS[name]`. This is §9's per-address
 *   number, and a request from another IP cannot spend it.
 *
 * A null `address` (an anonymous caller) counts as one more address from that IP. A
 * malformed address is `invalid_request` and never becomes a key.
 */
export async function enforceAddressLimit(name: AddressLimitName, ip: string, address: string | null, now = new Date()): Promise<LimitResult> {
  const key = address === null ? "anonymous" : addressKey(address);
  if (key === null) throw new ApiError("invalid_request", { message: "Not a valid EVM address." });

  const cap = IP_CAPS[name];
  const perIp = await hitBucket(`${name}:ip:${ip}`, cap, now);
  if (!perIp.allowed) throw rateLimited(perIp, cap.windowSec, "IP");

  const limit = LIMITS[name];
  const perAddress = await hitBucket(`${name}:ip:${ip}:address:${key}`, limit, now);
  if (!perAddress.allowed) throw rateLimited(perAddress, limit.windowSec, `${limit.per} from one IP`);
  return perAddress;
}

function rateLimited(result: LimitResult, windowSec: number, per: string): ApiError {
  return new ApiError("rate_limited", {
    message: `Too many requests. This route allows ${result.limit} per ${describeWindow(windowSec)} per ${per}.`,
    retryAfterSeconds: result.retryAfterSeconds,
  });
}

/**
 * The caller's IP. `x-real-ip` first: Vercel sets it to the single connecting address
 * and overwrites any client-supplied value. `x-forwarded-for` is only a fallback — its
 * leftmost token is attacker-controlled wherever a proxy *appends* rather than
 * replaces, and a spoofable key turns a per-IP limit into no limit. Falls back to a
 * constant so a local `next dev` still exercises the limiter.
 */
export function clientIp(req: Request): string {
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}

function describeWindow(sec: number): string {
  if (sec === 3600) return "hour";
  if (sec === 60) return "minute";
  return `${sec}s`;
}
