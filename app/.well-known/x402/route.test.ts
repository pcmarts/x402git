import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { seedListing } from "@/lib/test/fixtures";
import { makeMockDb } from "@/lib/test/mock-db";
import { GET } from "./route";

describe("GET /.well-known/x402 (x402scan discovery)", () => {
  let mock: ReturnType<typeof makeMockDb>;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = "https://x402git.test";
    resetEnv();
    mock = makeMockDb();
    setDb(mock.client as unknown as Db);
  });

  afterEach(() => {
    resetDb();
    resetEnv();
  });

  it("lists every live resource URL, and only those", async () => {
    seedListing(mock, { owner: "adrian", slug: "humanizer", published: true, releases: [{ version: "1.0.0" }] });
    seedListing(mock, { owner: "adrian", slug: "draft-thing", published: false, releases: [{ version: "1.0.0" }] });
    seedListing(mock, { owner: "bea", slug: "retired-thing", published: true, retired: true, releases: [{ version: "1.0.0" }] });

    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = await res.json();
    expect(body.version).toBe(1);
    expect(body.resources).toEqual(["https://x402git.test/api/r/adrian/humanizer"]);
    expect(body.instructions).toContain("402");
  });

  it("is an empty list, not an error, with nothing on sale", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).resources).toEqual([]);
  });
});
