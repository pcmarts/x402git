/**
 * lib/admin/overview.ts — the first screen: what needs a human, then how it is going.
 *
 * Until 2026-09-13 `/admin` opened on the listings table, and "is anything wrong?" was
 * one line of a six-line tally above twenty-five rows. An operator's first question on
 * arrival is not *what went up* — it is *do I need to do something*, and the answer was
 * spread over four pages (ops line on Listings, Blocked on Money, Failing on Activity,
 * the rebinding flag on Creators). This gathers those into one ordered list, each item
 * with the page where it is acted on, and says so plainly when the list is empty.
 *
 * It reads through the existing loaders rather than new queries, so every number here
 * is the number the linked page will show.
 */

import { loadActivity, type FailureGroup } from "@/lib/admin/activity";
import { loadAudit } from "@/lib/admin/audit";
import { loadCreators } from "@/lib/admin/creators";
import { loadAdminFeed } from "@/lib/admin/feed";
import { loadMoney, type MoneyTotals } from "@/lib/admin/money";
import { loadOpsHealth, type OpsHealth } from "@/lib/admin/ops";
import { formatDateTime } from "@/lib/web/manifest-view";
import { formatAmount } from "@/lib/web/money";

/** A failure older than this is history, not something to act on — Activity keeps it. */
export const FAILURE_RECENT_MS = 48 * 60 * 60 * 1000;

export type Attention = { status: "fail" | "warn"; text: string; href: string; action: string };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Ordered by what it costs to leave: commerce stopped, then people not being paid, then
 * things breaking, then things to review. Pure, so the wording and order are tested.
 */
export function attentionItems(input: {
  paused: OpsHealth["paused"];
  stuck: OpsHealth["stuck"];
  totals: Pick<MoneyTotals, "owedMicro" | "blockedCreators">;
  failures: readonly FailureGroup[];
  flagged: number;
  rebinding: readonly string[];
}): Attention[] {
  const out: Attention[] = [];

  for (const s of input.paused) {
    out.push({
      status: "fail",
      text: `${s.name} is paused${s.reason ? ` — ${s.reason}` : ""}${s.updated_by ? ` (${s.updated_by})` : ""}`,
      href: "/admin/ops",
      action: "Ops",
    });
  }

  if (input.stuck.length > 0) {
    const amount = input.stuck.reduce((sum, p) => sum + p.amountMicro, 0n);
    const who = input.totals.blockedCreators > 0 ? ` — ${plural(input.totals.blockedCreators, "creator")} not being paid` : "";
    out.push({ status: "fail", text: `${plural(input.stuck.length, "payout")} stuck, ${formatAmount(amount)}${who}`, href: "/admin/ops", action: "Ops" });
  }

  for (const f of input.failures) {
    out.push({
      status: f.name === "paused_block" || f.name === "sweep_skipped" ? "warn" : "fail",
      text: `${f.count}× ${f.name} (${f.cause}), last ${formatDateTime(f.lastAt)}`,
      href: "/admin/activity",
      action: "Activity",
    });
  }

  if (input.flagged > 0) {
    out.push({ status: "warn", text: `${plural(input.flagged, "listing")} flagged for review`, href: "/admin/listings?status=review", action: "Review" });
  }

  if (input.totals.owedMicro > 0n) {
    out.push({
      status: "warn",
      text: `${formatAmount(input.totals.owedMicro)} owed to creators — the next sweep pays it, so check the wallet: npm run ops:status`,
      href: "/admin/money",
      action: "Money",
    });
  }

  for (const handle of input.rebinding) {
    out.push({ status: "warn", text: `${handle} is changing payout address — sweeps still go to the old one`, href: `/admin/creators/${handle}`, action: "Creator" });
  }

  return out;
}

export async function loadOverview(chainId: number, now = Date.now()) {
  const [feed, health, money, activity, creators, audit] = await Promise.all([
    loadAdminFeed(undefined, chainId),
    loadOpsHealth(chainId),
    loadMoney("7d", 5, chainId),
    loadActivity("7d", undefined, { chainId }),
    loadCreators(undefined, chainId),
    loadAudit(5),
  ]);

  const recentFailures = activity.failures.filter((f) => now - Date.parse(f.lastAt) <= FAILURE_RECENT_MS);
  const rebinding = creators.rows.filter((r) => r.flags.includes("rebinding")).map((r) => r.creator.handle);
  const week = 7 * 24 * 60 * 60 * 1000;

  return {
    attention: attentionItems({
      paused: health.paused,
      stuck: health.stuck,
      totals: money.totals,
      failures: recentFailures,
      flagged: feed.tally.needsReview,
      rebinding,
    }),
    tally: feed.tally,
    newest: feed.rows.slice(0, 5),
    totals: money.totals,
    funnel: activity.funnel,
    creatorsTotal: creators.rows.length,
    creatorsWeek: creators.rows.filter((r) => now - Date.parse(r.creator.created_at) <= week).length,
    health,
    audit: audit.entries.slice(0, 5),
  };
}
