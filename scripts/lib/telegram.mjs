/**
 * scripts/lib/telegram.mjs — the same wire as lib/notify/telegram.ts, for `.mjs` scripts.
 *
 * There is no TypeScript loader for scripts in this repo (no tsx, no ts-node — see
 * package.json) and `lib/notify/telegram.ts` imports through the `@/` alias, so a terminal
 * script cannot call the real transport without adding a build step. This is the smallest
 * duplicate that keeps its four rules:
 *
 * - **Nothing here throws.** Unconfigured, non-2xx, network fault, timeout: every path
 *   returns `{ delivered, reason }`. A takedown that worked must not report failure
 *   because Telegram was slow.
 * - **No env vars, no send, no noise.** Missing `TELEGRAM_BOT_TOKEN` or
 *   `TELEGRAM_ADMIN_CHAT_ID` is `{ delivered: false, reason: "unconfigured" }` — the same
 *   posture `sendTelegram` takes, and the reason a checkout without `.env` stays silent.
 * - **The token never reaches a log.** It is in the URL path, so the URL is never printed
 *   and every reason string is split on the token first.
 * - **3 seconds, then give up.** `TELEGRAM_TIMEOUT_MS` in the TypeScript twin.
 *
 * The *message* is the caller's problem, and a caller here is duplicating the shape that
 * `formatAdminEvent` owns. Keep them in step by eye; the authoritative rendering is
 * asserted character for character in lib/notify/index.test.ts.
 */

/** Telegram's HTML subset needs exactly these three escaped, and only these three. */
export function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * POST one message to the admin channel. Returns why not, rather than throwing.
 *
 * Reads the two variables off `process.env`, so a script that loads `.env` itself must
 * have put them there before calling (both `ops-takedown.mjs` and `telegram-check.mjs`
 * merge the files over `process.env` and pass the token in explicitly instead).
 */
export async function sendTelegram(text, opts = {}) {
  const token = opts.token ?? process.env.TELEGRAM_BOT_TOKEN ?? "";
  const chatId = opts.chatId ?? process.env.TELEGRAM_ADMIN_CHAT_ID ?? "";
  if (!token || !chatId) return { delivered: false, reason: "unconfigured" };

  const redact = (s) => String(s).split(token).join("<token>");

  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        // A listing link would otherwise unfurl the whole manifest page under the message.
        disable_web_page_preview: true,
        disable_notification: !!opts.silent,
      }),
      signal: AbortSignal.timeout(3_000),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      return { delivered: false, reason: redact(`http_${r.status}${body.description ? `: ${body.description}` : ""}`) };
    }
    return { delivered: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { delivered: false, reason: redact(/abort|timeout/i.test(message) ? "timeout" : `transport: ${message}`) };
  }
}
