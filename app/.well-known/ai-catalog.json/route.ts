/**
 * GET /.well-known/ai-catalog.json — the ARD capability manifest
 * (agenticresourcediscovery.org).
 *
 * The third discovery document at this origin, and the one that names the other two.
 * /.well-known/api-catalog answers "what documents describe this HTTP API"; the MCP
 * server card answers "how do I connect to the MCP server"; this one answers the
 * question a registry asks — "what can this host do, and when would I want it".
 *
 * That last part is `representativeQueries`. They are not marketing copy: registries
 * embed them to decide whether to surface this host at all, so each one is a request an
 * agent would actually make in the words it would use. Two to five per entry, per spec.
 *
 * Every entry points at a document that exists on this origin and is reachable without
 * a credential. Nothing here is embedded (`data`) — the spec allows exactly one of
 * `url` or `data`, and a URL cannot go stale the way a copy can.
 *
 * The other two pointers the spec defines are the `Agentmap:` line in robots.txt and
 * the `<link rel="ai-catalog">` in app/layout.tsx. The third is a DNS record, which is
 * not published — see docs/agent-discovery.md for why.
 */

import { NextResponse } from "next/server";
import { BUY_SKILL_PATH } from "@/lib/buy-links";
import { appUrl } from "@/lib/env";
import { handle } from "@/lib/errors";
import { SKILL_DESCRIPTIONS } from "@/lib/skills";

export const dynamic = "force-dynamic";

export const SPEC_VERSION = "1.0";

export function aiCatalog(base: string) {
  // `urn:air:<fqdn>:<namespace>:<name>` — the fqdn, so a port on localhost cannot
  // break the URN's own delimiter.
  const fqdn = new URL(base).hostname;
  const urn = (namespace: string, name: string) => `urn:air:${fqdn}:${namespace}:${name}`;

  return {
    specVersion: SPEC_VERSION,
    host: {
      identifier: fqdn,
      displayName: "X402 Git",
      description:
        "Paid access to private git repositories over x402/USDC, for humans and agents. The manifest of every listing is public; the contents are private until paid for. Creators are paid 90% at their own wallet.",
      url: base,
    },
    entries: [
      {
        identifier: urn("mcp", "git-x402"),
        displayName: "X402 Git MCP server",
        description:
          "Streamable HTTP MCP server with six buy-side tools: search live repos and agent skills by what they do, learn how to buy with or without a wallet, read a listing's manifest, check the latest version and this wallet's price, buy over x402, and re-fetch a version already owned.",
        type: "application/mcp-server-card+json",
        url: `${base}/.well-known/mcp/server-card.json`,
        representativeQueries: [
          "find an agent skill that does a specific job",
          "buy a private git repo with USDC",
          "pay for an agent skill over x402",
          "check whether there is a new release of a skill I bought",
          "download a repository I already paid for",
        ],
      },
      {
        identifier: urn("api", "openapi"),
        displayName: "X402 Git HTTP API",
        description:
          "OpenAPI 3.1 description of every route: manifests, versions and prices, the x402 paid resource, entitlements, and the full headless creator rail.",
        type: "application/vnd.oai.openapi+json",
        url: `${base}/api/openapi.json`,
        representativeQueries: [
          "what endpoints does x402git expose",
          "how do I read a listing manifest without paying",
          "API to sell a git repository for USDC",
          "how much does this listing cost my wallet",
        ],
      },
      {
        identifier: urn("api", "catalog"),
        displayName: "API catalog",
        description:
          "RFC 9727 linkset naming the OpenAPI description, the human route list, the terms of service and the status endpoint.",
        type: "application/linkset+json",
        url: `${base}/.well-known/api-catalog`,
        representativeQueries: ["where is the API documentation for x402git", "find the OpenAPI spec for this site"],
      },
      {
        identifier: urn("skills", "index"),
        displayName: "Agent skills index",
        description: "Agent Skills Discovery 0.2.0 index of the skills published by this host, each with a sha256 digest.",
        type: "application/json",
        url: `${base}/.well-known/agent-skills/index.json`,
        representativeQueries: ["what agent skills does this site publish", "install the x402git skill"],
      },
      {
        identifier: urn("skills", "buy-a-repo"),
        displayName: "Skill: buy a private repo",
        description: SKILL_DESCRIPTIONS["buy-a-repo"],
        type: "text/markdown",
        url: `${base}${BUY_SKILL_PATH}`,
        representativeQueries: [
          "how do I pay a 402 and pull the repository",
          "buy an agent skill with my own wallet",
          "read a listing manifest before paying",
        ],
      },
      {
        identifier: urn("skills", "sell-a-repo"),
        displayName: "Skill: sell a private repo",
        description: SKILL_DESCRIPTIONS["sell-a-repo"],
        type: "text/markdown",
        url: `${base}/.well-known/agent-skills/sell-a-repo/SKILL.md`,
        representativeQueries: [
          "sell my code without a GitHub or Stripe account",
          "get paid in USDC for a private repository",
          "publish a listing headlessly and set a price",
        ],
      },
      {
        identifier: urn("listings", "sitemap"),
        displayName: "Listing directory",
        description: "Every live listing on the platform, as a sitemap. Each URL server-renders a complete public manifest.",
        type: "application/xml",
        url: `${base}/sitemap.xml`,
        representativeQueries: ["what is for sale on x402git", "list every skill available to buy here"],
      },
    ],
  };
}

export const GET = handle(async () =>
  new NextResponse(`${JSON.stringify(aiCatalog(appUrl()), null, 2)}\n`, {
    headers: {
      // The spec asks for `application/json` and open CORS by name.
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
    },
  }),
);
