/**
 * lib/web/author.test.ts — installs (FR-40) and the author page's loader.
 *
 * The install count is a **public number about money that changed hands**, so the tests
 * that matter are the ones about what it must not count: an update, a revoked purchase,
 * the same wallet twice. A count that is too high is a claim the platform made up.
 *
 * The author page's own rule is the second thing pinned here: only live listings, and
 * no exception for the owner. A page that showed a creator their own drafts would be a
 * second dashboard wearing a public page's clothes.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { makeMockDb } from "@/lib/test/mock-db";
import { installCount, installCounts, liveListingCount, loadAuthorPage } from "./loaders";

const CREATOR_ID = "77777777-7777-4777-8777-777777777777";
const A = "aaaaaaa1-1111-4111-8111-111111111111";
const B = "bbbbbbb2-2222-4222-8222-222222222222";

let mock: ReturnType<typeof makeMockDb>;

function computed() {
  return {
    artifact_class: "Toolkit",
    component_inventory: [{ kind: "scripts", count: 2 }],
    file_count: 7,
    dir_depth: 2,
    bytes_text: 20_100,
    bytes_binary: 0,
    languages: { JavaScript: 20_100 },
    tree: [{ path: "README.md", size: 4_096, binary: false }],
    readme_html: "<p>Run it.</p>",
    dependencies: [],
    licence: { spdx: "MIT", verdict: "pass" },
    scan: { verdict: "pass", scanner_version: "2026.08.2", at: "2026-08-21T10:00:00.000Z" },
    computed_at: "2026-08-28T16:20:00.000Z",
    analyzer_version: "0.1.0",
  };
}

function seedCreator(handle = "adrian") {
  mock.seed("creator", [
    { id: CREATOR_ID, handle, payout_address: "0x0000000000000000000000000000000000000001", terms_version: "2026-08-29" },
  ]);
}

function seedListing(id: string, slug: string, options: { live?: boolean; retired?: boolean; createdAt?: string; releaseAt?: string } = {}) {
  mock.seed("listing", [
    ...mock.rows("listing"),
    {
      id,
      creator_id: CREATOR_ID,
      slug,
      source: "github",
      price_micro: "9000000",
      update_price_micro: "5000000",
      description: `What ${slug} does.`,
      trigger_hint: "When you need it.",
      published_at: options.live === false ? null : "2026-08-21T00:00:00.000Z",
      retired_at: options.retired ? "2026-08-25T00:00:00.000Z" : null,
      created_at: options.createdAt ?? "2026-08-01T00:00:00.000Z",
    },
  ]);
  mock.seed("release", [
    ...mock.rows("release"),
    {
      id: `release-${slug}`,
      listing_id: id,
      version: "1.0.0",
      git_ref: "refs/tags/v1.0.0",
      commit_sha: "a".repeat(40),
      artifact_sha256: "b".repeat(64),
      scan: "pass",
      manifest: { computed: computed() },
      price_micro_at_publish: "9000000",
      update_price_micro_at_publish: "5000000",
      created_at: options.releaseAt ?? "2026-08-21T00:00:00.000Z",
    },
  ]);
}

function purchase(listingId: string, address: string, kind: "new" | "update" | "free", revoked = false) {
  mock.seed("purchase", [
    ...mock.rows("purchase"),
    {
      id: `p-${mock.rows("purchase").length}`,
      listing_id: listingId,
      release_id: "r",
      buyer_address: address,
      kind,
      source: "web",
      gross_micro: "9000000",
      fee_micro: "900000",
      net_micro: "8100000",
      all_versions: false,
      update_price_at_purchase: "5000000",
      granted_at: "2026-08-22T00:00:00.000Z",
      holdback_until: "2026-08-29T00:00:00.000Z",
      payout_id: null,
      revoked_at: revoked ? "2026-08-23T00:00:00.000Z" : null,
    },
  ]);
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

describe("installCounts (FR-40)", () => {
  it("is empty for no listings, and asks the database nothing", async () => {
    expect(await installCounts([])).toEqual(new Map());
  });

  it("counts a new purchase and a free one", async () => {
    seedCreator();
    seedListing(A, "humanizer");
    purchase(A, "0xaaa", "new");
    purchase(A, "0xbbb", "free");

    expect(await installCount(A)).toBe(2);
  });

  it("does not count an update — the same wallet buying again is not a second install", async () => {
    seedCreator();
    seedListing(A, "humanizer");
    purchase(A, "0xaaa", "new");
    purchase(A, "0xaaa", "update");
    purchase(A, "0xaaa", "update");

    expect(await installCount(A)).toBe(1);
  });

  it("counts one wallet once, whatever case it arrives in", async () => {
    seedCreator();
    seedListing(A, "humanizer");
    purchase(A, "0xAAA", "new");
    purchase(A, "0xaaa", "free");

    expect(await installCount(A)).toBe(1);
  });

  it("does not count a revoked purchase — FR-39's takedown is the only thing that revokes", async () => {
    seedCreator();
    seedListing(A, "humanizer");
    purchase(A, "0xaaa", "new", true);
    purchase(A, "0xbbb", "new");

    expect(await installCount(A)).toBe(1);
  });

  it("is absent from the map rather than zero, so a caller cannot print a nought by accident", async () => {
    seedCreator();
    seedListing(A, "humanizer");

    const counts = await installCounts([A]);
    expect(counts.has(A)).toBe(false);
    expect(await installCount(A)).toBe(0);
  });

  it("keeps two listings apart in one query", async () => {
    seedCreator();
    seedListing(A, "humanizer");
    seedListing(B, "repo-digest");
    purchase(A, "0xaaa", "new");
    purchase(B, "0xaaa", "new");
    purchase(B, "0xbbb", "new");

    const counts = await installCounts([A, B]);
    expect(counts.get(A)).toBe(1);
    expect(counts.get(B)).toBe(2);
  });

  it("returns a count and never an address", async () => {
    seedCreator();
    seedListing(A, "humanizer");
    purchase(A, "0xdeadbeef", "new");

    const counts = await installCounts([A]);
    expect(JSON.stringify([...counts])).not.toContain("0xdeadbeef");
  });
});

describe("loadAuthorPage", () => {
  it("is null for a handle nobody holds", async () => {
    expect(await loadAuthorPage("nobody")).toBeNull();
  });

  it("is null for a reserved handle, whatever the database holds", async () => {
    mock.seed("creator", [{ id: "x", handle: "docs", payout_address: "0x1", terms_version: "2026-08-29" }]);
    expect(await loadAuthorPage("docs")).toBeNull();
    expect(await loadAuthorPage("dashboard")).toBeNull();
    expect(await loadAuthorPage("purchases")).toBeNull();
    expect(await loadAuthorPage("how-it-works")).toBeNull();
  });

  it("is a real page with no listings when the creator has published nothing", async () => {
    seedCreator();
    const page = await loadAuthorPage("adrian");
    expect(page?.listings).toEqual([]);
    expect(page?.installs).toBe(0);
    expect(page?.profileListing).toBeNull();
  });

  it("carries every live listing as a card, with its installs", async () => {
    seedCreator();
    seedListing(A, "humanizer");
    seedListing(B, "repo-digest");
    purchase(A, "0xaaa", "new");
    purchase(A, "0xbbb", "new");
    purchase(B, "0xccc", "new");

    const page = await loadAuthorPage("adrian");
    expect(page?.listings.map((l) => l.slug).sort()).toEqual(["humanizer", "repo-digest"]);
    expect(page?.listings.find((l) => l.slug === "humanizer")?.installs).toBe(2);
    expect(page?.installs).toBe(3);
    expect(page?.listings[0].artifactClass).toBe("Toolkit");
    expect(page?.listings[0].priceMicro).toBe(9_000_000n);
  });

  it("shows the most recently shipped first", async () => {
    seedCreator();
    seedListing(A, "older", { releaseAt: "2026-08-01T00:00:00.000Z" });
    seedListing(B, "newer", { releaseAt: "2026-08-28T00:00:00.000Z" });

    expect((await loadAuthorPage("adrian"))?.listings.map((l) => l.slug)).toEqual(["newer", "older"]);
  });

  it("omits a draft and a retired listing — there is no owner's view of this page", async () => {
    seedCreator();
    seedListing(A, "draft-one", { live: false });
    seedListing(B, "retired-one", { retired: true });

    expect((await loadAuthorPage("adrian"))?.listings).toEqual([]);
  });

  it("is case-insensitive on the handle, the way every other route is", async () => {
    seedCreator();
    seedListing(A, "humanizer");
    expect((await loadAuthorPage("Adrian"))?.creator.handle).toBe("adrian");
  });
});

describe("liveListingCount", () => {
  it("counts only what is live", async () => {
    seedCreator();
    seedListing(A, "live-one");
    seedListing(B, "draft-one", { live: false });

    expect(await liveListingCount(CREATOR_ID)).toBe(1);
  });
});
