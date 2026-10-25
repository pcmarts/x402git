/**
 * lib/abuse-webhook.test.ts — FR-41.
 *
 * The URL is creator-supplied, so most of this is the SSRF test: `https` only, every
 * resolved address public unicast, no redirects, and the resolution done at delivery
 * rather than trusted from registration (docs/research/Gumroad Ideas.md).
 */

import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { seedListing } from "@/lib/test/fixtures";
import { makeMockDb } from "@/lib/test/mock-db";
import {
  ABUSE_WEBHOOK_EVENT_HEADER,
  ABUSE_WEBHOOK_SIGNATURE_HEADER,
  abuseWebhookSignature,
  checkWebhookUrl,
  isPublicUnicastAddress,
  sendAbuseWebhook,
} from "./abuse-webhook";

const SECRET = "whsec_test";

let mock: ReturnType<typeof makeMockDb>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  resetEnv();
});

afterEach(() => {
  resetDb();
  resetEnv();
});

function seed(url: string | null) {
  const seeded = seedListing(mock);
  mock.rows("creator").find((c) => c.id === seeded.creatorId)!.abuse_contact_url = url;
  return seeded;
}

describe("isPublicUnicastAddress", () => {
  it("refuses every reserved range, including the metadata service and its v6 disguises", () => {
    for (const address of ["127.0.0.1", "0.0.0.0", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "224.0.0.1", "::1", "::", "fd00::1", "fe80::1", "::ffff:169.254.169.254"]) {
      expect([address, isPublicUnicastAddress(address)]).toEqual([address, false]);
    }
  });

  it("allows a public address", () => {
    for (const address of ["93.184.216.34", "8.8.8.8", "2606:2800:220:1:248:1893:25c8:1946"]) {
      expect([address, isPublicUnicastAddress(address)]).toEqual([address, true]);
    }
  });
});

describe("checkWebhookUrl", () => {
  const resolve = (addresses: string[]) => async () => addresses;

  it("refuses http, refuses a name that resolves anywhere reserved, and allows one that does not", async () => {
    expect(await checkWebhookUrl("http://example.com/hook", resolve(["93.184.216.34"]))).toEqual({ ok: false, reason: "not_https" });
    expect(await checkWebhookUrl("https://example.com/hook", resolve(["93.184.216.34", "10.0.0.1"]))).toEqual({ ok: false, reason: "not_public" });
    expect(await checkWebhookUrl("https://example.com/hook", resolve(["93.184.216.34"]))).toEqual({ ok: true });
  });

  it("puts a literal IP through the same test, brackets and all", async () => {
    const never = async () => {
      throw new Error("dns must not be asked about a literal");
    };
    expect(await checkWebhookUrl("https://169.254.169.254/latest/meta-data", never)).toEqual({ ok: false, reason: "not_public" });
    expect(await checkWebhookUrl("https://[::1]/hook", never)).toEqual({ ok: false, reason: "not_public" });
  });
});

describe("sendAbuseWebhook", () => {
  const deps = (fetchImpl: ReturnType<typeof vi.fn>) => ({
    fetch: fetchImpl as unknown as typeof fetch,
    resolve: async () => ["93.184.216.34"],
    secret: SECRET,
    now: () => Date.parse("2026-09-13T04:00:00.000Z"),
  });

  it("signs FR-41's body and refuses to follow a redirect", async () => {
    const seeded = seed("https://creator.example.com/hook");
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));

    const result = await sendAbuseWebhook({ event: "release.compromised", listingId: seeded.listingId, version: "1.0.0", code: "dependency_malware" }, deps(fetchImpl));

    expect(result).toMatchObject({ delivered: true, status: 204 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://creator.example.com/hook");
    expect(init.redirect).toBe("manual");
    const headers = init.headers as Record<string, string>;
    expect(headers[ABUSE_WEBHOOK_EVENT_HEADER]).toBe("release.compromised");
    expect(headers[ABUSE_WEBHOOK_SIGNATURE_HEADER]).toBe(`sha256=${createHmac("sha256", SECRET).update(String(init.body), "utf8").digest("hex")}`);
    expect(JSON.parse(String(init.body))).toEqual({
      event: "release.compromised",
      listing_id: seeded.listingId,
      version: "1.0.0",
      code: "dependency_malware",
      docs_url: expect.stringContaining("/abuse"),
      timestamp: "2026-09-13T04:00:00.000Z",
    });
  });

  it("sends nothing at all when the creator registered no contact, or the secret is unset", async () => {
    const seeded = seed(null);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    expect(await sendAbuseWebhook({ event: "release.compromised", listingId: seeded.listingId, code: "x" }, deps(fetchImpl))).toMatchObject({ reason: "no_contact" });

    const withUrl = seed("https://creator.example.com/hook");
    expect(await sendAbuseWebhook({ event: "release.compromised", listingId: withUrl.listingId, code: "x" }, { ...deps(fetchImpl), secret: undefined })).toMatchObject({
      reason: "unconfigured",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never throws when the endpoint does", async () => {
    const seeded = seed("https://creator.example.com/hook");
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await sendAbuseWebhook({ event: "release.compromised", listingId: seeded.listingId, code: "x" }, deps(fetchImpl));
    expect(result.delivered).toBe(false);
    expect(result.reason).toContain("ECONNREFUSED");
  });
});

describe("abuseWebhookSignature", () => {
  it("is a hex HMAC-SHA256 over the exact body bytes", () => {
    expect(abuseWebhookSignature('{"a":1}', SECRET)).toBe(`sha256=${createHmac("sha256", SECRET).update('{"a":1}', "utf8").digest("hex")}`);
  });
});
