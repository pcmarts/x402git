/**
 * lib/admin/controls.ts — the two things an operator can now do from `/admin`.
 *
 * On 2026-09-07 the admin section was deliberately read-only: a kill switch and a
 * takedown "should not be a button sitting beside a hundred rows", so both stayed
 * scripts. That reasoning was about *where* the control sat, and it still holds — what
 * changed on 2026-09-13 is the observation that the scripts need a checkout and
 * `.env.local` holding the database's secret key, which is exactly what an operator
 * does not have on a phone at 3am during the incident a switch exists for. See
 * DECISIONS.md, 2026-09-13.
 *
 * So each control lives on a page of its own, never in a table row, and each one:
 *
 * - **is typed, not clicked.** The switch name or the `owner/slug` is typed into a
 *   field and checked here on the server — the page is not a security boundary.
 * - **carries a reason**, because the next person to read the row is usually you.
 * - **writes an audit row** with the caller's login from the session (lib/admin/audit.ts).
 *
 * What stayed a script, and why, is the money: `revoke` (FR-39 — the refund has no
 * automated path, FR-26) and clearing a stuck payout (it needs a chain scan to prove the
 * transfer never landed). Neither is here.
 *
 * Nothing in this file imports `lib/core/access.ts`. Retiring sets `retired_at`, which
 * `quote` already reads; it does not grant, revoke or move money.
 */

import { recordAdminAction } from "@/lib/admin/audit";
import { db } from "@/lib/db";
import type { ListingRow } from "@/lib/db/types";
import { setSwitch, SWITCHES, type SwitchName, type SwitchRow } from "@/lib/ops/switches";

export type ControlResult = { ok: true; message: string } | { ok: false; message: string };

export const REASON_MIN = 3;
export const REASON_MAX = 500;

export function isSwitchName(value: string): value is SwitchName {
  return (SWITCHES as readonly string[]).includes(value);
}

/** Trimmed, bounded operator prose, or null when it is too short to be a reason. */
export function reasonOf(input: unknown): string | null {
  const text = String(input ?? "").trim().slice(0, REASON_MAX);
  return text.length >= REASON_MIN ? text : null;
}

/** Exact match after trimming, case-insensitive: the typed confirmation rule everywhere. */
export function confirmed(typed: unknown, expected: string): boolean {
  return String(typed ?? "").trim().toLowerCase() === expected.toLowerCase();
}

/**
 * Pause or resume one switch.
 *
 * Pausing an already-paused switch is refused rather than re-written, for the same
 * reason `grantAdmin` refuses a live re-grant: the upsert would replace `reason`,
 * `updated_by` and `updated_at`, and those are the record of who threw it and why.
 */
export async function changeSwitch(input: {
  name: string;
  action: string;
  reason?: unknown;
  confirm?: unknown;
  by: string;
  current: readonly SwitchRow[];
}): Promise<ControlResult> {
  const { name, action, by } = input;
  if (!isSwitchName(name)) return { ok: false, message: `There is no switch called ${name || "that"}.` };
  if (action !== "pause" && action !== "resume") return { ok: false, message: "Choose pause or resume." };
  if (!confirmed(input.confirm, name)) return { ok: false, message: `Type ${name} exactly to confirm.` };

  const pausing = action === "pause";
  const reason = reasonOf(input.reason);
  if (pausing && !reason) {
    return { ok: false, message: "A pause needs a reason. Whoever reads this row next will want it, and it is usually you." };
  }

  const was = input.current.find((s) => s.name === name)?.paused ?? false;
  if (was === pausing) return { ok: false, message: `${name} is already ${pausing ? "paused" : "running"}. Nothing was changed.` };

  try {
    await setSwitch(name, pausing, pausing ? reason : null, by);
  } catch (e) {
    return { ok: false, message: `Could not save that: ${e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e)}` };
  }

  const auditError = await recordAdminAction({
    name: pausing ? "switch_paused" : "switch_resumed",
    by,
    props: { switch: name, ...(reason ? { reason } : {}) },
  });

  const effect = pausing ? `${name} is paused.` : `${name} is running again.`;
  const audit = auditError ? ` The audit row did not save (${auditError}) — note this somewhere.` : "";
  return { ok: true, message: `${effect} It takes effect everywhere within ten seconds.${audit}` };
}

/**
 * FR-39's takedown, the `retire` half of `scripts/ops-takedown.mjs`, from the web.
 *
 * Holders keep every version they own (FR-46) — this stops new purchases and nothing
 * else. The update is conditional on `retired_at` still being null, so two operators
 * acting on the same notice produce one retirement and one "already retired", never two
 * audit rows claiming the same act.
 *
 * The hosted repo is not archived here, matching the script: a takedown is often
 * followed by a `revoke` and an investigation, and both want the repo as it was.
 */
export async function takeDownListing(input: {
  listingId: string;
  confirm?: unknown;
  reason?: unknown;
  by: string;
}): Promise<ControlResult & { ref?: string }> {
  const { data: listingData, error: listingError } = await db().from("listing").select("*").eq("id", input.listingId).maybeSingle();
  if (listingError || !listingData) return { ok: false, message: "No such listing." };
  const listing = listingData as ListingRow;

  const { data: creatorData } = await db().from("creator").select("id, handle").eq("id", listing.creator_id).maybeSingle();
  const handle = (creatorData as { handle: string } | null)?.handle ?? "—";
  const ref = `${handle}/${listing.slug}`;

  if (listing.retired_at) return { ok: false, ref, message: `${ref} is already retired. Retire is terminal.` };
  if (!confirmed(input.confirm, ref)) return { ok: false, ref, message: `Type ${ref} exactly to confirm.` };
  const reason = reasonOf(input.reason);
  if (!reason) return { ok: false, ref, message: "A takedown needs a reason — the notice it answers, usually. It is the record of why." };

  const retiredAt = new Date().toISOString();
  const { data, error } = await db()
    .from("listing")
    .update({ retired_at: retiredAt })
    .eq("id", listing.id)
    .is("retired_at", null)
    .select("id");
  if (error) return { ok: false, ref, message: `Could not save that: ${error.message}` };
  if (!data || (data as unknown[]).length === 0) return { ok: false, ref, message: `${ref} was retired by someone else a moment ago.` };

  const auditError = await recordAdminAction({ name: "takedown_retired", by: input.by, listingId: listing.id, props: { ref, reason } });
  const audit = auditError ? ` The audit row did not save (${auditError}) — note this somewhere.` : "";
  return {
    ok: true,
    ref,
    message: `${ref} is retired. New purchases stop now; every wallet that already bought keeps what it owns.${audit}`,
  };
}
