import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /api/terms (FR-6)", () => {
  it("returns version, url and the sha256 of the served bytes", async () => {
    const res = await GET();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.version).toBe("2026-09-16");
    expect(body.url).toMatch(/\/terms\.md$/);
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is cacheable: it is the same answer for everyone", async () => {
    const res = await GET();
    expect(res.headers.get("cache-control")).toContain("public");
  });
});
