# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Next.js 16 (App Router) on Vercel, TypeScript, plain CSS with tokens, Supabase Postgres and Storage. Chosen in PRD Final.md §11; server-side rendering is a product requirement, not a preference, because agents fetch listing pages as HTML.

## Users

Two creators and two buyers, and every flow must work for all four.

- **Creator-human.** Ships 5–40 releases a year of skills, harnesses and agent tooling. Has an audience elsewhere (X, YouTube, Discord). Could build a payment wrapper himself; wants payouts, compliance and a listing page he does not have to maintain. Does not want to handle custody or tax or look like a sellout to the audience that built his following.
- **Creator-agent.** An autonomous agent that produces sellable code. Has a wallet and an SSH keypair, no GitHub account, no email it reads, no browser. Everything it does is through the API. Its operator set its policy weeks ago.
- **Buyer-operator ("Paul").** Runs several agents, funds a wallet with $20–50, wants his agents on the current version of the things he trusts, and wants to see what they bought.
- **Buyer-agent.** The transacting party. Reads the manifest, checks the version endpoint before each run, pays within a budget, downloads, and decides whether an update is worth paying for from the diff.

The web interface serves the two humans. It must never be the only way to do anything.

## Product Purpose

A creator connects or is provisioned a private git repo, sets a price, and gets a paid endpoint. Buyers pay in USDC over x402 and get the repo at a version. The platform takes a flat 10% of every payment and nothing else.

Success in 60 days: 50 paid purchases, 30 distinct paying wallets, 25 listings of which 20 are not ours, at least 5 listings created fully headless. The single hypothesis under test: **does a public manifest over a private repo convert where a sealed box does not?** Manifest views per purchase is the number that answers it.

## Positioning

Two claims a neighbouring product cannot truthfully make:

1. **The manifest is public; the contents are private.** Before paying, anyone can see the file tree, file count and sizes, language mix, rendered README, dependency list, licence, scan result, release log and a computed artifact class. Competitors (SkillShop.sh) ask buyers to purchase a sealed box, and they don't.
2. **Every flow is an API first; the website is a client of it.** An agent with a wallet and an SSH key can register, get a private git remote, push, price, publish, and be paid, with no human. The only agent-native registrar found in research (LobeHub) has no payments.

## Operating Context

- Creators arrive with a repo in hand and an audience elsewhere; the listing page is what they link to from a README, a tweet or a video. It is read cold, often by an agent, often once.
- Buyers arrive from a creator's link or an agent's fetch, decide in under a minute, pay with a connected wallet, download a zip. Returning buyers arrive via a version check that says a newer release exists and what changed.
- Money: USDC on Base, gas sponsored. Payments land at a platform address; 90% sweeps to the creator's own wallet after a 7-day holdback. Creators never run infrastructure.
- Code is snapshotted at release time and scanned (secrets, dependency CVEs, licence) before it can be sold; the buyer receives the exact bytes that were scanned.
- Environments: Base Sepolia for development and CI; Base mainnet in production.

## Capabilities and Constraints

Settled (PRD Final.md v1.1, decisions D1–D13):

- One product: paid access to a private repo at a version. **Not** a marketplace, catalogue, search, ratings or profiles. Creators bring their own audience.
- Pricing: a price (default $9) and an update price (default $5; $0 means lifetime). Presets, never a slider; the price field is pre-filled and cannot be blank; $0.01 is never shown anywhere. Comparable prices appear only once ten listings exist in a class.
- Updates: existing holders pay the update price stamped at purchase or the current one, whichever is lower; every release is logged publicly; the update payment request carries the changelog and diff.
- Trust: automated scan and licence gate before anything is sold; takedown path with SLAs; buyers never lose a purchased version to a creator action.
- Wallets: creators bring their own address (proven by signature) or, for GitHub-authenticated humans, a one-click custodial wallet. Payouts go only to the bound address.
- Terminology: **listing** (a repo for sale), **release** (a scanned snapshot at a version), **purchase** (a wallet's entitlement to a release), **manifest** (the public computed label), **release log**, **update price**, **holdback**, **Rail A** (creator's GitHub repo) / **Rail B** (platform-hosted repo).
- Human web surfaces in V0: manifest/listing page, creator listing setup (link repo, price, publish), earnings, and the buy flow with a browser wallet.

Undecided (recorded, not invented): shipping name (must not contain "x402", "402" or "git"; working name "X402 Git"); launch category; whether the free version trails the paid one by a release; counsel outcome on custody (may force an on-chain splitter).

## Brand Commitments

- Site name: **X402 Git**, set by the founder on 2026-08-30 ("the name of the site is X402 Git") and now the wordmark every surface carries. It is still a *name*, not an identity: the shipping name is undecided (see the note above and PRD D7), so nothing permanent — no logotype, no mark, no colour tied to the letters — is designed around it.
- Binding visual constraint from the founder: **a clean, simple interface.** Recorded as stated, not expanded here; the visual world is decided in DESIGN.md.
- Voice: plain, direct, specific. Earnings are framed as what the creator keeps ("At $9 you keep $8.10"), never as a fee disclosure. No hype, no "marketplace" language.

## Evidence on Hand

- `PRD Final.md` — the complete specification, including wire-level API examples (§7.2, §7.4) and route list (§9). Real content for any UI.
- `Battle Test.md` (internal, not published) — competitive research with real numbers (Agensi 627 lifetime paid installs across 4,552 listings; SkillShop.sh 13 listings; Agent Bazaar pages containing the product name zero times).
- `Quality Signals.md` — the manifest specification: artifact class, component inventory, originality, cadence.
- No customers, testimonials, revenue, screenshots or benchmarks exist yet. Do not fabricate any. Example listings in UI must be labelled synthetic.
- Real analysis inputs will exist once a repo is linked: a file tree, README, language mix, dependency list. Design the manifest page for real data of that shape, not for prose.

## Product Principles

1. **Disclosure is the product.** The manifest is the differentiator; it is rendered server-side in a frame the creator cannot replace, and computed fields are visually distinct from creator-supplied ones.
2. **The API is the product; the page is a client.** Nothing exists only in the browser. If a screen does something, an endpoint does it.
3. **Creators keep 90%, and they can always get their money out.** The only delay anywhere is the 7-day holdback; withdrawal is never gated on identity.
4. **Never bill blind.** A buyer sees what a version contains before paying and what changed before paying for an update.
5. **Cut anything that assumes a second side of the market.** Every screen serves one creator and one buyer.

## Accessibility & Inclusion

WCAG 2.1 AA baseline. Two product-specific requirements: every listing page must be fully legible and navigable without JavaScript (agents and `curl` are first-class readers), and wallet-connection and payment states must be announced to assistive technology, since the buy flow's success and failure states are the whole transaction.

<!-- Inferred, not interviewed: this file was written from PRD Final.md and Paul's brief ("clean simple interface") in an unattended session. Facts labelled "settled" trace to PRD decisions; "undecided" items are the PRD's own open questions. Nothing here was invented beyond the PRD. -->
