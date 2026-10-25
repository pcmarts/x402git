/**
 * lib/admin/ops.ts — the two ops facts that belong on a page an operator already has open.
 *
 * `scripts/ops-status.mjs` is the full answer and stays the full answer: it reads the
 * chain, compares the sweep wallet's balance against what is owed, and exits non-zero.
 * It also needs a terminal, a checkout and the environment. This is the subset that is
 * pure database — **which kill switches are thrown, and which payouts are stuck** — so
 * that the page an operator opens to watch listings also tells them if commerce is
 * paused or a creator is blocked. Nothing here touches an RPC; a page that renders in
 * 40ms should not wait on Base.
 *
 * Read-only. Flipping a switch is `/admin/ops` (lib/admin/controls.ts) or
 * `scripts/ops-switch.mjs`; clearing a stuck payout stays
 * `scripts/ops-clear-stuck-payout.mjs`, because it needs a chain scan first.
 */

import { db } from "@/lib/db";
import type { PayoutRow } from "@/lib/db/types";
import { toMicro } from "@/lib/db/types";
import { paymentChain } from "@/lib/env";
import { SWITCHES, type SwitchRow } from "@/lib/ops/switches";

/**
 * A payout that has been created but never confirmed. It blocks its creator: the
 * in-flight guard refuses to start another sweep for them on this chain while one sits
 * here, so a row in this state is a person not being paid.
 */
export type StuckPayout = { id: string; creatorId: string; amountMicro: bigint; toAddress: string; status: string; createdAt: string };

export type OpsHealth = {
  switches: SwitchRow[];
  paused: SwitchRow[];
  stuck: StuckPayout[];
  chainId: number;
  /** True when nothing needs a human right now. */
  clear: boolean;
};

/**
 * Every switch, and every stuck payout on the configured chain.
 *
 * The switch read is `allSwitches`'s query rather than `pausedSwitches`, because that
 * one is cached for ten seconds and this page is where somebody comes to find out the
 * truth. A name with no row reads as not paused, so a deployment whose migration has not
 * run shows four live switches rather than an error.
 */
export async function loadOpsHealth(chainId = paymentChain().chainId): Promise<OpsHealth> {
  const [switches, stuck] = await Promise.all([switchRows(), stuckPayouts(chainId)]);
  const paused = switches.filter((s) => s.paused);
  return { switches, paused, stuck, chainId, clear: paused.length === 0 && stuck.length === 0 };
}

async function switchRows(): Promise<SwitchRow[]> {
  try {
    const { data, error } = await db().from("ops_switch").select("*").order("name");
    if (error) throw error;
    const rows = (data as SwitchRow[] | null) ?? [];
    const byName = new Map(rows.map((r) => [r.name, r]));
    // Every known switch appears, whether or not anybody has touched it — a switch
    // missing from the list reads as "we do not have that control", which is worse than
    // showing it as off.
    return SWITCHES.map(
      (name) => byName.get(name) ?? { name, paused: false, reason: null, updated_at: "", updated_by: null },
    );
  } catch (e) {
    console.warn("[admin] could not read ops_switch:", e instanceof Error ? e.message : String(e));
    return SWITCHES.map((name) => ({ name, paused: false, reason: null, updated_at: "", updated_by: null }));
  }
}

/**
 * Degrades rather than throws, like `switchRows` beside it. This runs inside the
 * *listings* page, so an error here would 500 the surface an operator opens to find out
 * what is wrong — and the most likely cause is benign: a deployment where migration
 * 20260906010000 has not run has no `payout.chain_id` to filter on.
 *
 * The cost of failing quietly is one missing warning; the cost of throwing is the whole
 * page. Neither is good, and the page is worth more.
 */
async function stuckPayouts(chainId: number): Promise<StuckPayout[]> {
  const { data, error } = await db()
    .from("payout")
    .select("id, creator_id, amount_micro, to_address, status, created_at, chain_id")
    .eq("chain_id", chainId)
    .in("status", ["pending", "broadcast"])
    .order("created_at", { ascending: true });
  if (error) {
    console.warn("[admin] could not read payouts for the health line:", error.message);
    return [];
  }

  return ((data as PayoutRow[] | null) ?? []).map((row) => ({
    id: row.id,
    creatorId: row.creator_id,
    amountMicro: toMicro(row.amount_micro),
    toAddress: row.to_address,
    status: row.status,
    createdAt: row.created_at,
  }));
}

/** The one-line summary the tally prints. Pure, so the wording is testable. */
export function healthSummary(health: Pick<OpsHealth, "switches" | "paused" | "stuck">): string {
  const parts: string[] = [];
  parts.push(health.paused.length === 0 ? `${health.switches.length} switches live` : `${health.paused.map((s) => s.name).join(", ")} PAUSED`);
  parts.push(health.stuck.length === 0 ? "no payout stuck" : `${health.stuck.length} payout${health.stuck.length === 1 ? "" : "s"} stuck`);
  return parts.join(" · ");
}
