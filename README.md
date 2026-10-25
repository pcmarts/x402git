# X402 Git

X402 Git sells access to private git repositories over [x402](https://x402.org) and USDC, for humans and for agents. A creator lists a repo and sets a price, and buyers pay per release. Before a release can be sold, the platform snapshots it and scans it for secrets, vulnerable dependencies and licence problems. Buyers then get the exact bytes that were scanned. The live service is at [x402git.com](https://x402git.com).

## How it works

1. A creator lists a repo: a private GitHub repo through the GitHub App, or a repo the platform hosts for them.
2. Each release is snapshotted and scanned, and the result is published as a free, public manifest.
3. A buyer requests the repo and gets an HTTP 402 quote with the price and the payment requirement.
4. The buyer signs a USDC authorization on Base with their own key, and the facilitator settles it on-chain.
5. After settlement the buyer has an entitlement and a five-minute download URL. Agents do the same through the MCP server or the agent skills.

## Architecture

- Next.js 16 App Router on Vercel, in TypeScript with plain CSS. Pages are server-rendered and call the same JSON API that agents use.
- Supabase Postgres holds the ledger, and Supabase Storage holds the snapshots.
- `lib/core/access.ts` is the only module that knows about entitlements or money. Every surface calls its `quote`; only paid paths call `grant`.
- Payments are x402 verify and settle through a facilitator (`lib/x402`). Access is granted only after settle returns a transaction hash.
- A GitHub App gives read access to creators' repos and creates hosted ones. The scanner in `lib/scan` and `lib/analysis` decides what can be sold.

The spec is [PRD Final.md](PRD%20Final.md). [AGENTS.md](AGENTS.md) explains the layout and the rules that matter when you change the code.

## Run it yourself

```sh
npm ci
supabase start && supabase db reset   # local Postgres and Storage in Docker, schema applied
npm run dev                           # http://localhost:3000
```

Before `npm run dev`, copy `.env.example` to `.env` and fill in `SUPABASE_URL` and `SUPABASE_SECRET_KEY` from `supabase status`. The home page, `/docs` and `/api/openapi.json` then work. Signing in needs your own GitHub App, and paying needs a Base Sepolia wallet. [docs/SELF-HOST.md](docs/SELF-HOST.md) covers both, plus deploying your own instance. `npm run typecheck` and `npm test` need no `.env` and no database.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. The PRD is the spec, so a change that departs from it starts as a change to the PRD. Money is `bigint` micro-USDC everywhere. `npm run typecheck` and `npm test` must pass. Sign off every commit (`git commit -s`) under the [Developer Certificate of Origin](https://developercertificate.org/).

## Security

Please do not open a public issue for a vulnerability. Report it through GitHub private vulnerability reporting on this repository, or by email to abuse@x402git.com. [SECURITY.md](SECURITY.md) explains what is in scope and what to expect.

## Licence

The app is licensed under AGPL-3.0-only: see [LICENSE](LICENSE). The agent skills in `lib/skills` are MIT. [NOTICE](NOTICE) lists what the code licence does not cover, and [TRADEMARKS.md](TRADEMARKS.md) explains that it grants no right to the X402 Git name or logo.

## API and MCP guide

This is how to use the hosted service at x402git.com. A self-hosted instance serves the same routes on its own host.

Every route, request and response is generated from the same zod schemas the handlers validate against. [`/docs`](https://x402git.com/docs) is the readable list, [`/api/openapi.json`](https://x402git.com/api/openapi.json) is the machine one, and [`/docs/errors`](https://x402git.com/docs/errors) is the catalogue every error body comes from. Every error is `{ code, message, docs_url, details? }`.

Money is micro-USDC everywhere, as a decimal string: `9000000` is $9.00.

### For creators

**On the web.** Sign in with GitHub at `/signin` and bind a payout address by signing a challenge with your wallet. Then install the GitHub App on a private repo, pick it, set the price and publish. The dashboard gives you a README snippet to paste into your own README. That snippet is how downstream agents learn to check for new versions.

**Headless.** The website is a client of the same API, and there is no private admin surface. Hosted repos, where the platform creates the private repo and you push to it with a deploy key, are API only and currently invite-only.

```
GET    /api/terms                                             # the terms version you must accept
GET    /api/auth/challenge?address=0x…&purpose=address_proof  # a message to sign with your payout address
POST   /api/creators                                          # register; returns an api_key, shown once
POST   /api/listings                                          # create a listing: source "github" or "hosted"
POST   /api/listings/{id}/sync                                # cut a version: snapshot, scan, licence check
POST   /api/listings/{id}/licence                             # commit a LICENSE if the repo has none
PATCH  /api/listings/{id}                                     # price, update price, description, trigger hint
GET    /api/listings/{id}                                     # status, licence verdict, latest release
POST   /api/listings/{id}/publish                             # draft to live
GET    /api/earnings                                          # the ledger; payouts sweep daily after a 7-day holdback
DELETE /api/listings/{id}                                     # retire; existing buyers keep their access
```

Everything after registration is `Authorization: Bearer x4c_live_…`. A bearer key cannot move money or destroy data. Changing the payout address (`PATCH /api/creators/me`), rotating a deploy key, deleting a hosted repo and replacing a lost key (`POST /api/auth/rotate-key`) each need a fresh signature from the payout address. Payouts go only to the bound payout address; there is no `to` parameter. The server never sees your private key.

The full walk-through is the [sell-a-repo skill](lib/skills/sell-a-repo.md).

### For buyers

#### curl

```sh
# Free, no auth: what is in it, and what does it cost?
curl https://x402git.com/api/label/examples/humanizer
curl https://x402git.com/api/v/examples/humanizer

# The 402 carries the price, the payment requirement and the quote id (extra.quote_id).
curl -i https://x402git.com/api/r/examples/humanizer

# Sign accepts[0] as an EIP-3009 authorization with your own key, then:
curl -H "PAYMENT-SIGNATURE: <base64 x402 payload>" \
     -H "X-Quote-Id: <extra.quote_id from the 402>" \
     https://x402git.com/api/r/examples/humanizer
# → { version, artifact_sha256, download_url, expires_at, version_endpoint, manifest_url, all_versions }
```

A paid request without `X-Quote-Id` is refused with `price_changed`. Check the sha256 of what you download against `artifact_sha256`.

Add `X-Wallet-Signature: <address>.<nonce>.<signature>` to be quoted *your* price rather than the new-buyer price, to see what you already own, and to re-fetch a version you bought. Get the nonce and the message to sign from `GET /api/auth/challenge?address=<address>&purpose=wallet_ownership`. Each challenge is single use and lasts five minutes.

```sh
curl -H "X-Wallet-Signature: …" https://x402git.com/api/r/examples/humanizer/v/1.0.0
curl -H "X-Wallet-Signature: …" https://x402git.com/api/entitlements
```

An update price of `0` means updates are included for life. Otherwise an update costs the lower of the update price you were quoted when you bought and the current one, and you are charged at most once per listing per 7 days. `GET /api/v/:owner/:slug/releases` is the public release log.

`GET /api/snippet/:owner/:slug` returns the paste-ready README preamble as markdown.

The full walk-through is the [buy-a-repo skill](lib/skills/buy-a-repo.md).

#### MCP

The buy-side MCP server is at **`https://x402git.com/api/mcp`**. It uses Streamable HTTP, is stateless, and needs no authentication to connect. Add it by URL as a custom connector in any client that takes a remote MCP server. It has six tools. The first finds a listing by what it does, the second is for a client that cannot sign, and the other four wrap the route of the same shape:

| Tool | Wraps |
| --- | --- |
| `search_listings` | Nothing. Searches live repos and agent skills by what they do (name, description, computed tags, README). No wallet needed. Ordered by match, never by sales. |
| `how_to_buy` | Nothing. Returns for-sale status, price, listing page, skill and endpoint. No wallet needed. |
| `get_listing` | `GET /api/label/:owner/:slug` |
| `check_version` | `GET /api/v/:owner/:slug` |
| `purchase` | `GET /api/r/:owner/:slug` |
| `fetch_release` | `GET /api/r/:owner/:slug/v/:version` |

`purchase` takes a **pre-signed** `PAYMENT-SIGNATURE` value. Call it with no payment and you get the x402 402 back as structured content. That is the price, not an error. Sign the authorization locally with your own key and call again. Purchases made this way are recorded with `source: mcp`.

Add it to Claude Code:

```sh
claude mcp add --transport http x402git https://x402git.com/api/mcp
```

Or inspect it:

```sh
npx @modelcontextprotocol/inspector --transport http --server-url https://x402git.com/api/mcp
```

Or speak JSON-RPC to it directly:

```sh
curl -X POST https://x402git.com/api/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

The server card is at `https://x402git.com/.well-known/mcp/server-card.json`.

#### Agent skills

The buy and sell flows are also written as agent skills: [buy-a-repo](lib/skills/buy-a-repo.md) and [sell-a-repo](lib/skills/sell-a-repo.md). The site serves them at `https://x402git.com/.well-known/agent-skills/<name>/SKILL.md`, and they are mirrored to [pcmarts/x402git-skills](https://github.com/pcmarts/x402git-skills):

```sh
npx skills add pcmarts/x402git-skills
```
