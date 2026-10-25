/**
 * lib/admin/window.ts — the time window the money and activity pages are read through.
 *
 * One vocabulary, shared, because "how much did we make" and "what broke" are asked
 * about the same span of time and an operator should not have to learn two controls.
 *
 * `all` exists and is the default on the money page for a reason: at this stage the
 * lifetime numbers *are* the interesting ones (PRODUCT.md's 60-day target is 50
 * purchases), and a dashboard that defaults to the last 24 hours of a product making a
 * sale a week shows an operator a row of zeros and teaches them the page is broken.
 */

export const WINDOWS = ["24h", "7d", "30d", "all"] as const;
export type AdminWindow = (typeof WINDOWS)[number];

export const WINDOW_LABEL: Record<AdminWindow, string> = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
  all: "All time",
};

const HOUR = 60 * 60 * 1000;
const MS: Record<AdminWindow, number | null> = { "24h": 24 * HOUR, "7d": 7 * 24 * HOUR, "30d": 30 * 24 * HOUR, all: null };

/** `?window=` off the URL, narrowed. Anything unrecognised is the caller's default. */
export function adminWindow(value: string | undefined, fallback: AdminWindow = "all"): AdminWindow {
  return (WINDOWS as readonly string[]).includes(value ?? "") ? (value as AdminWindow) : fallback;
}

/** The epoch milliseconds at which this window opens, or null for "all time". */
export function windowStart(window: AdminWindow, now = Date.now()): number | null {
  const ms = MS[window];
  return ms === null ? null : now - ms;
}

/**
 * Is this timestamp inside the window? An absent or unparseable one never is — including
 * under `all`, where the bound is "has a real timestamp" rather than "no bound at all".
 * A row the database gave us a garbage date for is a row we cannot place in time, and
 * placing it in every window would make `all` disagree with the sum of its parts.
 */
export function inWindow(iso: string | null | undefined, window: AdminWindow, now = Date.now()): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  const start = windowStart(window, now);
  return start === null || t >= start;
}
