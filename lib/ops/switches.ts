/**
 * lib/ops/switches.ts — the §19 kill switches.
 *
 * Four global pauses an operator can throw without a deploy: registrations, publishing,
 * payments and sweeps. The fifth thing §19 asks for — per-listing takedown — is an
 * action rather than a state, and lives in `scripts/ops-takedown.mjs`.
 *
 *   if (await isPaused("registrations")) throw new ApiError("paused");
 *
 * Three properties, and each one is a decision rather than an implementation detail:
 *
 * **It fails open.** A switch that cannot be read is a switch that is off. The table is
 * a control for stopping commerce deliberately; it must never become the reason commerce
 * stopped by accident. In practice a database that cannot answer this query cannot serve
 * a purchase either — `quote` reads the listing from the same connection — so failing
 * open costs nothing real and removes a whole class of self-inflicted outage.
 *
 * **It is cached for ten seconds.** The paid path asks on every request, and a switch is
 * flipped by a human during an incident: ten seconds is far below the time it takes to
 * decide to flip one, and far above the request rate at which a per-request read would
 * matter. A failed read is cached too, briefly, so an outage does not turn into a query
 * storm.
 *
 * **A caller is never told why.** `reason` is operator prose for the operator. A paused
 * endpoint answers everyone identically — 503 — because a pause usually means an
 * incident, and an incident is not something to narrate to strangers while it is running.
 */

import { db } from "@/lib/db";

export const SWITCHES = ["registrations", "publishing", "payments", "sweeps"] as const;
export type SwitchName = (typeof SWITCHES)[number];

export type SwitchRow = { name: string; paused: boolean; reason: string | null; updated_at: string; updated_by: string | null };

const TTL_MS = 10_000;

let cache: { at: number; paused: ReadonlySet<string> } | null = null;

/** Tests, and anything that needs the next read to hit the database. */
export function resetSwitchCache(): void {
  cache = null;
}

/**
 * The set of switches currently paused. A name with no row is absent from the set, so a
 * database whose migration has not run reads as "nothing is paused" rather than failing.
 */
export async function pausedSwitches(now = Date.now()): Promise<ReadonlySet<string>> {
  if (cache && now - cache.at < TTL_MS) return cache.paused;

  try {
    const { data, error } = await db().from("ops_switch").select("name, paused").eq("paused", true);
    if (error) throw error;
    cache = { at: now, paused: new Set((data ?? []).map((r) => String((r as { name: string }).name))) };
  } catch (e) {
    // Fail open, loudly. Caching the failure keeps an outage from becoming a query storm.
    console.warn("[ops] could not read ops_switch; treating every switch as off:", e instanceof Error ? e.message : String(e));
    cache = { at: now, paused: new Set() };
  }
  return cache.paused;
}

export async function isPaused(name: SwitchName, now = Date.now()): Promise<boolean> {
  return (await pausedSwitches(now)).has(name);
}

/** Every switch and its state, for the ops script. Uncached — an operator wants truth. */
export async function allSwitches(): Promise<SwitchRow[]> {
  const { data, error } = await db().from("ops_switch").select("*").order("name");
  if (error) throw error;
  return (data ?? []) as SwitchRow[];
}

/** Flip one. Returns the row as written. Used by `scripts/ops-switch.mjs`. */
export async function setSwitch(name: SwitchName, paused: boolean, reason: string | null, by: string | null): Promise<SwitchRow> {
  const { data, error } = await db()
    .from("ops_switch")
    .upsert({ name, paused, reason, updated_by: by, updated_at: new Date().toISOString() }, { onConflict: "name" })
    .select("*")
    .single();
  if (error) throw error;
  resetSwitchCache();
  return data as SwitchRow;
}
