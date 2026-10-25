/**
 * lib/screening.ts — FR-38 sanctions screening. Unconditional, and not an identity gate.
 *
 * Every payout address is screened when it is bound and before every sweep; every payer
 * is screened before `settle`. Results are written to `screening` and retained 5 years.
 *
 *   const { hit } = await screen(address, "bind");
 *   if (hit) throw new ApiError("sanctioned_counterparty");
 *
 * The list is the public OFAC SDN digital-currency address set, cached in memory for
 * 24 hours. **Fail-open**: if the fetch fails we record `hit: false` with the error in
 * `raw` rather than blocking every payment on a GitHub raw outage. That is a deliberate
 * trade — an outage that stops all commerce is a worse failure than a few hours of
 * degraded screening, and the row makes the gap auditable after the fact.
 */

import { db } from "@/lib/db";

export type ScreeningContext = "bind" | "sweep" | "settle";

export type ScreeningResult = {
  hit: boolean;
  provider: string;
  /** True when the list could not be fetched and the check was skipped. */
  degraded: boolean;
  listSize: number;
};

export const OFAC_ETH_LIST_URL =
  "https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.json";

export const PROVIDER = "ofac-sdn-eth";
const CACHE_TTL_MS = 24 * 3600 * 1000;

type Cache = { addresses: Set<string>; fetchedAt: number; error?: string };
let cache: Cache | null = null;

/** Tests, and anything that needs a fresh list. */
export function resetScreeningCache(): void {
  cache = null;
}

/** The sanctioned set, lowercased. Cached 24h, including a failed fetch (see below). */
export async function sanctionedAddresses(now = Date.now()): Promise<Cache> {
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache;
  try {
    const res = await fetch(OFAC_ETH_LIST_URL, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`list fetch returned ${res.status}`);
    const list = (await res.json()) as unknown;
    if (!Array.isArray(list)) throw new Error("list is not an array");
    cache = { addresses: new Set(list.map((a) => String(a).toLowerCase())), fetchedAt: now };
  } catch (e) {
    // Cache the failure for a minute only, so a transient outage self-heals quickly.
    cache = { addresses: new Set(), fetchedAt: now - (CACHE_TTL_MS - 60_000), error: e instanceof Error ? e.message : String(e) };
  }
  return cache;
}

/**
 * Screen one address and record the result. Always writes a `screening` row — the
 * audit trail is the requirement, not the boolean.
 */
export async function screen(address: string, context: ScreeningContext): Promise<ScreeningResult> {
  const lower = address.toLowerCase();
  const list = await sanctionedAddresses();
  const degraded = list.error !== undefined;
  const hit = !degraded && list.addresses.has(lower);

  const raw: Record<string, unknown> = { list_url: OFAC_ETH_LIST_URL, list_size: list.addresses.size, checked_at: new Date().toISOString() };
  if (list.error) raw.error = list.error;

  try {
    const { error } = await db().from("screening").insert({ address: lower, context, hit, provider: PROVIDER, raw });
    if (error) throw error;
  } catch (e) {
    // The row is the audit trail; losing it must not silently pass a sanctioned address.
    console.error("[screening] could not record result:", e instanceof Error ? e.message : String(e));
    if (hit) throw e;
  }

  return { hit, provider: PROVIDER, degraded, listSize: list.addresses.size };
}
