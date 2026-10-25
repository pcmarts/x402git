/**
 * lib/analysis/cadence.ts — the Release Cadence Score and its sentence (FR-49, QS §4).
 *
 * Recency answers "did they ship?". A subscriber needs "will they keep shipping?",
 * which is a variance question. OpenSSF Scorecard's `Maintained` check is the closest
 * prior art and its weakness is instructive: "one commit per week" measures activity,
 * so a creator who ships twenty commits in a day each quarter passes it.
 *
 *   gaps    = days between consecutive releases (last <= 60)
 *   med     = median(gaps)
 *   eff     = max(med, 7)               # floor: do not punish burst publishers
 *   on_time = |{g : g <= 2 * med}| / |gaps|
 *   grace   = eff + 14
 *   overdue = clamp((days_since_last - grace) / (2 * eff), 0, 1)
 *   RCS     = round(100 * on_time * (1 - overdue))
 *
 * §4.1 is the other half: "no recent release" must not be a pure negative. Coelho &
 * Valente found 11% of maintainers considered their project *completed*, and npms.io
 * floors every maintenance sub-score at 0.9 for a stable, documented, tested package
 * with a small issue backlog. We apply the same floor and publish the exemption
 * rather than hiding it — a buyer who can see the rule can argue with it.
 *
 * We publish the sentence, not the integer (§4).
 */

export type CadenceInput = {
  /** Release or tag timestamps, any order. ISO-8601. */
  publishedAt: string[];
  /** Now, injectable so the test is not a clock test. */
  now?: Date;
  /** §4.1 inputs for the "finished, not abandoned" exemption. */
  finished?: {
    /** Newest version is >= 1.0.0. */
    stable: boolean;
    hasReadme: boolean;
    hasTests: boolean;
    openIssues: number;
    archived?: boolean;
  };
};

export type Cadence = {
  releases: number;
  median_days_between_releases: number | null;
  on_time_fraction: number | null;
  days_since_last: number | null;
  score: number | null;
  /** §4.1: the exemption fired. */
  finished: boolean;
  /** FR-49. Absent when there are too few releases to say anything honest. */
  sentence?: string;
};

/** §4.1, npms.io `isPackageFinished`, transposed. */
const MAX_OPEN_ISSUES_FOR_FINISHED = 15;
const FINISHED_FLOOR = 90;

export function cadence(input: CadenceInput): Cadence {
  const now = input.now ?? new Date();
  const times = input.publishedAt
    .map((t) => new Date(t).getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);

  if (times.length === 0) {
    return { releases: 0, median_days_between_releases: null, on_time_fraction: null, days_since_last: null, score: null, finished: false };
  }

  const daysSinceLast = daysBetween(times[times.length - 1], now.getTime());

  if (times.length < 3) {
    // One or two releases is not a cadence. Say what is true instead of inventing one.
    return {
      releases: times.length,
      median_days_between_releases: null,
      on_time_fraction: null,
      days_since_last: round1(daysSinceLast),
      score: null,
      finished: false,
      sentence: times.length === 1 ? "One release so far." : `${times.length} releases so far — too few to call a cadence.`,
    };
  }

  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push(daysBetween(times[i - 1], times[i]));

  const med = median(gaps);
  const eff = Math.max(med, 7);
  const onTime = gaps.filter((g) => g <= 2 * med).length / gaps.length;
  const grace = eff + 14;
  const overdue = clamp((daysSinceLast - grace) / (2 * eff), 0, 1);

  let score = Math.round(100 * onTime * (1 - overdue));

  const finished =
    !!input.finished &&
    input.finished.stable &&
    !input.finished.archived &&
    input.finished.hasReadme &&
    input.finished.hasTests &&
    input.finished.openIssues < MAX_OPEN_ISSUES_FOR_FINISHED;

  if (finished && score < FINISHED_FLOOR) score = FINISHED_FLOOR;

  return {
    releases: times.length,
    median_days_between_releases: round1(med),
    on_time_fraction: round2(onTime),
    days_since_last: round1(daysSinceLast),
    score,
    finished,
    sentence: sentenceFor(med, onTime, daysSinceLast, finished),
  };
}

/** §4: "Ships every ~7 days, hits that 93% of the time." */
function sentenceFor(med: number, onTime: number, daysSinceLast: number, finished: boolean): string {
  const every = med < 1.5 ? "day" : `~${Math.round(med)} days`;
  const base = `Ships every ${every}, hits that ${Math.round(onTime * 100)}% of the time. Last release ${describeAge(daysSinceLast)}.`;
  return finished ? `${base} Stable, documented and tested — treated as finished rather than abandoned.` : base;
}

function describeAge(days: number): string {
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 45) return `${Math.round(days)} days ago`;
  const months = Math.round(days / 30);
  return months < 24 ? `${months} months ago` : `${Math.round(days / 365)} years ago`;
}

function daysBetween(a: number, b: number): number {
  return (b - a) / 86_400_000;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
