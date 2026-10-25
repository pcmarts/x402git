/**
 * lib/notify/telegram.test.ts — the transport's four failures and the one success.
 *
 * The load-bearing assertion is the negative one: the bot token is in the request URL and
 * must never be in a log line. Every test spies on the whole console so a future edit that
 * logs the URL fails here rather than in a log drain.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnv } from "@/lib/env";
import { escapeHtml, redactToken, sendTelegram, TELEGRAM_MAX_CHARS, truncateForTelegram } from "./telegram";

const TOKEN = "8123456789:AAF-thisIsNotARealBotToken";
const CHAT = "-1000000000000";

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
let log: ReturnType<typeof vi.spyOn>;

/** Nothing the process printed, anywhere, may contain the token. */
function everythingLogged(): string {
  return [warn, error, log].flatMap((spy) => (spy.mock.calls as unknown[][]).map((call) => call.map(String).join(" "))).join("\n");
}

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  process.env.TELEGRAM_BOT_TOKEN = TOKEN;
  process.env.TELEGRAM_ADMIN_CHAT_ID = CHAT;
  resetEnv();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_ADMIN_CHAT_ID;
  resetEnv();
});

describe("escapeHtml", () => {
  it("escapes exactly the three characters Telegram's HTML subset reserves", () => {
    expect(escapeHtml('<b>evil</b> & "quoted"')).toBe('&lt;b&gt;evil&lt;/b&gt; &amp; "quoted"');
    expect(escapeHtml("plain")).toBe("plain");
  });
});

describe("truncateForTelegram", () => {
  it("leaves a short message alone and cuts a long one to the limit with a marker", () => {
    expect(truncateForTelegram("short")).toBe("short");
    const long = "x".repeat(5_000);
    const cut = truncateForTelegram(long);
    expect(cut.length).toBe(TELEGRAM_MAX_CHARS);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("never cuts an escaped entity or a tag in half — a broken entity is a 400, not a long message", () => {
    const cut = truncateForTelegram(`${"x".repeat(TELEGRAM_MAX_CHARS - 3)}&amp;tail`);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut).not.toMatch(/&[#a-zA-Z0-9]*…$/);

    const tag = truncateForTelegram(`${"x".repeat(TELEGRAM_MAX_CHARS - 3)}<a href="x">y</a>`);
    expect(tag).not.toMatch(/<[^>]*…$/);
  });
});

describe("sendTelegram", () => {
  it("sends nothing, and says nothing, when the channel is not configured", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    resetEnv();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));

    expect(await sendTelegram("hello", { fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({ delivered: false, reason: "unconfigured" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("POSTs the Bot API with the HTML parse mode, and keeps the token out of every log", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));

    const result = await sendTelegram("👤 <b>New creator</b>", { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result).toEqual({ delivered: true, status: 200 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      chat_id: CHAT,
      text: "👤 <b>New creator</b>",
      parse_mode: "HTML",
      disable_web_page_preview: true,
      disable_notification: false,
    });
    expect(everythingLogged()).not.toContain(TOKEN);
  });

  it("passes silent through as disable_notification", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await sendTelegram("quiet", { silent: true, fetchImpl: fetchImpl as unknown as typeof fetch });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).disable_notification).toBe(true);
  });

  it("truncates before sending, so the API never sees more than it accepts", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await sendTelegram("y".repeat(9_000), { fetchImpl: fetchImpl as unknown as typeof fetch });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).text).toHaveLength(TELEGRAM_MAX_CHARS);
  });

  it("reports a non-2xx as a failure with its status, and warns once naming only the reason", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"ok":false,"description":"chat not found"}', { status: 400 }));

    expect(await sendTelegram("hello", { fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({ delivered: false, reason: "http_400", status: 400 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toBe("[notify] telegram send failed: http_400");
  });

  it("never throws when the network does, and redacts a token the error quoted back", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`request to https://api.telegram.org/bot${TOKEN}/sendMessage failed, reason: ECONNREFUSED`);
    });

    const result = await sendTelegram("hello", { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result.delivered).toBe(false);
    expect(result.reason).toContain("ECONNREFUSED");
    expect(result.reason).not.toContain(TOKEN);
    expect(everythingLogged()).not.toContain(TOKEN);
  });

  it("aborts at the timeout and names it, rather than holding a request open", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
        }),
    );

    const pending = sendTelegram("hello", { fetchImpl: fetchImpl as unknown as typeof fetch });
    await vi.advanceTimersByTimeAsync(3_000);

    expect(await pending).toEqual({ delivered: false, reason: "timeout" });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("redactToken", () => {
  it("replaces every occurrence and leaves a token-free string alone", () => {
    expect(redactToken(`a ${TOKEN} b ${TOKEN}`, TOKEN)).toBe("a <token> b <token>");
    expect(redactToken("nothing to hide", TOKEN)).toBe("nothing to hide");
  });
});
