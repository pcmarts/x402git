import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { RESALE_COMPATIBLE_SPDX, applyLicenceGate, licenceGate } from "@/lib/licence";
import { makeMockDb } from "@/lib/test/mock-db";

describe("licence gate (FR-11, Quality Signals §11.5)", () => {
  it("passes every resale-compatible SPDX id", () => {
    for (const spdx of RESALE_COMPATIBLE_SPDX) {
      expect(licenceGate({ spdx, hasLicenceFile: true })).toMatchObject({ verdict: "pass", spdx, blocking: false });
    }
  });

  it("is case-insensitive and returns the canonical id", () => {
    expect(licenceGate({ spdx: "mit", hasLicenceFile: true })).toMatchObject({ verdict: "pass", spdx: "MIT" });
    expect(licenceGate({ spdx: "apache-2.0", hasLicenceFile: true })).toMatchObject({ verdict: "pass", spdx: "Apache-2.0" });
  });

  it("blocks when there is no licence at all — resale would infringe", () => {
    const gate = licenceGate({ spdx: null, hasLicenceFile: false });
    expect(gate).toMatchObject({ verdict: "block", spdx: null, blocking: true });
    expect(gate.reason).toMatch(/all rights reserved/i);
  });

  it("does not block NOASSERTION — linux, ffmpeg and node all return it", () => {
    for (const spdx of ["NOASSERTION", "noassertion", ""]) {
      expect(licenceGate({ spdx, hasLicenceFile: true })).toMatchObject({ verdict: "manual", blocking: false });
    }
  });

  it("routes a recognised but not resale-compatible licence to manual, not block", () => {
    const gate = licenceGate({ spdx: "GPL-3.0", hasLicenceFile: true });
    expect(gate).toMatchObject({ verdict: "manual", spdx: "GPL-3.0", blocking: false });
    expect(gate.reason).toMatch(/not on the resale-compatible list/);
  });

  it("treats a missing spdx with a file present as manual, not block", () => {
    expect(licenceGate({ spdx: undefined, hasLicenceFile: true }).verdict).toBe("manual");
  });
});

describe("applyLicenceGate", () => {
  let mock: ReturnType<typeof makeMockDb>;

  beforeEach(() => {
    mock = makeMockDb({ listing: [{ id: "l1", creator_id: "c1", slug: "widget", source: "github" }] });
    setDb(mock.client as unknown as Db);
  });
  afterEach(() => resetDb());

  it("writes licence_spdx and licence_verdict onto the listing", async () => {
    await applyLicenceGate("l1", { spdx: "MIT", hasLicenceFile: true });
    expect(mock.rows("listing")[0]).toMatchObject({ licence_spdx: "MIT", licence_verdict: "pass" });
  });

  it("re-runs on every cut, so removing the LICENSE flips the verdict", async () => {
    await applyLicenceGate("l1", { spdx: "MIT", hasLicenceFile: true });
    await applyLicenceGate("l1", { spdx: null, hasLicenceFile: false });
    expect(mock.rows("listing")[0]).toMatchObject({ licence_spdx: null, licence_verdict: "block" });
  });
});
