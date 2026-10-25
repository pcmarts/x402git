/**
 * lib/idempotency.ts — FR-2's `Idempotency-Key`.
 *
 * The problem it solves is narrow and real: `POST /api/creators` returns the API key
 * exactly once. If that response is dropped in flight the creator is stranded with an
 * account they cannot authenticate to. Replaying the identical 201 for 24 hours fixes
 * that, and nothing else needs it.
 *
 *   const key = idempotencyKeyFrom(req);
 *   const prior = await replayIdempotent("POST /api/creators", key, body);
 *   if (prior) return NextResponse.json(prior.response, { status: prior.status });
 *   …
 *   await recordIdempotent("POST /api/creators", key, body, 201, payload, creator.id);
 *
 * Reusing a key with a *different* body is a caller bug, not a retry, and returns
 * `invalid_request` rather than the wrong account's key.
 *
 * **The stored response holds a credential, so it is never stored in the clear**
 * (RED-TEAM-2026-09-21.md DB-1). `api_key` rows keep only a sha256 so that a copy of the
 * database yields no usable key; a plaintext copy of the same key in this table would
 * quietly undo that. The caller names the secret fields, they are sealed under
 * `SESSION_SECRET` (`sealStored`) before the insert and opened again on replay, and
 * `purgeExpiredIdempotency` deletes the row once its 24 hours are up — the TTL used to be
 * read-side only, so every key ever minted this way stayed in the table for good.
 */

import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import type { IdempotencyRow } from "@/lib/db/types";
import { ApiError } from "@/lib/errors";
import { openStored, sealStored } from "@/lib/web/session";

export const IDEMPOTENCY_TTL_HOURS = 24;

export function idempotencyKeyFrom(req: Request): string | null {
  const value = req.headers.get("idempotency-key")?.trim();
  return value && value.length > 0 && value.length <= 255 ? value : null;
}

export function requestHash(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
}

export type PriorResponse = { status: number; response: unknown };

/** Where the sealed fields live inside a stored response. Never returned to a caller. */
const SEALED = "_sealed";

function ttlCutoff(now: Date): Date {
  return new Date(now.getTime() - IDEMPOTENCY_TTL_HOURS * 3600 * 1000);
}

/** The stored response for this key, or null. Throws if the key was reused differently. */
export async function replayIdempotent(route: string, key: string | null, body: unknown, now = new Date()): Promise<PriorResponse | null> {
  if (!key) return null;

  const { data, error } = await db().from("idempotency").select("*").eq("key", storageKey(route, key)).maybeSingle();
  if (error) throw error;
  const row = data as IdempotencyRow | null;
  if (!row) return null;

  if (new Date(row.created_at).getTime() < ttlCutoff(now).getTime()) return null;

  if (row.request_hash && row.request_hash !== requestHash(body)) {
    throw new ApiError("invalid_request", { message: "That Idempotency-Key was already used with a different request body." });
  }
  return { status: row.status, response: unsealResponse(row.response) };
}

/** Put the sealed fields back. A field that will not open means `SESSION_SECRET` rotated since. */
function unsealResponse(stored: unknown): unknown {
  if (!stored || typeof stored !== "object" || !(SEALED in stored)) return stored;
  const { [SEALED]: sealed, ...rest } = stored as Record<string, unknown>;
  const out: Record<string, unknown> = { ...rest };
  for (const [field, value] of Object.entries((sealed ?? {}) as Record<string, unknown>)) {
    const opened = openStored(typeof value === "string" ? value : null);
    if (opened === null) {
      throw new ApiError("invalid_request", {
        message: "That response can no longer be replayed. The registration succeeded: mint a key with POST /api/auth/rotate-key.",
      });
    }
    out[field] = opened;
  }
  return out;
}

/**
 * Store the response so the next identical request replays it. Never throws.
 *
 * `secretFields` names the top-level string fields that are credentials. If one cannot
 * be sealed the response is not stored at all: a creator who cannot replay is
 * recoverable (`POST /api/auth/rotate-key`), a plaintext key in a table is not.
 */
export async function recordIdempotent(
  route: string,
  key: string | null,
  body: unknown,
  status: number,
  response: unknown,
  creatorId?: string | null,
  secretFields: readonly string[] = [],
): Promise<void> {
  if (!key) return;
  let stored: unknown;
  try {
    stored = sealResponse(response, secretFields);
  } catch (e) {
    console.warn("[idempotency] could not seal, so nothing was stored:", e instanceof Error ? e.message : String(e));
    return;
  }
  const { error } = await db()
    .from("idempotency")
    .insert({ key: storageKey(route, key), route, request_hash: requestHash(body), status, response: stored, creator_id: creatorId ?? null });
  // A duplicate means a concurrent identical request won the race; that is the point.
  if (error) console.warn("[idempotency] could not record:", error.message);
}

function sealResponse(response: unknown, secretFields: readonly string[]): unknown {
  if (secretFields.length === 0 || !response || typeof response !== "object") return response;
  const rest: Record<string, unknown> = { ...(response as Record<string, unknown>) };
  const sealed: Record<string, string> = {};
  for (const field of secretFields) {
    const value = rest[field];
    if (typeof value !== "string") continue;
    sealed[field] = sealStored(value);
    delete rest[field];
  }
  return { ...rest, [SEALED]: sealed };
}

/**
 * Delete every row past its 24 hours. Called from the daily cron, and the number it
 * returns is rows removed. Never throws: housekeeping must not fail the job it rides on.
 */
export async function purgeExpiredIdempotency(now = new Date()): Promise<number> {
  try {
    const { data, error } = await db().from("idempotency").delete().lt("created_at", ttlCutoff(now).toISOString()).select("key");
    if (error) throw error;
    return (data ?? []).length;
  } catch (e) {
    console.warn("[idempotency] purge failed:", e instanceof Error ? e.message : String(e));
    return 0;
  }
}

function storageKey(route: string, key: string): string {
  return `${route}:${key}`;
}
