import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MCP_SERVER_VERSION } from "@/lib/mcp/server";
import { GET, MCP_REGISTRY_PUBLIC_KEY } from "./route";

describe("the official MCP Registry listing (server.json + /.well-known/mcp-registry-auth)", () => {
  it("serves the domain proof in the registry's format", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe(`v=MCPv1; k=ed25519; p=${MCP_REGISTRY_PUBLIC_KEY}`);
    // 32 raw bytes of Ed25519 public key, base64.
    expect(Buffer.from(MCP_REGISTRY_PUBLIC_KEY, "base64")).toHaveLength(32);
  });

  it("publishes the version the server announces, at the production endpoint", () => {
    const server = JSON.parse(readFileSync(new URL("../../../server.json", import.meta.url), "utf8"));
    expect(server.name).toBe("com.x402git/git-x402");
    expect(server.version).toBe(MCP_SERVER_VERSION);
    expect(server.remotes).toEqual([{ type: "streamable-http", url: "https://x402git.com/api/mcp" }]);
    expect(server.description.length).toBeLessThanOrEqual(100);
    // The schema's Repository object: `url` and `source` are both required.
    expect(server.repository).toEqual({ url: "https://github.com/pcmarts/x402git", source: "github" });
  });
});
