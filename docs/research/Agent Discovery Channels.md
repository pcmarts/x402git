# Agent discovery channels

Research, 16 September 2026. The question: how does an AI agent that has never heard of
x402git find a listing, and what would make that happen without anyone doing it by hand?

Companion to [agent-discovery.md](../agent-discovery.md), which covers what an agent can
find *once it is on our domain*. This file is about how it gets to the domain at all.
Nothing here is a decision; the candidates go through [BACKLOG.md](../BACKLOG.md) and the
PRD per the working agreement.

## Where we stand today (measured, not assumed)

| Channel | Status on 16 Sep 2026 | How checked |
| --- | --- | --- |
| Coinbase x402 Bazaar (15,768 resources) | **Absent.** Our 402 body carries no `extensions.bazaar` | `GET …/discovery/merchant?payTo=0xDbd3…4b60` returns `total: 0`; `…/discovery/search?query=x402git` empty; decoded `PAYMENT-REQUIRED` for `examples/humanizer` has no `extensions` key |
| Agentic.market (Coinbase, fed from the Bazaar) | Absent | Search via the AgentLayer wallet plugin's `x402_search_services`; "git repository code" returns seven GitHub-metadata APIs, none of them us |
| Web search (Brave index, which Claude uses) | **Absent for our own name.** `"x402git"` and `site:x402git.com` return nothing from the domain | WebSearch, 16 Sep |
| Bing / Google verification, IndexNow | Not set up | No verification file or meta, no IndexNow key in `app/` or `public/` |
| JSON-LD on listing pages | None. Only `/` and `/how-it-works` carry structured data | `grep ld+json app/` |
| Official MCP Registry | Absent (five other x402 servers are listed) | `registry.modelcontextprotocol.io/v0/servers?search=x402git` |
| x402scan, x402.org ecosystem, skills.sh, Smithery, Glama | Absent | Direct lookups |
| Our own `.well-known` layer (ARD catalog, skills index, MCP card) | Published and live | `curl` 200s |

The on-domain layer is real but pull-only: nothing crawls it. The ARD spec's own
publishing guide says publishing "does not guarantee that any particular ARD-implementing
service will find or index you", and as of today no public crawler of `ai-catalog.json`
or `Agentmap:` exists (Hugging Face lists it as a next step; Google's and AWS's ARD
registries are enterprise-scoped). The Agent Skills Discovery RFC names no adopters and no
crawler; the one consumer, `npx skills add <url>`, has an open bug about not reading the
index. So the documents we publish are correct, cheap, and currently reach nobody who
did not already have the URL.

## How agents actually find paid services in 2026

Ranked by evidence, strongest first.

1. **A human gives the agent the URL.** Still the dominant path. Every tutorial and every
   Cloudflare/`@x402/fetch` example hard-codes the endpoint. The README snippet
   (`/api/snippet`) and the `claude mcp add` one-liner are the artefacts that serve this
   path, and they already exist.
2. **Skills registries, for coding agents.** `npx skills add owner/repo` against a public
   GitHub repo containing `SKILL.md` lists it on skills.sh automatically; Vercel's
   `find-skills` (2M+ installs) queries that index from inside Claude Code and Cursor.
   No submission step, no curation. This is the best-evidenced case of an agent
   discovering a capability on its own.
3. **The x402 Bazaar, for agents holding USDC.** Purpose-built for exactly our buyer.
   Consumed by Coinbase Agentic Wallet MCP tools (list, search, pay), the `awal` CLI
   skill, AgentKit's `discover_x402_services`, `@coinbase/cdp-sdk`, AWS Bedrock
   AgentCore's built-in Bazaar target, and third-party wallet plugins (the one installed
   on this machine included). Search returns at most 20 results ranked by relevance
   blended with a `quality` block (30-day calls, 30-day unique payers, last called) that
   the facilitator computes from settlements.
4. **Web search inside chat products.** ChatGPT reads the Bing index (allow
   `OAI-SearchBot`, HTML only); Claude reads Brave (86.7% citation overlap with Brave top
   results); Perplexity runs its own crawler. Server-rendered pages, a sitemap, and
   structured data are the whole game here. We have the first two and not the third, and
   we are not indexed.
5. **MCP registries.** The official registry accepts a remote streamable-HTTP server with
   no package and no review, verified by DNS TXT or `/.well-known/mcp-registry-auth`; it
   is the upstream feed for PulseMCP and Glama. No public numbers on how many agents
   query it; it is distribution for the buy-side MCP, not for individual listings.

### Doors that are closed to this product

- **Anthropic connectors directory**: policy bans software that "transfers money,
  cryptocurrency, or other financial assets"; also needs a Team/Enterprise org.
- **ChatGPT apps**: "selling digital products or services … is not allowed"; crypto
  transfers banned. Instant Checkout itself was discontinued 5 Mar 2026.
- **Perplexity merchant program**: digital goods are a restricted category.
- **Stripe agentic commerce / Stripe Directory**: needs Stripe-processed payments.
- **Google UCP/AP2**: Merchant Center, retail-shaped; x402 exists there only as a payment
  extension, not a discovery channel.
- **llms.txt**: server-log study over 83 sites, Apr–Jul 2026: GPTBot fetched robots.txt
  3,990 times and llms.txt 7 times; ClaudeBot 3,120 vs 9; PerplexityBot 0. Our markdown
  reading of `/` already covers the use case. Skip.

### What listing gets you

Not sales. A 16 Sep 2026 seller postmortem (Korean government data over MCP and x402)
reports ~1,250 requests a day from directory listings, "nearly all health-check and
security-scanner bots", and effectively zero real tool calls in week one. An August
census of 1,225 Bazaar sellers found 17% returning 404 and still listed. Discovery
channels put the listing where a funded agent *can* find it; the manifest and the trust
report have to do the rest.

## The Bazaar, in detail

Mechanics from the spec (`specs/extensions/bazaar.md`) and the CDP docs:

- The server puts `extensions.bazaar = { info, schema, routeTemplate? }` in the 402 body.
  `info.input` is `{ type: "http", method, queryParams?/headers? }` for GET;
  `info.output` is optional (`type`, `format`, `example`). `schema` is JSON Schema
  2020-12 validating `info`; the facilitator validates it before cataloguing.
- Optional top-level `resource` metadata: `serviceName` (≤32 chars), `tags` (≤5),
  `iconUrl`. Quality "considers … the completeness of the description, output schema,
  and service metadata", so these are worth filling.
- **Cataloguing happens only when the facilitator processes a `PaymentPayload` that
  echoes the extension.** "If the extension is omitted, discovery cataloging will not
  occur." Two consequences:
  1. A listing with zero sales is never in the Bazaar. Declaring the extension is
     necessary, not sufficient; something has to settle once.
  2. The *buyer's* client has to echo it. Coinbase's own clients do; a hand-rolled
     EIP-3009 signer following our skill file may not, unless the skill says to copy
     `extensions` from the 402 into the payload.
- `routeTemplate` (`/api/r/:owner/:slug`) collapses every match into **one** catalog
  entry. That is the opposite of what we want: each listing needs its own entry with its
  own description and tags. Leave `routeTemplate` out, and check that the facilitator's
  `matches_resource` check accepts the concrete URL (2.25.0 changed this; see
  [x402-upstream.md](../x402-upstream.md)).
- Feedback comes back in the `EXTENSION-RESPONSES` header (`bazaar.status`:
  success / processing / rejected). Two open reports (x402 #2112, Apr 2026; #3045,
  Aug 2026) say the CDP facilitator never emits it and resources silently fail to index.
  Verify with `…/discovery/merchant?payTo=<our address>` after the first settlement
  rather than trusting the header.
- No delisting mechanism is documented. The backlog's FR-45 question (is a takedown
  removed promptly?) has an answer: it is not removed at all; the URL just 404s, like
  17% of the index. That is tolerable because the entry names a URL and a price, not the
  artifact.
- The backlog's per-buyer-price question: the entry advertises one `amount`. The
  honest value is the new-buyer price; the 402 the agent then receives is the one that
  binds, and it can be lower (update price), never higher.

## Recommendations, ranked by automatic reach per unit of effort

*Status, 16 Sep 2026: items 1, 2 and 3 accepted and built the same day (PRD §9, §13;
docs/agent-discovery.md, "Off-domain"), except item 1's seeding, which was declined: the
platform does not buy its own listings, and a listing is indexed on its first organic sale
(DECISIONS.md, 2026-09-16). Item 4 done the same day: public skills repo at
github.com/pcmarts/x402git-skills, PRs to awesome-agentic-commerce, awesome-x402 and the
x402.org ecosystem; awesome-agent-skills declined by its own "established usage" rule
for now. Item 5 (README snippet) already existed.*

*21 Sep 2026: the three platform-owned `examples/*` listings submitted to
nohumans.directory (`POST api.nohumans.directory/v1/listings`, free, no account; one concrete
`/api/r/` URL per listing, `/api/v/` manifest as the free `sample_query`, category
`ai.agents`). Its probe only checks the unpaid 402 and the sample; its paying scout caps at
about $0.50 a call, so $5–$9 listings stay probe-verified, not paid-verified, unless a
$3 verify-now plan is bought. Third-party creators' listings were left for their owners.
Claim tokens (the edit keys, shown once) are in `nohumans-directory.local.json`.*

Each item is either per-listing-automatic (fires on publish with no creator action) or
one-off (done once for the platform). Nothing here asks a creator to do anything.

1. **Declare the Bazaar extension on the 402** (per-listing-automatic, already in the
   backlog). Attach it where requirements are built (`lib/core/access.ts` →
   `lib/x402/server.ts`), with `@x402/extensions`; `serviceName` = `owner/slug`, `tags`
   from the manifest's capability inventory, `info.output` = `application/zip` with the
   artifact digest. Tell the buy-a-repo skill to echo `extensions`. A listing then
   enters the Bazaar on its first organic sale, which the merchant endpoint confirms. The
   platform does not seed that sale (declined, 16 Sep 2026). Also publish `/.well-known/x402`
   (`{ version: 1, resources: [...] }`) and `x-payment-info` per operation in
   `/api/openapi.json`, which is what x402scan crawls; register the origin there once.
2. **Get indexed by the search engines the chat products read** (per-listing-automatic
   once wired). Verify the domain in Bing Webmaster Tools and Google Search Console;
   ping IndexNow from the publish path so each new listing is pushed rather than waited
   for; add JSON-LD `Product` + `Offer` (price in USDC, `SoftwareSourceCode` as the
   item) to the listing page next to the manifest it already renders server-side.
   `robots.txt` already allows every crawler; leave it. This is the only channel that
   surfaces a listing by *topic* to Claude, ChatGPT and Perplexity users, human or agent.
3. **Publish the buy-side MCP to the official MCP Registry** (one-off). `server.json`
   with a single `remotes: [{ type: "streamable-http", url: "https://x402git.com/api/mcp" }]`,
   namespace `com.x402git` verified by DNS TXT. Feeds PulseMCP and Glama; list on
   Smithery (`smithery mcp publish <url>`) and claim on Glama in the same sitting.
4. **A public `x402git/skills` GitHub repo** (one-off) holding the same `buy-a-repo` and
   `sell-a-repo` skill files we already serve, so `npx skills add x402git/skills` works
   and skills.sh and `find-skills` pick it up. Add the topics `agent-skills`, `x402`,
   `mcp-server`; open PRs to `awesome-agent-skills`, `awesome-agentic-commerce`,
   `awesome-x402`, and the x402.org ecosystem page (one JSON file). The skill must stay
   byte-identical to `/.well-known/agent-skills/…` or the digest invariant lies; publish
   from the same source.
5. **Keep the README snippet as the per-listing human path** (exists). Every GitHub
   aggregator scrapes public READMEs; a creator who pastes the snippet into their public
   repo puts the listing in front of every agent that reads that README.

Not worth doing now: DNS-AID (already decided), ARD registries (already published, no
crawler yet), llms.txt, and the four policy-blocked directories above. Revisit the
Anthropic and OpenAI directories only if a fiat rail ever exists.

## Other x402 directories (surveyed 21 Sep 2026)

Looked for registries shaped like nohumans.directory: a paid-endpoint index an agent
queries before spending. The first three are worth doing. Submitted the same day: 402 Index
(the three `examples/*` endpoints, all 201 "pending review"; a domain claim was opened and
its hash is served at `/.well-known/402index-verify.txt`, to be confirmed with
`POST 402index.io/api/v1/claim/verify {"domain":"x402git.com"}` within 72 hours of 21 Sep,
once deployed), x402 List (one marketplace entry, submission `<submission id>`, which replaces
`<submission id>` sent with a mistyped email; probe found 3/3 endpoints, no fee charged for a
custom domain on Vercel, manual review within 7 days) and usdc.org/x402 (form accepted,
reviewed by hand). Contact on all of them, and now on the nohumans listings:
`<directory-signup-address>`. Responses are in `402index.local.json` and `x402-list.local.json`.
Circle's form needs a Google sign-in, so it is Paul's to fill.

| Directory | Size | How to get in | Cost | Verdict |
| --- | --- | --- | --- | --- |
| [402 Index](https://402index.io) (L402 + x402 + MPP; HTTP, RSS, Nostr, MCP) | ~15,000 endpoints | `POST 402index.io/api/v1/register` per endpoint (`url`, `name`, `protocol`; price, network, provider optional); probe checks the 402, then admin review. Also ingests the Bazaar. Claim the domain via `/.well-known/402index-verify.txt` to edit later | Free, 10/hour per IP, no email needed | **Do.** Closest twin of nohumans |
| [x402 List](https://x402-list.com) | 791 services | `POST x402-list.com/api/v1/submit`: one submission per *service* with up to 50 endpoint paths; needs a contact email; automated probe then manual review (7-day window, one submission per email per 7 days) | Free on an own domain; $1 USDC if they class the host as free compute (`vercel.app`, `workers.dev`; a custom domain on Vercel is not stated either way) | **Do.** One entry covers the whole marketplace |
| [Circle Agent Marketplace](https://agents.circle.com/services) (behind Circle's Discovery API) | curated | Google form (`forms.gle/7YFzvdmMcn1JH5tF6`) or `agents.circle.com/sell`; sanctions-screened, reviewed by Circle; vanilla x402 on Base is an accepted rail | Free | **Do, by hand.** A human form; highest-trust catalog of the lot |
| [Open 402](https://agentinternetruntime.com/directory) (`ArcedeDev/open-402`) | small | Serve `/.well-known/agent.json` (payout address, payments, `intents[]` with prices), then submit the domain or PR `registry/domains.txt` | Free | Maybe. Costs a new well-known document with a single `payout_address`, which does not fit per-creator payTo |
| [usdc.org/x402](https://usdc.org/x402) | 19 sites | Web form (URL, email, type, description), reviewed; the form posts JSON to `/api/x402-submit` | Free | Done 21 Sep. Human-facing, tiny |
| [Satring](https://satring.com) (L402 first, x402 since 2026; feeds 402 Index) | — | `POST satring.com/api/v1/services`, per service with payTo, network, asset | $0.50 USDC per submission | Not yet: costs money, and 402 Index already has us directly |
| x402looker AgentIndex, x402watch | 100 / — | Submission form is disabled; x402watch only re-probes Bazaar and x402scan | — | Skip |
| [x402 Endpoint catalog](https://endpoint.x402jp.com) (x402jp; aggregates x402scan, Agentic.Market, Onyx Bazaar, Pay.sh, Ampersend, Circle) | 17,089 endpoints | Nothing to do: **already in it** via x402scan | — | Done, but see the note below |
| Agentic.Market, Onyx Bazaar | — | Both read the CDP Bazaar only | — | Follows the first sale, as decided |
| Ampersend, HOL registry, x402daily ecosystem page | — | No public seller path found | — | Skip |
| Pay.sh | 74 providers | Solana-first `pay-skills` registry | — | Skip: wrong chain |
| Agent Exchange | — | $1 USDC per listing, expires every 7 days | Rent | Skip |
| `nirholas/x402-skill-registry` | 4 seed listings, no hosted instance | Requires a Solana rail as well as Base | $0.01 | Skip |

**x402scan is cataloguing the wrong things.** The x402jp catalog shows what x402scan took
from `/openapi.json` on 16 Sep: 36 URLs, of which 8 are real listings and 28 are not paid
resources at all (`/api/cron/sweep`, `/api/cron/reconcile`, `/api/webhooks/github`,
`/api/payouts/sweep`, `/api/auth/rotate-key`, the creator CRUD routes, and the
`{owner}/{slug}` templates percent-encoded). It also has not re-crawled since: none of the
listings published after 16 Sep are there. Candidates for the backlog: mark only the
`/api/r/` operations with `x-payment-info` (or serve x402scan a listings-only document),
and re-register the origin on publish.

## What to measure

- Bazaar presence: `…/discovery/merchant?payTo=<PLATFORM_RECEIVING_ADDRESS>` total, and
  each entry's `quality.l30DaysUniquePayers`.
- Search presence: `site:x402git.com` in Bing and Google; Search Console impressions.
- Referrers on `/api/r/` 402s versus paid GETs, by user agent, to tell scanners from
  buyers.
