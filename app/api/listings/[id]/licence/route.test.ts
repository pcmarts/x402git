import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { ALLOWED_SPDX, licenceText } from "@/lib/licences";
import { makeMockDb } from "@/lib/test/mock-db";
import { ctx, OTHER_API_KEY, req, seedCreator, seedListing } from "@/lib/test/listings-fixtures";

const hosted = vi.hoisted(() => ({ commitLicenceFile: vi.fn() }));
vi.mock("@/lib/github/hosted", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github/hosted")>()),
  ...hosted,
}));
vi.mock("@/lib/github/installations", () => ({ installationAccount: vi.fn(), resolveRepo: vi.fn(), repoById: vi.fn() }));
vi.mock("@/lib/release", () => ({ cutRelease: vi.fn() }));

const { POST } = await import("./route");

let mock: ReturnType<typeof makeMockDb>;
let creator: Record<string, any>;
let hostedListing: Record<string, any>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  creator = seedCreator(mock);
  hostedListing = seedListing(mock, creator, { slug: "humanizer", source: "hosted", hosted_org: "x402git-hosted-01", github_repo_id: "987654", deploy_key_id: "5150" });
  hosted.commitLicenceFile.mockResolvedValue({ commitSha: "d".repeat(40), path: "LICENSE", spdx: "MIT" });
});

afterEach(() => {
  resetDb();
  vi.clearAllMocks();
  resetEnv();
});

describe("POST /api/listings/:id/licence (FR-11, Rail B)", () => {
  it("commits the LICENSE and records a pass verdict", async () => {
    const res = await POST(req("/x", { method: "POST", body: { spdx: "MIT" } }), ctx(hostedListing.id));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.licence).toEqual({ spdx: "MIT", verdict: "pass" });
    expect(body.commit_sha).toBe("d".repeat(40));

    expect(hosted.commitLicenceFile).toHaveBeenCalledWith({ owner: "x402git-hosted-01", repo: "a1b2c3--humanizer" }, "MIT", "a1b2c3");

    const row = mock.rows("listing")[0];
    expect(row.licence_spdx).toBe("MIT");
    expect(row.licence_verdict).toBe("pass");
  });

  it("accepts every id on the allow-list and nothing else", async () => {
    for (const spdx of ALLOWED_SPDX) {
      const res = await POST(req("/x", { method: "POST", body: { spdx } }), ctx(hostedListing.id));
      expect(res.status).toBe(200);
    }
    for (const spdx of ["GPL-3.0", "AGPL-3.0", "unlicensed", "NOASSERTION", "mit"]) {
      const res = await POST(req("/x", { method: "POST", body: { spdx } }), ctx(hostedListing.id));
      expect(res.status).toBe(400);
    }
  });

  it("refuses to write into a Rail A repo — that repository belongs to the creator", async () => {
    const railA = seedListing(mock, creator, { slug: "own-repo", source: "github" });

    const res = await POST(req("/x", { method: "POST", body: { spdx: "MIT" } }), ctx(railA.id));
    expect(res.status).toBe(400);
    expect(hosted.commitLicenceFile).not.toHaveBeenCalled();
  });

  it("410s a retired listing", async () => {
    const gone = seedListing(mock, creator, { slug: "gone", source: "hosted", hosted_org: "x402git-hosted-01", github_repo_id: "1", retired_at: new Date().toISOString() });

    const res = await POST(req("/x", { method: "POST", body: { spdx: "MIT" } }), ctx(gone.id));
    expect(res.status).toBe(410);
  });

  it("404s someone else's listing", async () => {
    const other = seedCreator(mock, { handle: "someone" }, OTHER_API_KEY);
    const theirs = seedListing(mock, other, { slug: "not-yours", source: "hosted", hosted_org: "x402git-hosted-01", github_repo_id: "2" });

    const res = await POST(req("/x", { method: "POST", body: { spdx: "MIT" } }), ctx(theirs.id));
    expect(res.status).toBe(404);
    expect(hosted.commitLicenceFile).not.toHaveBeenCalled();
  });
});

describe("the licence templates themselves", () => {
  it("ships all four, and fills in the year and holder where the licence has them", () => {
    const mit = licenceText("MIT", "a1b2c3", 2026);
    expect(mit).toContain("Copyright (c) 2026 a1b2c3");
    expect(mit).not.toContain("[year]");
    expect(mit).not.toContain("[fullname]");

    expect(licenceText("Apache-2.0", "a1b2c3", 2026)).toContain("Apache License");
    expect(licenceText("BSD-3-Clause", "a1b2c3", 2026)).toContain("Copyright (c) 2026 a1b2c3");
    // MPL carries no copyright line, so there is nothing to substitute — and that is correct.
    expect(licenceText("MPL-2.0", "a1b2c3", 2026)).toContain("Mozilla Public License Version 2.0");
  });

  it("is the full text, not a stub", () => {
    for (const spdx of ALLOWED_SPDX) {
      expect(licenceText(spdx, "a1b2c3").length).toBeGreaterThan(1000);
    }
  });
});
