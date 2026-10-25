/**
 * lib/notify/index.test.ts — what an operator's phone actually shows, character for
 * character, plus the two guarantees the call sites depend on: a flood of the same error
 * posts once, and nothing in here can throw into a paid request.
 *
 * The formatter tests double as the privacy test: the strings below are the whole message,
 * so a field that should never travel (a buyer address, a key) would be visible here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnv } from "@/lib/env";
import { type AdminEvent, ERROR_HOURLY_CAP, formatAdminEvent, notifyAdmin, resetNotifyThrottle } from "./index";

const APP = "https://x402git.test";

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = APP;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_ADMIN_CHAT_ID;
  resetEnv();
  resetNotifyThrottle();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env.NEXT_PUBLIC_APP_URL;
  resetEnv();
  resetNotifyThrottle();
});

describe("formatAdminEvent", () => {
  it("names a new creator and links to their admin page, with the handle escaped", () => {
    const text = formatAdminEvent({ kind: "creator_joined", handle: "<b>x</b>", creatorId: "c1", via: "web", walletMode: "self_custody" });

    expect(text).toBe(["👤 <b>New creator @&lt;b&gt;x&lt;/b&gt;</b>", "via: web", "wallet: self_custody", `${APP}/admin/creators/%3Cb%3Ex%3C%2Fb%3E`].join("\n"));
  });

  it("prices a new listing in USDC from micro-USDC, never a float", () => {
    const text = formatAdminEvent({ kind: "listing_created", listingId: "l1", handle: "acme", slug: "widgets", rail: "hosted", priceMicro: 1_500_000n, visibility: "public" });

    expect(text).toBe(["📦 <b>New listing acme/widgets</b>", "price: $1.50 USDC", "rail: hosted", "visibility: public", `${APP}/admin/listings/l1`].join("\n"));
  });

  it("names the chain and shortens the transaction hash on a settlement", () => {
    const base: Extract<AdminEvent, { kind: "payment_settled" }> = {
      kind: "payment_settled",
      listingId: "l1",
      handle: "acme",
      slug: "widgets",
      version: "1.2.0",
      grossMicro: 9_000_000n,
      purchaseKind: "initial",
      source: "agent",
      chainId: 84532,
      txHash: "0x1234567890abcdefabcd",
    };

    expect(formatAdminEvent(base)).toBe(
      [
        "💸 <b>$9.00 USDC — acme/widgets</b>",
        "version: 1.2.0",
        "kind: initial",
        "source: agent",
        "chain: Base Sepolia",
        'tx: <a href="https://sepolia.basescan.org/tx/0x1234567890abcdefabcd">0x1234…abcd</a>',
        `${APP}/admin/listings/l1`,
      ].join("\n"),
    );

    // Mainnet gets the mainnet explorer; an unknown chain gets a CAIP-2 name rather than
    // a bare number, and no link we would be guessing at.
    expect(formatAdminEvent({ ...base, chainId: 8453 })).toContain('<a href="https://basescan.org/tx/0x1234567890abcdefabcd">0x1234…abcd</a>');
    expect(formatAdminEvent({ ...base, chainId: 1 })).toContain("chain: eip155:1");
    expect(formatAdminEvent({ ...base, chainId: 1 })).toContain("tx: 0x1234…abcd\n");
    // A settlement with no hash yet still reports, without an empty tx line.
    expect(formatAdminEvent({ ...base, txHash: null, source: null })).toContain("source: unknown");
    expect(formatAdminEvent({ ...base, txHash: null })).not.toContain("tx:");
  });

  it("shouts an error and murmurs an alert, escaping whatever was thrown", () => {
    const text = formatAdminEvent({ kind: "error", where: "POST /api/r", code: "settlement_timeout", message: "facilitator said <no>", listingId: "l1", details: { attempt: 2 } });

    expect(text).toBe(
      ["🚨 <b>Error in POST /api/r</b>", "code: settlement_timeout", "message: facilitator said &lt;no&gt;", "listing: l1", "attempt: 2", `${APP}/admin/activity`].join("\n"),
    );

    const alert = formatAdminEvent({ kind: "error", where: "cron/rescan", message: "socket quota exhausted", severity: "alert" });
    expect(alert).toBe(["⚠️ <b>Alert in cron/rescan</b>", "message: socket quota exhausted", `${APP}/admin/activity`].join("\n"));
  });

  it("names who did what to which subject on an operator action", () => {
    const text = formatAdminEvent({ kind: "admin_action", action: "switch_paused", by: "pcmarts", via: "admin", subject: "payments", reason: "facilitator 5xx" });

    expect(text).toBe(["🔒 <b>Switch paused by pcmarts</b>", "subject: payments", "via: admin", "reason: facilitator 5xx", `${APP}/admin/audit`].join("\n"));
  });

  it("has a phrase for every action an operator can take, and falls back to the raw name", () => {
    const label = (action: string) =>
      formatAdminEvent({ kind: "admin_action", action, by: "pcmarts", via: "admin", subject: "s" }).split("\n")[0];

    expect(label("switch_paused")).toBe("🔒 <b>Switch paused by pcmarts</b>");
    expect(label("switch_resumed")).toBe("🔒 <b>Switch resumed by pcmarts</b>");
    expect(label("takedown_retired")).toBe("🔒 <b>Listing retired (takedown) by pcmarts</b>");
    expect(label("takedown_revoked")).toBe("🔒 <b>Purchases revoked (takedown) by pcmarts</b>");
    expect(label("admin_granted")).toBe("🔒 <b>Admin granted by pcmarts</b>");
    expect(label("admin_revoked")).toBe("🔒 <b>Admin revoked by pcmarts</b>");
    // A name added to lib/admin/audit.ts and not here still reads as itself.
    expect(label("something_new")).toBe("🔒 <b>something_new by pcmarts</b>");
  });

  it("links to the listing when the action had one, and to the audit trail otherwise", () => {
    const retired = formatAdminEvent({ kind: "admin_action", action: "takedown_retired", by: "paul", via: "script", subject: "acme/widgets", reason: "DMCA #12", listingId: "l1" });

    expect(retired).toBe(
      ["🔒 <b>Listing retired (takedown) by paul</b>", "subject: acme/widgets", "via: script", "reason: DMCA #12", `${APP}/admin/listings/l1`].join("\n"),
    );
    // No listing, no reason: three lines and the trail.
    expect(formatAdminEvent({ kind: "admin_action", action: "admin_granted", by: "pcmarts", via: "admin", subject: "second-operator" })).toBe(
      ["🔒 <b>Admin granted by pcmarts</b>", "subject: second-operator", "via: admin", `${APP}/admin/audit`].join("\n"),
    );
  });

  it("says when the audit row did not save — the message is then the only record", () => {
    const text = formatAdminEvent({
      kind: "admin_action",
      action: "switch_paused",
      by: "pcmarts",
      via: "admin",
      subject: "payments",
      auditError: "insert into <event> failed",
    });

    expect(text).toBe(
      ["🔒 <b>Switch paused by pcmarts</b>", "subject: payments", "via: admin", "⚠️ audit row did not save: insert into &lt;event&gt; failed", `${APP}/admin/audit`].join("\n"),
    );
  });

  it("escapes the login, the subject and the reason, all of which are typed by a person", () => {
    const text = formatAdminEvent({ kind: "admin_action", action: "takedown_retired", by: "<b>root</b>", via: "admin", subject: "acme/<i>x</i>", reason: "a & b" });

    expect(text).toContain("🔒 <b>Listing retired (takedown) by &lt;b&gt;root&lt;/b&gt;</b>");
    expect(text).toContain("subject: acme/&lt;i&gt;x&lt;/i&gt;");
    expect(text).toContain("reason: a &amp; b");
  });
});

describe("notifyAdmin", () => {
  const err = (message: string, code?: string): AdminEvent => ({ kind: "error", where: "POST /api/r", code, message });

  it("posts nothing on an unconfigured deployment, and says so rather than failing", async () => {
    expect(await notifyAdmin({ kind: "creator_joined", handle: "acme", creatorId: "c1", via: "api" })).toEqual({ delivered: false, reason: "unconfigured" });
  });

  it("posts the same error once per window, lets a different key through, and forgets after ten minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-09-13T04:00:00.000Z"));

    expect((await notifyAdmin(err("boom", "internal"))).reason).toBe("unconfigured");
    expect((await notifyAdmin(err("boom", "internal"))).reason).toBe("throttled");
    // A different code is a different fault; it is not what the throttle is for.
    expect((await notifyAdmin(err("boom", "replay"))).reason).toBe("unconfigured");
    // No code: the head of the message is the key.
    expect((await notifyAdmin(err("something else"))).reason).toBe("unconfigured");
    expect((await notifyAdmin(err("something else"))).reason).toBe("throttled");

    vi.setSystemTime(Date.parse("2026-09-13T04:09:00.000Z"));
    expect((await notifyAdmin(err("boom", "internal"))).reason).toBe("throttled");
    vi.setSystemTime(Date.parse("2026-09-13T04:10:01.000Z"));
    expect((await notifyAdmin(err("boom", "internal"))).reason).toBe("unconfigured");
  });

  it("caps errors per hour whatever their keys, and lets the next hour through", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-09-13T04:00:00.000Z"));

    for (let i = 0; i < ERROR_HOURLY_CAP; i++) expect((await notifyAdmin(err(`fault ${i}`))).reason).toBe("unconfigured");
    expect((await notifyAdmin(err("one too many"))).reason).toBe("throttled");

    vi.setSystemTime(Date.parse("2026-09-13T05:00:01.000Z"));
    expect((await notifyAdmin(err("one too many"))).reason).toBe("unconfigured");
  });

  it("never throttles a signup, a listing or a payment — those are the events worth having", async () => {
    for (let i = 0; i < 3; i++) {
      expect((await notifyAdmin({ kind: "creator_joined", handle: "acme", creatorId: "c1", via: "web" })).reason).toBe("unconfigured");
      expect((await notifyAdmin({ kind: "listing_created", listingId: "l1", handle: "acme", slug: "w", rail: "hosted", priceMicro: 1n })).reason).toBe("unconfigured");
    }
  });

  it("never throttles an operator action, even the identical one twice", async () => {
    const paused: AdminEvent = { kind: "admin_action", action: "switch_paused", by: "pcmarts", via: "admin", subject: "payments", reason: "facilitator 5xx" };

    // Two operators reaching for the same switch inside the error window is exactly the
    // pair you must see; `throttled` here would hide the second one.
    expect((await notifyAdmin(paused)).reason).toBe("unconfigured");
    expect((await notifyAdmin(paused)).reason).toBe("unconfigured");
  });

  it("swallows a formatter that throws — a courtesy must not fail a paid request", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // `priceMicro` as a number: `formatAmount` mixes it with a bigint and throws TypeError.
    const broken = { kind: "listing_created", listingId: "l1", handle: "acme", slug: "w", rail: "hosted", priceMicro: 9 } as unknown as AdminEvent;

    expect(await notifyAdmin(broken)).toEqual({ delivered: false, reason: "failed" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("[notify] could not send listing_created");
  });
});
