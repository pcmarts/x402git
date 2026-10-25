import { describe, expect, it } from "vitest";
import { cadence } from "./cadence";

const NOW = new Date("2026-08-29T12:00:00Z");

/** `count` releases ending `daysSinceLast` ago, `gap` days apart. */
function metronome(count: number, gap: number, daysSinceLast: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const daysAgo = daysSinceLast + (count - 1 - i) * gap;
    out.push(new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString());
  }
  return out;
}

describe("release cadence (Quality Signals §4)", () => {
  it("publishes the sentence, not the integer", () => {
    const result = cadence({ publishedAt: metronome(10, 7, 2), now: NOW });
    expect(result.sentence).toMatch(/^Ships every ~7 days, hits that 100% of the time\./);
    expect(result.median_days_between_releases).toBe(7);
    expect(result.score).toBe(100);
  });

  it("scores a metronomic repo high and an overdue one low", () => {
    const metronomic = cadence({ publishedAt: metronome(12, 6.5, 2), now: NOW });
    // sindresorhus/got in §4: historically regular, three cadences overdue.
    const overdue = cadence({ publishedAt: metronome(12, 19, 57), now: NOW });

    expect(metronomic.score).toBeGreaterThan(80);
    expect(overdue.score).toBeLessThan(40);
    expect(overdue.score).toBeGreaterThanOrEqual(0);
  });

  it("floors the effective gap at 7 days, so a twice-daily repo is not overdue after 48h", () => {
    const bursty = cadence({ publishedAt: metronome(20, 0.5, 2), now: NOW });
    expect(bursty.score).toBeGreaterThan(50);
  });

  it("penalises missed rhythm through the on-time fraction, not the variance (§4.2)", () => {
    const irregular = [
      ...metronome(4, 3, 40), // four quick releases
      new Date(NOW.getTime() - 30 * 86_400_000).toISOString(),
      new Date(NOW.getTime() - 2 * 86_400_000).toISOString(), // then a long gap
    ];
    const result = cadence({ publishedAt: irregular, now: NOW });
    expect(result.on_time_fraction).toBeLessThan(1);
  });

  it("does not punish finished software (§4.1)", () => {
    const quiet = metronome(8, 20, 400);
    const abandoned = cadence({ publishedAt: quiet, now: NOW });
    const finished = cadence({
      publishedAt: quiet,
      now: NOW,
      finished: { stable: true, hasReadme: true, hasTests: true, openIssues: 3 },
    });

    expect(abandoned.score).toBe(0);
    expect(finished.score).toBe(90);
    expect(finished.finished).toBe(true);
    expect(finished.sentence).toMatch(/finished rather than abandoned/);
  });

  it("withholds the exemption from an undocumented, untested or busy project", () => {
    const quiet = metronome(8, 20, 400);
    const base = { stable: true, hasReadme: true, hasTests: true, openIssues: 3 };
    expect(cadence({ publishedAt: quiet, now: NOW, finished: { ...base, hasTests: false } }).finished).toBe(false);
    expect(cadence({ publishedAt: quiet, now: NOW, finished: { ...base, openIssues: 40 } }).finished).toBe(false);
    expect(cadence({ publishedAt: quiet, now: NOW, finished: { ...base, stable: false } }).finished).toBe(false);
    expect(cadence({ publishedAt: quiet, now: NOW, finished: { ...base, archived: true } }).finished).toBe(false);
  });

  it("says what is true when there are too few releases to call a cadence", () => {
    expect(cadence({ publishedAt: [], now: NOW }).sentence).toBeUndefined();
    expect(cadence({ publishedAt: metronome(1, 7, 3), now: NOW }).sentence).toBe("One release so far.");
    expect(cadence({ publishedAt: metronome(2, 7, 3), now: NOW }).sentence).toMatch(/too few to call a cadence/);
    expect(cadence({ publishedAt: metronome(2, 7, 3), now: NOW }).score).toBeNull();
  });

  it("ignores unparseable timestamps rather than throwing", () => {
    const result = cadence({ publishedAt: ["not a date", ...metronome(4, 5, 1)], now: NOW });
    expect(result.releases).toBe(4);
  });
});
