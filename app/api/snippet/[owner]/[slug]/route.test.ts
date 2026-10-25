/**
 * app/api/snippet/:owner/:slug — FR-30. The generator itself is covered by
 * `lib/web/readme-snippet.test.ts`; this covers that the route serves it as markdown,
 * with the listing's real prices, and that a draft is a 404.
 */

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { seedListing } from "@/lib/test/fixtures";
import { makeMockDb } from "@/lib/test/mock-db";
import { GET } from "./route";

let mock: ReturnType<typeof makeMockDb>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  process.env.NEXT_PUBLIC_APP_URL = "https://x402git.test";
  resetEnv();
});

afterEach(() => {
  resetDb();
  delete process.env.NEXT_PUBLIC_APP_URL;
  resetEnv();
});

function get() {
  const req = new NextRequest("https://x402git.test/api/snippet/adrian/humanizer", {
    headers: { "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 250) + 1}` },
  });
  return GET(req, { params: Promise.resolve({ owner: "adrian", slug: "humanizer" }) });
}

describe("GET /api/snippet/:owner/:slug", () => {
  it("serves the preamble as markdown with the listing's prices", async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });

    const res = await get();
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(text).toContain("## adrian/humanizer — v1.2.0");
    expect(text).toContain("$9 per release.");
    expect(text).toContain("Updates are $3,");
    expect(text).toContain("GET https://x402git.test/api/v/adrian/humanizer");
  });

  it("says updates are included when the update price is $0 (FR-30)", async () => {
    seedListing(mock, { updatePriceMicro: "0", releases: [{ version: "1.0.0" }] });

    const text = await (await get()).text();
    expect(text).toContain("Updates are included");
  });

  it("is a 404 for a draft, so an unpublished listing is not discoverable", async () => {
    seedListing(mock, { published: false });

    const res = await get();
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("not_found");
  });

  it("still serves a retired listing, marked in the header (FR-43)", async () => {
    seedListing(mock, { retired: true, releases: [{ version: "1.0.0" }] });

    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("x-listing-status")).toBe("retired");
  });
});
