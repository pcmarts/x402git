/**
 * lib/x402/jurisdiction.ts — FR-38's third clause, the one that is not about addresses.
 *
 * "`x-vercel-ip-country` in comprehensively sanctioned jurisdictions → `451` on paid and
 * creator routes."
 *
 * Comprehensive (as opposed to list-based) US sanctions programmes cover Cuba, Iran,
 * North Korea and Syria in whole, and the Crimea, Donetsk and Luhansk regions of
 * Ukraine. Vercel supplies the country on every request and the region alongside it, so
 * the region check is the same one line.
 *
 * Absent header → no block. Locally and in CI there is no geo-IP, and a gate that
 * defaults to closed would make `next dev` untestable while adding nothing: the header
 * is set by the platform edge, never by the client.
 */

import { ApiError } from "@/lib/errors";

export const COUNTRY_HEADER = "x-vercel-ip-country";
export const REGION_HEADER = "x-vercel-ip-country-region";

/** ISO-3166-1 alpha-2, comprehensively sanctioned. */
export const BLOCKED_COUNTRIES = new Set(["CU", "IR", "KP", "SY"]);

/** ISO-3166-2 subdivisions of Ukraine under comprehensive sanctions. */
export const BLOCKED_UA_REGIONS = new Set(["43", "14", "09"]);

export function blockedJurisdiction(country: string | null, region: string | null): boolean {
  const c = (country ?? "").trim().toUpperCase();
  if (!c) return false;
  if (BLOCKED_COUNTRIES.has(c)) return true;
  const r = (region ?? "").trim().toUpperCase().replace(/^UA-/, "");
  return c === "UA" && BLOCKED_UA_REGIONS.has(r);
}

/** What the platform edge said about where this request came from. */
export type Jurisdiction = { country: string | null; region: string | null };

/** Lift the two geo headers off a request so they can be carried past the HTTP layer. */
export function jurisdictionOf(req: Request): Jurisdiction {
  return { country: req.headers.get(COUNTRY_HEADER), region: req.headers.get(REGION_HEADER) };
}

/** Throws `451 blocked_jurisdiction`. Call it first on anything that moves money. */
export function requirePermittedJurisdiction(where: Request | Jurisdiction | null | undefined): void {
  if (!where) return;
  const { country, region } = "headers" in where ? jurisdictionOf(where) : where;
  if (blockedJurisdiction(country, region)) throw new ApiError("blocked_jurisdiction");
}
