/**
 * GET /.well-known/mcp/server-card.json — SEP-1649. The card for the buy-side MCP
 * server at /api/mcp (FR-31), at the origin-level address a client looks for before it
 * has been told anything.
 *
 * Two shapes in one document, on purpose.
 *
 * The card proper is SEP-1649's: `$schema`, `name`, `version`, `description` required,
 * `remotes[]` carrying the Streamable HTTP endpoint and the protocol versions the SDK
 * we ship actually accepts. `SUPPORTED_PROTOCOL_VERSIONS` is imported rather than
 * typed out, so an SDK upgrade cannot leave this document claiming yesterday's wire.
 *
 * Alongside it, `serverInfo`, `transport` and `capabilities` mirror what `initialize`
 * returns. They are not in SEP-1649 — the SEP is unmerged and the readers in the field
 * (isitagentready's scanner among them) predate its flattening — and they are cheap
 * insurance: an old reader finds `serverInfo.name`, a new one finds `name`, and both
 * are the same two values from lib/mcp/server.ts.
 *
 * `tools` is names only. The schemas, titles and payment metadata are what `tools/list`
 * is for, and a copy of them here would be a second contract to keep in step with
 * lib/mcp/server.ts — which is exactly what the four `wraps GET /api/…` descriptions
 * refuse to be. Names are enough to decide whether to connect.
 */

import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { NextResponse } from "next/server";
import { appUrl } from "@/lib/env";
import { handle } from "@/lib/errors";
import { MCP_SERVER_DESCRIPTION, MCP_SERVER_NAME, MCP_SERVER_TITLE, MCP_SERVER_VERSION, mcpServerInfo, TOOL_NAMES } from "@/lib/mcp/server";

export const dynamic = "force-dynamic";

const SCHEMA_URL = "https://raw.githubusercontent.com/modelcontextprotocol/experimental-ext-server-card/main/schema.json";

export function serverCard(base: string) {
  const endpoint = `${base}/api/mcp`;
  const info = mcpServerInfo(base);

  return {
    $schema: SCHEMA_URL,
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
    title: MCP_SERVER_TITLE,
    description: MCP_SERVER_DESCRIPTION,
    websiteUrl: base,
    // The same `repository` object as server.json (repo root); both schemas define it.
    repository: { url: "https://github.com/pcmarts/x402git", source: "github" },
    icons: info.icons,
    remotes: [
      {
        type: "streamable-http" as const,
        url: endpoint,
        supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
      },
    ],

    // The `initialize` view of the same server, for readers written before SEP-1649.
    serverInfo: info,
    transport: { type: "streamable-http" as const, url: endpoint, endpoint },
    capabilities: { tools: { listChanged: false } },
    tools: [...TOOL_NAMES],

    documentation: `${base}/docs#mcp`,
  };
}

export const GET = handle(async () =>
  new NextResponse(`${JSON.stringify(serverCard(appUrl()), null, 2)}\n`, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      // A card is public and carries no credential; a browser-side client should be
      // able to read it, the same reason /api/mcp opens CORS.
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
    },
  }),
);
