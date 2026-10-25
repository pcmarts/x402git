---
name: buy-a-repo
description: Buy paid access to a private git repository on x402git.com over HTTP 402, paying in USDC on Base or USDT0 on Stellar — whichever the listing offers. Use when an agent needs a skill, harness or library that is sold on X402 Git — to read a listing's free manifest before paying, to see which networks it can be paid on, to pay and pull the artifact, to check for a new release, or to re-fetch a version it already owns.
license: MIT
---

# Buy a private repo on X402 Git

Every listing has a **public manifest** and **private contents**. You can read the file
tree, licence, dependencies and security-scan result for free, decide, and only then
pay. Payment is over [x402](https://x402git.com/how-it-works) in dollars — **USDC on
Base**, or **USDT0 on Stellar** — and a listing offers whichever of the two its creator
can be paid on. There is no account, no email and no browser anywhere in this flow.

Money is always **micro-dollars as a decimal string**: `9000000` is $9.00. USDC and
USDT0 both count as $1; there is no conversion between them.

## What you need

One of:

- **An EVM wallet** that can sign EIP-191 messages and EIP-3009 transfer authorizations,
  funded with USDC on Base.
- **A Stellar account** (a `G…` address with its `S…` secret) that holds USDT0 (on
  pubnet; testnet deployments price in testnet USDC) and a little XLM for its reserve.
  `npx x402git-stellar buy <owner>/<slug>` does the whole exchange below from that key
  (source: https://github.com/pcmarts/x402git-stellar, MIT).

The server never sees your private key and has no code path that could — you sign
locally.

## 1. Read the manifest (free)

```
GET https://x402git.com/api/label/{owner}/{slug}
```

Returns the manifest of the latest passing release: `computed` (everything the analyser
measured from the exact bytes you would receive — tree, sizes, dependencies, licence,
scan result) and `self_reported` (the creator's own description and trigger hint, badged
as such). `artifact_sha256` is the hash of the artifact that was scanned and the one you
will be served.

Read this before you buy. It costs nothing and needs no wallet.

## 2. Check the version, your price, and how it can be paid

```
GET https://x402git.com/api/v/{owner}/{slug}
```

`latest`, `published_at`, `price_micro`, `update_price_micro`. Add the wallet header
(step 3) and it also answers `owned`, `entitled`, `all_versions` and `price_kind`
(`new` | `update` | `free` | `owned`) — what *your* next fetch would cost.

This is the cheap call to make on a schedule. `update_price_micro: "0"` means updates
are included for life once you have bought once.

**Which networks a listing takes** is `payment_options` — on MCP `search_listings`
results, `get_listing` and `how_to_buy`, and on the listing's own JSON:

```json
[{ "network": "eip155:8453", "asset": "0x833589…", "asset_symbol": "USDC", "amount": "9000000", "how": "Sign the eip155:8453 entry of accepts…" },
 { "network": "stellar:pubnet", "asset": "CBSJZEIO…", "asset_symbol": "USDT0", "amount": "90000000", "how": "Pay USDT0 on Stellar: `npx x402git-stellar buy owner/slug`…" }]
```

A listing with no entry for your network cannot be bought with your wallet. Say so and
hand the person the listing page; do not try to sign anyway.

## 3. Prove which wallet you are (`X-Wallet-Signature`)

Entitlement is never disclosed without a signature.

```
GET https://x402git.com/api/auth/challenge?address={address}&purpose=wallet_ownership
→ { nonce, message, expires_at, address }
```

Sign `message` verbatim and send:

```
X-Wallet-Signature: {address}.{nonce}.{signature}
```

- EVM: EIP-191 `personal_sign`; `signature` is the `0x…` hex.
- Stellar: SEP-53 (`Keypair.signMessage` in `@stellar/stellar-sdk`, ed25519 over
  `SHA256("Stellar Signed Message:\n" + message)`); `signature` is base64, `address` the
  `G…` account.

Single use, five-minute expiry. Get a fresh challenge per call.

## 4. Buy

```
GET https://x402git.com/api/r/{owner}/{slug}
```

With no payment attached you get **HTTP 402** with the x402 v2 body (also in the
`PAYMENT-REQUIRED` header):

- `accepts[]` — **one entry per network the listing takes**, Base first when it is
  offered. Each has `scheme`, `network`, `asset`, `payTo`, `amount`
  (`maxAmountRequired`), `resource`, `maxTimeoutSeconds`, `extra` and a `description`
  naming the token and chain ("$9.00 in USDT0 on Stellar"). **Sign the entry whose
  `network` is yours — never `accepts[0]` by position.** On a Stellar-only listing
  index 0 *is* the Stellar entry; on a listing that takes both, it is Base.
- `extra.kind` — `new` or `update`. On an update, `extra.from`, `extra.to` and
  `extra.releases[]` tell you **what changed before you pay for it**. Read them.
- `extra.quote_id` — echo it back or the purchase is rejected `price_changed`.
- `extra.manifest_url`, `extra.scan_badge_url` — the manifest and scan for this exact
  version.
- `extra.instructions`, `extra.listing_url`, `extra.skill_url`, `extra.mcp_url` — for a
  reader that is not an x402 client: one sentence saying what this response is, the
  page a person can buy on, this document, and the MCP server. If you cannot sign, stop
  here and hand the person `extra.listing_url`; the 402 is the price, not a fault.
- `extensions.bazaar` and `resource` — the discovery declaration. Copy both, unchanged,
  into your payment payload (`extensions` and `resource` next to `accepted` and
  `payload`). `@x402/fetch` and every `@x402/core` client do this by themselves; a
  hand-rolled signer has to. It costs nothing and it is how the listing gets indexed
  for the next agent.

Sign your entry locally and repeat the request:

- **Base** (`eip155:8453`): an EIP-3009 `transferWithAuthorization` of `amount`
  micro-USDC to `payTo`, signed against the EIP-712 domain in `extra`.
- **Stellar** (`stellar:pubnet`): a Soroban `transfer` of `amount` stroops of the
  `asset` contract to `payTo`, signed as an auth entry (`@x402/stellar`'s
  `ExactStellarScheme` with `createEd25519Signer`; fees are sponsored, so no XLM moves).
  `npx x402git-stellar buy {owner}/{slug}` does this, refuses any `asset` it cannot
  name, and checks the balance first.

```
GET https://x402git.com/api/r/{owner}/{slug}
PAYMENT-SIGNATURE: {base64 payment payload}
X-Quote-Id: {extra.quote_id}
X-Wallet-Signature: {address}.{nonce}.{signature}   # optional, to be quoted your price
```

**200** returns `{ version, artifact_sha256, download_url, expires_at, version_endpoint,
manifest_url, all_versions }`. `download_url` is a signed URL valid for five minutes.
Verify the sha256 of what you download against `artifact_sha256`. The `PAYMENT-RESPONSE`
header carries the settlement, including the transaction hash.

Access is granted only after the payment settles on-chain. A $0 listing grants on the
first call with no payment.

## 5. Re-fetch what you own — free, forever

```
GET https://x402git.com/api/r/{owner}/{slug}/v/{version}
X-Wallet-Signature: {address}.{nonce}.{signature}
```

A version belongs to the wallet that paid for it, on the network it paid on: what a Base
wallet bought is that Base wallet's, what a Stellar account bought is that account's.
A retired listing still serves to the wallets that bought it. From a Stellar key:
`npx x402git-stellar fetch {owner}/{slug}`.

```
GET https://x402git.com/api/entitlements
X-Wallet-Signature: {address}.{nonce}.{signature}
```

Everything this wallet owns: listing, version, `all_versions`, price paid, tx hash,
granted-at.

## Staying current

Poll `GET /api/v/{owner}/{slug}` with your wallet header before a run. If `latest` has
moved and `entitled` is false, `GET /api/r/…` returns an update 402 whose `extra` names
the diff. You are charged at most one update per listing per 7 days; releases inside
that window are granted free.

## The same thing over MCP

```
claude mcp add --transport http x402git https://x402git.com/api/mcp
```

Or add `https://x402git.com/api/mcp` as a custom connector in any client that takes a
remote MCP server; there is no login.

Six tools. `search_listings` finds live listings by what they do; it is free, needs no
wallet, and every result carries `payment_options`, so you can filter to listings you can
pay before going further. `how_to_buy` is free and needs no wallet: it says whether the
listing is for sale, the price, its `payment_options`, and the page, skill and endpoint
above — if you cannot sign, that is the tool to answer a person with. Pass it the
`network` you pay on and, when the listing offers nothing on it, it answers
`cannot_pay: true` with the options that exist instead of a procedure you cannot
follow. The other four are thin wrappers over the routes above: `get_listing`,
`check_version`, `purchase`, `fetch_release`. `purchase` returns the 402 as an error
result carrying the payment requirements (x402 MCP transport), you sign the entry whose
`network` is yours locally, and you call it again with `payment_signature`. Server card:
`https://x402git.com/.well-known/mcp/server-card.json`.

## Errors

Every error is `{ code, message, docs_url, details? }`. The ones that matter here:
`price_changed` (re-read the 402 and echo the new `quote_id`), `expired_authorization`,
`insufficient_balance` (the payer holds less of the listing's token than the price),
`replay`, `settlement_pending` / `settlement_timeout` (the money may have moved — poll
`GET /api/v/…` with your wallet header rather than re-paying), `not_entitled`,
`rate_limited` (with `retry_after_seconds`). Full catalogue:
https://x402git.com/docs/errors

## Reference

- OpenAPI: https://x402git.com/api/openapi.json
- Routes: https://x402git.com/docs
- Rate limits: `/api/r` 60/min per address; `/api/v` and `/api/label` 600/min per IP.
