import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { setPublicGithub } from "@/lib/github/public";
import { seedListing } from "@/lib/test/fixtures";
import { makeMockDb } from "@/lib/test/mock-db";
import { stubPublicGithub } from "@/lib/test/public-github";
import { GET } from "./route";

const COMMIT = "0".repeat(40); // what the shared fixture stamps on every release
// Well in the past whatever the clock says: the route reads the real `Date.now()`.
const PAST = "2026-10-01T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";

let mock: ReturnType<typeof makeMockDb>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  delete process.env.CRON_SECRET;
  resetEnv();
});

afterEach(() => {
  resetDb();
  setPublicGithub(null);
  delete process.env.CRON_SECRET;
  resetEnv();
});

function get(headers: Record<string, string> = {}) {
  return GET(new NextRequest("https://x402git.test/api/cron/promises", { headers }));
}

/** An open-release listing with one pending release promised for `opensAt`. */
function seedOpen(slug: string, publicRepo: string, opensAt: string, overrides: Record<string, unknown> = {}) {
  const seeded = seedListing(mock, { owner: "adrian", slug, releases: [{ version: "1.1.0" }] });
  Object.assign(mock.rows("listing").find((l) => l.id === seeded.listingId)!, { open_release: true, public_repo_url: publicRepo, next_opens_at: opensAt });
  Object.assign(mock.rows("release").find((r) => r.id === seeded.latest.id)!, {
    promise_status: "pending",
    opens_at: opensAt,
    open_licence_spdx: "MIT",
    promise_checked_at: null,
    opened_at: null,
    promise_evidence: null,
    ...overrides,
  });
  return seeded;
}

describe("GET /api/cron/promises", () => {
  it("requires the Vercel cron bearer token when CRON_SECRET is set", async () => {
    process.env.CRON_SECRET = "s3cret";
    resetEnv();
    expect((await get()).status).toBe(401);
    expect((await get({ authorization: "Bearer wrong" })).status).toBe(401);
    expect((await get({ authorization: "Bearer s3cret" })).status).toBe(200);
  });

  it("checks every due promise once and reports each verdict with its evidence", async () => {
    const kept = seedOpen("kept", "https://github.com/octo/kept", PAST);
    const broken = seedOpen("broken", "https://github.com/octo/broken", PAST);
    const notYet = seedOpen("not-yet", "https://github.com/octo/not-yet", FUTURE);
    setPublicGithub(
      stubPublicGithub({
        commits: { "octo/kept": [COMMIT], "octo/broken": [] },
        licences: { "octo/kept": "MIT" },
        tags: { "octo/kept": { [COMMIT]: "v1.1.0" } },
      }),
    );

    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.due).toBe(2);
    expect(body.opened_on_time).toBe(1);
    expect(body.overdue).toBe(1);
    expect(body.failed).toBe(0);
    expect(body.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ release_id: kept.latest.id, status: "opened_on_time", evidence: expect.objectContaining({ ref: "v1.1.0", licence: "MIT" }) }),
        expect.objectContaining({ release_id: broken.latest.id, status: "overdue" }),
      ]),
    );

    const rows = mock.rows("release");
    expect(rows.find((r) => r.id === kept.latest.id)!.promise_status).toBe("opened_on_time");
    expect(rows.find((r) => r.id === broken.latest.id)!.promise_status).toBe("overdue");
    expect(rows.find((r) => r.id === notYet.latest.id)!.promise_status).toBe("pending");

    // §10: one event per verdict, named, with no buyer address anywhere near it.
    const events = mock.rows("event").filter((e) => e.name === "promise_checked");
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.props.status).sort()).toEqual(["opened_on_time", "overdue"]);
  });

  it("reports a release GitHub would not answer for and carries on with the rest", async () => {
    const stuck = seedOpen("stuck", "https://github.com/octo/stuck", PAST);
    setPublicGithub(stubPublicGithub({ fail: true }));

    const body = await (await get()).json();

    expect(body.failed).toBe(1);
    expect(body.results[0]).toMatchObject({ release_id: stuck.latest.id, error: expect.stringMatching(/did not answer/) });
    const row = mock.rows("release").find((r) => r.id === stuck.latest.id)!;
    expect(row.promise_status).toBe("pending");
    expect(row.promise_checked_at).not.toBeNull();
  });

  it("does nothing when nothing is due", async () => {
    seedOpen("later", "https://github.com/octo/later", FUTURE);
    const github = stubPublicGithub();
    setPublicGithub(github);
    const body = await (await get()).json();
    expect(body).toMatchObject({ due: 0, opened_on_time: 0, overdue: 0, failed: 0, results: [] });
    expect(github.calls).toEqual([]);
  });
});
