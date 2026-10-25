import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { webMcpScript } from "./webmcp";

type Tool = { name: string; description: string; inputSchema: unknown; execute: () => Promise<{ content: { text: string }[] }> };

/** Runs the inline script against a fake browser and returns whatever it registered. */
function run(shape: "registerTool" | "provideContext" | "none", fetched: unknown = { ok: true }) {
  const registered: Tool[] = [];
  const modelContext =
    shape === "registerTool"
      ? { registerTool: (t: Tool) => registered.push(t) }
      : shape === "provideContext"
        ? { provideContext: ({ tools }: { tools: Tool[] }) => registered.push(...tools) }
        : undefined;

  const context = {
    navigator: modelContext ? { modelContext } : {},
    location: { origin: "https://x402git.com" },
    fetch: async () => ({ ok: true, json: async () => fetched }),
  };
  createContext(context);
  runInContext(webMcpScript("examples", "humanizer"), context);
  return registered;
}

describe("WebMCP tools on a listing page", () => {
  it("registers four read-only tools with the fields the API requires", () => {
    const tools = run("registerTool");
    expect(tools.map((t) => t.name)).toEqual(["get_listing_manifest", "get_listing_price", "get_listing_releases", "how_to_buy_listing"]);
    for (const tool of tools) {
      expect(tool.description.length, tool.name).toBeGreaterThan(20);
      expect(tool.inputSchema, tool.name).toEqual({ type: "object", properties: {}, required: [] });
      expect(typeof tool.execute, tool.name).toBe("function");
    }
  });

  it("falls back to the earlier provideContext spelling", () => {
    expect(run("provideContext").map((t) => t.name)).toHaveLength(4);
  });

  it("does nothing at all in a browser without the API", () => {
    expect(() => run("none")).not.toThrow();
  });

  it("answers from this origin's public routes for the listing on the page", async () => {
    const tools = run("registerTool", { owner: "examples" });
    const manifest = await tools[0].execute();
    expect(JSON.parse(manifest.content[0].text)).toEqual({ owner: "examples" });

    const how = JSON.parse((await tools[3].execute()).content[0].text);
    expect(how.resource_endpoint).toBe("https://x402git.com/api/r/examples/humanizer");
    expect(how.skill).toBe("https://x402git.com/.well-known/agent-skills/buy-a-repo/SKILL.md");
    expect(how.steps.length).toBeGreaterThan(2);
  });

  it("cannot break out of the script tag", () => {
    expect(webMcpScript("</script><script>alert(1)</script>", "x")).not.toContain("</script>");
  });
});
