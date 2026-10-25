import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { makeMockDb } from "@/lib/test/mock-db";
import { EMPTY_BLOB_SHA, MIN_BLOB_BYTES, loadCorpus, originality, overlapAgainst, significantBlobs } from "./originality";

const sha = (n: number) => n.toString(16).padStart(40, "0");

describe("significantBlobs (Quality Signals §5.3)", () => {
  it("drops the empty blob, which is in every Python repo", () => {
    const blobs = significantBlobs([
      { sha: EMPTY_BLOB_SHA, size: 0 },
      { sha: sha(1), size: 1000 },
    ]);
    expect(blobs).toEqual([sha(1)]);
  });

  it("drops trivial files, so a shared .gitkeep is not evidence of copying", () => {
    const blobs = significantBlobs([
      { sha: sha(2), size: MIN_BLOB_BYTES - 1 },
      { sha: sha(3), size: MIN_BLOB_BYTES },
    ]);
    expect(blobs).toEqual([sha(3)]);
  });

  it("deduplicates and sorts, so the stored array is stable", () => {
    expect(significantBlobs([{ sha: sha(9), size: 100 }, { sha: sha(1), size: 100 }, { sha: sha(9), size: 100 }])).toEqual([sha(1), sha(9)]);
  });
});

describe("overlap (FR-50)", () => {
  const mine = [sha(1), sha(2), sha(3), sha(4), sha(5), sha(6), sha(7), sha(8), sha(9), sha(10)];

  it("reports no overlap against an empty corpus", () => {
    expect(overlapAgainst(mine, [])).toMatchObject({ blob_overlap_ratio: 0, blobs_seen_elsewhere: 0, nearest_listing: null });
  });

  it("names the nearest listing and reports the highest single-listing ratio", () => {
    const result = overlapAgainst(mine, [
      { listingId: "a", label: "adrian/one", blobShas: mine.slice(0, 3) },
      { listingId: "b", label: "beth/two", blobShas: mine.slice(0, 6) },
    ]);
    expect(result.blob_overlap_ratio).toBe(0.6);
    expect(result.nearest_listing).toBe("beth/two");
    expect(result.blobs_seen_elsewhere).toBe(6);
    expect(result.derivative_of).toBeNull();
  });

  it("flags a derivative at 90% overlap with one live listing", () => {
    const result = overlapAgainst(mine, [{ listingId: "a", label: "adrian/one", blobShas: mine.slice(0, 9) }]);
    expect(result.blob_overlap_ratio).toBe(0.9);
    expect(result.derivative_of).toBe("adrian/one");
  });

  it("does not flag a derivative when the overlap is spread across several listings", () => {
    const result = overlapAgainst(mine, [
      { listingId: "a", label: "adrian/one", blobShas: mine.slice(0, 5) },
      { listingId: "b", label: "beth/two", blobShas: mine.slice(5) },
    ]);
    expect(result.blobs_seen_elsewhere).toBe(10);
    expect(result.blob_overlap_ratio).toBe(0.5);
    expect(result.derivative_of).toBeNull();
  });

  it("handles an artifact with no significant blobs", () => {
    expect(overlapAgainst([], [{ listingId: "a", label: "x/y", blobShas: [sha(1)] }])).toMatchObject({ blobs_total: 0, blob_overlap_ratio: 0 });
  });
});

describe("corpus loading", () => {
  let mock: ReturnType<typeof makeMockDb>;

  beforeEach(() => {
    mock = makeMockDb({
      creator: [{ id: "c1", handle: "adrian" }, { id: "c2", handle: "beth" }],
      listing: [
        { id: "mine", creator_id: "c1", slug: "widget", source: "github", published_at: "2026-01-01T00:00:00Z" },
        { id: "live", creator_id: "c2", slug: "gadget", source: "github", published_at: "2026-01-01T00:00:00Z" },
        { id: "draft", creator_id: "c2", slug: "sketch", source: "github", published_at: null },
        { id: "gone", creator_id: "c2", slug: "old", source: "github", published_at: "2026-01-01T00:00:00Z", retired_at: "2026-02-01T00:00:00Z" },
      ],
      release: [
        { id: "r-old", listing_id: "live", version: "1.0.0", scan: "pass", blob_shas: [sha(1)], created_at: "2026-01-01T00:00:00Z", price_micro_at_publish: "0", update_price_micro_at_publish: "0", git_ref: "v1.0.0", commit_sha: "a" },
        { id: "r-new", listing_id: "live", version: "2.0.0", scan: "pass", blob_shas: [sha(2), sha(3)], created_at: "2026-03-01T00:00:00Z", price_micro_at_publish: "0", update_price_micro_at_publish: "0", git_ref: "v2.0.0", commit_sha: "b" },
        { id: "r-draft", listing_id: "draft", version: "1.0.0", scan: "pass", blob_shas: [sha(4)], created_at: "2026-03-01T00:00:00Z", price_micro_at_publish: "0", update_price_micro_at_publish: "0", git_ref: "v1.0.0", commit_sha: "c" },
        { id: "r-gone", listing_id: "gone", version: "1.0.0", scan: "pass", blob_shas: [sha(5)], created_at: "2026-03-01T00:00:00Z", price_micro_at_publish: "0", update_price_micro_at_publish: "0", git_ref: "v1.0.0", commit_sha: "d" },
        { id: "r-mine", listing_id: "mine", version: "1.0.0", scan: "pass", blob_shas: [sha(2)], created_at: "2026-03-01T00:00:00Z", price_micro_at_publish: "0", update_price_micro_at_publish: "0", git_ref: "v1.0.0", commit_sha: "e" },
      ],
    });
    setDb(mock.client as unknown as Db);
  });
  afterEach(() => resetDb());

  it("uses the newest passing release of every other live listing", async () => {
    const corpus = await loadCorpus("mine");
    expect(corpus).toEqual([{ listingId: "live", label: "beth/gadget", blobShas: [sha(2), sha(3)] }]);
  });

  it("compares against the corpus without counting the listing's own history", async () => {
    const result = await originality([sha(2), sha(3), sha(7), sha(8)], "mine");
    expect(result.blob_overlap_ratio).toBe(0.5);
    expect(result.nearest_listing).toBe("beth/gadget");
  });
});
