# Security policy

x402git moves real money. If you find a way to get something without paying, to be paid something you are not owed, or to be served bytes that were never scanned, we want to hear about it before anyone else does.

## How to report

- **Preferred:** GitHub private vulnerability reporting on this repository (Security tab, "Report a vulnerability").
- **Or email:** `abuse@x402git.com`.

Please do not open a public issue, pull request or discussion for a vulnerability.

Include what you found, the steps to reproduce it, and what an attacker gains. A proof of concept against a local deployment on Base Sepolia is ideal.

We acknowledge every report within **72 hours**, keep you updated while we fix it, and credit you when it ships unless you would rather stay anonymous.

## In scope

- The payment and entitlement path: `lib/core/access.ts` (quote and grant) and anything that reaches a grant without going through it.
- The x402 verify and settle flow (`lib/x402/`): replayed or reused payments, grants before settlement returns a transaction hash, amount, asset, network or recipient confusion.
- The scanner (`lib/scan/`) and the release snapshot (`lib/release/`, `lib/snapshot.ts`): anything that lets a release be served that was not scanned, or served bytes whose `artifact_sha256` differs from the scanned artifact.
- Authentication and sessions: GitHub OAuth sign-in, the session cookie, API keys, wallet signatures, and the admin gate.
- Payout binding (`lib/payouts/`): anything that sends a creator's payout anywhere other than their bound payout address, or lets someone else change that binding.

## Out of scope

- Volumetric denial of service, and load or flood testing of any kind.
- Findings that require a leaked `CRON_SECRET` or other operator credentials.
- The hosted third-party services themselves (Vercel, Supabase, GitHub, Coinbase CDP, the x402 facilitator, Base). Report those to their owners. How x402git uses them is in scope.
- Missing headers or best-practice notes with no demonstrated impact.

## Rules for testing

- **Never test against mainnet funds.** Run your own copy on Base Sepolia (see `docs/SELF-HOST.md`) and use testnet USDC.
- Do not run high-volume or automated testing against https://x402git.com or its production rate limits.
- Do not create listings, purchases or payouts on production as tests, and do not access or change data that is not yours.

## Safe harbour

If you follow this policy in good faith, we will not pursue or support legal action against you for your research, and we will work with you to understand and fix the problem quickly. If in doubt about whether something is allowed, ask first at `abuse@x402git.com`.
