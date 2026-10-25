/**
 * lib/abuse-webhook.ts — FR-41, the creator's abuse webhook.
 *
 * FR-2 lets a creator register an abuse contact URL; FR-41 says what we may send to it and
 * how: **`https` only, resolving to a public unicast IP at call time, no redirects, a 5s
 * timeout**, and an HMAC-signed body `{ event, listing_id, version, code, docs_url,
 * timestamp }`. The four events are `release.failed`, `release.compromised` (added
 * 13 Sep 2026 — "PRD Trust Report.md" §7), `listing.takedown` and `payout.sent`.
 *
 * **Only `release.compromised` is wired today.** This module is the shared signing and
 * delivery path and the union names all four, but the other three still have no caller;
 * `send` is called from the §7 rescan cron and nowhere else. Wiring the rest is a matter
 * of calling `sendAbuseWebhook` from `lib/release` and `lib/admin/controls.ts` — the
 * transport below does not care which event it carries.
 *
 * **The URL is a creator-supplied string, so it is treated as hostile.** Gumroad's
 * `valid_post_url?` (docs/research/Gumroad Ideas.md) resolves the hostname and rejects the
 * reserved ranges at create time *and again at delivery*, because DNS can change between
 * the two; that is the rule copied here. `https:` is checked, the hostname is resolved
 * through `dns.lookup` with `all: true` and **every** answer must be a public unicast
 * address, and the request is made with `redirect: "manual"` so a 302 to `169.254.169.254`
 * cannot be followed. A literal IP in the URL goes through exactly the same test.
 *
 * There is a residual DNS-rebinding window between the check and the connect that only a
 * pinned-IP dialer closes; it is named here rather than papered over, and the payload
 * carries nothing secret, so the cost of losing that race is an outbound POST to an
 * internal address with a body the operator already knows.
 *
 * **Nothing here throws.** A creator's webhook endpoint being down, slow, hostile or
 * misconfigured must never fail the cron that raised the event; every path returns a
 * `AbuseWebhookResult` the caller puts in a summary.
 */

import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { db } from "@/lib/db";
import type { CreatorRow, ListingRow } from "@/lib/db/types";
import { appUrl } from "@/lib/env";

/** FR-41's four events. `release.compromised` was added 13 Sep 2026 (§7). */
export type AbuseWebhookEvent = "release.failed" | "release.compromised" | "listing.takedown" | "payout.sent";

/** FR-41's body, exactly. No finding text, no package list, nothing a signature protects. */
export type AbuseWebhookPayload = {
  event: AbuseWebhookEvent;
  listing_id: string;
  version: string | null;
  code: string;
  docs_url: string;
  timestamp: string;
};

export type AbuseWebhookResult = {
  delivered: boolean;
  /** Why not, when `delivered` is false: `no_contact`, `unconfigured`, `not_https`… */
  reason?: string;
  status?: number;
  url?: string;
};

/** FR-41: 5 seconds, whatever the endpoint is doing. */
export const ABUSE_WEBHOOK_TIMEOUT_MS = 5_000;

/** The header the signature travels in. `sha256=<hex>`, the shape GitHub taught everyone. */
export const ABUSE_WEBHOOK_SIGNATURE_HEADER = "x402git-signature";

/** The header naming the event, so a receiver can route without parsing the body. */
export const ABUSE_WEBHOOK_EVENT_HEADER = "x402git-event";

export type AbuseWebhookDeps = {
  fetch?: typeof fetch;
  /** Seam for the SSRF test. Returns the addresses the hostname resolves to, right now. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** The HMAC key. Defaults to `ABUSE_WEBHOOK_SECRET`; absent means nothing is sent. */
  secret?: string;
  now?: () => number;
};

/**
 * FR-39 is the process a recipient of any of these events actually needs to read — what we
 * do about a claim, and how long we take. When there is a per-event webhook reference page
 * this becomes a fragment on it; until then a live page beats a plausible dead link.
 */
export function abuseWebhookDocsUrl(): string {
  return `${appUrl()}/abuse`;
}

/** Hex HMAC-SHA256 over the exact bytes that are POSTed. */
export function abuseWebhookSignature(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

/**
 * The reserved ranges, as a predicate over one resolved address.
 *
 * Everything that is not globally routable unicast is refused: loopback, link-local (which
 * is where the cloud metadata service lives), the three private v4 blocks, CGNAT, the
 * v4 multicast/reserved tail, `::`, `::1`, unique-local v6, v6 link-local, and the
 * v4-mapped forms of all of the above. A hostname that resolves to *any* of these is
 * refused outright rather than filtered down to its public answers — a name that answers
 * with both is a name doing something we have no reason to accommodate.
 */
export function isPublicUnicastAddress(address: string): boolean {
  const value = address.trim().toLowerCase();
  const family = isIP(value);
  if (family === 4) return isPublicV4(value);
  if (family !== 6) return false;

  // `::ffff:10.0.0.1` is a v4 address wearing a v6 hat; test it as what it is.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped) return isPublicV4(mapped[1]);
  if (value === "::" || value === "::1") return false;
  // fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast.
  if (/^f[cd]/.test(value)) return false;
  if (/^fe[89ab]/.test(value)) return false;
  if (/^ff/.test(value)) return false;
  return true;
}

function isPublicV4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false; // link-local, and the metadata service
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (parts[2] === 0 || parts[2] === 2)) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a >= 224) return false; // multicast and the reserved tail
  return true;
}

/**
 * FR-41's URL test, run at call time and not merely at registration: `https`, a hostname
 * that resolves, and every answer a public unicast address.
 */
export async function checkWebhookUrl(url: string, resolveHost: (hostname: string) => Promise<string[]>): Promise<{ ok: true } | { ok: false; reason: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "bad_url" };
  }
  if (parsed.protocol !== "https:") return { ok: false, reason: "not_https" };

  // `new URL("https://[::1]/")` keeps the brackets; the resolver and `isIP` want them off.
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await resolveHost(host);
    } catch {
      return { ok: false, reason: "dns_failed" };
    }
  }
  if (addresses.length === 0) return { ok: false, reason: "dns_failed" };
  if (!addresses.every(isPublicUnicastAddress)) return { ok: false, reason: "not_public" };
  return { ok: true };
}

const defaultResolve = async (hostname: string): Promise<string[]> => (await lookup(hostname, { all: true })).map((a) => a.address);

/**
 * Sign and POST one event to the listing's creator abuse contact.
 *
 * The URL is read from `creator.abuse_contact_url` — the **effective** one, never
 * `pending_abuse_contact_url`, which is the 48-hour-delayed value (FR-5, migration 0300)
 * and is not yet a place this platform has agreed to send anything.
 */
export async function sendAbuseWebhook(
  input: { event: AbuseWebhookEvent; listingId: string; version?: string | null; code: string },
  deps: AbuseWebhookDeps = {},
): Promise<AbuseWebhookResult> {
  const secret = deps.secret ?? process.env.ABUSE_WEBHOOK_SECRET;
  if (!secret) return { delivered: false, reason: "unconfigured" };

  let url: string | null;
  try {
    url = await abuseContactFor(input.listingId);
  } catch (e) {
    return { delivered: false, reason: `lookup_failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!url) return { delivered: false, reason: "no_contact" };

  const check = await checkWebhookUrl(url, deps.resolve ?? defaultResolve);
  if (!check.ok) return { delivered: false, reason: check.reason, url };

  const payload: AbuseWebhookPayload = {
    event: input.event,
    listing_id: input.listingId,
    version: input.version ?? null,
    code: input.code,
    docs_url: abuseWebhookDocsUrl(),
    timestamp: new Date((deps.now ?? Date.now)()).toISOString(),
  };
  // Signed over the serialised bytes, and those exact bytes are the body — a receiver that
  // re-serialises before verifying would get a different string and it would be their bug.
  const body = JSON.stringify(payload);

  try {
    const response = await (deps.fetch ?? fetch)(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [ABUSE_WEBHOOK_EVENT_HEADER]: input.event,
        [ABUSE_WEBHOOK_SIGNATURE_HEADER]: abuseWebhookSignature(body, secret),
      },
      body,
      // FR-41: a 3xx is not followed. The check above proved where *this* URL points.
      redirect: "manual",
      signal: AbortSignal.timeout(ABUSE_WEBHOOK_TIMEOUT_MS),
    });
    if (response.status >= 300) return { delivered: false, reason: `http_${response.status}`, status: response.status, url };
    return { delivered: true, status: response.status, url };
  } catch (e) {
    return { delivered: false, reason: `transport: ${e instanceof Error ? e.message : String(e)}`, url };
  }
}

/** The creator's effective abuse contact URL for a listing, or null if they set none. */
async function abuseContactFor(listingId: string): Promise<string | null> {
  const { data: listingData, error } = await db().from("listing").select("creator_id").eq("id", listingId).maybeSingle();
  if (error) throw error;
  const listing = listingData as Pick<ListingRow, "creator_id"> | null;
  if (!listing) return null;

  const { data: creatorData, error: creatorError } = await db().from("creator").select("abuse_contact_url").eq("id", listing.creator_id).maybeSingle();
  if (creatorError) throw creatorError;
  const creator = creatorData as Pick<CreatorRow, "abuse_contact_url"> | null;
  return creator?.abuse_contact_url ?? null;
}
