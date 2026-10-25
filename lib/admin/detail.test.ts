/**
 * The detail loaders. The properties that must never regress: no key hash leaves the
 * module, purchase and payout reads stay on the configured chain, and a malformed scan
 * report degrades rather than throws.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keyOf, loadCreatorDetail, loadListingDetail, salesSummaryOf, scanSummaryOf } from "@/lib/admin/detail";
import { resetDb, setDb, type Db } from "@/lib/db";
import type { ApiKeyRow } from "@/lib/db/types";
import { resetEnv } from "@/lib/env";
import { makeMockDb } from "@/lib/test/mock-db";

const LISTING = "11111111-1111-4111-8111-111111111111";
const DAY = 24 * 60 * 60 * 1000;

describe("scanSummaryOf", () => {
  it("puts blocking findings first, then by severity, and drops malformed ones", () => {
    const s = scanSummaryOf({
      scanned_at: "2026-09-10T00:00:00Z",
      checked: ["secrets", "osv"],
      findings: [
        { kind: "vulnerability", rule_id: "GHSA-low", severity: "LOW", description: "", blocking: false },
        { nonsense: true },
        { kind: "vulnerability", rule_id: "GHSA-high", severity: "HIGH", description: "", blocking: true },
        { kind: "secret", rule_id: "aws", severity: "CRITICAL", description: "", blocking: true, path: "deploy.sh", line: 3 },
      ],
      osv_error: "timeout",
    });
    expect(s.findings.map((f) => f.rule_id)).toEqual(["aws", "GHSA-high", "GHSA-low"]);
    expect(s).toMatchObject({ checked: ["secrets", "osv"], osvError: "timeout", scannedAt: "2026-09-10T00:00:00Z" });
  });

  it("reads null and garbage as an empty report", () => {
    expect(scanSummaryOf(null).findings).toEqual([]);
    expect(scanSummaryOf("nope")).toMatchObject({ findings: [], checked: [], error: null });
  });
});

describe("keyOf", () => {
  const row: ApiKeyRow = {
    id: "k1",
    creator_id: "c1",
    kind: "session",
    hash: "deadbeef",
    scopes: ["listings:write"],
    created_at: "2026-09-01T00:00:00Z",
    expires_at: "2026-09-02T00:00:00Z",
    revoked_at: null,
    revoked_reason: null,
    last_used_at: null,
  };

  it("never carries the hash", () => {
    expect(JSON.stringify(keyOf(row))).not.toContain("deadbeef");
    expect(keyOf(row)).not.toHaveProperty("hash");
  });

  it("reads an expired session key as not live", () => {
    expect(keyOf(row, Date.parse("2026-09-03T00:00:00Z")).live).toBe(false);
    expect(keyOf(row, Date.parse("2026-09-01T12:00:00Z")).live).toBe(true);
  });
});

describe("salesSummaryOf", () => {
  it("splits held from owed and leaves swept and revoked out of both", () => {
    const now = Date.parse("2026-09-13T00:00:00Z");
    const s = salesSummaryOf(
      [
        { gross_micro: "1000000", net_micro: "900000", revoked_at: null, payout_id: null, holdback_until: new Date(now + DAY).toISOString() },
        { gross_micro: 2000000, net_micro: 1800000, revoked_at: null, payout_id: null, holdback_until: new Date(now - DAY).toISOString() },
        { gross_micro: 3000000, net_micro: 2700000, revoked_at: null, payout_id: "p1", holdback_until: new Date(now - DAY).toISOString() },
        { gross_micro: 4000000, net_micro: 3600000, revoked_at: "2026-09-12T00:00:00Z", payout_id: null, holdback_until: new Date(now - DAY).toISOString() },
      ],
      now,
    );
    expect(s).toEqual({ sales: 3, grossMicro: 6000000n, netMicro: 5400000n, revoked: 1, heldMicro: 900000n, owedMicro: 1800000n });
  });
});

describe("loaders", () => {
  beforeEach(() => {
    process.env.X402_NETWORK = "base-sepolia";
    resetEnv();
    const mock = makeMockDb({
      creator: [{ id: "c1", handle: "adrian", payout_address: "0xabc", created_at: "2026-09-01T00:00:00Z" }],
      listing: [{ id: LISTING, creator_id: "c1", slug: "skills", published_at: "2026-09-02T00:00:00Z", retired_at: null, created_at: "2026-09-01T00:00:00Z" }],
      release: [
        { id: "r1", listing_id: LISTING, version: "1.0.0", scan: "pass", created_at: "2026-09-02T00:00:00Z", commit_sha: "a" },
        { id: "r2", listing_id: LISTING, version: "1.1.0", scan: "fail", created_at: "2026-09-03T00:00:00Z", commit_sha: "b" },
      ],
      purchase: [
        { id: "p1", listing_id: LISTING, chain_id: 84532, gross_micro: 1000000, net_micro: 900000, payout_id: null, revoked_at: null, holdback_until: "2020-01-01T00:00:00Z", buyer_address: "0xbuyer" },
        { id: "p2", listing_id: LISTING, chain_id: 8453, gross_micro: 5000000, net_micro: 4500000, payout_id: null, revoked_at: null, holdback_until: "2020-01-01T00:00:00Z", buyer_address: "0xbuyer" },
      ],
      payout: [
        { id: "po1", creator_id: "c1", chain_id: 84532, amount_micro: 900000, gas_micro: 0, to_address: "0xabc", status: "confirmed", created_at: "2026-09-10T00:00:00Z" },
        { id: "po2", creator_id: "c1", chain_id: 8453, amount_micro: 1, gas_micro: 0, to_address: "0xabc", status: "confirmed", created_at: "2026-09-10T00:00:00Z" },
      ],
      api_key: [{ id: "k1", creator_id: "c1", kind: "agent", hash: "deadbeef", scopes: [], created_at: "2026-09-01T00:00:00Z", expires_at: null, revoked_at: null, revoked_reason: null, last_used_at: null }],
      event: [
        { id: 1, name: "manifest_view", listing_id: LISTING, at: "2026-09-03T00:00:00Z", props: {} },
        { id: 2, name: "settled", listing_id: LISTING, at: "2026-09-04T00:00:00Z", props: { amount: 1 } },
      ],
    });
    setDb(mock.client as unknown as Db);
  });

  afterEach(() => {
    resetDb();
    delete process.env.X402_NETWORK;
    resetEnv();
  });

  it("returns null for an id that is not a uuid, without querying", async () => {
    expect(await loadListingDetail("../etc")).toBeNull();
  });

  it("loads one listing: newest release first, the passing one selling, one chain, views excluded", async () => {
    const d = (await loadListingDetail(LISTING))!;
    expect(d.creator.handle).toBe("adrian");
    expect(d.releases.map((r) => r.version)).toEqual(["1.1.0", "1.0.0"]);
    expect(d.sellable?.version).toBe("1.0.0");
    expect(d.sales).toMatchObject({ sales: 1, grossMicro: 1000000n, owedMicro: 900000n });
    expect(d.events.map((e) => e.name)).toEqual(["settled"]);
  });

  it("loads one creator by handle, case-insensitively, with no key hash and one chain", async () => {
    const d = (await loadCreatorDetail("Adrian"))!;
    expect(d.listings).toHaveLength(1);
    expect(d.payouts.map((p) => p.id)).toEqual(["po1"]);
    expect(d.sales.grossMicro).toBe(1000000n);
    expect(JSON.stringify(d, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toMatch(/deadbeef|0xbuyer/);
  });

  it("returns null for an unknown creator", async () => {
    expect(await loadCreatorDetail("nobody")).toBeNull();
  });
});
