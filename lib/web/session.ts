/**
 * lib/web/session.ts — the creator's web session (FR-1, D14).
 *
 * The web app is a client of the API (D9), so the dashboard needs a bearer credential to
 * call `/api/listings/…` with. Since D14 ("PRD Session Keys.md") that credential is the
 * session's *own* key — an `x4s_live_…` row minted silently when the creator signs in
 * (FR-55) — not the creator's agent key. Only the sha256 of it is stored, so the
 * plaintext has nowhere to live server-side; it lives in this cookie, and the cookie
 * therefore has to be worth trusting with it.
 *
 * The cookie is `x4s.<payload>.<mac>`:
 *
 *   payload = base64url( iv | AES-256-GCM ciphertext | tag )   ← encrypted at rest
 *   mac     = base64url( HMAC-SHA256(payload) )                ← signed
 *
 * Two independent keys, both derived from `SESSION_SECRET` with distinct labels, so a
 * signing oracle is never an encryption oracle. GCM already authenticates, and the
 * outer HMAC is checked *first* in constant time so a forged cookie is rejected before
 * any decryption is attempted.
 *
 * FR-60, because the collision is confusing on sight: the cookie's name stem is `x4s`
 * and session keys are prefixed `x4s_live_`, and they are **different things**. The
 * scanner's pattern (`x4[cs]_live_[0-9A-Za-z]{32}`, `lib/scan/secrets.ts`) requires the
 * `_live_` segment, so it can never match a cookie.
 *
 * What is in it: the GitHub identity (id + login), the creator id once one exists, the
 * session key, and the GitHub user OAuth token (needed to list App installations on
 * `/dashboard/new`). Nothing here is authorisation on its own — every API call the
 * dashboard makes is re-authenticated by `requireCreator`, and the web guards
 * additionally check the key resolves to a live `session` row (FR-56), which is what
 * makes signing out revoke a captured cookie.
 *
 * §14.7 still holds: this credential cannot move money (FR-26) and cannot destroy data
 * without a wallet signature (FR-5).
 */

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sessionSecret } from "@/lib/env";
import { safeReturnPath } from "@/lib/web/safe-redirect";

export const SESSION_COOKIE = "x4s";
export const OAUTH_STATE_COOKIE = "x4_oauth";

/** Two weeks. Long enough to be useful, short enough that a session key expires. */
export const SESSION_TTL_SEC = 14 * 24 * 60 * 60;

/** The GitHub identity OAuth proved. Present in every session. */
export type SessionGithub = {
  id: number;
  login: string;
  /** The user-to-server OAuth token. Used only for `GET /user/installations`. */
  token?: string;
};

export type SessionData = {
  github: SessionGithub;
  /** Absent until the creator binds a payout address — `creator.payout_address` is NOT NULL. */
  creatorId?: string;
  handle?: string;
  /**
   * This session's own key in plaintext — `x4s_live_…`, minted at sign-in and never
   * shown to anyone (FR-55). Never the agent key: the dashboard stopped borrowing that
   * credential in D14, and a cookie carrying one is refused by the web guards (FR-56).
   *
   * Optional only because a pre-creator session has no creator to mint against. The
   * invariant the rest of the code leans on: **a session with a `creatorId` always
   * carries an `apiKey`**, so no dashboard surface has to gate on a missing key (FR-59).
   */
  apiKey?: string;
  /**
   * Pre-creator sessions only: the path sign-in was headed for before the callback sent
   * the reader to bind a wallet first. The bind route hands it to the key page as the
   * way on, so a creator who installed the App before they had an account still lands
   * on the repo picker. Already passed through `safeReturnPath`; dropped once bound.
   */
  next?: string;
  /** Seconds since the Unix epoch. */
  iat: number;
  exp: number;
};

const VERSION = "x4s";
const IV_BYTES = 12;
const TAG_BYTES = 16;

type Purpose = "session" | "keybox" | "stored";

/**
 * Two keys per purpose, derived from `SESSION_SECRET`. The purpose is part of the label,
 * so the session cookie and the one-time key box below are encrypted and signed under
 * different keys: one cannot be re-labelled as the other even by someone who can mint
 * one of them.
 */
function keys(purpose: Purpose): { enc: Buffer; mac: Buffer } {
  const secret = sessionSecret();
  return {
    enc: createHash("sha256").update(`x402git:${purpose}:enc:${secret}`, "utf8").digest(),
    mac: createHash("sha256").update(`x402git:${purpose}:mac:${secret}`, "utf8").digest(),
  };
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** Serialise, encrypt, sign. `version.payload.mac`, the whole cookie value. */
function seal(purpose: Purpose, version: string, data: unknown): string {
  const { enc, mac } = keys(purpose);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", enc, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
  const payload = b64url(Buffer.concat([iv, body, cipher.getAuthTag()]));
  const signature = b64url(createHmac("sha256", mac).update(payload).digest());
  return `${version}.${payload}.${signature}`;
}

/**
 * Verify, then decrypt. Returns null for every failure — a tampered cookie, a cookie
 * signed under a rotated secret, a cookie of the wrong purpose — because all of them
 * mean the same thing to the caller and none of them should surface as a 500.
 */
function open(purpose: Purpose, version: string, cookie: string | undefined | null): unknown {
  if (!cookie) return null;
  const parts = cookie.split(".");
  if (parts.length !== 3 || parts[0] !== version) return null;
  const [, payload, signature] = parts;

  let enc: Buffer;
  let mac: Buffer;
  try {
    ({ enc, mac } = keys(purpose));
  } catch {
    return null; // no SESSION_SECRET configured: nobody is signed in
  }

  const expected = createHmac("sha256", mac).update(payload).digest();
  let given: Buffer;
  try {
    given = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  try {
    const raw = Buffer.from(payload, "base64url");
    if (raw.length <= IV_BYTES + TAG_BYTES) return null;
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(raw.length - TAG_BYTES);
    const body = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", enc, iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8"));
  } catch {
    return null;
  }
}

export function sealSession(data: SessionData): string {
  return seal("session", VERSION, data);
}

/**
 * Verify, decrypt, and check the expiry. Null for every failure, including an expired
 * cookie — that is just "not signed in". Server-side expiry of the *key* the cookie
 * carries is enforced separately, by `resolveBearer` (FR-56), regardless of what the
 * cookie claims here.
 */
export function openSession(cookie: string | undefined | null, now = new Date()): SessionData | null {
  const data = open("session", VERSION, cookie) as SessionData | null;
  if (!data) return null;
  if (typeof data?.exp !== "number" || data.exp * 1000 <= now.getTime()) return null;
  if (typeof data?.github?.id !== "number" || typeof data?.github?.login !== "string") return null;
  return data;
}

/** Stamp `iat`/`exp` around the caller's fields. */
export function newSession(data: Omit<SessionData, "iat" | "exp">, now = new Date()): SessionData {
  const iat = Math.floor(now.getTime() / 1000);
  return { ...data, iat, exp: iat + SESSION_TTL_SEC };
}

/**
 * FR-55: the instant a session stamped at `now` expires, as an ISO string — the
 * `expires_at` its session-key row must carry, so the row and the cookie die together.
 * Pass the *same* `now` to `newSession` and the two agree to the second.
 */
export function sessionExpiresAt(now = new Date()): string {
  return new Date((Math.floor(now.getTime() / 1000) + SESSION_TTL_SEC) * 1000).toISOString();
}

// --- the one-time key box (FR-59) --------------------------------------------

/**
 * A freshly minted **agent** key is shown exactly once, on `/dashboard/key`, and the
 * route that mints it is a POST that redirects. Carrying the plaintext across that
 * redirect in the query string would put it in browser history, in the Referer of every
 * asset on the page and in any access log in front of us — so it travels in its own
 * sealed, httpOnly cookie instead: same AES-256-GCM-then-HMAC as the session, different
 * derivation label, five minutes to live.
 *
 * It is a separate cookie rather than a field on the session because the two have
 * nothing to do with each other: the session key is what the dashboard calls the API
 * with, and this is a value the page prints once and forgets. A server component cannot
 * clear a cookie, so nothing deletes this one — `maxAge` does, and it is short for
 * exactly that reason. `exp` inside is checked too, so a replayed box is refused even
 * if a client keeps sending it.
 */
export const KEY_BOX_COOKIE = "x4_key";
export const KEY_BOX_TTL_SEC = 300;

const BOX_VERSION = "x4k";

export function sealBox(value: string, now = new Date()): string {
  return seal("keybox", BOX_VERSION, { v: value, exp: Math.floor(now.getTime() / 1000) + KEY_BOX_TTL_SEC });
}

export function openBox(cookie: string | undefined | null, now = new Date()): string | null {
  const data = open("keybox", BOX_VERSION, cookie) as { v?: unknown; exp?: unknown } | null;
  if (!data || typeof data.v !== "string" || typeof data.exp !== "number") return null;
  if (data.exp * 1000 <= now.getTime()) return null;
  return data.v;
}

/**
 * A secret that has to sit in a database row for a while — today only the API key inside
 * the `Idempotency-Key` replay of `POST /api/creators` (lib/idempotency.ts). Same
 * AES-256-GCM-then-HMAC, its own derivation label, and no `exp` inside: the row's own
 * `created_at` is the clock, and the row is deleted when it runs out. What this buys is
 * the property `api_key` rows already have — a copy of the database alone yields no
 * usable credential.
 */
const STORED_VERSION = "x4d";

export function sealStored(value: string): string {
  return seal("stored", STORED_VERSION, { v: value });
}

export function openStored(sealed: string | undefined | null): string | null {
  const data = open("stored", STORED_VERSION, sealed) as { v?: unknown } | null;
  return data && typeof data.v === "string" ? data.v : null;
}

export type CookieOptions = {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number;
};

/**
 * `secure` follows the app URL rather than NODE_ENV, so a production build served over
 * plain http in a container still sets a cookie the browser will send back.
 */
export function cookieOptions(maxAge: number, appUrlValue: string): CookieOptions {
  return { httpOnly: true, sameSite: "lax", secure: appUrlValue.startsWith("https://"), path: "/", maxAge };
}

/** The OAuth `state`, plus the path to return to. One cookie, one round trip. */
export function encodeOAuthState(state: string, next: string): string {
  return `${state}~${Buffer.from(next, "utf8").toString("base64url")}`;
}

export function decodeOAuthState(cookie: string | undefined | null): { state: string; next: string } | null {
  if (!cookie) return null;
  const at = cookie.indexOf("~");
  if (at <= 0) return null;
  try {
    const next = Buffer.from(cookie.slice(at + 1), "base64url").toString("utf8");
    return { state: cookie.slice(0, at), next: safeReturnPath(next, "/dashboard") };
  } catch {
    return null;
  }
}

/** Constant-time compare of two OAuth state values. */
export function stateMatches(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export function newState(): string {
  return randomBytes(24).toString("base64url");
}
