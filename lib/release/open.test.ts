import { describe, expect, it } from "vitest";
import { stubPublicGithub } from "@/lib/test/public-github";
import { OPEN_RELEASE_MAX_DAYS, openEligibility, openStamp } from "./open";

const COMMIT = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const PUBLIC = "https://github.com/octo/widget";
const creator = { payout_address: "0x0000000000000000000000000000000000000001", stellar_payout_address: null };
const mit = { verdict: "pass" as const, spdx: "MIT" };

function ids(checks: { id: string; ok: boolean }[], ok: boolean) {
  return checks.filter((c) => c.ok === ok).map((c) => c.id);
}

describe("openEligibility — computed at cut, never declared (STRATEGY §6a, BUILD H6)", () => {
  it("passes every check for a licensed release, a public target repo, an unpublished commit and a bound payout", async () => {
    const github = stubPublicGithub({ repos: { "octo/widget": { private: false } }, commits: { "octo/widget": [] } });
    const checks = await openEligibility({ listing: { public_repo_url: PUBLIC }, creator, licence: mit, commitSha: COMMIT, github });

    expect(checks.map((c) => c.id)).toEqual(["licence", "public_repo", "not_yet_public", "payout_address"]);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks[2].detail).toContain(COMMIT.slice(0, 12));
    // Two GETs and no more: the repository, then the commit.
    expect(github.calls).toEqual(["repos/octo/widget", `repos/octo/widget/commits/${COMMIT}`]);
  });

  it("fails `licence` when the sold snapshot has no resale-compatible licence", async () => {
    const github = stubPublicGithub({ repos: { "octo/widget": { private: false } } });
    const blocked = await openEligibility({ listing: { public_repo_url: PUBLIC }, creator, licence: { verdict: "block", spdx: null }, commitSha: COMMIT, github });
    expect(ids(blocked, false)).toEqual(["licence"]);
    expect(blocked[0].detail).toMatch(/no licence file/i);

    const manual = await openEligibility({ listing: { public_repo_url: PUBLIC }, creator, licence: { verdict: "manual", spdx: "GPL-3.0" }, commitSha: COMMIT, github });
    expect(ids(manual, false)).toEqual(["licence"]);
    expect(manual[0].detail).toContain("GPL-3.0");
  });

  it("fails `public_repo` when the target is missing, private or unset", async () => {
    const missing = await openEligibility({ listing: { public_repo_url: PUBLIC }, creator, licence: mit, commitSha: COMMIT, github: stubPublicGithub() });
    expect(ids(missing, false)).toEqual(["public_repo", "not_yet_public"]);
    expect(missing[1].detail).toMatch(/does not exist, or is not public/);

    const priv = await openEligibility({
      listing: { public_repo_url: PUBLIC },
      creator,
      licence: mit,
      commitSha: COMMIT,
      github: stubPublicGithub({ repos: { "octo/widget": { private: true } } }),
    });
    expect(ids(priv, false)).toEqual(["public_repo", "not_yet_public"]);
    expect(priv[1].detail).toMatch(/is private/);

    const unset = await openEligibility({ listing: { public_repo_url: null }, creator, licence: mit, commitSha: COMMIT, github: stubPublicGithub() });
    expect(ids(unset, false)).toEqual(["public_repo", "not_yet_public"]);
  });

  it("fails `not_yet_public` when the sold commit is already in the public repo (H6: nothing early to sell)", async () => {
    const github = stubPublicGithub({ repos: { "octo/widget": { private: false } }, commits: { "octo/widget": [COMMIT] } });
    const checks = await openEligibility({ listing: { public_repo_url: PUBLIC }, creator, licence: mit, commitSha: COMMIT, github });
    expect(ids(checks, false)).toEqual(["not_yet_public"]);
    expect(checks[2].detail).toMatch(/already public/);
  });

  it("fails `payout_address` when the creator has no bound address on any rail", async () => {
    const github = stubPublicGithub({ repos: { "octo/widget": { private: false } } });
    const none = await openEligibility({ listing: { public_repo_url: PUBLIC }, creator: { payout_address: "", stellar_payout_address: null }, licence: mit, commitSha: COMMIT, github });
    expect(ids(none, false)).toEqual(["payout_address"]);

    const stellar = await openEligibility({
      listing: { public_repo_url: PUBLIC },
      creator: { payout_address: "", stellar_payout_address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF" },
      licence: mit,
      commitSha: COMMIT,
      github: stubPublicGithub({ repos: { "octo/widget": { private: false } } }),
    });
    expect(ids(stellar, false)).toEqual([]);
  });

  it("treats GitHub not answering as a failed check, not a skipped one", async () => {
    const github = stubPublicGithub({ fail: true });
    const checks = await openEligibility({ listing: { public_repo_url: PUBLIC }, creator, licence: mit, commitSha: COMMIT, github });
    expect(ids(checks, false)).toEqual(["public_repo", "not_yet_public"]);
    expect(checks[1].detail).toMatch(/could not be asked/);
  });
});

describe("openStamp — the columns written on the release", () => {
  const cut = "2026-10-25T15:30:00.000Z";
  const plusDays = (n: number) => new Date(new Date(cut).getTime() + n * 86_400_000).toISOString();
  const ok = [{ id: "licence", ok: true, detail: "" }];
  const bad = [{ id: "licence", ok: true, detail: "" }, { id: "not_yet_public", ok: false, detail: "already public" }];

  it("stamps a pending promise at the cut plus the listing's days, with the sold licence, when every check passed", () => {
    const stamp = openStamp({ listing: { open_after_days: 30 }, release: { created_at: cut, opens_at: null }, licenceSpdx: "MIT", checks: ok });
    expect(stamp).toEqual({
      opens_at: plusDays(30),
      open_licence_spdx: "MIT",
      promise_status: "pending",
      open_eligibility: ok,
      promise_checked_at: null,
    });
  });

  it("counts from this release's own cut, so every release restarts the clock", () => {
    const later = "2026-11-10T09:00:00.000Z";
    const stamp = openStamp({ listing: { open_after_days: 7 }, release: { created_at: later, opens_at: null }, licenceSpdx: "MIT", checks: ok });
    expect(stamp.opens_at).toBe(new Date(new Date(later).getTime() + 7 * 86_400_000).toISOString());
  });

  it("marks the release ineligible when any check failed, and keeps the checks so the page can say which", () => {
    const stamp = openStamp({ listing: { open_after_days: 30 }, release: { created_at: cut, opens_at: null }, licenceSpdx: "MIT", checks: bad });
    expect(stamp.promise_status).toBe("ineligible");
    expect(stamp.opens_at).toBe(plusDays(30));
    expect(stamp.open_eligibility).toEqual(bad);
  });

  it("clamps a number beyond the cap to 90 days after the cut, which is the database's own cap", () => {
    const stamp = openStamp({ listing: { open_after_days: 400 }, release: { created_at: cut, opens_at: null }, licenceSpdx: "MIT", checks: ok });
    expect(stamp.opens_at).toBe(plusDays(OPEN_RELEASE_MAX_DAYS));
    expect(stamp.promise_status).toBe("pending");
  });

  it("never pushes back a date the row already carries (a resumed pending cut after the days went up)", () => {
    const stamp = openStamp({ listing: { open_after_days: 60 }, release: { created_at: cut, opens_at: plusDays(30) }, licenceSpdx: "MIT", checks: ok });
    expect(stamp.opens_at).toBe(plusDays(30));

    const earlier = openStamp({ listing: { open_after_days: 7 }, release: { created_at: cut, opens_at: plusDays(30) }, licenceSpdx: "MIT", checks: ok });
    expect(earlier.opens_at).toBe(plusDays(7));
  });

  it("is ineligible, never pending, when the listing has no number of days", () => {
    for (const days of [null, undefined, 0, -3, 2.5]) {
      const stamp = openStamp({ listing: { open_after_days: days as number | null }, release: { created_at: cut, opens_at: null }, licenceSpdx: "MIT", checks: ok });
      expect(stamp.opens_at, String(days)).toBeNull();
      expect(stamp.promise_status, String(days)).toBe("ineligible");
    }
  });
});
