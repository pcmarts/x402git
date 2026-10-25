# Contributing to x402git

Thanks for helping. x402git sells access to private git repos for USDC over x402, so a small mistake here can cost someone money. These rules exist for that reason.

## Getting set up

Local setup (Supabase, your own GitHub App, Base Sepolia, the public x402 facilitator) is in [docs/SELF-HOST.md](docs/SELF-HOST.md). Copy `.env.example` to `.env` (gitignored) and fill it in. Use testnet values only.

## The rules

- **The PRD is the spec.** [PRD Final.md](PRD%20Final.md) holds the decisions, requirements, routes and data model. If your change needs the code to deviate from it, change the PRD first in the same pull request and say why. Don't reopen settled decisions in code.
- **`lib/core/access.ts` is the only module that knows about money or entitlements.** Every surface calls `quote`; only paid paths call `grant`. Don't fork it, and don't decide entitlement anywhere else.
- **Money is `bigint` micro-USDC everywhere** (`9000000n` is $9.00). Never a float, never a `number`.
- **Grant only after the facilitator's `settle` returns a transaction hash.** Payment nonces are unique; a payment can never grant twice.
- **Payouts go only to the creator's bound payout address.** There is no `to` parameter, and there must never be one.
- **Plain CSS using the tokens in [DESIGN.md](DESIGN.md).** No Tailwind.
- **Page text must be in the server-rendered HTML.** Listing pages are read by agents and crawlers that don't run JavaScript.

## Before you open a pull request

```
npm run typecheck   # must pass
npm test            # must pass; the suite is hermetic and needs no secrets
npm run check:ssr   # for any page change; needs `npm run dev` running
```

CI runs typecheck, tests, `npm audit` and gitleaks on every pull request. Never commit a secret, a private key or a filled-in env file, even a testnet one.

Keep commits small and focused, one change per commit, with a message that says what changed and why. Tests go next to the code they cover (`foo.ts`, `foo.test.ts`).

## Sign your commits (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/) instead of a CLA. Every commit must carry a `Signed-off-by:` line, which `git commit -s` adds for you:

```
git commit -s -m "fix: reject a settle response with no transaction hash"
```

By signing off you certify that you wrote the change, or otherwise have the right to submit it, under this project's licence (AGPL-3.0-only for the app, MIT for `lib/skills/`). You also accept that the contribution and your sign-off, including your name and email, are public and kept permanently. The full text is at the link above. CI rejects a pull request if any commit is missing a sign-off. To fix older commits, run `git rebase --signoff` against the base branch, then force-push your branch. Never force-push `main`; rebasing or force-pushing your own pull-request branch is fine.

## Questions

Open a [GitHub issue](https://github.com/pcmarts/x402git/issues). Report security problems privately instead, as described in [SECURITY.md](SECURITY.md).
