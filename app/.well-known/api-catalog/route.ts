/**
 * GET /.well-known/api-catalog — the machine surface, at the one URL an agent can guess
 * without being told (RFC 9727). §9 lists the routes; this is how a caller that has
 * never read §9 finds them.
 *
 * The body is a linkset (RFC 9264, `application/linkset+json`): link context objects,
 * each with an `anchor` and one array of targets per IANA relation. Two anchors — the
 * HTTP API and the MCP server — because they are two ways in, documented in two places.
 *
 * Nothing here is a new fact. `service-desc` is the generated OpenAPI document (FR-33),
 * `service-doc` is /docs, which renders from the same route registry, and
 * `terms-of-service` is GET /api/terms (FR-6). A route added to the registry appears in
 * all three without this file changing; the catalogue names documents, not endpoints.
 *
 * The Link headers that point here are in next.config.ts.
 */

import { NextResponse } from "next/server";
import { appUrl } from "@/lib/env";
import { handle } from "@/lib/errors";

// `appUrl()` is read per request rather than baked at build, so a preview deployment
// advertises its own host instead of production's.
export const dynamic = "force-dynamic";

/** RFC 9264 §4.2: a target IRI plus its attributes. */
type Target = { href: string; type: string; title: string };
type LinkContext = { anchor: string } & Record<string, Target[] | string>;

export function apiCatalog(base: string): { linkset: LinkContext[] } {
  return {
    linkset: [
      {
        anchor: `${base}/api`,
        "service-desc": [
          {
            href: `${base}/api/openapi.json`,
            type: "application/json",
            title: "OpenAPI 3.1 description of every route, generated from the schemas",
          },
        ],
        "service-doc": [
          {
            href: `${base}/docs`,
            type: "text/html",
            title: "Route list, authentication and the error catalogue",
          },
        ],
        "terms-of-service": [
          {
            href: `${base}/api/terms`,
            type: "application/json",
            title: "Creator terms: version, URL, and the sha256 of the served bytes",
          },
        ],
        status: [
          {
            href: `${base}/api/health`,
            type: "application/json",
            title: "Whether the platform is answering, and whether it can reach its database",
          },
        ],
        describedby: [
          {
            href: `${base}/how-it-works`,
            type: "text/html",
            title: "What a listing is, what payment buys, and what arrives",
          },
        ],
      },
      {
        anchor: `${base}/api/mcp`,
        "service-doc": [
          {
            href: `${base}/docs#mcp`,
            type: "text/html",
            title: "Buy-side MCP server over Streamable HTTP",
          },
        ],
      },
    ],
  };
}

export const GET = handle(async () =>
  // Not `NextResponse.json`: the media type is the linkset's, not `application/json`,
  // and it is pretty-printed because a person curling this is reading it. CORS is open
  // because it is a public document with no credential attached — the same reason
  // /api/mcp opens it.
  new NextResponse(`${JSON.stringify(apiCatalog(appUrl()), null, 2)}\n`, {
    headers: {
      "content-type": "application/linkset+json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
    },
  }),
);
