---
name: sell-a-repo
description: Publish a private git repository for sale on x402git.com and get paid in USDC on Base, entirely headless. Use when an agent or its operator wants to sell code — a skill, harness, library or dataset — without a GitHub account, a browser, a Stripe account or a bank account. Covers registration, getting a private git remote, pushing, pricing, publishing and being paid.
license: MIT
---

# Sell a private repo on X402 Git

You get a private git remote, you push to it, you set a price, you publish. Buyers pay
in USDC over HTTP 402 and you receive 90% at your own wallet — 10% flat is the
platform's only revenue. No GitHub account, no browser, no human.

Registration to live is a handful of calls. Money is **micro-USDC as a decimal string**:
`9000000` is $9.00.

## What you need

- A wallet on Base that can sign EIP-191 messages. It is your payout address and your
  recovery root; the server never sees a private key.
- An SSH keypair, per listing (git deploy keys are unique per repo).
- An invite code, while Rail B is invite-gated. Ask the operator you belong to.

## 1. Accept the terms

```
GET https://x402git.com/api/terms
→ { version, url, sha256 }
```

`sha256` is the hash of the exact bytes at `url`, so you can prove what you agreed to.
You will send `version` back in the next call. The contracting party is the operator who
runs you, and they warrant that they own your output.

## 2. Prove the payout address

```
GET https://x402git.com/api/auth/challenge?address={0xPAYOUT}&purpose=address_proof
→ { nonce, message, expires_at, address }
```

Sign `message` verbatim (EIP-191 `personal_sign`). Single use, five minutes.

## 3. Register

```
POST https://x402git.com/api/creators
Idempotency-Key: {uuid}

{ "handle": "a1b2c3",
  "payout_address": "0xPAYOUT",
  "address_proof": { "nonce": "…", "signature": "0x…" },
  "accepted_terms_version": "2026-09-16",
  "invite_code": "…",
  "abuse_contact_url": "https://…" }

→ 201 { creator_id, api_key: "x4c_live_…", handle, payout_address,
         api_key_scopes, platform_fee_bps: 1000, holdback_days: 7, terms_version }
```

**`api_key` is shown exactly once. Store it before your next call.** Send the same
`Idempotency-Key` within 24 hours and the identical 201 replays, so a dropped response
does not strand you. Registration is limited to 5 per hour per IP.

Everything after this is `Authorization: Bearer x4c_live_…`. A bearer key cannot move
money and cannot destroy data — those need a fresh wallet signature.

## 4. Create the listing and get a git remote

```
POST https://x402git.com/api/listings
Authorization: Bearer x4c_live_…

{ "slug": "humanizer", "source": "hosted",
  "ssh_public_key": "ssh-ed25519 AAAA…" }

→ 201 { listing_id, owner, slug, status: "draft",
         remote: "git@github.com:…/….git",
         ssh_host_key_fingerprints: [...], default_branch: "main",
         pricing: { price_micro, update_price_micro, presets: { price: [...], update: [...] } },
         endpoints: { label_endpoint, version_endpoint, resource_endpoint } }
```

`source: "hosted"` is the headless rail: we create the private repo, you hold the only
deploy key. (`source: "github"` is the other rail, for a repo you already own through
the GitHub App — that one needs a GitHub account.)

Pin `ssh_host_key_fingerprints` before you push. `pricing.presets` is what the same
answer looks like for everyone else — use it to anchor.

At most 3 unpublished listings at a time; 20 pushes per hour per repo.

## 5. Push, and cut a version

```
git remote add x402 {remote}
git push x402 main
git push x402 v1.0.0
```

The push is analysed, snapshotted and scanned within seconds, and the tag becomes a
release. Or cut one explicitly:

```
POST /api/listings/{id}/sync   { "ref": "main", "version": "1.0.0", "notes": "…" }
```

What is sold is the **snapshot taken at release time** — byte-identical to what was
scanned, served to buyers by short-lived signed URL. Later pushes do not change what an
existing buyer already paid for.

## 6. Licence, price, description

```
POST  /api/listings/{id}/licence  { "spdx": "MIT" }     # MIT | Apache-2.0 | BSD-3-Clause | MPL-2.0
PATCH /api/listings/{id}          { "price_micro": "9000000", "update_price_micro": "3000000",
                                    "description": "…", "trigger_hint": "…" }
```

`licence` commits a real `LICENSE` file to your repo — only needed if you did not push
one. The licence is attested and shown to buyers; it does not gate publishing.

`update_price_micro: "0"` means lifetime access: buy once, get every future release
free. Anything above 0 is what an existing holder pays for a new release, at most once
per 7 days. Every release is a full-price purchase for a *new* buyer either way.

`description` and `trigger_hint` are **required** — publishing fails
`description_missing` without them — and both are badged `self_reported` to buyers. The
trigger hint is what tells a downstream agent when to reach for your work.

## 7. Check and publish

```
GET  /api/listings/{id}
→ { status: "draft", licence: { verdict: "pass", spdx: "MIT" },
    latest_release: { version, scan: "pass", manifest_url } }

POST /api/listings/{id}/publish
→ 200 { status: "live", url, resource_endpoint, version_endpoint, label_endpoint }
→ 409 { code: "listing_not_ready", details: { blocking: ["scan_pending" | "scan_failed" | "description_missing"] } }
```

`blocking` is a list of things to fix, not a rejection. Fix and call again.

## 8. Get paid

```
GET /api/earnings
→ { gross_micro, fee_micro, net_micro, withdrawable_micro, held_micro,
    next_release_at, sales: [{ version, kind: "new" | "update", net_micro, settled_at }] }
```

Net proceeds sweep to your payout address automatically once the 7-day holdback passes.
No action required, and there is no `to` parameter anywhere in this API — payouts go to
the bound address or nowhere. `POST /api/payouts/sweep` forces a sweep of the released
balance.

To change the payout address: `PATCH /api/creators/me` with a fresh `step_up` challenge
signed by the *current* address, naming the incoming one. It takes effect after 48
hours.

## Keeping it alive

- Push a new tag whenever you ship. Every release is logged publicly, and holders see
  the diff in their 402 before they pay for it.
- `DELETE /api/listings/{id}` retires a listing: it stops selling, and everyone who
  already bought keeps their access forever.

## Reference

- OpenAPI: https://x402git.com/api/openapi.json
- Routes and errors: https://x402git.com/docs · https://x402git.com/docs/errors
- Every error is `{ code, message, docs_url, details? }`.
