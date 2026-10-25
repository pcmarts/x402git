/**
 * §14.1 for the author page: the shelf must be complete in the server HTML.
 *
 * Same proof as the product page's test — the component is awaited and rendered to
 * static markup, so what is asserted is the bytes a `curl` receives with scripting off.
 * What it guards is the same failure: a page whose HTML contains none of the things it
 * is a page about.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import type { ListingProfile } from "@/lib/web/github-profile";
import { makeMockDb } from "@/lib/test/mock-db";
import AuthorPageView, { generateMetadata } from "./page";

/** GitHub is not reachable from a unit test and must not be. */
const profile: ListingProfile = { repo: null, owner: null, stats: null };

vi.mock("@/lib/web/github-profile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/web/github-profile")>();
  return { ...actual, listingProfile: async () => profile };
});

const CREATOR_ID = "88888888-8888-4888-8888-888888888888";

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

function seedCreator() {
  mock.seed("creator", [
    { id: CREATOR_ID, handle: "examples", payout_address: "0x0000000000000000000000000000000000000001", terms_version: "2026-08-29" },
  ]);
}

function seedListing(slug: string, options: { live?: boolean } = {}) {
  const id = `listing-${slug}`;
  mock.seed("listing", [
    ...mock.rows("listing"),
    {
      id,
      creator_id: CREATOR_ID,
      slug,
      source: "github",
      price_micro: "9000000",
      update_price_micro: "0",
      description: `Rewrites ${slug} into something a person would have written.`,
      trigger_hint: "When a draft reads like a model wrote it.",
      published_at: options.live === false ? null : "2026-08-21T00:00:00.000Z",
      retired_at: null,
      created_at: "2026-08-01T00:00:00.000Z",
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
      update_price_micro_at_publish: "0",
      created_at: "2026-08-21T00:00:00.000Z",
    },
  ]);
  return id;
}

function purchase(listingId: string, address: string) {
  mock.seed("purchase", [
    ...mock.rows("purchase"),
    {
      id: `p-${mock.rows("purchase").length}`,
      listing_id: listingId,
      release_id: "r",
      buyer_address: address,
      kind: "new",
      source: "web",
      gross_micro: "9000000",
      fee_micro: "900000",
      net_micro: "8100000",
      all_versions: false,
      update_price_at_purchase: "0",
      granted_at: "2026-08-22T00:00:00.000Z",
      holdback_until: "2026-08-29T00:00:00.000Z",
      payout_id: null,
      revoked_at: null,
    },
  ]);
}

async function html(owner = "examples"): Promise<string> {
  const element = await AuthorPageView({ params: Promise.resolve({ owner }) });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = "https://x402git.com";
  resetEnv();
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  profile.repo = null;
  profile.owner = null;
  profile.stats = null;
});

afterEach(() => {
  resetDb();
  delete process.env.NEXT_PUBLIC_APP_URL;
  resetEnv();
});

describe("the author page, in the server HTML", () => {
  // 2026-08-30: the product page went compact — the person's counts, bio, site and
  // socials render here and only here, in the full creator strip.
  it("carries the person's whole profile — the metadata the product page no longer shows", async () => {
    seedCreator();
    seedListing("humanizer");
    profile.owner = {
      login: "examples",
      name: "Adrian Vance",
      avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
      bio: "Building tools for people who write.",
      blog: "https://adrian.dev/",
      company: "@somewhere",
      location: "Lisbon",
      twitter_username: "adrianvance",
      followers: 1_240,
      public_repos: 42,
      created_at: "2016-02-11T00:00:00Z",
      html_url: "https://github.com/examples",
    };
    profile.stats = { repos: 42, stars: 1_204, truncated: false };

    const markup = await html();

    expect(markup).toContain("Adrian Vance");
    expect(markup).toContain("Building tools for people who write.");
    expect(markup).toContain("adrian.dev");
    expect(markup).toContain("@somewhere · Lisbon");
    expect(markup).toContain("42 public repos");
    expect(markup).toContain("1,240 followers");
    expect(markup).toContain("on GitHub since 2016");
    expect(markup).toContain("1,204");
    expect(markup).toContain("stars across their public repositories");
    expect(markup).toContain('href="https://x.com/adrianvance"');
    expect(markup).toContain('href="https://github.com/examples"');
  });

  it("carries the handle and every live listing", async () => {
    seedCreator();
    seedListing("humanizer");
    seedListing("repo-digest");

    const markup = await html();

    expect(markup).toContain("<h1>examples</h1>");
    expect(markup).toContain("humanizer");
    expect(markup).toContain("repo-digest");
    expect(markup).toContain('href="/examples/humanizer"');
    expect(markup).toContain("$9");
  });

  it("shows installs, exactly, and never a buyer address (FR-40)", async () => {
    seedCreator();
    const id = seedListing("humanizer");
    purchase(id, "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    purchase(id, "0xfeedfacefeedfacefeedfacefeedfacefeedface");

    const markup = await html();

    expect(markup).toContain("2 installs");
    expect(markup).not.toContain("0xdeadbeef");
    expect(markup).not.toContain("0xfeedface");
  });

  it("prints no install line at all before the first purchase", async () => {
    seedCreator();
    seedListing("humanizer");
    expect(await html()).not.toContain("install");
  });

  it("is an empty shelf, not a 404, for a creator who has published nothing", async () => {
    seedCreator();
    const markup = await html();
    expect(markup).toContain("Nothing published yet");
    expect(markup).toContain("<h1>examples</h1>");
  });

  it("omits a draft, which is unreachable by URL to everyone but its owner", async () => {
    seedCreator();
    seedListing("secret", { live: false });
    const markup = await html();
    expect(markup).not.toContain("secret");
    expect(markup).toContain("Nothing published yet");
  });

  it("404s on an unknown handle and on a reserved one", async () => {
    await expect(html("nobody")).rejects.toThrow();
    seedCreator();
    await expect(html("docs")).rejects.toThrow();
  });

  it("does not link the platform count back to the page it is on", async () => {
    seedCreator();
    seedListing("humanizer");
    seedListing("repo-digest");
    profile.owner = { login: "examples", name: "Examples" };

    const markup = await html();
    // The strip's count is text here, not a link to this very page.
    expect(markup).toContain("2 repos on X402 Git");
    expect(markup).not.toContain('<a href="/examples">2 repos</a>');
  });
});

describe("generateMetadata", () => {
  it("describes the shelf with counts and slugs, never with the creator's own claims", async () => {
    seedCreator();
    seedListing("humanizer");

    const meta = await generateMetadata({ params: Promise.resolve({ owner: "examples" }) });
    expect(meta.title).toBe("examples");
    expect(String(meta.description)).toContain("1 repository for sale by examples");
    expect(String(meta.description)).toContain("humanizer");
    expect(String(meta.description)).not.toContain("Rewrites");
    expect(meta.alternates?.canonical).toBe("/examples");
  });

  it("is not indexed when there is nothing on it", async () => {
    seedCreator();
    const meta = await generateMetadata({ params: Promise.resolve({ owner: "examples" }) });
    expect(meta.robots).toEqual({ index: false });
  });

  it("is a not-found title for a handle nobody holds", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ owner: "nobody" }) });
    expect(meta.title).toBe("Not found");
  });
});
