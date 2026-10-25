/**
 * lib/mcp/tool-docs.ts — the MCP tools as the /docs page lists them.
 *
 * A leaf with no imports, so the page does not pull the server (and the database client
 * behind it) in to print six rows. `server.test.ts` holds the names equal to
 * `TOOL_NAMES`, in order, so a seventh tool cannot ship undocumented.
 */

export type McpToolDoc = {
  name: string;
  does: string;
  /** The GET path the tool is the same code path as, or null when it wraps nothing. */
  wraps: string | null;
};

export const MCP_TOOL_DOCS: McpToolDoc[] = [
  { name: "search_listings", does: "Find live repos and agent skills by what they do. Free, no wallet.", wraps: null },
  {
    name: "how_to_buy",
    does: "Whether a listing is for sale, its price, the page to buy on, the skill and the endpoint. Free, no wallet.",
    wraps: null,
  },
  { name: "get_listing", does: "The free manifest: file tree, licence, dependencies, security scan.", wraps: "/api/label/:owner/:slug" },
  { name: "check_version", does: "The latest version, and what the next fetch costs this wallet.", wraps: "/api/v/:owner/:slug" },
  { name: "purchase", does: "Buy the latest release over x402 with a payment you signed locally.", wraps: "/api/r/:owner/:slug" },
  { name: "fetch_release", does: "Re-fetch a version this wallet already owns. Free, forever.", wraps: "/api/r/:owner/:slug/v/:version" },
];
