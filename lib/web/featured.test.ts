/**
 * lib/web/featured.test.ts — the home page's examples, present and absent.
 *
 * The behaviour worth pinning is the absence. A featured listing may not exist on the
 * deployment that renders the page, and the home page is required to render one fewer
 * line rather than a placeholder for something nobody can open (PRODUCT.md, "Evidence
 * on Hand"). A regression here is silent in every other test: the page would still
 * render, it would just be advertising a 404.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { makeMockDb } from "@/lib/test/mock-db";
import { cardBlurb, FEATURED_OWNER, FEATURED_SLUGS, featuredListings } from "./featured";

const CREATOR_ID = "44444444-4444-4444-8444-444444444444";

/** The first featured slug, for the tests that need one real example. */
const SLUG = FEATURED_SLUGS[0];

let mock: ReturnType<typeof makeMockDb>;

function computed(overrides: Record<string, unknown> = {}) {
  return {
    artifact_class: "Harness",
    component_inventory: [{ kind: "skill", count: 1 }],
    file_count: 18,
    dir_depth: 3,
    bytes_text: 225_280,
    bytes_binary: 0,
    languages: { Python: 68_000, Shell: 32_000 },
    tree: [{ path: "README.md", size: 4_096, binary: false }],
    readme_html: "<p>Run it.</p>",
    dependencies: [],
    licence: { spdx: "MIT", verdict: "pass" },
    scan: { verdict: "pass", scanner_version: "2026.08.2", at: "2026-08-21T10:00:00.000Z" },
    computed_at: "2026-08-28T16:20:00.000Z",
    analyzer_version: "0.1.0",
    ...overrides,
  };
}

function seedCreator(handle = FEATURED_OWNER) {
  mock.seed("creator", [
    { id: CREATOR_ID, handle, payout_address: "0x0000000000000000000000000000000000000001", terms_version: "2026-08-29" },
  ]);
}

type SeedOptions = {
  published?: boolean;
  retired?: boolean;
  description?: string | null;
  updatePrice?: string;
  release?: "pass" | "fail" | "none";
  manifest?: boolean;
};

function seedListing(slug: string, options: SeedOptions = {}) {
  const id = `listing-${slug}`;
  mock.seed("listing", [
    ...mock.rows("listing"),
    {
      id,
      creator_id: CREATOR_ID,
      slug,
      source: "hosted",
      price_micro: "9000000",
      update_price_micro: options.updatePrice ?? "0",
      description: options.description === undefined ? `What ${slug} does.` : options.description,
      trigger_hint: "When you need it.",
      licence_spdx: "MIT",
      licence_verdict: "pass",
      published_at: options.published === false ? null : "2026-08-21T00:00:00.000Z",
      retired_at: options.retired ? "2026-08-25T00:00:00.000Z" : null,
    },
  ]);

  if (options.release === "none") return;
  mock.seed("release", [
    ...mock.rows("release"),
    {
      id: `release-${slug}`,
      listing_id: id,
      version: "1.0.0",
      git_ref: "refs/tags/v1.0.0",
      commit_sha: "a".repeat(40),
      artifact_sha256: "b".repeat(64),
      scan: options.release ?? "pass",
      manifest: options.manifest === false ? null : { computed: computed() },
      price_micro_at_publish: "9000000",
      update_price_micro_at_publish: options.updatePrice ?? "0",
      created_at: "2026-08-21T00:00:00.000Z",
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

describe("featuredListings", () => {
  it("returns nothing at all when the featured creator does not exist yet", async () => {
    expect(await featuredListings()).toEqual([]);
  });

  it("returns nothing when the creator exists but has published no examples", async () => {
    seedCreator();
    expect(await featuredListings()).toEqual([]);
  });

  it("reads the listing, the creator and the latest passing manifest", async () => {
    seedCreator();
    seedListing(SLUG, { description: "Rewrites machine prose.", updatePrice: "0" });

    const [item] = await featuredListings();
    expect(item.path).toBe(`${FEATURED_OWNER}/${SLUG}`);
    expect(item.href).toBe(`/${FEATURED_OWNER}/${SLUG}`);
    expect(item.description).toBe("Rewrites machine prose.");
    expect(item.triggerHint).toBe("When you need it.");
    expect(item.priceMicro).toBe(9_000_000n);
    expect(item.updatePriceMicro).toBe(0n);
    expect(item.artifactClass).toBe("Harness");
    expect(item.fileCount).toBe(18);
    expect(item.languages).toBe("Python 68% · Shell 32%");
  });

  it("keeps the declared order, not the database's", async () => {
    seedCreator();
    for (const slug of [...FEATURED_SLUGS].reverse()) seedListing(slug);

    expect((await featuredListings()).map((l) => l.slug)).toEqual([...FEATURED_SLUGS]);
  });

  it("omits a slug that has no listing rather than standing in for it", async () => {
    seedCreator();
    const [missing, ...present] = FEATURED_SLUGS;
    for (const slug of present) seedListing(slug);

    const slugs = (await featuredListings()).map((l) => l.slug);
    expect(slugs).toEqual(present);
    expect(slugs).not.toContain(missing);
  });

  it("omits a draft, which is unreachable by URL to everyone but its owner", async () => {
    seedCreator();
    seedListing(SLUG, { published: false });
    expect(await featuredListings()).toEqual([]);
  });

  it("omits a retired listing", async () => {
    seedCreator();
    seedListing(SLUG, { retired: true });
    expect(await featuredListings()).toEqual([]);
  });

  it("ignores a listing whose slug is not a featured one", async () => {
    seedCreator();
    seedListing("something-else");
    expect(await featuredListings()).toEqual([]);
  });

  it("keeps the price and drops the computed half when no release has passed the scan", async () => {
    seedCreator();
    seedListing(SLUG, { release: "fail" });

    const [item] = await featuredListings();
    expect(item.priceMicro).toBe(9_000_000n);
    expect(item.artifactClass).toBeNull();
    expect(item.fileCount).toBeNull();
    expect(item.languages).toBeNull();
  });

  it("drops the computed half whole rather than half, when the stored manifest is unusable (FR-52)", async () => {
    seedCreator();
    seedListing(SLUG, { manifest: false });

    const [item] = await featuredListings();
    expect(item.artifactClass).toBeNull();
    expect(item.fileCount).toBeNull();
    expect(item.languages).toBeNull();
  });

  it("carries a null description rather than inventing one", async () => {
    seedCreator();
    seedListing(SLUG, { description: null });
    expect((await featuredListings())[0].description).toBeNull();
  });
});

describe("cardBlurb", () => {
  it("uses the description, which is what the slot is for", () => {
    expect(cardBlurb({ description: "Rewrites prose.", triggerHint: "When a draft reads like a model wrote it, badly." })).toBe(
      "Rewrites prose.",
    );
  });

  it("falls back to the trigger hint when the hint fits whole and the description does not", () => {
    const long = "A long paragraph about the thing it does and every last one of its many limitations.";
    expect(cardBlurb({ description: long, triggerHint: "When drafts read wrong." })).toBe("When drafts read wrong.");
  });

  it("cuts the description when neither fits, rather than falling back to a cut hint", () => {
    const long = "A long paragraph about the thing it does and every last one of its many limitations.";
    const alsoLong = "Fetch this when you happen to be doing the exact thing that this listing was written for.";
    expect(cardBlurb({ description: long, triggerHint: alsoLong })).toBe("A long paragraph about the thing it does and every last one…");
  });

  it("uses whichever exists when only one does", () => {
    expect(cardBlurb({ description: "Rewrites prose.", triggerHint: null })).toBe("Rewrites prose.");
    expect(cardBlurb({ description: null, triggerHint: "When drafts read wrong." })).toBe("When drafts read wrong.");
  });

  it("cuts on a word boundary and says it cut", () => {
    const blurb = cardBlurb({ description: null, triggerHint: "one two three four five six seven eight nine ten eleven twelve thirteen" });
    expect(blurb).toBe("one two three four five six seven eight nine ten eleven twelve…");
  });

  it("does not leave a dangling comma or dash before the ellipsis", () => {
    const blurb = cardBlurb({ description: null, triggerHint: "one two three four five six seven eight nine ten eleven twelve, thirteen" });
    expect(blurb).toBe("one two three four five six seven eight nine ten eleven twelve…");
  });

  it("leaves a blurb that already fits alone", () => {
    expect(cardBlurb({ description: null, triggerHint: "Turns git log into release notes." })).toBe("Turns git log into release notes.");
  });

  it("returns null rather than inventing words for a listing with none", () => {
    expect(cardBlurb({ description: null, triggerHint: null })).toBeNull();
    expect(cardBlurb({ description: "   ", triggerHint: null })).toBeNull();
  });
});
