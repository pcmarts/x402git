# Agent discovery

Added 31 August 2026. What an agent that has never heard of this platform can find, and
where each document comes from.

The product's claim is agent parity (PRD Final §G6, §G3): everything a person can do
here, a machine can do headlessly. That claim is worth nothing if the machine cannot
find the surface in the first place. This is the discovery layer — nine documents, all
generated from something that already exists, none of them a second copy of the API.

## The entry points

| URL | Spec | What it is |
| --- | --- | --- |
| `Link:` headers on every public page | RFC 8288 | `api-catalog`, `service-desc`, `service-doc`, `terms-of-service`. A HEAD request finds everything below |
| `/.well-known/api-catalog` | RFC 9727 / RFC 9264 | Linkset: the OpenAPI document, `/docs`, the terms, the status endpoint |
| `/.well-known/ai-catalog.json` | ARD | Capability manifest, with `representativeQueries` for registries that embed |
| `/.well-known/mcp/server-card.json` | SEP-1649 | The card for the MCP server at `/api/mcp` |
| `/.well-known/agent-skills/index.json` | Agent Skills Discovery 0.2.0 | Two skills, each with a `sha256:` digest |
| `/.well-known/agent-skills/{name}/SKILL.md` | — | `buy-a-repo`, `sell-a-repo`. The bytes the index digests |
| `/api/openapi.json` | OpenAPI 3.1 | Generated from the zod schemas (FR-33) |
| `/api/health` | RFC 8631 `status` | One database round trip. `ok` or `degraded` |
| `robots.txt` | RFC 9309 / Content Signals | An allowlist for the buy-side funnel in front of `Disallow: /api/`, plus `Content-Signal` and `Agentmap` |
| `/openapi.json` | @agentcash/discovery (x402scan) | The same document as `/api/openapi.json`, at the origin root, which is the one URL x402scan's crawler reads. The `/api/r` template carries `x-payment-info`, and so does one concrete path per live listing with its fixed new-buyer price (lib/openapi/listings.ts), because the crawler fetches a template literally and registers only URLs that answer 402. `info` carries a contact and `x-guidance` |
| `/.well-known/x402` | x402scan's earlier convention | `{ version: 1, resources: [...] }` — every live paid resource URL. x402scan no longer parses it (its crawler calls it legacy); kept because other x402 tooling still probes it and it costs one query |
| `extensions.bazaar` on every 402 | x402 `bazaar` extension | The Bazaar discovery declaration, per listing, with `resource.serviceName` and `resource.tags` computed from the manifest. Catalogued by the CDP facilitator on the first settlement that echoes it |
| `/.well-known/mcp-registry-auth` | MCP Registry HTTP auth | Domain proof for `com.x402git/*`; `server.json` at the repo root is what is published |
| `/.well-known/402index-verify.txt` | 402 Index domain claim | The public hash of a claim on x402git.com at 402index.io; the private token is in `402index.local.json`. Verified owners can edit or remove their listings |
| `/<INDEXNOW_KEY>.txt` | IndexNow | The key a publish, retirement or new release pings Bing with (lib/indexnow.ts). At the root, because a key file only vouches for URLs under its own path |
| `<script type="application/ld+json">` on a listing page | schema.org Product + Offer | Price in USDC, availability, licence, languages — computed facts only (lib/web/listing-json-ld.ts) |
| `Accept: text/markdown` on any public page | — | The same page as markdown, `x-markdown-tokens` estimated |
| `navigator.modelContext` on a listing page | WebMCP | Four read-only tools for an agent driving a browser |

Two pointers to the ARD manifest exist besides the file itself: `Agentmap:` in
robots.txt and `<link rel="ai-catalog">` in the page head (app/layout.tsx).

**robots.txt is part of this layer, not separate from it.** The buyer is a crawler: a
well-behaved agent handed a resource URL reads robots.txt before it fetches. Until
1 Sep 2026 a blanket `Disallow: /api/` meant such an agent refused `/api/r/…` and never
saw the 402 challenge. The disallow stays — it is the default — but the six free,
unauthenticated, GET-only reads that make up the funnel (`/api/r/`, `/api/v/`,
`/api/label/`, `/api/snippet/`, `/api/md/`, `/api/openapi.json`, `/api/terms`) are
allowed by name in front of it. Anything added under `/api/` that an agent must be able
to fetch unauthenticated has to be added to `AGENT_READABLE` in app/robots.txt/route.ts
or it is invisible to every crawler that obeys the file.

## Where each document is generated from

Nothing in this layer is hand-maintained except the two skills and the home/how-it-works
markdown, and those are deliberately short indexes rather than restatements.

- **`/docs`, `/docs/errors`, and their markdown readings** — `lib/openapi/registry.ts`
  and the `ERRORS` catalogue. A route that exists in one reading exists in all of them.
- **The api-catalog and ai-catalog** — they name documents, not endpoints, so adding a
  route never touches them.
- **The MCP server card** — `MCP_SERVER_NAME`, `MCP_SERVER_VERSION` and `TOOL_NAMES`
  from `lib/mcp/server.ts`, and `SUPPORTED_PROTOCOL_VERSIONS` from the MCP SDK, so an
  SDK upgrade cannot leave the card claiming yesterday's wire.
- **The skills index** — digests computed from the served bytes at request time
  (`lib/skills`), never from a build-time copy.
- **A listing in markdown** — the listing's own manifest and release rows, through the
  same loaders the HTML page uses.
- **Error recovery lines** — `lib/web/error-recovery.ts`, shared by the HTML page and
  the markdown reading (it used to live inside `app/docs/errors/page.tsx`).

## Content Signals

```
Content-Signal: search=yes, ai-input=yes, ai-train=no
```

Chosen 31 Aug 2026. `search=yes` because that is how a buyer finds a listing;
`ai-input=yes` because an agent grounding an answer in a manifest before it pays is the
product working as designed; `ai-train=no` because being readable by an agent is not a
licence to absorb the creators' work into a model.

## Markdown negotiation

`next.config.ts` rewrites a request carrying `Accept: text/markdown` to
`app/api/md/[[...path]]/route.ts`. Same URL, no redirect, HTML still the default. The
rewrite is scoped to the public pages: it stays off `/api`, off the signed-in surfaces,
and off anything with a dot in the last segment, so `robots.txt` and `sitemap.xml` keep
serving their own bytes.

The markdown response carries `Vary: accept` and is cacheable. The HTML response does
not: Next owns `Vary` on a page response and overwrites anything `next.config.ts` sets
there, and it does not matter — the HTML pages are `no-cache, must-revalidate`, so no
shared cache holds one reading to hand to the other reader.

## Off-domain: where these documents get picked up

Everything above is pull-only until something off this domain points at it. As of
16 Sep 2026 (see research/Agent Discovery Channels.md for the evidence) four things do:

- **The x402 Bazaar.** The 402 declares the `bazaar` extension; the facilitator indexes
  the URL on the first settlement that echoes it — the listing's first sale. The platform
  does not buy listings to seed the index (founder, 16 Sep 2026; DECISIONS.md).
  `npm run bazaar:check -- --all` reports each live listing's state.
- **x402scan.** Its crawler reads `GET /openapi.json` at the origin and nothing else
  (`@agentcash/discovery` 1.7.x — `/.well-known/x402` is legacy to it). Registering the
  origin is a one-off form at x402scan.com/resources/register; `npx @agentcash/discovery
  discover x402git.com` shows what it will see.
- **The official MCP Registry.** `server.json` published under `com.x402git`, verified by
  `/.well-known/mcp-registry-auth`. Re-publish when `MCP_SERVER_VERSION` changes:
  `mcp-publisher login http --domain x402git.com --private-key …` then `mcp-publisher publish`.
- **Bing and Google.** Sitemap plus IndexNow on every change, and the Product/Offer
  structured data on each listing page; both consoles are verified.
- **skills.sh and `npx skills add pcmarts/x402git-skills`.** The two skills are mirrored,
  byte for byte, to a public GitHub repo in the layout the skills CLI discovers
  (`skills/<name>/SKILL.md`). `npm run skills:publish` regenerates it from `lib/skills`;
  the mirror is never edited by hand, so the digest in the index stays the digest of
  what GitHub serves. The mirror carries an MIT LICENSE (the skills' `license:` field says
  the same) and is tagged by the publisher (`--tag vX.Y.Z`, first tag `v1.0.0`, 24 Oct 2026).
- **The lists.** PRs opened 16 Sep 2026: Merit-Systems/awesome-agentic-commerce #710,
  xpaysh/awesome-x402 #1531, and the x402.org ecosystem directory (coinbase/x402,
  `typescript/site/app/ecosystem/partners-data/x402-git`). VoltAgent/awesome-agent-skills
  was not submitted: its rules refuse skills without established community usage.

## DNS-AID — not published, and why

`draft-mozleywilliams-dnsop-dnsaid` wants ServiceMode SVCB/HTTPS records under
`_agents.x402git.com`, in a DNSSEC-signed zone. **x402git.com is on Vercel DNS, which
supports A, AAAA, ALIAS, CNAME, TXT, MX, SRV and CAA only — no SVCB or HTTPS record
type — and the zone is unsigned** (`dig DS x402git.com` returns nothing). Neither half
of the requirement can be met without moving the zone to a provider that does both
(Cloudflare, Route 53 with DNSSEC enabled).

Decision, 31 Aug 2026 (founder): skip it. The draft is early and nothing consumes it
widely. If the zone moves, this is the whole change:

```zone
; ServiceMode SVCB, one per entrypoint
_index._agents.x402git.com. 3600 IN HTTPS 1 x402git.com. (
    alpn="h2,http/1.1"
    ipv4hint=""
    endpoint="/.well-known/ai-catalog.json" )

_mcp._agents.x402git.com.   3600 IN HTTPS 1 x402git.com. (
    alpn="h2,http/1.1"
    endpoint="/api/mcp" )

; ARD also defines plain TXT/SRV pointers, which Vercel DNS *can* host today:
_catalog._agents.x402git.com. 3600 IN TXT "v=ard1; url=https://x402git.com/.well-known/ai-catalog.json"
```

Then enable DNSSEC at the provider and publish the DS record at the registrar. The
`endpoint` parameter is a draft-defined SvcParam; check the current draft before
publishing, since the key numbers are not yet assigned by IANA.

## What is deliberately not published

- **Listings as skills.** Every live listing is arguably an agent skill, but the
  artifact is behind a 402 and its digest is already published per version in the
  manifest. An index advertising URLs no consumer can fetch is a worse document than one
  that explains how to buy them — which is what `buy-a-repo` is.
- **Tool schemas in the MCP card.** `tools/list` is the contract. A copy in the card is
  a second contract to keep in step.
- **A `/llms.txt`.** The markdown reading of `/` is that file, at the URL an agent
  already has. Server logs across the industry (Apr–Jul 2026) show the major crawlers
  fetching it in single digits against thousands of robots.txt reads.
- **A `routeTemplate` in the Bazaar declaration.** It would collapse every listing into
  one catalogue entry named after the platform. Each listing is its own entry.

## Verifying

```
curl -sI  https://x402git.com/ | grep -i ^link
curl -s   https://x402git.com/.well-known/api-catalog
curl -s   https://x402git.com/.well-known/ai-catalog.json
curl -s   https://x402git.com/.well-known/mcp/server-card.json
curl -s   https://x402git.com/.well-known/agent-skills/index.json
curl -s   https://x402git.com/.well-known/agent-skills/buy-a-repo/SKILL.md | shasum -a 256
curl -s   https://x402git.com/robots.txt
curl -s -H 'Accept: text/markdown' https://x402git.com/ -D- -o/dev/null
curl -s   https://x402git.com/api/health
curl -s   https://x402git.com/.well-known/x402
curl -s   https://x402git.com/openapi.json | jq '.info.contact, .paths["/api/r/{owner}/{slug}"].get["x-payment-info"]'
npx @agentcash/discovery discover x402git.com
curl -s   https://x402git.com/.well-known/mcp-registry-auth
curl -s   https://x402git.com/api/r/examples/humanizer | jq '.extensions.bazaar.info, .resource'
curl -s   "https://api.cdp.coinbase.com/platform/v2/x402/discovery/merchant?payTo=<PLATFORM_RECEIVING_ADDRESS>"
```

The digest printed by the `shasum` line must equal the `digest` for that skill in the
index; that is the one invariant here that a deploy could break silently, and
`app/.well-known/agent-skills/index.json/route.test.ts` holds it.
