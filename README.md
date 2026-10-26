# X402 Git

**Agents pay open source maintainers, per release, on Stellar.**

X402 Git sells early access to a project's next release over [x402](https://x402.org), the HTTP 402 payment standard. A person or an AI agent asks for the release, gets a price back, pays in USDT0 with one signature, and downloads the exact bytes that were scanned. The money goes to the project's own Stellar address. On the date the maintainer set, the same commit goes public under its licence, and the platform checks that it did.

**HackMeridian 2026 submission.** This is the `hackmeridian` branch. It runs live at **[hack.x402git.com](https://hack.x402git.com)** on Stellar mainnet with real money. The maintainer pitch is at [hack.x402git.com/open-source](https://hack.x402git.com/open-source).

## The problem

Open source is worth an estimated $8.8 trillion to the companies that use it, and almost none of that reaches the people who write it. Agents now do a growing share of the reading, installing and upgrading. They never see a sponsor button, and they don't click one. They can pay a 402 in one round trip, though, if the release has a price and an address to pay.

X402 Git gives a release both. A maintainer puts the next release on early access. Users and their agents who want it now pay for it. Everyone else gets it free on the date the maintainer promised.

## It works on mainnet

Our own example listing, [`pcmarts/open-release-demo-next`](https://hack.x402git.com/pcmarts/open-release-demo-next), priced at $1. We were both the buyer and the creator on these runs. They show the money moving, not traction.

| Rail | Step | Transaction |
| --- | --- | --- |
| Stellar mainnet | Buyer pays $1.00 USDT0 from Freighter. The facilitator pays the network fee | [`5bd56529…a63a3`](https://stellar.expert/explorer/public/tx/5bd56529a6da515deba4b9a9034ad6800354ccf74b15c4e8a1beb47be37a63a3) |
| Stellar mainnet | The project is paid 0.90 USDT0 (90%) at its own Stellar address | [`16b6e576…d4b69`](https://stellar.expert/explorer/public/tx/16b6e576d170ccad99183b83f0b42a073eadaf70b86badc785bef47a53dd4b69) |
| Arbitrum One | Buyer pays $1.00 USDT0 from MetaMask | [`0xec10bbd2…d34037`](https://arbiscan.io/tx/0xec10bbd2c8df0f7e61fcd499ca1320775569c959e6b1c5ae912f12fcb5d34037) |
| Arbitrum One | The project is paid 0.90 USDT0 | [`0x3c1e8d76…10cc6`](https://arbiscan.io/tx/0x3c1e8d76f5cbb3a7c5e608ac550c86d3f9bf9356215b85ecf500ff7ddbd10cc6) |

Both payouts were sent by the payout sweep (`POST /api/payouts/sweep`). The event deployment sets the holdback to zero days so the payout can follow the sale straight away. Production holds for 7 days.

## What we built at the event

Everything Stellar here was written at HackMeridian, after `d87ea40` (25 Oct 2026, 10:55 UTC). Before that, the app sold releases for USDC on Base only. The diff is `git diff d87ea40 hackmeridian`: 173 files, about 22,000 lines.

- **A Stellar rail in the 402.** Every listing's 402 now has a `stellar:pubnet` entry next to the EVM ones. It is the stock [`@x402/stellar`](https://www.npmjs.com/package/@x402/stellar) exact scheme: a Soroban `transfer` of the USDT0 SAC, settled through the OpenZeppelin facilitator, with fees sponsored. The buyer spends no XLM. ([`lib/x402/stellar.ts`](lib/x402/stellar.ts), [`lib/x402/server.ts`](lib/x402/server.ts))
- **Stellar payers in the money core.** A `G…` address can buy, own and re-download a version. Ownership is proven with a SEP-53 signed message. Access is still granted in one module, and only after settle returns a transaction hash. ([`lib/core/access.ts`](lib/core/access.ts), [`lib/auth/stellar-binding.ts`](lib/auth/stellar-binding.ts))
- **Stellar payouts.** The sweep pays 90% to the creator's bound Stellar address, one payment at a time from the platform account. A Stellar sale is only ever paid out to a Stellar address. ([`lib/payouts/stellar.ts`](lib/payouts/stellar.ts), [`lib/payouts/sweep.ts`](lib/payouts/sweep.ts))
- **Open releases.** A listing can promise that each release goes public in a named repository N days after it is cut (7, 30, 90 or a custom number). Eligibility is computed, never declared: the licence passes, the public repo exists, the commit is not already public there, and the creator can be paid. Once the date passes, the platform asks GitHub whether the same commit is public under the same licence and records *Opened on time* or *Overdue*, with a link to the evidence. The verdict shows on the page, in the manifest JSON and in MCP. ([`lib/release/open.ts`](lib/release/open.ts), [`lib/release/promise.ts`](lib/release/promise.ts), [`app/api/cron/promises`](app/api/cron/promises))
- **Pay from any Stellar wallet.** The listing page has one Pay block with a row for each way to pay. The Stellar row uses the [Stellar Wallets Kit](https://github.com/Creit-Tech/Stellar-Wallets-Kit), so Freighter, Lobstr, xBull and the rest work. One press connects, checks what you already own, and asks for the signature. ([`app/_components/pay-block.tsx`](app/_components/pay-block.tsx), [`lib/web/stellar-checkout.ts`](lib/web/stellar-checkout.ts))
- **Stellar-only creators.** A maintainer can sign up, bind a Stellar payout address with one signature, and list a repo without ever touching an EVM wallet. Adding another rail later is one wallet and one signature. ([`app/dashboard/wallet/page.tsx`](app/dashboard/wallet/page.tsx))
- **A USDT0 rail on Arbitrum,** so a buyer whose dollars are on Arbitrum can pay without bridging first. ([`lib/x402/flow.ts`](lib/x402/flow.ts))
- **An agent buyer CLI,** [`pcmarts/x402git-stellar`](https://github.com/pcmarts/x402git-stellar) (MIT, separate repo). It is the stock `@x402/stellar` client as a command line: `buy`, `fetch` and `whoami`. It never signs a token it can't name, and it refuses before signing when the account can't cover the price.
- **Agent discovery.** The MCP server's `search_listings`, `how_to_buy` and `get_listing` tools report each listing's payment options per network, and its open-release status.

Tests: 175 files and 2,444 tests in this repo, 38 in the CLI, all passing. The money paths (402, settle, entitlement, sweep) each have a Stellar test file next to the Base one.

## Intake goals and evidence

| Goal | Status | Evidence |
| --- | --- | --- |
| 1. Agents pay open source maintainers on Stellar | Done, on mainnet | The two Stellar transactions above. The CLI runs the same exchange from a terminal: [`x402git-stellar`](https://github.com/pcmarts/x402git-stellar) |
| 2. Open releases, with the opening date checked | Built and tested. The live flip is in the demo video | [`lib/release/promise.ts`](lib/release/promise.ts) and its tests; the open-release fields in [`/api/openapi.json`](https://hack.x402git.com/api/openapi.json) |
| 3. An agent with a budget | Done | The agent's wallet is a plain Stellar account holding $5. Ask the CLI to buy above its balance and it exits with code 3 before signing; the chain would refuse anyway |
| 4. The first open releases: ours plus 3 from other teams | Ours is listed | [`pcmarts/open-release-demo-next`](https://hack.x402git.com/pcmarts/open-release-demo-next) |

## Try it

All of this runs against the live deployment. Reading is free and needs nothing.

```sh
B=https://hack.x402git.com

# What is in the release and what it costs. Free, no account.
curl $B/api/label/pcmarts/open-release-demo-next

# The 402 itself. The payment-required header lists Base USDC, Arbitrum USDT0 and Stellar USDT0.
curl -si $B/api/r/pcmarts/open-release-demo-next | grep -i payment-required \
  | cut -d' ' -f2 | base64 -d | python3 -m json.tool
```

**Let Claude Code find it.** Add the MCP server and ask for an open release. No wallet is needed to search.

```sh
claude mcp add --transport http x402git-hack https://hack.x402git.com/api/mcp
# then: "find an open release on x402git and tell me how to pay for it on Stellar"
```

**Buy it with the agent CLI.** This spends $1 of real USDT0 on Stellar mainnet. You need a Stellar account with a USDT0 trustline and at least $1 USDT0 in it. The CLI isn't on npm yet, so build it from source:

```sh
git clone https://github.com/pcmarts/x402git-stellar && cd x402git-stellar
npm install && npm run build && npm link

export X402GIT_STELLAR_SECRET=S…            # the paying account's secret, read from the environment only
export X402GIT_BASE_URL=https://hack.x402git.com
x402git-stellar whoami                       # the address and its USDT0 balance
x402git-stellar buy pcmarts/open-release-demo-next   # pays, checks the sha256, writes the zip, prints the stellar.expert link
x402git-stellar fetch pcmarts/open-release-demo-next # downloads it again for free, with a signed message
```

**Or buy it in a browser.** Open [the listing](https://hack.x402git.com/pcmarts/open-release-demo-next), press the Stellar row of the Pay block and sign with Freighter, Lobstr or another Stellar wallet.

## How it works

1. A creator lists a repo: a private GitHub repo through the GitHub App, or a repo the platform hosts for them. For an open release, the private repo is a mirror of the public project, one release ahead.
2. Each release is snapshotted and scanned for secrets, vulnerable dependencies, malware and licence problems. The result is published as a free, public manifest.
3. A buyer requests the repo and gets an HTTP 402 quote: the price, and one payment option per rail (Stellar USDT0, Arbitrum USDT0, Base USDC).
4. The buyer signs the payment with their own key, and a facilitator settles it on-chain. The platform never holds a buyer's key.
5. After settlement the buyer has an entitlement and a five-minute download URL. A version belongs to the address that paid for it, and re-downloading it is free.
6. The sweep pays the creator 90% on the same rail, to the address they bound with a signature.
7. For an open release, the platform checks the public repo once the opening date has passed, and shows whether the promise was kept.

## Architecture

- Next.js 16 App Router on Vercel, in TypeScript with plain CSS. Pages are server-rendered and call the same JSON API that agents use.
- Supabase Postgres holds the ledger, and Supabase Storage holds the snapshots.
- `lib/core/access.ts` is the only module that knows about entitlements or money. Every surface calls its `quote`; only paid paths call `grant`.
- Payments are x402 verify and settle through a facilitator per rail (`lib/x402`): OpenZeppelin for Stellar, Coinbase for Base and Arbitrum. Access is granted only after settle returns a transaction hash. Money is `bigint` micro-dollars everywhere; Stellar's 7 decimals are converted at the edge.
- A GitHub App gives read access to creators' repos and creates hosted ones. The scanner in `lib/scan` and `lib/analysis` decides what can be sold. `lib/release` stamps and checks open-release promises.
- No smart contract of our own. The Stellar side is the USDT0 SAC, the stock x402 scheme, a hosted facilitator and Horizon.

The spec is [PRD Final.md](PRD%20Final.md). [AGENTS.md](AGENTS.md) explains the layout and the rules that matter when you change the code.

## Run it yourself

```sh
npm ci
supabase start && supabase db reset   # local Postgres and Storage in Docker, schema applied
npm run dev                           # http://localhost:3000
```

Before `npm run dev`, copy `.env.example` to `.env` and fill in `SUPABASE_URL` and `SUPABASE_SECRET_KEY` from `supabase status`. The home page, `/docs` and `/api/openapi.json` then work. Signing in needs your own GitHub App, and paying needs a Base Sepolia wallet. To run the Stellar rail too, fill in the `STELLAR_*` block in `.env.example` (testnet works with the free x402.org facilitator); leave `STELLAR_NETWORK` empty and Base runs alone. [docs/SELF-HOST.md](docs/SELF-HOST.md) covers both, plus deploying your own instance. `npm run typecheck` and `npm test` need no `.env` and no database.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. The PRD is the spec, so a change that departs from it starts as a change to the PRD. Money is `bigint` micro-dollars everywhere. `npm run typecheck` and `npm test` must pass. Sign off every commit (`git commit -s`) under the [Developer Certificate of Origin](https://developercertificate.org/).

## Security

Please do not open a public issue for a vulnerability. Report it through GitHub private vulnerability reporting on this repository, or by email to abuse@x402git.com. [SECURITY.md](SECURITY.md) explains what is in scope and what to expect.

## Licence

The app is licensed under AGPL-3.0-only: see [LICENSE](LICENSE). The agent skills in `lib/skills` are MIT. [NOTICE](NOTICE) lists what the code licence does not cover, and [TRADEMARKS.md](TRADEMARKS.md) explains that it grants no right to the X402 Git name or logo.

## API and MCP guide

This is how to use the hosted service at x402git.com. A self-hosted instance serves the same routes on its own host.

Every route, request and response is generated from the same zod schemas the handlers validate against. [`/docs`](https://x402git.com/docs) is the readable list, [`/api/openapi.json`](https://x402git.com/api/openapi.json) is the machine one, and [`/docs/errors`](https://x402git.com/docs/errors) is the catalogue every error body comes from. Every error is `{ code, message, docs_url, details? }`.

Money is micro-dollars everywhere (micro-USDC or micro-USDT0, both 6 decimals), as a decimal string: `9000000` is $9.00. The Stellar entry of a 402 carries the amount in the token's own 7 decimals.

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
