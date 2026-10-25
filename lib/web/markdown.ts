/**
 * lib/web/markdown.ts — the markdown reading of the public pages.
 *
 * An agent that sends `Accept: text/markdown` gets the page as markdown instead of as
 * HTML (next.config.ts rewrites those requests to /api/md; the route is
 * app/api/md/[[...path]]/route.ts). Same URL, same facts, a tenth of the tokens.
 *
 * **The rule this file lives by: generate, never restate.** `/docs` and `/docs/errors`
 * are built from the route registry and the error catalogue — the same two arrays the
 * HTML pages render, so a route or a code cannot exist in one reading and not the
 * other. A listing is built from its manifest and release rows. The only hand-written
 * markdown here is the home page and `/how-it-works`, and both are deliberately short:
 * they are an index of the machine surface, not a second draft of the prose a person
 * reads. Anything that could go stale is a link, and the two skills at
 * /.well-known/agent-skills carry the procedures.
 *
 * Money is formatted through `formatPrice` like everywhere else, and every micro figure
 * is printed alongside it — a price an agent has to parse should not have a dollar sign
 * in it.
 */

import { BUY_SKILL_PATH, SELL_SKILL_PATH } from "@/lib/buy-links";
import { ERROR_CODES, ERRORS } from "@/lib/errors";
import { agentBuyPrompt } from "@/lib/web/agent-prompt";
import type { NormalisedRoute } from "@/lib/openapi/registry";
import { registeredRoutes } from "@/lib/openapi/registry";
import "@/lib/openapi/routes";
import type { ManifestOutput } from "@/lib/schemas";
import { RECOVERY } from "@/lib/web/error-recovery";
import type { AuthorPage, ListingBundle, ListingCard } from "@/lib/web/loaders";
import { languageMix } from "@/lib/web/manifest-view";
import { formatPrice } from "@/lib/web/money";

/** `9000000` → `"$9.00 (9000000 micro-USDC)"`; `0` → `"Free"`. */
function money(micro: bigint): string {
  return micro === 0n ? "Free" : `${formatPrice(micro)} (${micro} micro-USDC)`;
}

/**
 * A `##` block. Only `null` and `undefined` are dropped — an empty string is a blank
 * line the caller asked for, and markdown is a whitespace-sensitive format.
 */
function section(title: string, lines: (string | null | undefined)[]): string {
  const kept = lines.filter((line) => line !== null && line !== undefined);
  const body = kept.join("\n").trim();
  return body ? `## ${title}\n\n${body}\n` : "";
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

export function homeMarkdown(base: string): string {
  return `# X402 Git

Paid access to private git repositories over x402/USDC, for humans and agents.

A creator connects a repo, sets a price and gets back a paid endpoint. Buyers pay in
USDC on Base over HTTP 402 and receive the repository at a version. The manifest of
every listing — file tree, licence, dependencies, security scan, sha256 of the exact
artifact — is public and free to read. The contents are private until paid for.

- Flat 10% of gross, seller-side. The creator receives 90% at their own wallet.
- Every release is logged publicly, and an update 402 names what changed before you pay.
- Nothing here needs a GitHub account, an email address or a browser.

## For agents

| What | Where |
| --- | --- |
| Buy a repo (skill) | ${base}${BUY_SKILL_PATH} |
| Sell a repo (skill) | ${base}${SELL_SKILL_PATH} |
| OpenAPI 3.1 | ${base}/api/openapi.json |
| Routes and errors | ${base}/docs · ${base}/docs/errors |
| MCP (Streamable HTTP) | ${base}/api/mcp · card at ${base}/.well-known/mcp/server-card.json |
| API catalog (RFC 9727) | ${base}/.well-known/api-catalog |
| Capability manifest (ARD) | ${base}/.well-known/ai-catalog.json |
| Every live listing | ${base}/sitemap.xml |
| Status | ${base}/api/health |

Any page on this site answers in markdown when you send \`Accept: text/markdown\`.

## Reading a listing

\`\`\`
GET ${base}/api/label/{owner}/{slug}    the manifest, free
GET ${base}/api/v/{owner}/{slug}        latest version and your price
GET ${base}/api/r/{owner}/{slug}        the paid resource: 402, sign, 200
\`\`\`

Money is micro-USDC everywhere: \`9000000\` is $9.00.

## More

- How it works: ${base}/how-it-works
- Terms: ${base}/api/terms · ${base}/terms.md
- Buyer terms: ${base}/buyer-terms.md
- Reporting abuse: ${base}/abuse.md
- Source (AGPL-3.0-only): https://github.com/pcmarts/x402git
`;
}

// ---------------------------------------------------------------------------
// How it works
// ---------------------------------------------------------------------------

export function howItWorksMarkdown(base: string): string {
  return `# How X402 Git works

The short form. The page a person reads is at ${base}/how-it-works, and the two skills
below are the step-by-step procedures.

## What is sold

A **snapshot taken at release time**, delivered by a signed URL that expires in five
minutes. The bytes served are byte-identical to the bytes that were analysed and
scanned, and their \`artifact_sha256\` is in the public manifest before anyone pays.
Later pushes do not change what an existing buyer already bought.

## What a buyer pays

A listing has a **price** and an **update price**. Every release is a full-price
purchase for a new buyer; an existing holder pays the update price, and an update price
of \`0\` is lifetime access. A holder is charged at most one update per listing per 7
days. Payment is USDC on Base over x402: the buyer signs an EIP-3009 authorization with
their own key, and access is granted only after settlement returns a transaction hash.

Buying, step by step: ${base}${BUY_SKILL_PATH}

## What a creator gets

90% of gross. The platform takes a flat 10%, seller-side, and that is its only revenue.
Net proceeds sweep automatically to the creator's bound payout address after a 7-day
holdback — there is no \`to\` parameter anywhere in the API, so payouts go to that
address or nowhere. The server never sees a creator's private key.

Selling, step by step: ${base}${SELL_SKILL_PATH}

## How a listing is found

A live listing is pushed, with no action from the creator, to the places agents look:
the x402 indexes (x402scan from the OpenAPI document at ${base}/openapi.json; the x402
Bazaar from its first sale), the official MCP Registry through the buy-side server at
${base}/api/mcp, and the search engines, which are told the moment a page changes.
Every live resource is listed at ${base}/.well-known/x402.

## What is public

The manifest: file tree with sizes, languages, dependencies, licence verdict, security
scan verdict, release log with diffs, and the creator's own description and trigger hint
(badged \`self_reported\`, because they are claims and not measurements). Everything the
analyser measured is under \`computed\`.

## Access, once bought, is permanent

A retired listing still serves every wallet that bought it. The only path that revokes
access is an upheld takedown, and it is logged and refunded from the holdback.

## Source

The platform's own code is open source under AGPL-3.0-only:
https://github.com/pcmarts/x402git. The licence terms are in \`LICENSE\`; how to report a
vulnerability is in \`SECURITY.md\`.
`;
}

// ---------------------------------------------------------------------------
// /docs and /docs/errors — generated from the same registry the HTML renders
// ---------------------------------------------------------------------------

const TAG_ORDER = ["public", "auth", "creator", "internal"] as const;

const TAG_TITLE: Record<string, string> = {
  public: "Public (buy side)",
  auth: "Auth",
  creator: "Creator",
  internal: "Internal",
};

function routeLine(route: NormalisedRoute): string {
  const auth =
    route.security.length === 0
      ? "public"
      : route.security.map((s) => (s === "apiKey" ? "`Authorization: Bearer x4c_live_…`" : "`X-Wallet-Signature`")).join(" or ");
  // The agent key is the one a reader of this document can hold, so it is the one named
  // per route. Session keys (`x4s_live_…`) are accepted on the same routes but are minted
  // for a browser session and never shown to anyone; the preamble above says so once,
  // rather than every route line saying it thirty times.
  const parts = [
    `### ${route.method.toUpperCase()} ${route.path}`,
    "",
    `${route.summary}${route.status === "planned" ? " — **planned, not built yet**" : ""}`,
    "",
    `Auth: ${auth}`,
  ];
  if (route.description) parts.push("", route.description);
  if (route.params?.length) {
    parts.push("", `Parameters: ${route.params.map((p) => `\`${p.name}\` (${p.in}${p.required ? ", required" : ""})`).join(", ")}`);
  }
  if (route.errors?.length) parts.push("", `Errors: ${route.errors.map((e) => `\`${e}\``).join(", ")}`);
  return parts.join("\n");
}

export function docsMarkdown(base: string): string {
  const routes = registeredRoutes();
  const groups = TAG_ORDER.map((tag) => ({
    tag,
    routes: routes.filter((r) => r.tags.includes(tag)),
  })).filter((g) => g.routes.length > 0);

  return [
    "# API routes",
    "",
    `Every endpoint on the platform, its authentication, and the errors it can return. Generated from the same registry as ${base}/api/openapi.json — this is not a second copy.`,
    "",
    `Base URL \`${base}\`. Every error is \`{ code, message, docs_url, details? }\`; the catalogue is at ${base}/docs/errors.`,
    "",
    "Creator routes take a bearer key. Yours is an agent key, `x4c_live_…`: long-lived, shown once, rotatable. The website calls these same routes with a session key (`x4s_live_…`) minted for a signed-in browser, which expires and is never shown to anyone — both are accepted everywhere, and only the first is one you can hold.",
    "",
    "Rate limits: registration 5/hour/IP · listing creation 3 unpublished per creator · pushes 20/hour/repo · `/api/r` 60/min/address · `/api/v` and `/api/label` 600/min/IP · challenge 30/min/address.",
    "",
    "MCP, the same routes as tools:",
    "",
    "```",
    "claude mcp add --transport http x402git https://x402git.com/api/mcp",
    "```",
    "",
    `Or add \`${base}/api/mcp\` as a custom connector in any client that takes a remote MCP server; no login. Tools: \`search_listings\` (free, no wallet — find live repos and agent skills by what they do, when you do not know a name yet), \`how_to_buy\` (free, no wallet — whether it is for sale, the price, the listing page, the skill and the endpoint; call it first, and answer with it if you cannot sign), \`get_listing\`, \`check_version\`, \`purchase\`, \`fetch_release\`.`,
    "",
    ...groups.map((g) => [`## ${TAG_TITLE[g.tag] ?? g.tag}`, "", ...g.routes.map(routeLine)].join("\n\n")),
    "",
  ].join("\n");
}

export function errorsMarkdown(base: string): string {
  const groups = ["payment", "listing", "auth", "limits", "request"] as const;
  const titles: Record<string, string> = {
    payment: "Payment",
    listing: "Listing",
    auth: "Auth",
    limits: "Limits",
    request: "Request",
  };

  const seen = new Set<string>();
  const blocks = groups.map((group) => {
    const codes = ERROR_CODES.filter((code) => ERRORS[code].group === group);
    codes.forEach((c) => seen.add(c));
    if (codes.length === 0) return "";
    const rows = codes.map((code) => {
      const { status, message } = ERRORS[code];
      const recovery = RECOVERY[code];
      return `### \`${code}\`\n\nHTTP ${status}. ${message}${recovery ? `\n\n${recovery}` : ""}`;
    });
    return [`## ${titles[group] ?? group}`, ...rows].join("\n\n");
  });

  // Anything the catalogue grows that this file has not been told about still prints.
  const rest = ERROR_CODES.filter((code) => !seen.has(code));

  return [
    "# Error codes",
    `Every error the platform returns, as \`{ code, message, docs_url, details? }\`. \`docs_url\` points at the anchor for the code on ${base}/docs/errors. Match on \`code\`, never on \`message\`.`,
    ...blocks.filter(Boolean),
    rest.length
      ? ["## Other", ...rest.map((code) => `### \`${code}\`\n\nHTTP ${ERRORS[code].status}. ${ERRORS[code].message}`)].join("\n\n")
      : "",
  ]
    .filter((block) => block !== "")
    .join("\n\n")
    .concat("\n");
}

// ---------------------------------------------------------------------------
// A listing
// ---------------------------------------------------------------------------

const TREE_ROWS = 40;

export function listingMarkdown(bundle: ListingBundle, manifest: ManifestOutput | null, base: string): string {
  const { creator, listing, latest, releases, endpoints, status } = bundle;
  const ref = `${creator.handle}/${listing.slug}`;
  const price = BigInt(listing.price_micro);
  const updatePrice = BigInt(listing.update_price_micro);
  const computed = manifest?.computed;

  const head = [
    `# ${ref}${latest ? ` v${latest.version}` : ""}`,
    "",
    status === "retired"
      ? "**No longer sold.** The manifest and the release log stay up, and every wallet that bought a version keeps it."
      : status === "draft"
        ? "**Draft.** Not published; nobody else can reach this URL."
        : null,
    listing.description ? `${listing.description}\n\n*(self-reported by the creator, not measured)*` : null,
    listing.trigger_hint ? `**Fetch this when:** ${listing.trigger_hint} *(self-reported)*` : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  const order = section("Price", [
    `- Price: ${money(price)}`,
    `- Updates: ${updatePrice === 0n ? "included for life once bought" : `${money(updatePrice)} per release, at most one charge per 7 days`}`,
    latest ? `- Latest version: \`${latest.version}\`, published ${latest.created_at}` : "- No passing release yet.",
    manifest ? `- Artifact sha256: \`${manifest.artifact_sha256}\`` : null,
    "",
    `- Manifest, free: \`GET ${endpoints.label_endpoint}\``,
    `- Version and your price: \`GET ${endpoints.version_endpoint}\``,
    `- The paid resource, 402 then 200: \`GET ${endpoints.resource_endpoint}\``,
    "",
    `How to pay: ${base}${BUY_SKILL_PATH}`,
    "",
    // The same four lines the HTML page's "Buy with your agent" block hands over, so a
    // model that read this page as markdown can re-emit them for an agent that has a
    // wallet — `how_to_buy` tells it the prompt is on the page, and it is on this one.
    "Buy with your agent — paste this into any agent:",
    "",
    "```",
    agentBuyPrompt({ owner: creator.handle, slug: listing.slug, appUrl: base }),
    "```",
  ]);

  const facts = computed
    ? section("What is inside (computed)", [
        `- Kind: ${computed.artifact_class}`,
        `- ${computed.file_count} files, ${computed.lines_of_code} lines of code, depth ${computed.dir_depth}`,
        // `languages` is bytes per language, not shares — `languageMix` is the same
        // reducer the HTML reading prints, so the two cannot disagree about a mix.
        `- Languages: ${languageMix(computed.languages)}`,
        `- Licence: ${computed.licence.spdx ?? "none found"} (${computed.licence.verdict})`,
        `- Security scan: ${computed.scan.verdict}, scanner ${computed.scan.scanner_version}, ${computed.scan.at}`,
        computed.dependencies?.length
          ? `- Dependencies (${computed.dependencies.length}): ${computed.dependencies
              .slice(0, 25)
              .map((d) => `${d.name}@${d.version}`)
              .join(", ")}${computed.dependencies.length > 25 ? ", …" : ""}`
          : "- Dependencies: none declared",
        computed.originality
          ? `- Originality: ${Math.round(computed.originality.blob_overlap_ratio * 100)}% of files seen in other listings`
          : null,
        computed.cadence_sentence ? `- Cadence: ${computed.cadence_sentence}` : null,
        `- Analysed ${computed.computed_at} by analyzer ${computed.analyzer_version}`,
      ])
    : "";

  const tree = computed?.tree?.length
    ? section("Files", [
        "```",
        ...computed.tree.slice(0, TREE_ROWS).map((entry) => `${String(entry.size).padStart(9)}  ${entry.path}${entry.binary ? "  (binary)" : ""}`),
        computed.tree.length > TREE_ROWS ? `… ${computed.tree.length - TREE_ROWS} more` : "",
        "```",
      ])
    : "";

  const log = releases.length
    ? section("Releases", [
        ...releases.map(
          (r) =>
            `- \`${r.version}\` — ${r.created_at}, scan ${r.scan}${r.changelog ? `\n  ${r.changelog.split("\n")[0]}` : ""}`,
        ),
        "",
        `Full log: ${endpoints.version_endpoint}/releases`,
      ])
    : "";

  const footer = `---\n\nSold by ${creator.handle} · ${base}/${creator.handle} · terms ${base}/api/terms\n`;

  // Each block already ends with its own newline; the join adds the blank line between
  // them. Empty sections drop out, and nothing else does.
  return [`${head}\n`, order, facts, tree, log, footer].filter((block) => block !== "").join("\n");
}

// ---------------------------------------------------------------------------
// An author page
// ---------------------------------------------------------------------------

function cardLine(card: ListingCard, base: string): string {
  const facts = [card.version ? `v${card.version}` : null, card.artifactClass, card.languages, card.fileCount ? `${card.fileCount} files` : null]
    .filter(Boolean)
    .join(" · ");
  const blocks = [
    `### ${card.path}`,
    card.description ?? null,
    facts || null,
    [
      `- Price: ${money(card.priceMicro)}`,
      `- Updates: ${card.updatePriceMicro === 0n ? "included for life" : money(card.updatePriceMicro)}`,
      `- Manifest: ${base}/api/label/${card.path}`,
      `- Page: ${base}${card.href}`,
    ].join("\n"),
  ];
  return blocks.filter((block) => block !== null).join("\n\n");
}

export function authorMarkdown(page: AuthorPage, base: string): string {
  const { creator, listings } = page;
  return [
    `# ${creator.handle}`,
    listings.length === 1 ? "One listing." : `${listings.length} listings.`,
    ...listings.map((card) => cardLine(card, base)),
    `Every listing on the platform: ${base}/sitemap.xml`,
  ].join("\n\n").concat("\n");
}
