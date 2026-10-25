/**
 * The indexer test behind the product's central metric. It decides which bucket a
 * `manifest_view` lands in and nothing else — no request is ever refused on this.
 *
 * The bias under test, stated in the module and enforced here: **when in doubt, count it
 * as a potential buyer.** Dropping a real view understates the number PRODUCT.md says
 * decides the product; letting a crawler through only dilutes it.
 */

import { describe, expect, it } from "vitest";
import { isLikelyBot } from "@/lib/web/user-agent";

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const SAFARI_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

describe("isLikelyBot", () => {
  it("passes real browsers through as people", () => {
    expect(isLikelyBot(CHROME)).toBe(false);
    expect(isLikelyBot(SAFARI_IOS)).toBe(false);
  });

  it("catches the search indexers this site deliberately invites", () => {
    expect(isLikelyBot("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toBe(true);
    expect(isLikelyBot("Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)")).toBe(true);
    expect(isLikelyBot("Mozilla/5.0 (compatible; YandexBot/3.0)")).toBe(true);
    expect(isLikelyBot("Mozilla/5.0 (compatible; AhrefsBot/7.0)")).toBe(true);
    expect(isLikelyBot("Mozilla/5.0 (compatible; SemrushBot/7~bl)")).toBe(true);
    expect(isLikelyBot("Mozilla/5.0 (compatible; YisouSpider/5.0)")).toBe(true);
    expect(isLikelyBot("Mozilla/5.0 (compatible; Yahoo! Slurp)")).toBe(true);
  });

  it("catches link previewers and uptime monitors", () => {
    expect(isLikelyBot("facebookexternalhit/1.1")).toBe(true);
    expect(isLikelyBot("Slackbot-LinkExpanding 1.0")).toBe(true);
    expect(isLikelyBot("TelegramBot (like TwitterBot)")).toBe(true);
    expect(isLikelyBot("WhatsApp/2.23")).toBe(true);
    expect(isLikelyBot("UptimeRobot/2.0")).toBe(true);
    expect(isLikelyBot("Pingdom.com_bot_version_1.4")).toBe(true);
  });

  /**
   * The inversion this module exists to prevent. An agent reading a manifest before it
   * pays is the buyer class x402 targets — robots.txt says so in its own words — and
   * `curl` is how it reads. Excluding these would drop the numerator while leaving their
   * purchase in the denominator.
   */
  it("does NOT treat a scripted fetch as an indexer — on this site it is probably a buyer", () => {
    expect(isLikelyBot("curl/8.4.0")).toBe(false);
    expect(isLikelyBot("Wget/1.21.4")).toBe(false);
    expect(isLikelyBot("python-requests/2.32.3")).toBe(false);
    expect(isLikelyBot("Go-http-client/2.0")).toBe(false);
    expect(isLikelyBot("node-fetch/3.3.2")).toBe(false);
    expect(isLikelyBot("HeadlessChrome/140.0.0.0")).toBe(false);
    expect(isLikelyBot("Mozilla/5.0 (compatible) Claude-User/1.0")).toBe(false);
  });

  it("does not treat a missing user-agent as an indexer — a script here is likely an agent", () => {
    expect(isLikelyBot(null)).toBe(false);
    expect(isLikelyBot(undefined)).toBe(false);
    expect(isLikelyBot("   ")).toBe(false);
  });

  /** `bot` as a bare substring flags a real phone. The four-letter prefix rule refuses it. */
  it("does not flag devices whose name merely contains the letters bot", () => {
    expect(isLikelyBot("Mozilla/5.0 (Linux; Android 13; CUBOT NOTE 20) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36")).toBe(false);
    expect(isLikelyBot("Mozilla/5.0 (Linux; Android 11; cubot_x30)")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isLikelyBot("GOOGLEBOT/2.1")).toBe(true);
    expect(isLikelyBot("CURL/8.4.0")).toBe(false);
  });

  it("catches a bare bot or crawler token however it is punctuated", () => {
    expect(isLikelyBot("SomeService (+http://example.com/bot)")).toBe(true);
    expect(isLikelyBot("my-crawler/1.0")).toBe(true);
    expect(isLikelyBot("Generic Spider 2.0")).toBe(true);
  });
});
