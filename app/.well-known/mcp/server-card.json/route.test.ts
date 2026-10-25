import { readFileSync } from "node:fs";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { MCP_SERVER_NAME, MCP_SERVER_VERSION, mcpServerInfo, TOOL_NAMES } from "@/lib/mcp/server";
import { GET, serverCard } from "./route";

describe("GET /.well-known/mcp/server-card.json (SEP-1649)", () => {
  const card = serverCard("https://x402git.com");

  it("carries the four required SEP-1649 fields", () => {
    for (const field of ["$schema", "name", "version", "description"] as const) {
      expect(card[field], field).toBeTruthy();
    }
  });

  it("names the Streamable HTTP endpoint and the versions the SDK actually speaks", () => {
    expect(card.remotes).toEqual([
      { type: "streamable-http", url: "https://x402git.com/api/mcp", supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS },
    ]);
  });

  it("is the same server as lib/mcp/server.ts, not a description of one", () => {
    expect(card.name).toBe(MCP_SERVER_NAME);
    expect(card.version).toBe(MCP_SERVER_VERSION);
    expect(card.tools).toEqual([...TOOL_NAMES]);
  });

  it("also answers the pre-SEP shape, so an older reader finds the same two values", () => {
    expect(card.serverInfo).toEqual(mcpServerInfo("https://x402git.com"));
    expect(card.transport.url).toBe(card.remotes[0].url);
    expect(card.capabilities.tools).toBeDefined();
  });

  it("carries the description, homepage and icon directories build a listing page from", () => {
    expect(card.serverInfo.description).toBe(card.description);
    expect(card.serverInfo.websiteUrl).toBe("https://x402git.com");
    expect(card.icons).toContainEqual({ src: "https://x402git.com/icon-512.png", mimeType: "image/png", sizes: ["512x512"] });
  });

  it("points at the public source repository, the same object server.json publishes", () => {
    const server = JSON.parse(readFileSync(new URL("../../../../server.json", import.meta.url), "utf8"));
    expect(card.repository).toEqual({ url: "https://github.com/pcmarts/x402git", source: "github" });
    expect(card.repository).toEqual(server.repository);
  });

  it("is JSON, cacheable, and readable from a browser", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(JSON.parse(await res.text()).name).toBe(MCP_SERVER_NAME);
  });
});
