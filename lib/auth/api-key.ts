/**
 * lib/auth/api-key.ts — the creator bearer credentials (D11, D14, FR-4, FR-54..FR-61, §14.7).
 *
 * A creator has two kinds of key, and they are the same primitive: a prefix, 32 base62
 * characters, and only the sha256 stored (FR-54, "PRD Session Keys.md").
 *
 *   agent    x4c_live_…   long-lived, one per creator, held by a programme
 *   session  x4s_live_…   short-lived, one per browser session, minted silently on sign-in
 *
 * The prefixes are deliberate: they are what GitHub's secret-scanning partner program
 * matches on and what our own scanner (FR-35) looks for, and a leak is distinguishable
 * in a log at a glance (FR-60). The session *cookie* is separately named `x4s`
 * (`x4s.<payload>.<mac>`) — a different thing sharing a stem; the scanner pattern
 * requires `_live_` and cannot match a cookie.
 *
 * Keys live in the `api_key` table, not on `creator`: a row is revocable on its own, so
 * signing out revokes session rows (FR-57) and rotating the agent key touches only the
 * agent row (FR-58). That per-row revocation is what retired the creator's epoch
 * counter — one revocable row per credential, instead of one integer for all of them.
 *
 * §14.7 is the design constraint: these keys *will* leak, so neither can move money
 * (FR-26 — payouts go only to the bound address, and no `to` parameter exists) and
 * neither can destroy data on its own (FR-5 — step-up needs a wallet signature).
 *
 *   const creator = await requireCreator(req, "listings:write");
 *   creator.apiKey.kind   // FR-61: was this a human on the dashboard, or an agent?
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import type { ApiKeyKind, ApiKeyRow, ApiScope, CreatorRow } from "@/lib/db/types";
import { ApiError } from "@/lib/errors";

export const AGENT_KEY_PREFIX = "x4c_live_";
export const SESSION_KEY_PREFIX = "x4s_live_";
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const KEY_BODY_LENGTH = 32;

/** FR-4. A new creator gets both; there is no narrower default worth having. */
export const DEFAULT_SCOPES: ApiScope[] = ["listings:write", "earnings:read"];

/** The reason the secret scanner (FR-35) revokes with; FR-57 keys off it. */
export const SCAN_REVOKE_REASON = "found_in_repository";

export type GeneratedApiKey = { key: string; hash: string };

/** FR-61: the row that authenticated the request travels with the creator. */
export type AuthedCreator = CreatorRow & { apiKey: Pick<ApiKeyRow, "id" | "kind" | "scopes"> };

export function keyPrefix(kind: ApiKeyKind): string {
  return kind === "session" ? SESSION_KEY_PREFIX : AGENT_KEY_PREFIX;
}

/**
 * Mint a key. Returns the plaintext (shown once for an agent key, never for a session
 * key, and never stored either way) and the hash to store. Rejection sampling, so every
 * character is uniform over the alphabet.
 */
export function generateApiKey(kind: ApiKeyKind = "agent"): GeneratedApiKey {
  let body = "";
  while (body.length < KEY_BODY_LENGTH) {
    for (const byte of randomBytes(KEY_BODY_LENGTH)) {
      if (byte >= 248) continue; // 248 = 4 * 62; anything above would bias the alphabet
      body += BASE62[byte % 62];
      if (body.length === KEY_BODY_LENGTH) break;
    }
  }
  const key = keyPrefix(kind) + body;
  return { key, hash: hashApiKey(key) };
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** FR-60: `x4[cs]_live_` + 32 base62. The same shape the scanner matches. */
export function looksLikeApiKey(value: string): boolean {
  return new RegExp(`^x4[cs]_live_[0-9A-Za-z]{${KEY_BODY_LENGTH}}$`).test(value);
}

/** Constant-time hex comparison, for the rare paths that compare two hashes directly. */
export function hashesEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

// --- minting ------------------------------------------------------------------

/**
 * FR-54: mint a key and store its hash. The plaintext is returned to exactly one
 * caller and never written anywhere — not to the row, not to a log.
 *
 * `expiresAt` is null for an agent key and required for a session key: the table's
 * CHECK enforces it, and FR-56 enforces expiry server-side regardless of what a cookie
 * claims, so a session row without one would be an immortal session.
 */
export async function insertApiKey(
  creatorId: string,
  kind: ApiKeyKind,
  scopes: readonly string[] = DEFAULT_SCOPES,
  expiresAt: string | null = null,
): Promise<{ key: string; row: ApiKeyRow }> {
  if (kind === "session" && !expiresAt) throw new TypeError("insertApiKey: a session key needs an expires_at (FR-56)");

  const { key, hash } = generateApiKey(kind);
  const { data, error } = await db()
    .from("api_key")
    .insert({ creator_id: creatorId, kind, hash, scopes: [...scopes], expires_at: expiresAt })
    .select("*")
    .single();
  if (error) throw error;
  return { key, row: data as ApiKeyRow };
}

/**
 * FR-58: rotate the creator's agent key and nothing else. Revoking first is what keeps
 * the `api_key_one_live_agent` partial unique index satisfiable — two live agent rows
 * are not a state this table can hold.
 *
 * Scopes carry over from the row being replaced: rotation is a recovery action, not a
 * permissions change.
 */
export async function rotateAgentKey(creatorId: string, scopes?: readonly string[]): Promise<{ key: string; row: ApiKeyRow }> {
  const { data, error } = await db()
    .from("api_key")
    .update({ revoked_at: new Date().toISOString(), revoked_reason: "rotated" })
    .eq("creator_id", creatorId)
    .eq("kind", "agent")
    .is("revoked_at", null)
    .select("*");
  if (error) throw error;

  const previous = ((data ?? []) as ApiKeyRow[])[0];
  const next = scopes ?? (previous?.scopes?.length ? previous.scopes : DEFAULT_SCOPES);
  return insertApiKey(creatorId, "agent", next, null);
}

// --- revocation ---------------------------------------------------------------

/**
 * FR-57: revoke every live session key of a creator, in one write. Sign-out calls this,
 * and it is deliberately "everywhere at once" — it is what makes a captured cookie die
 * the moment the creator signs out on any device (the property the retired epoch
 * counter used to carry). Agent keys are untouched.
 */
export async function revokeSessionKeys(creatorId: string, reason: string): Promise<void> {
  const { error } = await db()
    .from("api_key")
    .update({ revoked_at: new Date().toISOString(), revoked_reason: reason })
    .eq("creator_id", creatorId)
    .eq("kind", "session")
    .is("revoked_at", null);
  if (error) throw error;
}

/**
 * FR-4 / §14.7: revoke a key we found in a repository. The scan (FR-35) calls this with
 * the hash of a key it matched in the snapshot's text; nothing here ever holds the
 * plaintext.
 *
 * Since FR-54 this is a plain `revoked_at` write — the old `revoked:<reason>:<ms>:<hash>`
 * prefix trick existed only because `creator.api_key_hash` was NOT NULL UNIQUE, and that
 * column is gone. `revoked_at is null` in the filter keeps it idempotent: a second hit on
 * an already-revoked key rewrites nothing and reports nothing.
 *
 * FR-57: a scan hit on an *agent* key means the account is under review, so that
 * creator's web sessions do not outlive it either.
 *
 * Returns the ids of the creators whose key was revoked; empty means the key was not one
 * of ours (or was already revoked), which is the common case.
 */
export async function revokeApiKeyByHash(hash: string, reason = SCAN_REVOKE_REASON): Promise<string[]> {
  const { data, error } = await db()
    .from("api_key")
    .update({ revoked_at: new Date().toISOString(), revoked_reason: reason })
    .eq("hash", hash)
    .is("revoked_at", null)
    .select("id, creator_id, kind");
  if (error) throw error;

  const revoked = (data ?? []) as Pick<ApiKeyRow, "id" | "creator_id" | "kind">[];
  if (reason === SCAN_REVOKE_REASON) {
    for (const row of revoked) {
      if (row.kind === "agent") await revokeSessionKeys(row.creator_id, "agent_key_compromised");
    }
  }
  return revoked.map((row) => row.creator_id);
}

// --- resolution ---------------------------------------------------------------

/** The bearer token, or null. Accepts `Bearer <key>` and a bare key. */
export function apiKeyFrom(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const value = header.trim();
  const match = /^Bearer\s+(.+)$/i.exec(value);
  const key = match ? match[1].trim() : value;
  return key.length > 0 ? key : null;
}

/**
 * FR-56: resolve a plaintext key to its row and its creator, or null.
 *
 * Null covers every "no" — unknown hash, revoked row, expired row, or a row whose
 * creator has since been deleted — because the caller must not be able to tell them
 * apart (§14.7: the error is the same either way).
 *
 * Two indexed equality reads rather than a join: `hash` is UNIQUE and `creator.id` is
 * the primary key, and the mock DB the tests run against does not do joins.
 */
export async function resolveBearer(key: string): Promise<{ row: ApiKeyRow; creator: CreatorRow } | null> {
  if (!looksLikeApiKey(key)) return null;

  const { data, error } = await db().from("api_key").select("*").eq("hash", hashApiKey(key)).maybeSingle();
  if (error) throw error;
  const row = data as ApiKeyRow | null;
  if (!row || row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return null;

  const { data: creatorData, error: creatorError } = await db().from("creator").select("*").eq("id", row.creator_id).maybeSingle();
  if (creatorError) throw creatorError;
  const creator = creatorData as CreatorRow | null;
  if (!creator) return null;

  touchLastUsed(row.id);
  return { row, creator };
}

/**
 * FR-56: `last_used_at` is an audit convenience (FR-61), not a correctness input, so it
 * is fired and forgotten — never awaited, and its failures are swallowed. A key that
 * works must not stop working, or slow down, because a bookkeeping write did.
 */
function touchLastUsed(id: string): void {
  void Promise.resolve(db().from("api_key").update({ last_used_at: new Date().toISOString() }).eq("id", id)).then(
    () => undefined,
    () => undefined,
  );
}

/**
 * The authenticated creator. Throws `invalid_key` when the header is missing, malformed,
 * unknown, revoked or expired, and `insufficient_scope` when the key lacks `scope`
 * (FR-4). Scopes come from the `api_key` row (FR-54), not from the creator.
 *
 * Both kinds are accepted here (FR-56) — D9 means the dashboard calls the same endpoints
 * an agent does. It is the *web* guards that additionally require `kind = 'session'`.
 */
export async function requireCreator(req: Request, scope?: ApiScope): Promise<AuthedCreator> {
  const key = apiKeyFrom(req);
  if (!key) throw new ApiError("invalid_key");

  const resolved = await resolveBearer(key);
  if (!resolved) throw new ApiError("invalid_key");

  const { row, creator } = resolved;
  if (scope && !(row.scopes ?? []).includes(scope)) {
    throw new ApiError("insufficient_scope", { message: `This key does not carry the \`${scope}\` scope.`, details: { required: scope, granted: row.scopes } });
  }
  return { ...creator, apiKey: { id: row.id, kind: row.kind, scopes: row.scopes } };
}
