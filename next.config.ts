import type { NextConfig } from "next";

/*
  RFC 8288 Link headers, on the public HTML pages.

  An agent that lands on a page — the home page, a manifest — should be able to find
  the machine surface without parsing the markup, and a HEAD request should be enough.
  Four registered relations, all pointing at documents that already exist:

    api-catalog       /.well-known/api-catalog   RFC 9727, the linkset
    service-desc      /api/openapi.json          generated from the zod schemas (FR-33)
    service-doc       /docs                      the route list, same registry
    terms-of-service  /api/terms                 version + sha256 of the served bytes

  Relative refs are resolved against the request URI (RFC 8288 §3), so this is correct
  on a preview deployment and on localhost without knowing the host.

  Not applied to /api/* — a caller already inside the API has the catalogue by
  definition, and these bytes would ride on every paid resource response.
*/
const AGENT_LINKS = [
  '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"',
  '</api/openapi.json>; rel="service-desc"; type="application/json"',
  '</docs>; rel="service-doc"; type="text/html"',
  '</api/terms>; rel="terms-of-service"; type="application/json"',
].join(", ");

/*
  Which paths have a markdown reading, as path-to-regexp fragments.

  One segment is any public page name that is not a signed-in surface and not a file
  (`[^/.]+` — no dot, so robots.txt and sitemap.xml keep serving their own bytes). Two
  segments is `/{owner}/{slug}` plus /docs/errors, minus /api. The lists are negative
  because the interesting single-segment case is `/{owner}`, and creators name
  themselves.
*/
const NOT_APP_PAGE = "(?!api/|_next/|dashboard|signin|purchases|receipts|opengraph-image)";
const MARKDOWN_ONE_SEGMENT = `${NOT_APP_PAGE}[^/.]+`;
const MARKDOWN_TWO_SEGMENTS = `${NOT_APP_PAGE}[^/]+`;

/*
  Security headers (RED-TEAM-2026-09-21.md OPS-2 / AUTH-5). Until this block the only
  one on any response was the platform's own HSTS, so /dashboard/wallet (rebind a payout
  address), /dashboard/key (rotate the agent key) and /admin/ops (pause payments) could
  all be framed by another site and clicked through.

  Every response gets the four that cannot break anything. `Referrer-Policy` is not
  cosmetic here: /dashboard/wallet carries a live challenge nonce in its query string,
  and a creator's README may load images from any https host.
*/
const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
];

/*
  Pages also get the CSP directives that need no inventory of what the page loads:
  nobody may frame it, a stray `<base>` cannot re-point its relative URLs, and no plugin
  content runs. Deliberately absent:

  - `script-src` / `style-src`. Seven components ship hand-written inline scripts and
    React writes inline styles, so an honest policy needs a nonce threaded through each
    one. That is the follow-up; a policy carrying 'unsafe-inline' would be decoration.
  - `form-action`. Chrome enforces it across the redirect a form POST ends in, and two
    of ours leave the origin on purpose: sign-in goes to github.com and the admin
    release download to a signed storage URL.

  /api is left out because its routes are JSON, and the one that serves markup — the
  README SVG proxy — sets a stricter policy of its own (`default-src 'none'; sandbox`)
  that a second header from here must not be allowed to compete with.
*/
const PAGE_CSP = { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'none'; object-src 'none'" };

/** The one condition: the caller asked for markdown. */
const WANTS_MARKDOWN = { type: "header", key: "accept", value: ".*text/markdown.*" } as const;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // `x-powered-by: Next.js` tells a scanner which advisories to try and tells a reader nothing.
  poweredByHeader: false,
  // FR-11: `lib/licences/*.txt` is read from disk at request time (lib/licences/index.ts).
  // Nothing imports it, so the tracer cannot see it — name it explicitly or the licence
  // route 500s in production while passing every local test.
  outputFileTracingIncludes: {
    "/api/listings/[id]/licence": ["./lib/licences/*.txt"],
    // Same trap, same fix: lib/skills/*.md is read from disk at request time and
    // nothing imports it, so the tracer cannot see it. Both routes need it — the index
    // hashes the files, the SKILL.md route serves them.
    "/.well-known/agent-skills/index.json": ["./lib/skills/*.md"],
    "/.well-known/agent-skills/[name]/SKILL.md": ["./lib/skills/*.md"],
  },
  headers: async () => [
    { source: "/:path*", headers: SECURITY_HEADERS },
    { source: "/((?!api/).*)", headers: [PAGE_CSP] },
    { source: "/", headers: [{ key: "Link", value: AGENT_LINKS }] },
    {
      // One segment: /docs, /how-it-works, and the author page at /:owner. Cannot
      // reach into /api, which is always two or more.
      source: "/:page",
      headers: [{ key: "Link", value: AGENT_LINKS }],
    },
    {
      // Two segments: manifest pages at /:owner/:slug, and /docs/errors. The negative
      // lookahead keeps this off /api/terms, /api/mcp and /api/openapi.json.
      source: "/:owner((?!api/)[^/]+)/:slug",
      headers: [{ key: "Link", value: AGENT_LINKS }],
    },
    /*
      No `Vary: Accept` rule here, though both readings share a URL. Next owns `Vary`
      on a page response and overwrites whatever this file sets — and it does not need
      to be overridden, because those pages are `no-cache, must-revalidate` and no
      shared cache stores them. The markdown response is the cacheable one, and it sets
      `Vary: accept` itself in app/api/md/[[...path]]/route.ts.
    */
  ],

  /*
    Markdown for agents. A request for a public page carrying `Accept: text/markdown`
    is rewritten to /api/md, which renders the same facts from the same loaders as
    markdown — same URL, no redirect, and HTML remains the default for everyone who
    did not ask. See app/api/md/[[...path]]/route.ts and lib/web/markdown.ts.

    The sources are the public pages and nothing else: the exclusion list keeps the
    rewrite off /api, off the signed-in surfaces, and off the paths that are files
    rather than pages, where a markdown rendition would be a 404 in place of a
    perfectly good robots.txt.
  */
  rewrites: async () => ({
    beforeFiles: [
      { source: "/", has: [WANTS_MARKDOWN], destination: "/api/md" },
      { source: `/:page(${MARKDOWN_ONE_SEGMENT})`, has: [WANTS_MARKDOWN], destination: "/api/md/:page" },
      { source: `/:owner(${MARKDOWN_TWO_SEGMENTS})/:slug`, has: [WANTS_MARKDOWN], destination: "/api/md/:owner/:slug" },
    ],
    afterFiles: [
      // The OpenAPI document at the origin root. x402scan's crawler (@agentcash/discovery
      // 1.7.x) reads exactly `GET /openapi.json` and nothing else — not `/.well-known/x402`,
      // which it now calls legacy. Same bytes as /api/openapi.json (FR-33), no redirect.
      { source: "/openapi.json", destination: "/api/openapi.json" },
      // IndexNow key file at the root (lib/indexnow.ts): the engine reads `/<key>.txt`,
      // and a key file only vouches for URLs under its own path. The key is read here at
      // config time — Next loads .env before evaluating this file, and Vercel exposes the
      // production variables to the build — so exactly one path rewrites to the
      // well-known route and every other `/<hex>.txt` stays what it is (not found).
      // (A `?key=:key` on the destination does not reach the handler's `nextUrl`.)
      ...(process.env.INDEXNOW_KEY && /^[0-9a-f]{8,128}$/i.test(process.env.INDEXNOW_KEY)
        ? [{ source: `/${process.env.INDEXNOW_KEY}.txt`, destination: "/.well-known/indexnow-key.txt" }]
        : []),
    ],
    fallback: [],
  }),
};

export default nextConfig;
