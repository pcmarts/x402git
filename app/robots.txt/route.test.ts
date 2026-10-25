import { describe, expect, it } from "vitest";
import { GET } from "./route";

async function body(): Promise<string> {
  const res = await GET();
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/plain");
  return await res.text();
}

describe("GET /robots.txt", () => {
  it("keeps the crawl rules it had before the Content-Signal line was added", async () => {
    const text = await body();
    expect(text.startsWith("User-Agent: *\nAllow: /\n")).toBe(true);
    for (const line of ["Disallow: /dashboard", "Disallow: /signin", "Disallow: /api/"]) {
      expect(text).toContain(line);
    }
    expect(text).toMatch(/^Sitemap: .+\/sitemap\.xml$/m);
    expect(text).toMatch(/^Host: /m);
  });

  it("lets an agent reach the buy-side funnel, and nothing else under /api/", async () => {
    const text = await body();
    for (const path of ["/api/r/", "/api/v/", "/api/label/", "/api/snippet/", "/api/md/", "/api/openapi.json", "/api/terms"]) {
      expect(text).toContain(`Allow: ${path}`);
    }
    // Not on the list, so `Disallow: /api/` still covers them.
    for (const path of ["/api/mcp", "/api/creators", "/api/listings", "/api/auth/", "/api/webhooks/"]) {
      expect(text).not.toContain(`Allow: ${path}`);
    }
  });

  it("puts every Allow before the Disallow, for first-match-wins parsers", async () => {
    const lines = (await body()).split("\n");
    const lastAllow = lines.findLastIndex((l) => l.startsWith("Allow:"));
    const firstDisallow = lines.findIndex((l) => l.startsWith("Disallow:"));
    expect(lastAllow).toBeLessThan(firstDisallow);
  });

  it("declares all three content signals, inside the user-agent block", async () => {
    const text = await body();
    expect(text).toContain("Content-Signal: search=yes, ai-input=yes, ai-train=no");
    // Inside the block: before the blank line that ends it.
    expect(text.split("\n\n")[0]).toContain("Content-Signal:");
  });

  it("points at the ARD manifest with Agentmap", async () => {
    expect(await body()).toMatch(/^Agentmap: .+\/\.well-known\/ai-catalog\.json$/m);
  });
});
