import { describe, expect, it } from "vitest";
import nextConfig from "@/next.config";
import { GET, apiCatalog } from "./route";

describe("GET /.well-known/api-catalog (RFC 9727)", () => {
  it("is served as a linkset, cacheable and readable from a browser", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/linkset+json");
    expect(res.headers.get("cache-control")).toContain("public");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("anchors the API and the MCP server, with absolute targets", async () => {
    const body = apiCatalog("https://x402git.com");
    const anchors = body.linkset.map((c) => c.anchor);
    expect(anchors).toEqual(["https://x402git.com/api", "https://x402git.com/api/mcp"]);

    const api = body.linkset[0];
    expect(api["service-desc"]).toEqual([expect.objectContaining({ href: "https://x402git.com/api/openapi.json" })]);
    expect(api["service-doc"]).toEqual([expect.objectContaining({ href: "https://x402git.com/docs" })]);
    expect(api["terms-of-service"]).toEqual([expect.objectContaining({ href: "https://x402git.com/api/terms" })]);
  });

  it("parses as JSON when served", async () => {
    const res = await GET();
    expect(JSON.parse(await res.text()).linkset).toHaveLength(2);
  });
});

describe("Link headers (RFC 8288)", () => {
  const rules = async () => (await nextConfig.headers?.()) ?? [];
  const linkValue = (rule: { headers: { key: string; value: string }[] }) =>
    rule.headers.find((h) => h.key === "Link")?.value ?? "";

  it("points the home page at the catalogue, the description, the docs and the terms", async () => {
    const home = (await rules()).find((r) => r.source === "/");
    expect(home).toBeDefined();
    const link = linkValue(home as never);
    for (const rel of ["api-catalog", "service-desc", "service-doc", "terms-of-service"]) {
      expect(link).toContain(`rel="${rel}"`);
    }
    expect(link).toContain("</.well-known/api-catalog>");
    expect(link).toContain("</api/openapi.json>");
  });

  it("keeps the two-segment rule off /api/*", async () => {
    const twoSegment = (await rules()).find((r) => r.source.includes(":slug"));
    expect(twoSegment?.source).toContain("(?!api/)");
  });
});
