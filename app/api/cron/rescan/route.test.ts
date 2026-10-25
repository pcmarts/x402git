import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { seedListing } from "@/lib/test/fixtures";
import { makeMockDb } from "@/lib/test/mock-db";
import { GET } from "./route";

let mock: ReturnType<typeof makeMockDb>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  // No SOCKET_* and no artifact in the bucket: the run has candidates, calls no vendor and
  // reports what it could not do, which is the shape the summary has to be right about.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  delete process.env.SOCKET_TOKEN_VALUE;
  delete process.env.SOCKET_ORG_SLUG;
  resetEnv();
});

afterEach(() => {
  resetDb();
  vi.unstubAllGlobals();
  delete process.env.CRON_SECRET;
  resetEnv();
});

function get(headers: Record<string, string> = {}, query = "") {
  return GET(new NextRequest(`https://x402git.test/api/cron/rescan${query}`, { headers }));
}

/** A release with a report the v1 shim can lift, which is what every queue needs to see one. */
function seedReport(slug: string, owner: string) {
  const seeded = seedListing(mock, { owner, slug, releases: [{ version: "1.0.0" }] });
  Object.assign(mock.rows("release").find((r) => r.id === seeded.latest.id)!, {
    scan_report: {
      scanner_version: "2026.08.1",
      scanned_at: "2026-04-01T09:00:00.000Z",
      findings: [],
      counts: { secrets: 0, vulnerabilities: 0, blocking: 0 },
      checked: ["secrets"],
      packages_scanned: 0,
    },
  });
  return seeded;
}

describe("GET /api/cron/rescan", () => {
  it("requires the Vercel cron bearer token when CRON_SECRET is set", async () => {
    process.env.CRON_SECRET = "s3cret";
    resetEnv();

    expect((await get()).status).toBe(401);
    expect((await get({ authorization: "Bearer wrong" })).status).toBe(401);
    expect((await get({ authorization: "Bearer s3cret" })).status).toBe(200);
  });

  it("is open when no secret is configured, so a local run works", async () => {
    expect((await get()).status).toBe(200);
  });

  it("answers the §7 summary and records the run as an event", async () => {
    const seeded = seedListing(mock, { releases: [{ version: "1.0.0" }] });
    Object.assign(mock.rows("release").find((r) => r.id === seeded.latest.id)!, {
      scan_report: {
        scanner_version: "2026.08.1",
        scanned_at: "2026-04-01T09:00:00.000Z",
        findings: [],
        counts: { secrets: 0, vulnerabilities: 0, blocking: 0 },
        checked: ["secrets"],
        packages_scanned: 0,
      },
    });

    const body = await (await get()).json();
    expect(body).toMatchObject({
      queued: 1,
      repaired: 0,
      refreshed: 0,
      compromised: 0,
      socket_skipped: 1,
      errors: [],
    });
    expect(typeof body.ran_at).toBe("string");
    // The three bytes `seedListing` puts in the bucket are not a zip, so the release is
    // skipped by name rather than crashing the run.
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0]).toMatchObject({ release_id: seeded.latest.id, version: "1.0.0" });
    expect(mock.rows("event").map((e) => e.name)).toContain("cron_rescan");
  });

  // --- ?mode=backfill (§7, 14 Sep 2026) -------------------------------------------

  it("names the mode in the summary, and an unrecognised one is the nightly", async () => {
    seedReport("humanizer", "adrian");
    expect((await (await get()).json()).mode).toBe("nightly");
    expect((await (await get({}, "?mode=nonsense")).json()).mode).toBe("nightly");
    expect((await (await get({}, "?mode=backfill")).json()).mode).toBe("backfill");
    expect(mock.rows("event").filter((e) => e.name === "cron_rescan").at(-1)!.props).toMatchObject({ mode: "backfill" });
  });

  it("resolves `listing=owner/slug` to exactly one release and answers with its rows", async () => {
    const mine = seedReport("humanizer", "adrian");
    seedReport("other", "billie");

    const body = await (await get({}, "?mode=backfill&listing=adrian/humanizer")).json();

    expect(body).toMatchObject({ mode: "backfill", queued: 1 });
    // The three bytes `seedListing` puts in the bucket are not a zip, so this release is
    // skipped — and the rows still come back, because "what does the page say now" is the
    // question the operator typed.
    expect(body.public_checks).toMatchObject({ release_id: mine.latest.id, version: "1.0.0" });
    expect(body.public_checks.checks.map((c: { id: string }) => c.id)).toContain("capabilities");
  });

  it("404s on a listing path that resolves to nothing, and refuses `listing` on the nightly", async () => {
    seedReport("humanizer", "adrian");

    const missing = await get({}, "?mode=backfill&listing=adrian/nothing");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "not_found" });
    expect((await get({}, "?mode=backfill&listing=nobody/humanizer")).status).toBe(404);

    // Sweeping every live listing because somebody asked for one is the wrong way to be wrong.
    const wrongMode = await get({}, "?listing=adrian/humanizer");
    expect(wrongMode.status).toBe(400);
    expect(await wrongMode.json()).toMatchObject({ code: "invalid_request" });
  });
});
