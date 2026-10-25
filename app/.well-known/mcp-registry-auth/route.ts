/**
 * GET /.well-known/mcp-registry-auth — proof of domain for the official MCP Registry.
 *
 * The registry (registry.modelcontextprotocol.io) lets a domain publish servers under its
 * reverse-DNS namespace — `com.x402git/*` — once it can sign a challenge with a key
 * whose public half is served here. `mcp-publisher login http --domain x402git.com`
 * fetches this file, then `mcp-publisher publish` sends `server.json` (repo root).
 *
 * The public key is public by definition; the private half lives in
 * `mcp-registry-key.local.json` (gitignored via `*.local.json`) and is used only from a
 * terminal at publish time. Rotating it means a new key pair, a new line here, a deploy,
 * and a fresh login. Format per the registry's authentication guide:
 * `v=MCPv1; k=ed25519; p=<base64 public key>`.
 */

import { NextResponse } from "next/server";
import { handle } from "@/lib/errors";

export const MCP_REGISTRY_PUBLIC_KEY = "GBhsTin/vKbUZbwm1nRPHaBxJI1RD1s9JL5uxzIpO4w=";

export const GET = handle(async () => {
  return new NextResponse(`v=MCPv1; k=ed25519; p=${MCP_REGISTRY_PUBLIC_KEY}`, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
});
