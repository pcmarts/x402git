import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { makeMockDb } from "@/lib/test/mock-db";
import { GET } from "./route";

const CREATOR_ID = "11111111-1111-4111-8111-111111111111";
const LISTING_ID = "22222222-2222-4222-8222-222222222222";

let mock: ReturnType<typeof makeMockDb>;

/** The `computed` block the analyser writes onto the release row. */
function computed() {
  return {
    artifact_class: "Harness",
    component_inventory: [{ kind: "skill", count: 1 }],
    file_count: 18,
    dir_depth: 3,
    bytes_text: 225_280,
    bytes_binary: 67_584,
    languages: { Python: 68_000 },
    tree: [{ path: "README.md", size: 4_096, binary: false }],
    readme_html: "<p>hello</p>",
    dependencies: [{ name: "requests", ecosystem: "pypi", version: "2.31.0" }],
    licence: { spdx: "MIT", verdict: "pass" },
    scan: { verdict: "pass", scanner_version: "2026.08.2", at: "2026-08-21T10:00:00.000Z" },
    computed_at: "2026-08-28T16:20:00.000Z",
    analyzer_version: "0.1.0",
  };
}

function seed(options: { published?: boolean; retired?: boolean; scan?: "pass" | "fail" | "pending"; manifest?: unknown; priceMicro?: string } = {}) {
  mock.seed("creator", [
    { id: CREATOR_ID, handle: "adrian", payout_address: "0x0000000000000000000000000000000000000001", terms_version: "2026-08-29" },
  ]);
  mock.seed("listing", [
    {
      id: LISTING_ID,
      creator_id: CREATOR_ID,
      slug: "humanizer",
      source: "github",
      price_micro: options.priceMicro ?? "9000000",
      update_price_micro: "5000000",
      description: "Rewrites machine prose.",
      trigger_hint: "When a draft reads like a model wrote it.",
      licence_spdx: "MIT",
      licence_verdict: "pass",
      published_at: options.published === false ? null : "2026-08-21T00:00:00.000Z",
      retired_at: options.retired ? "2026-08-25T00:00:00.000Z" : null,
    },
  ]);
  mock.seed("release", [
    {
      id: "33333333-3333-4333-8333-333333333333",
      listing_id: LISTING_ID,
      version: "1.2.0",
      git_ref: "refs/tags/v1.2.0",
      commit_sha: "a".repeat(40),
      artifact_sha256: "b".repeat(64),
      scan: options.scan ?? "pass",
      manifest: "manifest" in options ? options.manifest : { computed: computed() },
      price_micro_at_publish: "9000000",
      update_price_micro_at_publish: "5000000",
      created_at: "2026-08-21T00:00:00.000Z",
    },
  ]);
}

function request(path = "/api/label/adrian/humanizer"): NextRequest {
  return new NextRequest(`https://x402git.com${path}`);
}

function ctx(owner = "adrian", slug = "humanizer") {
  return { params: Promise.resolve({ owner, slug }) };
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = "https://x402git.com";
  resetEnv();
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
});

afterEach(() => {
  resetDb();
  delete process.env.NEXT_PUBLIC_APP_URL;
  resetEnv();
});

describe("GET /api/label/:owner/:slug", () => {
  it("returns the manifest for a live listing", async () => {
    seed();
    const res = await GET(request(), ctx());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.owner).toBe("adrian");
    expect(body.slug).toBe("humanizer");
    expect(body.version).toBe("1.2.0");
    expect(body.computed.artifact_class).toBe("Harness");
    expect(body.computed.analyzer_version).toBe("0.1.0");
  });

  it("is free and cacheable for a minute (FR-49)", async () => {
    seed();
    const res = await GET(request(), ctx());
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
  });

  it("states the list price and where to buy, so a manifest alone can be priced (FR-49)", async () => {
    seed();
    const body = await (await GET(request(), ctx())).json();
    expect(body.price_micro).toBe("9000000");
    expect(body.update_price_micro).toBe("5000000");
    expect(body.resource_endpoint).toBe("https://x402git.com/api/r/adrian/humanizer");
    expect(body.version_url).toBe("https://x402git.com/api/v/adrian/humanizer");
    // The failure this closes: no price at all, next to `licence: MIT`, reads as free.
    expect(body.price_micro).not.toBe("0");
    expect(body.computed.price_micro).toBeUndefined();
  });

  it("quotes the current price, not the price the release was cut at", async () => {
    // The release row still says 9000000 at publish; the creator has since raised it.
    seed({ priceMicro: "12000000" });
    const body = await (await GET(request(), ctx())).json();
    expect(body.price_micro).toBe("12000000");
  });

  it("still serves a legacy $0 listing rather than 404ing it (FR-24)", async () => {
    // The write path floors prices at $0.01 (D2b), but rows saved as 0 before
    // 31 Aug 2026 keep serving — so the manifest schema must not reject them.
    seed({ priceMicro: "0" });
    const res = await GET(request(), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).price_micro).toBe("0");
  });

  it("namespaces the creator's own words under self_reported (FR-51)", async () => {
    seed();
    const body = await (await GET(request(), ctx())).json();
    expect(body.self_reported.description).toBe("Rewrites machine prose.");
    expect(body.computed.description).toBeUndefined();
  });

  it("takes the creator's words from the listing, not from a stale analyser blob", async () => {
    seed({ manifest: { computed: computed(), self_reported: { description: "an old claim the creator retracted" } } });
    const body = await (await GET(request(), ctx())).json();
    expect(body.self_reported.description).toBe("Rewrites machine prose.");
  });

  it("404s a draft, so an unpublished listing is not discoverable by URL", async () => {
    seed({ published: false });
    const res = await GET(request(), ctx());
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("not_found");
  });

  it("still answers for a retired listing, and says so in a header (FR-43)", async () => {
    seed({ retired: true });
    const res = await GET(request(), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-listing-status")).toBe("retired");
  });

  it("404s when no release has passed its scan", async () => {
    seed({ scan: "fail" });
    const res = await GET(request(), ctx());
    expect(res.status).toBe(404);
  });

  it("404s rather than serving half a manifest when the blob does not validate", async () => {
    seed({ manifest: { computed: { artifact_class: "Harness" } } });
    const res = await GET(request(), ctx());
    expect(res.status).toBe(404);
  });

  it("404s an unknown owner and an unknown slug", async () => {
    seed();
    expect((await GET(request(), ctx("nobody", "humanizer"))).status).toBe(404);
    expect((await GET(request(), ctx("adrian", "nothing"))).status).toBe(404);
  });

  it("is case-insensitive on the path, because URLs get copied", async () => {
    seed();
    expect((await GET(request(), ctx("Adrian", "Humanizer"))).status).toBe(200);
  });

  it("carries a docs_url on the error body (FR-33)", async () => {
    seed({ published: false });
    const body = await (await GET(request(), ctx())).json();
    expect(body.docs_url).toBe("https://x402git.com/docs/errors#not_found");
  });

  it("counts against the label rate limit", async () => {
    seed();
    await GET(request(), ctx());
    expect(mock.rpcCalls.some((c) => c.name === "rate_limit_hit" && String(c.args.p_bucket).startsWith("label:"))).toBe(true);
  });
});
