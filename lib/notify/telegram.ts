/**
 * lib/notify/telegram.ts — the wire, and nothing else.
 *
 * One function that POSTs a string to the admin channel through the Bot API. What goes
 * *in* the string is `lib/notify/index.ts`'s problem; this file knows about a token, a
 * chat id, a timeout and the four ways a send can fail. The bot, the channel and how to
 * rotate the token are in ADMIN-NOTIFICATIONS.md.
 *
 * Three rules, all of them the same rule that `lib/abuse-webhook.ts` keeps for the
 * outbound webhook — a notification is a courtesy and must never become an outage:
 *
 * - **Nothing here throws.** Unconfigured, non-2xx, a network fault, a timeout: every
 *   path returns a `TelegramSendResult`, and the caller decides whether it is worth
 *   mentioning. The one on the paid path is `notifyAdmin`, and a failed courtesy must
 *   not fail a settlement.
 * - **The token never reaches a log.** It is in the *URL*, which is why the URL is never
 *   logged and why the reason string is run through `redactToken` before `console.warn`
 *   sees it — a fetch implementation is entitled to put the request URL in its own error
 *   message, and Vercel's log drain is not a place for a bot token. Same rule as
 *   `lib/chain.ts`, which refuses to print `EVM_RPC_URL` for the same reason.
 * - **3 seconds, then give up.** Telegram is not a dependency of anything this product
 *   sells. An `AbortController` rather than `AbortSignal.timeout` so a timeout can be
 *   told apart from a caller's abort and named as one.
 *
 * `parse_mode: HTML` is Telegram's smallest markup dialect — `<b>`, `<i>`, `<a href>` —
 * and it is the reason `escapeHtml` exists. Everything user-supplied (a handle, a slug, a
 * thrown message) must pass through it, or the first creator to register `<b>` breaks
 * every message that names them with a 400 from the API.
 */

import { telegramConfig } from "@/lib/env";

export type TelegramSendResult = {
  delivered: boolean;
  /** Why not, when `delivered` is false: `unconfigured`, `timeout`, `http_403`, `transport: …`. */
  reason?: string;
  status?: number;
};

/** Telegram is a courtesy; three seconds is already generous on a request path. */
export const TELEGRAM_TIMEOUT_MS = 3_000;

/**
 * Telegram rejects a `text` longer than 4096 characters outright. Cutting at 4000 leaves
 * room for the ellipsis and for the fact that the limit counts UTF-16 code units, which
 * is not what `String.length` counts once an emoji is involved.
 */
export const TELEGRAM_MAX_CHARS = 4_000;

/**
 * Telegram's HTML subset needs exactly these three escaped, and only these three:
 * quotes are literal outside an attribute, and this module never interpolates into one.
 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Cut to `TELEGRAM_MAX_CHARS` with a visible marker.
 *
 * The cut lands in already-escaped HTML, so a naive slice can end mid-`&amp;` or mid-tag
 * and the API answers 400 "can't parse entities" — the whole message lost to save 96
 * characters. Any dangling entity or tag at the seam is dropped before the ellipsis.
 */
export function truncateForTelegram(text: string): string {
  if (text.length <= TELEGRAM_MAX_CHARS) return text;
  const cut = text
    .slice(0, TELEGRAM_MAX_CHARS - 1)
    .replace(/&[#a-zA-Z0-9]*$/, "")
    .replace(/<[^>]*$/, "");
  return `${cut}…`;
}

export type SendTelegramOptions = {
  /** Delivered without a sound. Nothing uses it yet; errors at 3am eventually will. */
  silent?: boolean;
  /** Test seam. Never reached for in production code — the global `fetch` is the point. */
  fetchImpl?: typeof fetch;
};

/**
 * POST one message to the admin channel. Returns why not, rather than throwing.
 *
 * An unconfigured deployment is silent in both senses: no request, and no warning either.
 * Every preview build is unconfigured on purpose (see `telegramConfig`), and a log line
 * per event on every preview is noise that teaches an operator to filter `[notify]`.
 */
export async function sendTelegram(text: string, opts: SendTelegramOptions = {}): Promise<TelegramSendResult> {
  let config: { botToken: string; chatId: string } | null;
  try {
    config = telegramConfig();
  } catch {
    // `env()` throws only on a malformed *declared shape*; treat it as "no channel".
    config = null;
  }
  if (!config) return { delivered: false, reason: "unconfigured" };

  const { botToken, chatId } = config;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TELEGRAM_TIMEOUT_MS);

  try {
    const response = await (opts.fetchImpl ?? fetch)(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: truncateForTelegram(text),
        parse_mode: "HTML",
        // A listing link would otherwise unfurl the whole manifest page under every message.
        disable_web_page_preview: true,
        disable_notification: !!opts.silent,
      }),
      signal: controller.signal,
    });
    if (!response.ok) return failed(`http_${response.status}`, botToken, response.status);
    return { delivered: true, status: response.status };
  } catch (e) {
    if (timedOut) return failed("timeout", botToken);
    return failed(`transport: ${e instanceof Error ? e.message : String(e)}`, botToken);
  } finally {
    clearTimeout(timer);
  }
}

/** One warn, naming the reason and nothing else. */
function failed(reason: string, botToken: string, status?: number): TelegramSendResult {
  const safe = redactToken(reason, botToken);
  console.warn(`[notify] telegram send failed: ${safe}`);
  return status === undefined ? { delivered: false, reason: safe } : { delivered: false, reason: safe, status };
}

/**
 * Belt and braces: a `fetch` error message may quote the request URL, and the token is in
 * the path. Exported so the test can prove the redaction rather than trust it.
 */
export function redactToken(text: string, botToken: string): string {
  return botToken.length > 0 ? text.split(botToken).join("<token>") : text;
}
