/**
 * lib/notify/index.ts — the five things worth a phone buzz, and what they may say.
 *
 * Setup, rotation and the reasoning are in ADMIN-NOTIFICATIONS.md; this is the code.
 *
 * `/admin` already shows all of this and shows it better (`lib/admin/feed.ts`,
 * `lib/admin/activity.ts`). What a page cannot do is tell an operator that the first
 * creator of the day just signed up, or that the settle path has started answering 500.
 * That is the whole job here: five event shapes, one line of formatting each, and a
 * transport that cannot fail loudly (`lib/notify/telegram.ts`).
 *
 * **Privacy: a notification carries no identity and no key.** No buyer address, no payout
 * address, no API key, no signature, no secret — the same rule `lib/admin/feed.ts` keeps
 * for the operator's own dashboard under FR-40, and for the stronger reason that a
 * Telegram channel is a third party's server, a phone's lock screen and a group's member
 * list. `AdminEvent` deliberately has no field for any of them, so keeping the rule is
 * not a matter of remembering to: a caller with a buyer address in hand has nowhere to
 * put it. The one address-shaped thing that does travel is a transaction hash, which is
 * public on the chain the moment it settles, and it travels shortened.
 *
 * **Only errors are throttled.** A signup, a listing, a settlement and an operator action
 * all post every time. An `admin_action` in particular is never noise: somebody paused
 * payments or took a listing down, there is at most one of those a week, and the one you
 * suppress is the one you did not do yourself (14 Sep 2026).
 *
 * **Errors are throttled, best-effort.** Vercel's Fluid Compute reuses an instance across
 * invocations, so an in-process map does suppress the common case — one broken dependency
 * answering the same way for every request — and it is a courtesy, not a guarantee: a
 * scale-out gives each new instance its own counters. That is the right trade for a
 * notifier. The alternative is a table write on the error path, which is a database call
 * added to the exact moment the database may be what is broken.
 *
 * Money is bigint micro-USDC and is rendered by `formatAmount` (CLAUDE.md: never a
 * float, and never a second formatter). The chain is always named, because
 * `lib/admin/feed.ts` §"One chain" is right that one Supabase project serves both Base
 * and Base Sepolia and an unlabelled amount reads testnet traffic as revenue.
 */

import { chainLabel } from "@/lib/buy-links";
import { appUrl } from "@/lib/env";
import { formatAmount } from "@/lib/web/money-format";
import { escapeHtml, sendTelegram, type TelegramSendResult } from "./telegram";

export type AdminEvent =
  | { kind: "creator_joined"; handle: string; creatorId: string; via: "web" | "api"; walletMode?: string }
  | { kind: "listing_created"; listingId: string; handle: string; slug: string; rail: "hosted" | "linked" | string; priceMicro: bigint; visibility?: string }
  | {
      kind: "payment_settled";
      listingId: string;
      handle: string;
      slug: string;
      version: string;
      grossMicro: bigint;
      purchaseKind: string;
      source: string | null;
      /** CAIP-2: `eip155:8453`, `eip155:84532`, `stellar:pubnet`, `stellar:testnet`. */
      network: string;
      txHash: string | null;
    }
  | {
      kind: "error";
      where: string;
      code?: string;
      message: string;
      /** `error` is the default and shouts; `alert` is the quieter "worth a look". */
      severity?: "error" | "alert";
      listingId?: string | null;
      details?: Record<string, string | number | boolean | null>;
    }
  | {
      kind: "admin_action";
      /** An `AuditEventName` from lib/admin/audit.ts, or `admin_granted` / `admin_revoked`. */
      action: string;
      /** The GitHub login that did it (web), or the OS username (script). Never a form value. */
      by: string;
      via: "admin" | "script";
      /** The switch name, the `handle/slug` ref, or the login that was granted/revoked. */
      subject: string;
      reason?: string | null;
      listingId?: string | null;
      /** Set when the audit row failed to save — the phone is then the only record. */
      auditError?: string | null;
    };

/** The same key twice inside this window posts once. */
export const ERROR_THROTTLE_MS = 10 * 60_000;

/** And no more than this many error posts an hour, whatever their keys. */
export const ERROR_HOURLY_CAP = 20;

const HOUR_MS = 60 * 60_000;

/** key → when it last posted. Pruned on every admission test, so it cannot grow forever. */
const lastPostedAt = new Map<string, number>();
/** Timestamps of the error posts admitted in the last hour, oldest first. */
let recentErrorPosts: number[] = [];

/** Tests, and anything that wants a clean instance. */
export function resetNotifyThrottle(): void {
  lastPostedAt.clear();
  recentErrorPosts = [];
}

/**
 * Format one event and post it. Never throws, never rejects.
 *
 * Fire-and-forget is the intended use — `void notifyAdmin(…)` on a request path — but the
 * result is returned so a cron or a test can say what happened. A suppressed error comes
 * back as `{ delivered: false, reason: "throttled" }`, which is not a failure.
 */
export async function notifyAdmin(event: AdminEvent): Promise<TelegramSendResult> {
  try {
    if (event.kind === "error" && !admitError(throttleKey(event), Date.now())) {
      return { delivered: false, reason: "throttled" };
    }
    return await sendTelegram(formatAdminEvent(event));
  } catch (e) {
    // A bug in the formatter above must not fail a paid request. Name the kind only.
    console.warn(`[notify] could not send ${describeKind(event)}: ${e instanceof Error ? e.message : String(e)}`);
    return { delivered: false, reason: "failed" };
  }
}

/** `where:code`, falling back to the head of the message when there is no code. */
function throttleKey(event: Extract<AdminEvent, { kind: "error" }>): string {
  return `${event.where}:${event.code ?? event.message.slice(0, 80)}`;
}

/** True if this key may post now. Records the post as a side effect when it may. */
function admitError(key: string, now: number): boolean {
  recentErrorPosts = recentErrorPosts.filter((t) => now - t < HOUR_MS);
  for (const [k, t] of lastPostedAt) if (now - t >= ERROR_THROTTLE_MS) lastPostedAt.delete(k);

  if (recentErrorPosts.length >= ERROR_HOURLY_CAP) return false;
  const last = lastPostedAt.get(key);
  if (last !== undefined && now - last < ERROR_THROTTLE_MS) return false;

  lastPostedAt.set(key, now);
  recentErrorPosts.push(now);
  return true;
}

function describeKind(event: AdminEvent): string {
  return typeof event === "object" && event !== null && typeof event.kind === "string" ? event.kind : "an event";
}

/**
 * The message body, in Telegram's HTML subset: an emoji and a bold headline, a handful of
 * `key: value` lines, then the `/admin` page that has the rest. Pure, and exported so the
 * tests read the exact string an operator would.
 *
 * Every interpolated value goes through `escapeHtml` — handles and slugs are creator-set,
 * and an error message can be anything a library felt like throwing.
 */
export function formatAdminEvent(event: AdminEvent): string {
  switch (event.kind) {
    case "creator_joined": {
      const lines = [`👤 <b>New creator @${escapeHtml(event.handle)}</b>`, `via: ${escapeHtml(event.via)}`];
      if (event.walletMode) lines.push(`wallet: ${escapeHtml(event.walletMode)}`);
      lines.push(link(`/admin/creators/${encodeURIComponent(event.handle)}`));
      return lines.join("\n");
    }

    case "listing_created": {
      const lines = [
        `📦 <b>New listing ${escapeHtml(`${event.handle}/${event.slug}`)}</b>`,
        `price: ${money(event.priceMicro)}`,
        `rail: ${escapeHtml(event.rail)}`,
      ];
      if (event.visibility) lines.push(`visibility: ${escapeHtml(event.visibility)}`);
      lines.push(link(`/admin/listings/${encodeURIComponent(event.listingId)}`));
      return lines.join("\n");
    }

    case "payment_settled": {
      const lines = [
        `💸 <b>${money(event.grossMicro)} — ${escapeHtml(`${event.handle}/${event.slug}`)}</b>`,
        `version: ${escapeHtml(event.version)}`,
        `kind: ${escapeHtml(event.purchaseKind)}`,
        `source: ${escapeHtml(event.source ?? "unknown")}`,
        // Never an unlabelled network: see the header, and lib/admin/feed.ts.
        `chain: ${escapeHtml(chainName(event.network))}`,
      ];
      if (event.txHash) lines.push(`tx: ${txLink(event.network, event.txHash)}`);
      lines.push(link(`/admin/listings/${encodeURIComponent(event.listingId)}`));
      return lines.join("\n");
    }

    case "error": {
      const alert = event.severity === "alert";
      const lines = [`${alert ? "⚠️" : "🚨"} <b>${alert ? "Alert" : "Error"} in ${escapeHtml(event.where)}</b>`];
      if (event.code) lines.push(`code: ${escapeHtml(event.code)}`);
      lines.push(`message: ${escapeHtml(event.message)}`);
      if (event.listingId) lines.push(`listing: ${escapeHtml(event.listingId)}`);
      for (const [k, v] of Object.entries(event.details ?? {})) lines.push(`${escapeHtml(k)}: ${escapeHtml(String(v))}`);
      lines.push(link("/admin/activity"));
      return lines.join("\n");
    }

    case "admin_action": {
      const lines = [
        `🔒 <b>${escapeHtml(humanAction(event.action))} by ${escapeHtml(event.by)}</b>`,
        `subject: ${escapeHtml(event.subject)}`,
        `via: ${escapeHtml(event.via)}`,
      ];
      if (event.reason) lines.push(`reason: ${escapeHtml(event.reason)}`);
      // The audit row is the durable record and this message is the copy. When the row did
      // not save, the copy is all there is, so it says so rather than reading like a
      // routine notification (lib/admin/audit.ts).
      if (event.auditError) lines.push(`⚠️ audit row did not save: ${escapeHtml(event.auditError)}`);
      lines.push(link(event.listingId ? `/admin/listings/${encodeURIComponent(event.listingId)}` : "/admin/audit"));
      return lines.join("\n");
    }
  }
}

/**
 * The event name as an operator would say it. An unknown name falls through to the raw
 * string rather than to "Unknown action": a name this table has not caught up with is
 * still more useful than the word for not knowing it.
 */
const ACTION_LABELS: Record<string, string> = {
  switch_paused: "Switch paused",
  switch_resumed: "Switch resumed",
  takedown_retired: "Listing retired (takedown)",
  takedown_revoked: "Purchases revoked (takedown)",
  user_marked_test: "User marked test",
  user_marked_real: "User marked real",
  admin_granted: "Admin granted",
  admin_revoked: "Admin revoked",
};

function humanAction(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

/** `$1.50 USDC`. `formatAmount` is the shipping formatter — bigint in, no float anywhere. */
function money(micro: bigint): string {
  return `${formatAmount(micro)} USDC`;
}

/** `Base`, `Base Sepolia`, `Stellar`, or the CAIP-2 name of a network we have no label for. */
function chainName(network: string): string {
  return chainLabel(network);
}

/**
 * `0x1234…abcd`, linked to the explorer.
 *
 * The explorer bases are spelled here rather than imported from
 * `lib/web/wallet-checkout.ts`, which owns the same two: that module pulls `viem` and
 * `@x402/core` in with it, and a notifier reached from a signup route has no business
 * loading a wallet client. Two lines duplicated against a dependency that size is the
 * cheaper of the two mistakes; `lib/buy-links.ts` exists for the same reason.
 */
function txLink(network: string, txHash: string): string {
  const short = escapeHtml(txHash.length > 12 ? `${txHash.slice(0, 6)}…${txHash.slice(-4)}` : txHash);
  const explorer = explorerTxBase(network);
  return explorer ? `<a href="${explorer}/${encodeURIComponent(txHash)}">${short}</a>` : short;
}

/** The `…/tx/` base per network, or null for one we would only be guessing at. */
function explorerTxBase(network: string): string | null {
  switch (network) {
    case "eip155:8453":
      return "https://basescan.org/tx";
    case "eip155:84532":
      return "https://sepolia.basescan.org/tx";
    // The Stellar rail (25 Oct 2026): stellar.expert, public and testnet.
    case "stellar:pubnet":
      return "https://stellar.expert/explorer/public/tx";
    case "stellar:testnet":
      return "https://stellar.expert/explorer/testnet/tx";
    default:
      return null;
  }
}

function link(path: string): string {
  return `${appUrl()}${path}`;
}
