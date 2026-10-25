/**
 * lib/web/earnings.test.ts — W1.5.
 *
 * The dashboard earnings totals must come from the canonical ledger (`earningsFor`),
 * which aggregates over every row, not from the displayed `.limit(200)` page. With more
 * than 200 sales the old loader understated earnings and diverged from `GET /api/earnings`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import type { CreatorRow } from "@/lib/db/types";
import { resetEnv } from "@/lib/env";
import { earningsFor } from "@/lib/payouts/ledger";
import { seedListing, seedPurchase } from "@/lib/test/fixtures";
import { makeMockDb } from "@/lib/test/mock-db";
import { earningsForCreator } from "@/lib/web/loaders";

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

describe("earningsForCreator (W1.5)", () => {
  it("sums every sale via the canonical ledger, not just the newest 200-row page", async () => {
    const seed = seedListing(mock, { priceMicro: "9000000", releases: [{ version: "1.0.0" }] });
    const creator = mock.rows("creator")[0] as CreatorRow;

    // 250 released sales — past the old `.limit(200)` page boundary.
    for (let i = 0; i < 250; i++) {
      seedPurchase(mock, {
        listingId: seed.listingId,
        releaseId: seed.latest.id,
        buyer: `0x${i.toString(16).padStart(40, "0")}`,
        grossMicro: "9000000",
        grantedAt: new Date(Date.now() - (i + 30) * 86_400_000).toISOString(),
      });
    }

    const view = await earningsForCreator(creator);
    const canonical = await earningsFor(creator);

    // The totals cover all 250, not the 200 the loader displays.
    expect(view.grossMicro).toBe(9_000_000n * 250n);
    expect(view.feeMicro).toBe(900_000n * 250n);
    expect(view.netMicro).toBe(8_100_000n * 250n);

    // And they equal the canonical ledger's totals exactly.
    expect(view.grossMicro).toBe(canonical.grossMicro);
    expect(view.feeMicro).toBe(canonical.feeMicro);
    expect(view.netMicro).toBe(canonical.netMicro);
    expect(view.withdrawableMicro).toBe(canonical.withdrawableMicro);
    expect(view.heldMicro).toBe(canonical.heldMicro);

    // The page is still used only for the displayed rows.
    expect(view.sales).toHaveLength(200);
  });
});
