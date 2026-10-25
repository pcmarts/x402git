/**
 * lib/web/safe-redirect.ts — the one validator every return-to path passes through.
 *
 * An OAuth next, a reissue next, and the decoded OAuth state return path all feed a
 * server-issued redirect. The naive startsWith(sol) && !startsWith(sol sol) guard is
 * defeated by a backslash: new URL(sol bs evil.com, base) resolves to https://evil.com/,
 * because browsers and the WHATWG URL parser treat a backslash as a forward slash.
 *
 * safeReturnPath rejects anything that is not a same-origin path and returns a
 * fallback instead, so a captured or crafted next can only ever bounce the reader
 * back inside this site.
 */

import { appUrl } from "@/lib/env";

export function safeReturnPath(raw: unknown, fallback = "/dashboard"): string {
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  // Control chars (0x00-0x1f) and backslash ONLY. Do NOT use a range like /[ -\\]/,
  // which spans 0x20-0x5c and would reject "/", "?", ".", digits, and every legal path
  // (contradicting this item own acceptance case /dashboard/x?y=1#z).
  if (/[\u0000-\u001f\\]/.test(raw)) return fallback;
  try {
    const base = appUrl();
    const u = new URL(raw, base);
    if (u.origin !== new URL(base).origin) return fallback; // the load-bearing backstop
    return u.pathname + u.search + u.hash;
  } catch {
    return fallback;
  }
}
