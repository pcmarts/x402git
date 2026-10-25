import { describe, expect, it } from "vitest";
import { aiCatalog, GET, SPEC_VERSION } from "./route";

const catalog = aiCatalog("https://x402git.com");

describe("GET /.well-known/ai-catalog.json (ARD)", () => {
  it("has a spec version, a host with a stable identifier, and entries", () => {
    expect(catalog.specVersion).toBe(SPEC_VERSION);
    expect(catalog.host.identifier).toBe("x402git.com");
    expect(catalog.host.displayName).toBeTruthy();
    expect(catalog.entries.length).toBeGreaterThan(0);
  });

  it("gives every entry a urn:air identifier scoped to the fqdn", () => {
    for (const entry of catalog.entries) {
      expect(entry.identifier, entry.displayName).toMatch(/^urn:air:x402git\.com:[a-z0-9-]+:[a-z0-9-]+$/);
    }
  });

  it("gives every entry exactly one of url or data, and a media type", () => {
    for (const entry of catalog.entries) {
      expect(entry.type, entry.identifier).toMatch(/\//);
      expect("url" in entry, entry.identifier).toBe(true);
      expect("data" in entry, entry.identifier).toBe(false);
      expect(entry.url.startsWith("https://x402git.com"), entry.identifier).toBe(true);
    }
  });

  it("gives every entry 2–5 representative queries for a registry to embed", () => {
    for (const entry of catalog.entries) {
      expect(entry.representativeQueries.length, entry.identifier).toBeGreaterThanOrEqual(2);
      expect(entry.representativeQueries.length, entry.identifier).toBeLessThanOrEqual(5);
    }
  });

  it("names the other discovery documents rather than restating them", () => {
    const urls = catalog.entries.map((e) => e.url);
    expect(urls).toContain("https://x402git.com/.well-known/mcp/server-card.json");
    expect(urls).toContain("https://x402git.com/.well-known/api-catalog");
    expect(urls).toContain("https://x402git.com/api/openapi.json");
  });

  it("is JSON with open CORS, as the spec asks by name", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
