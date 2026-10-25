import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import type { ListingRow, ReleaseRow } from "@/lib/db/types";
import { setPublicGithub } from "@/lib/github/public";
import { makeMockDb } from "@/lib/test/mock-db";
import { seedCreator, seedListing, seedRelease } from "@/lib/test/listings-fixtures";
import { stubPublicGithub } from "@/lib/test/public-github";
import { checkPromise, checkPromiseIfDue, duePromises, promiseDue, refreshPromiseOnRead, resetPromiseCache } from "./promise";

const COMMIT = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const PUBLIC = "https://github.com/octo/widget";
const NOW = new Date("2026-10-25T17:05:00.000Z");
const PAST = "2026-10-25T17:00:00.000Z";
const FUTURE = "2026-12-01T17:00:00.000Z";

let mock: ReturnType<typeof makeMockDb>;
let listing: ListingRow;

function release(overrides: Record<string, unknown> = {}): ReleaseRow {
  return seedRelease(mock, listing, {
    commit_sha: COMMIT,
    promise_status: "pending",
    opens_at: PAST,
    open_licence_spdx: "MIT",
    promise_checked_at: null,
    opened_at: null,
    promise_evidence: null,
    open_eligibility: [{ id: "licence", ok: true, detail: "MIT" }],
    ...overrides,
  }) as ReleaseRow;
}

function stored(id: string): ReleaseRow {
  return mock.rows("release").find((r) => r.id === id) as ReleaseRow;
}

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  resetPromiseCache();
  const creator = seedCreator(mock);
  listing = seedListing(mock, creator, { open_release: true, public_repo_url: PUBLIC, open_after_days: 30 }) as ListingRow;
});

afterEach(() => {
  resetDb();
  setPublicGithub(null);
  vi.restoreAllMocks();
});

describe("promiseDue", () => {
  it("is true only for a pending promise whose date has passed", () => {
    expect(promiseDue({ promise_status: "pending", opens_at: PAST }, NOW)).toBe(true);
    expect(promiseDue({ promise_status: "pending", opens_at: NOW.toISOString() }, NOW)).toBe(true);
    expect(promiseDue({ promise_status: "pending", opens_at: FUTURE }, NOW)).toBe(false);
    expect(promiseDue({ promise_status: "opened_on_time", opens_at: PAST }, NOW)).toBe(false);
    expect(promiseDue({ promise_status: "overdue", opens_at: PAST }, NOW)).toBe(false);
    expect(promiseDue({ promise_status: "ineligible", opens_at: PAST }, NOW)).toBe(false);
    expect(promiseDue({ promise_status: null, opens_at: PAST }, NOW)).toBe(false);
    expect(promiseDue({ promise_status: "pending", opens_at: null }, NOW)).toBe(false);
  });
});

describe("checkPromise — was the promise kept? (STRATEGY §6a, Proof 4)", () => {
  it("records opened_on_time with evidence when the public repo has the commit under the same licence", async () => {
    const row = release();
    const github = stubPublicGithub({
      commits: { "octo/widget": [COMMIT] },
      licences: { "octo/widget": "MIT" },
      tags: { "octo/widget": { [COMMIT]: "v1.1.0" } },
    });

    const checked = await checkPromise(row, listing, { now: NOW, github });

    expect(checked.promise_status).toBe("opened_on_time");
    expect(checked.opened_at).toBe(NOW.toISOString());
    expect(checked.promise_checked_at).toBe(NOW.toISOString());
    expect(checked.promise_evidence).toEqual({
      ref: "v1.1.0",
      html_url: `https://github.com/octo/widget/commit/${COMMIT}`,
      licence: "MIT",
      checked_url: `https://api.github.com/repos/octo/widget/commits/${COMMIT}`,
    });
    expect(stored(row.id).promise_status).toBe("opened_on_time");
  });

  it("falls back to the short sha as the ref when no tag points at the commit", async () => {
    const row = release();
    const github = stubPublicGithub({ commits: { "octo/widget": [COMMIT] }, licences: { "octo/widget": "MIT" } });
    const checked = await checkPromise(row, listing, { now: NOW, github });
    expect((checked.promise_evidence as { ref: string }).ref).toBe(COMMIT.slice(0, 12));
  });

  it("records overdue when the commit is not in the public repo after the date", async () => {
    const row = release();
    const github = stubPublicGithub({ commits: { "octo/widget": [] }, licences: { "octo/widget": "MIT" } });

    const checked = await checkPromise(row, listing, { now: NOW, github });

    expect(checked.promise_status).toBe("overdue");
    expect(checked.opened_at).toBeNull();
    expect(checked.promise_checked_at).toBe(NOW.toISOString());
    expect((checked.promise_evidence as { reason: string }).reason).toMatch(/was not in github.com\/octo\/widget/);
    // Only the commit was asked for: a missing commit needs no licence read.
    expect(github.calls).toEqual([`repos/octo/widget/commits/${COMMIT}`]);
  });

  it("records overdue with the licence it found when the commit is public under a different licence", async () => {
    const row = release();
    const github = stubPublicGithub({ commits: { "octo/widget": [COMMIT] }, licences: { "octo/widget": "GPL-3.0" } });

    const checked = await checkPromise(row, listing, { now: NOW, github });

    expect(checked.promise_status).toBe("overdue");
    const evidence = checked.promise_evidence as { licence: string; reason: string; html_url: string };
    expect(evidence.licence).toBe("GPL-3.0");
    expect(evidence.reason).toMatch(/licensed GPL-3.0, not MIT/);
    expect(evidence.html_url).toContain(COMMIT);
  });

  it("compares licences case-insensitively, the way the gate does", async () => {
    const row = release({ open_licence_spdx: "mit" });
    const github = stubPublicGithub({ commits: { "octo/widget": [COMMIT] }, licences: { "octo/widget": "MIT" } });
    expect((await checkPromise(row, listing, { now: NOW, github })).promise_status).toBe("opened_on_time");
  });

  it("leaves a release alone until its date has passed", async () => {
    const row = release({ opens_at: FUTURE });
    const github = stubPublicGithub({ commits: { "octo/widget": [COMMIT] }, licences: { "octo/widget": "MIT" } });

    const checked = await checkPromise(row, listing, { now: NOW, github });

    expect(checked).toBe(row);
    expect(stored(row.id).promise_status).toBe("pending");
    expect(stored(row.id).promise_checked_at).toBeNull();
    expect(github.calls).toEqual([]);
  });

  it("never re-checks a release that already has a verdict", async () => {
    const github = stubPublicGithub({ commits: { "octo/widget": [COMMIT] }, licences: { "octo/widget": "MIT" } });
    for (const status of ["opened_on_time", "overdue", "not_open", "ineligible"] as const) {
      const row = release({ promise_status: status, version: `1.0.${status.length}` });
      await checkPromise(row, listing, { now: NOW, github });
      expect(stored(row.id).promise_status).toBe(status);
    }
    expect(github.calls).toEqual([]);
  });

  it("stamps the attempt and rethrows when GitHub cannot be asked, so the row stays pending", async () => {
    const row = release();
    const github = stubPublicGithub({ fail: true });

    await expect(checkPromise(row, listing, { now: NOW, github })).rejects.toThrow(/did not answer/);

    expect(stored(row.id).promise_status).toBe("pending");
    expect(stored(row.id).promise_checked_at).toBe(NOW.toISOString());
  });
});

describe("checkPromiseIfDue — the read path", () => {
  it("flips a backdated pending release on the first read (BATTLE-TEST §4: backdated allowed)", async () => {
    const row = release({ opens_at: "2026-10-01T00:00:00.000Z" });
    setPublicGithub(stubPublicGithub({ commits: { "octo/widget": [COMMIT] }, licences: { "octo/widget": "MIT" } }));

    const checked = await checkPromiseIfDue(row, listing, { now: NOW });
    expect(checked.promise_status).toBe("opened_on_time");
  });

  it("never throws: an unreachable GitHub returns the row as it was", async () => {
    const row = release();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setPublicGithub(stubPublicGithub({ fail: true }));

    const checked = await checkPromiseIfDue(row, listing, { now: NOW });

    expect(checked.promise_status).toBe("pending");
    expect(warn).toHaveBeenCalled();
  });

  it("asks GitHub about the same release at most once a minute", async () => {
    const row = release();
    const github = stubPublicGithub({ fail: true });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await checkPromiseIfDue(row, listing, { now: NOW, github });
    await checkPromiseIfDue(row, listing, { now: new Date(NOW.getTime() + 30_000), github });
    expect(github.calls).toHaveLength(1);

    // A minute later the question is asked again — and this time GitHub answers.
    github.fail = false;
    github.commits["octo/widget"] = [COMMIT];
    github.licences["octo/widget"] = "MIT";
    const checked = await checkPromiseIfDue(row, listing, { now: new Date(NOW.getTime() + 61_000), github });
    expect(github.calls).toHaveLength(4);
    expect(checked.promise_status).toBe("opened_on_time");
  });

  it("costs nothing for a release whose date has not passed", async () => {
    const row = release({ opens_at: FUTURE });
    const github = stubPublicGithub();
    expect(await checkPromiseIfDue(row, listing, { now: NOW, github })).toBe(row);
    expect(github.calls).toEqual([]);
  });
});

describe("refreshPromiseOnRead — over a listing bundle, in place", () => {
  it("replaces `latest` and its entry in `releases` with the checked row", async () => {
    const row = release();
    const github = stubPublicGithub({ commits: { "octo/widget": [COMMIT] }, licences: { "octo/widget": "MIT" } });
    const bundle = { listing, latest: row, releases: [row] };

    await refreshPromiseOnRead(bundle, { now: NOW, github });

    expect(bundle.latest?.promise_status).toBe("opened_on_time");
    expect(bundle.releases[0].promise_status).toBe("opened_on_time");
  });

  it("is a no-op with no latest release or no due promise", async () => {
    const github = stubPublicGithub();
    const none = { listing, latest: null, releases: [] as ReleaseRow[] };
    expect(await refreshPromiseOnRead(none, { now: NOW, github })).toBe(none);
    const future = release({ opens_at: FUTURE });
    const bundle = { listing, latest: future, releases: [future] };
    await refreshPromiseOnRead(bundle, { now: NOW, github });
    expect(bundle.latest).toBe(future);
    expect(github.calls).toEqual([]);
  });
});

describe("duePromises — what the cron reads", () => {
  it("returns pending releases whose date has passed, oldest first, each with its listing", async () => {
    const later = release({ version: "1.0.1", opens_at: "2026-10-25T16:00:00.000Z" });
    const earlier = release({ version: "1.0.2", opens_at: "2026-10-20T00:00:00.000Z" });
    release({ version: "1.0.3", opens_at: FUTURE });
    release({ version: "1.0.4", promise_status: "opened_on_time" });
    release({ version: "1.0.5", promise_status: null, opens_at: null });

    const due = await duePromises(NOW);

    expect(due.map((d) => d.release.id)).toEqual([earlier.id, later.id]);
    expect(due[0].listing.id).toBe(listing.id);
  });

  it("is empty when nothing is due", async () => {
    release({ opens_at: FUTURE });
    expect(await duePromises(NOW)).toEqual([]);
  });
});
