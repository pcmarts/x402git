import { describe, expect, it } from "vitest";
import { ERROR_CODES, ERRORS } from "@/lib/errors";
import { registeredRoutes } from "@/lib/openapi/registry";
import "@/lib/openapi/routes";
import { RECOVERY } from "@/lib/web/error-recovery";
import { docsMarkdown, errorsMarkdown, homeMarkdown, howItWorksMarkdown } from "@/lib/web/markdown";

const BASE = "https://x402git.com";

describe("homeMarkdown", () => {
  const md = homeMarkdown(BASE);

  it("is an index of the machine surface, not a retelling of the page", () => {
    for (const url of [
      `${BASE}/api/openapi.json`,
      `${BASE}/api/mcp`,
      `${BASE}/.well-known/api-catalog`,
      `${BASE}/.well-known/ai-catalog.json`,
      `${BASE}/.well-known/mcp/server-card.json`,
      `${BASE}/.well-known/agent-skills/buy-a-repo/SKILL.md`,
      `${BASE}/sitemap.xml`,
      `${BASE}/api/health`,
    ]) {
      expect(md, url).toContain(url);
    }
  });

  it("states the two facts an agent needs before it parses anything", () => {
    expect(md).toContain("micro-USDC");
    expect(md).toContain("10%");
  });
});

describe("howItWorksMarkdown", () => {
  it("hands the procedures to the skills rather than restating them", () => {
    const md = howItWorksMarkdown(BASE);
    expect(md).toContain("/.well-known/agent-skills/buy-a-repo/SKILL.md");
    expect(md).toContain("/.well-known/agent-skills/sell-a-repo/SKILL.md");
    expect(md).toContain(`${BASE}/how-it-works`);
  });
});

describe("docsMarkdown", () => {
  const md = docsMarkdown(BASE);

  it("prints every registered route — the same array the OpenAPI document walks", () => {
    const routes = registeredRoutes();
    expect(routes.length).toBeGreaterThan(20);
    for (const route of routes) {
      expect(md, `${route.method} ${route.path}`).toContain(`### ${route.method.toUpperCase()} ${route.path}`);
    }
  });

  it("says which authentication each route needs", () => {
    expect(md).toContain("`Authorization: Bearer x4c_live_…`");
    expect(md).toContain("`X-Wallet-Signature`");
    expect(md).toContain("Auth: public");
  });
});

describe("errorsMarkdown", () => {
  const md = errorsMarkdown(BASE);

  it("covers every code in the catalogue, with its status", () => {
    for (const code of ERROR_CODES) {
      expect(md, code).toContain(`### \`${code}\``);
      expect(md, code).toContain(`HTTP ${ERRORS[code].status}. ${ERRORS[code].message}`);
    }
  });

  it("prints the recovery line the HTML reading prints, from the one shared map", () => {
    const [code, recovery] = Object.entries(RECOVERY)[0];
    expect(md, code).toContain(recovery as string);
  });
});
