import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { openApiDocument } from "@/lib/openapi";
import { seedListing } from "@/lib/test/fixtures";
import { makeMockDb } from "@/lib/test/mock-db";
import { listingPaths } from "./listings";

describe("per-listing OpenAPI paths (lib/openapi/listings.ts)", () => {
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

  it("emits one paid GET per live listing with a fixed price, and nothing for drafts or retired", async () => {
    seedListing(mock, { owner: "adrian", slug: "humanizer", priceMicro: "9000000", published: true, releases: [{ version: "1.0.0" }] });
    seedListing(mock, { owner: "adrian", slug: "draft", published: false, releases: [{ version: "1.0.0" }] });
    seedListing(mock, { owner: "bea", slug: "gone", published: true, retired: true, releases: [{ version: "1.0.0" }] });

    const paths = await listingPaths();
    expect(Object.keys(paths)).toEqual(["/api/r/adrian/humanizer"]);
    const op = (paths["/api/r/adrian/humanizer"] as { get: Record<string, unknown> }).get;
    expect(op.operationId).toBe("buy_adrian_humanizer");
    expect(op.security).toEqual([{ walletSignature: [] }]);
    expect(op["x-payment-info"]).toEqual(expect.objectContaining({ protocols: [{ x402: {} }], price: { mode: "fixed", currency: "USD", amount: "9.00" } }));
    expect((op.responses as Record<string, unknown>)["402"]).toBeTruthy();
    expect(op.description).toContain("https://x402git.test/api/label/adrian/humanizer");
  });

  it("references only schemas the static document defines", async () => {
    seedListing(mock, { owner: "adrian", slug: "humanizer", published: true, releases: [{ version: "1.0.0" }] });
    const schemas = (openApiDocument() as { components: { schemas: Record<string, unknown> } }).components.schemas;
    const refs = JSON.stringify(await listingPaths()).match(/#\/components\/schemas\/([A-Za-z]+)/g) ?? [];
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(schemas).toHaveProperty(ref.replace("#/components/schemas/", ""));
  });
});
