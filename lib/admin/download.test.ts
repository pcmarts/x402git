/**
 * An operator's download of a release. What is pinned: it is never a purchase, it never
 * happens without an audit row naming who did it, and it refuses a release that is not
 * on the listing in the URL or has no stored bytes.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_DOWNLOAD_TTL_SECONDS, adminReleaseDownload } from "@/lib/admin/download";
import { resetDb, setDb, type Db } from "@/lib/db";
import { makeMockDb } from "@/lib/test/mock-db";

let mock: ReturnType<typeof makeMockDb>;

const PATH = "listing-1/1.0.0/abc.zip";

beforeEach(() => {
  mock = makeMockDb({
    creator: [{ id: "creator-1", handle: "adrian" }],
    listing: [
      { id: "listing-1", creator_id: "creator-1", slug: "humanizer" },
      { id: "listing-2", creator_id: "creator-1", slug: "other" },
    ],
    release: [
      { id: "release-1", listing_id: "listing-1", version: "1.0.0", storage_path: PATH, artifact_sha256: "abc", scan: "pass" },
      { id: "release-2", listing_id: "listing-1", version: "0.9.0", storage_path: null, artifact_sha256: null, scan: "fail" },
    ],
    purchase: [],
    event: [],
  });
  mock.storage.set("artifacts", new Map([[PATH, new Uint8Array([1, 2, 3])]]));
  setDb(mock.client as unknown as Db);
});

afterEach(() => resetDb());

describe("adminReleaseDownload", () => {
  it("signs a one-minute URL named for the release, and writes no purchase", async () => {
    const r = await adminReleaseDownload({ listingId: "listing-1", releaseId: "release-1", by: "pcmarts" });

    expect(r).toMatchObject({ ok: true, ref: "adrian/humanizer@1.0.0" });
    const url = r.ok ? r.url : "";
    expect(url).toContain(PATH);
    expect(url).toContain(`expires_in=${ADMIN_DOWNLOAD_TTL_SECONDS}`);
    expect(url).toContain(`download=${encodeURIComponent("humanizer-1.0.0.zip")}`);
    expect(mock.rows("purchase")).toHaveLength(0);
  });

  it("records who downloaded what, as an admin action", async () => {
    await adminReleaseDownload({ listingId: "listing-1", releaseId: "release-1", by: "pcmarts" });

    const events = mock.rows("event");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      name: "artifact_downloaded",
      listing_id: "listing-1",
      props: { ref: "adrian/humanizer@1.0.0", release_id: "release-1", sha256: "abc", by: "pcmarts", via: "admin" },
    });
  });

  it("refuses a release that belongs to a different listing than the URL names", async () => {
    const r = await adminReleaseDownload({ listingId: "listing-2", releaseId: "release-1", by: "pcmarts" });
    expect(r.ok).toBe(false);
    expect(mock.rows("event")).toHaveLength(0);
  });

  it("refuses a release with no stored artifact, and records nothing", async () => {
    const r = await adminReleaseDownload({ listingId: "listing-1", releaseId: "release-2", by: "pcmarts" });
    expect(r).toMatchObject({ ok: false });
    expect(mock.rows("event")).toHaveLength(0);
  });

  it("refuses to download when the audit row does not save", async () => {
    // Only the event insert fails; the reads still come from the seeded rows.
    const real = makeMockDb({
      creator: mock.rows("creator"),
      listing: mock.rows("listing"),
      release: mock.rows("release"),
    });
    mock.client.from = (table: string) =>
      table === "event" ? { insert: async () => ({ data: null, error: { message: "insert failed" } }) } : real.client.from(table);

    const r = await adminReleaseDownload({ listingId: "listing-1", releaseId: "release-1", by: "pcmarts" });
    expect(r).toMatchObject({ ok: false });
    expect(r.ok ? "" : r.message).toContain("audit row did not save");
  });
});
