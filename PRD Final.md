# PRD: Git x402 — Final

**Site name:** X402 Git (was "Git x402"; renamed 2026-08-30 on the founder's direction). See D7 — this is still a working name, not a shipping one.
**Owner:** TBD — still the blocker, see §18
**Status:** **Final v1.1 — 29 Aug 2026.** v1.0 (same day) merged the v0.2 PRD and the Build Plan (superseded drafts, kept internally) and added agent parity; v1.1 is the result of a five-angle battle test of v1.0 (adversarial, agent walkthrough, simplicity, security/compliance, editorial). FR numbers are renumbered in v1.1.
**Related:** a five-angle battle test of v1.0 (an internal review) · [Quality Signals.md](docs/research/Quality%20Signals.md)
**Domain:** x402git.com (working — see D7)

---

## 0. What this version settles

**From Paul's direction (v1.0):**

1. **Full agent parity, both sides.** Every creator capability — register, get a private git remote, push, price, publish, check earnings, get paid — works headless. The web UI is one client of the API; an agent is another.
2. **Revenue is a flat 10% of gross payments, and nothing else.**
3. **Updates are explicit.** A listing is sold with an update price (which may be $0 — that is "lifetime"); every release is logged publicly; the buyer's agent sees what changed before it pays for it.
4. **Sync is instant** (webhooks), with a seller-triggered "sync now"; creators can retire a listing and delete a hosted repo without ever revoking what a buyer paid for.

**From the battle test (v1.1) — the changes that matter:**

5. **Cut to a five-table, ~15-route V0.** Gone from V0: the listing stake, price-default randomisation, the substantive-release billing heuristic, the release-policy enum, daily reconciliation polling, sell-side MCP, server-side key issuance, sandboxed example generation, MinHash originality, Go scanner binaries in serverless. Each returns in V1 only if the 60-day numbers say the thing it protects is actually under attack. See §16.
6. **The buyer must be identifiable before payment.** v1.0's update pricing, lifetime access and re-download were unimplementable: the first request carried no wallet. v1.1 adds one signed-address header, used everywhere an unpaid grant is made. See FR-20.
7. **Withdrawals go only to the bound payout address.** v1.0 let `POST /api/withdrawals { to }` send anywhere, which made the 48h rebind delay decorative. See FR-26.
8. **Wallet modes, corrected.** `linked` (bring your own, ownership proven by signature) is the only API mode. `issued` — "the agent gets the keys" — becomes a **client-side** convenience in the SDK/MCP: the key is generated on the agent's machine and only the address is sent; the server has no code path that ever sees a private key. `custodial` (CDP Server Wallet) is available only to GitHub-authenticated human creators, because it is the one mode where the wallet cannot be the recovery root. See D12.
9. **Custody is named honestly.** All modes route buyer funds through a platform address for the holdback window. That is custody of creator funds for that window; the PRD no longer calls any mode "non-custodial" for earnings. ~~Counsel sign-off or an on-chain splitter is a **launch gate**, not a V1 nicety.~~ See D13, §19. *(Amended 2026-09-04, founder: it is no longer a launch gate. V0 launches without an entity and before counsel; both follow on traction, trigger in Q9 — see D5. No entity yet; the custody and reporting questions are with counsel (see D13, Q9).)*
10. **The update-price rug is closed.** A purchase stamps the update price in force; a holder is charged the lower of that and the current price, and a $0-update purchase is lifetime forever. See FR-16.
11. **Sanctions screening is unconditional and nearly free.** See FR-38.
12. **Buyers are not exposed to creators.** Creators see sales, not wallet addresses; the version endpoint is not a public purchase-history oracle. See FR-20, FR-40.

Everything from the 28 Aug narrowing stands: one product, paid access to a private repo, public manifest, no marketplace.

---

## 1. Summary

**A creator — human or agent — connects or is provisioned a private git repo, sets a price, and gets back a paid endpoint. Buyers — human or agent — pay in USDC over x402 and get access. The platform takes 10% of every payment. That is the entire business model.**

Not a marketplace, not a catalogue, not a directory.

The one thing that makes it more than a payment wrapper:

> **The manifest is public. The contents are private.**

Anyone can see the file tree, file count, sizes, language mix, rendered README, dependency list and computed substance class **before paying**. The bytes stay behind the paywall.

And the one thing that makes it more than a web app:

> **Every flow is an API first. The website is a client of it.**

An agent with nothing but a funded wallet and an SSH keypair can become a seller: hit one endpoint, receive a private git remote, push code, publish, and be paid to its own wallet. The same agent, or another, can find a listing, read its manifest, pay, pull, and later see exactly what changed before paying for an update — end to end with zero humans. The Battle Test found one competitor doing anything like this — LobeHub, where "agents register their own identity" — and flagged it as the second real threat precisely because it is agent-native (BT §7). It has no payments. We do.

**This pair of decisions is the product.** SkillShop.sh ships paid private repos over x402 and hides the contents until after purchase; it has 13 listings, four of them tests. Agent Bazaar's listing pages are a JS shell invisible to any agent that fetches HTML. Both failed the side of the market they claimed to serve.

---

## 2. Problem

**Creator side.** Builders publish work to GitHub for free because there is no low-friction way to charge for it. The options are all-or-nothing: give it away, or gate it behind a $50/mo community. Neither fits something that ships a new release every fortnight. And a growing class of creators are not people at all — agents that generate, maintain and improve code have no way to sell it whatsoever: no GitHub identity, no Stripe account, no bank account.

**Buyer side.** You cannot evaluate a private repo before buying it. Every existing paid-repo product asks for payment first and disclosure second — so buyers, reasonably, don't buy.

**Why now.** x402 makes machine-payable HTTP practical: zero protocol fee, gas sponsored on Base, and the buyer needs no account. An agent can pay for and pull a repo with no human in the loop — and, with this product, can *sell* one the same way.

**Why this is hard.** The payment layer is an afternoon of work and your target creators know it (BT KS-2). Demand for one-off purchase of code artifacts is close to unproven — Agensi has moved **627 paid installs in its lifetime across 4,552 listings** (BT KS-4). This PRD assumes tests A/B/C in the Battle Test have passed.

---

## 3. Goals and non-goals

### Goals (V0)

- **G1** — A creator goes from landing page to a live, priced endpoint in under 5 minutes.
- **G2** — **A buyer can tell what is inside a private repo before paying**, without the creator writing anything. This is the differentiator; everything else is plumbing.
- **G3** — An agent can pay and pull with no human in the loop after initial budget authorization.
- **G4** — Creators are paid to a wallet they control without running any infrastructure, and nothing but the fraud holdback ever delays it.
- **G5** — Nothing reaches a buyer without passing an automated security scan whose per-check results are published. The scan blocks on secrets, HIGH/CRITICAL CVEs, known-malicious dependencies, instruction smuggling and size caps; everything else it finds is disclosed. The licence is computed and displayed but does not gate. *(Amended 2026-09-02: the licence check was a gate until then — see DECISIONS.md, "The licence gate is a signal, not a gate".)* *(Amended 2026-09-13: until then this read "without passing an automated security scan" and nothing more — the two new blocking classes, the disclosed tier and the published per-check results come from "PRD Trust Report.md", accepted 13 Sep 2026.)*
- **G6** — **Full agent parity on the creator side.** Every capability in G1 and G4 is achievable headless from the OpenAPI document and the 402 payloads alone. Target: registration to live endpoint in under 2 minutes, zero browser, zero GitHub account.
- **G7** — **A buyer's agent never pays for an update blind.** Every update 402 carries what changed.

### Non-goals (V0)

- **NG1** — A browsable marketplace, catalogue, search, filters, categories or rankings. Creators bring their own audience. *(Amended 16 Sep 2026: agent-facing search over the live listings is in — the MCP `search_listings` tool, FR-31. It searches the set `sitemap.xml` and `/openapi.json` already publish, orders by text match and then name, and never by sales, installs, views or anything a creator could buy. A browse page, categories and rankings stay out. See DECISIONS.md, "Agents can search the live listings".)*
- **NG2** — Ratings, reviews, votes, creator profiles, social features.
- **NG3** — Listing anything we do not have explicit permission to sell. Permanently out of scope.
- **NG4** — Card payments, credits, multi-chain, fiat. Cut from V0; the architecture must not preclude cards (BT KS-6).
- **NG5** — Subscriptions and delegation-backed automatic recurring billing. Paid updates on pull (D1) deliver the economics without the surface.
- **NG6** — Executing creator code on our infrastructure. Hosting bytes (git rail, snapshots) is in scope; running them is not — including for example generation (§8.10).
- **NG7** — Notifications, bots, update-push infrastructure. A version endpoint the client polls is sufficient (BT KS-9).
- **NG8** — LLM judges, eval harnesses, adoption curves, reputation graphs. V2.
- **NG9** — Any platform revenue mechanism other than the 10% commission. No listing fees, no fixed per-transaction fees, no paid tiers, no withdrawal fees beyond pass-through gas.
- **NG10** — Any server-side code path that sees a creator's private key.

### What "simplified" must not mean

Cutting to a bare paywall produces SkillShop.sh. **G2 is not a feature to defer.** Cutting the headless creator path produces a web app agents can buy from but never sell on, forfeiting the one wedge no competitor with payments occupies. Everything else in v1.0 was fair game, and §16 cuts it.

---

## 4. Users

### Creator-human
Ships 5–40 releases/year across skills, harnesses and agent OSes. Has an audience somewhere. Can build an x402 wrapper himself and needs a reason not to. Cares about: keeping his audience, not handling custody or tax, not looking like a sellout.
**Job:** "Let me charge for my newest work without abandoning the free version that built my following."

### Creator-agent
An autonomous agent that produces sellable artifacts. Has a wallet (or its SDK can make one locally) and an SSH keypair. Has **no** GitHub account, no monitored email, no browser. Its operator set its policy weeks ago.
**Job:** "Turn the thing I just built into a priced endpoint, and get the proceeds to my operator's wallet, without waking anyone up."

### Buyer-operator — "Paul"
Runs several agents. Willing to fund an agent wallet with $20–50. Wants the latest Humanizer without checking the repo every fortnight — and wants to see what his agents bought.
**Job:** "Keep my agents on the current version of the things I've decided to trust."

### Buyer-agent
The transacting party. Has a spend budget and policy. Needs machine-readable pricing, a deterministic payment flow, a version endpoint to poll, and the diff before it pays for an update.
**Job:** "Acquire the resource I was told I could acquire, within budget, without asking."

---

## 5. Core decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **A listing has a price and an update price. Every release is a purchase for new buyers; existing holders pay the update price, and an update price of $0 is lifetime access.** One integer replaces an access-model enum. Delegation-backed automatic recurring billing is V1 | Recurring is 7.5x better economics (BT §5). Paid updates on pull capture most of it with the `exact` scheme and no subscription surface: the buyer's agent polls, sees the diff, and pays when it wants to. Leaving update semantics implicit (v0.2) meant silently re-charging full price on every release |
| D2 | **Creators set the price. The platform sets no economic floor.** Suggested default, un-clearable field, presets not a slider | Anchoring is causally established (Fong, Manchanda & Song, *JMR* 2026); itch.io's un-clearable $2 default is its modal price; Gumroad with no default has a median creator earning $70/year |
| D2a | **One track: repo access, default $9, update price default $5.** Presets $1 / $5 / $9 / $19 / custom for price; $0 / $3 / $5 / $9 / custom for updates. *(Amended 2026-08-31, founder: the $0 release preset is gone — a release is never free, so the first purchase always costs something. $0 updates stay: that one is lifetime access, D1. Listings saved free before this date keep serving per FR-24.)* The headless API returns the same presets and defaults in every listing response | The same asset sells for $5–$19 as an artifact and $0.02–$0.05 metered; framing sets a 200x spread. Agents get the anchoring context machine-readably. Price randomisation (v1.0 FR-6a) is cut: n=25 has no statistical power |
| D2b | **Technical minimum $0.01, never surfaced as a suggestion** — anywhere, including API docs. *(Amended 2026-08-31, founder: the floor now also excludes $0 for the release price; only the update price may be 0.)* *(Amended 2026-09-01, founder: "never surfaced as a suggestion" is exactly that and no more. The floor may be **stated as a constraint** under a custom-price field the creator has already opened — see FR-12. It may still never be a preset, a placeholder, a default, or a number the product recommends.)* | Below $0.01 the facilitator fee exceeds the commission; an unsuggested floor becomes the suggestion (22% of Unity's assets sit just above its $4.99 minimum) |
| D2c | **(Revised) Anti-spam is caps and holdback, not a stake.** Per creator: 3 unpublished listings, 1 hosted repo per unpublished listing, 200 MB per repo, 20 pushes/hour. Rail B registration requires an invite code in V0. The refundable stake (v1.0) is cut | The stake was a full inbound-and-outbound payment lifecycle whose refund conditions ("review pass") referenced a review step that did not exist, and it was gameable for $2.50 by wash-trading $25. Caps are a WHERE clause; the holdback already makes scam-and-run unprofitable |
| D2d | **Percentage commission only. Never a fixed per-transaction fee** | Envato's fixed $12 fee turned a $15 sale into a $2.60 author take; a 10.8x volume increase produced a 77% revenue loss |
| D3 | **We sell a snapshot taken at release time, delivered by short-lived signed URL** (§6) | The artifact served is byte-identical to the one scanned. Collaborator invite needs a GitHub account; an agent has none |
| D3a | **The manifest is public, the contents are private** | The differentiator SkillShop.sh refuses to ship |
| D4 | **Opt-in supply only**; every creator accepts the agreement with a recorded terms version, on web and API alike. For agent creators the contracting party is the registering operator, who warrants ownership of the agent's output | Reputational and copyright exposure (BT KS-3); an agent cannot hold copyright or make a warranty |
| D5 | **(Amended 2026-09-04, founder.)** V0 **launches without an entity and before counsel; both follow on traction, trigger in Q9.** No entity yet; the custody and reporting questions are with counsel (see D13, Q9). **The trigger is unset: §18 Q9.** *Until 2026-09-04 this read: ~~"Entity formed, and D13 resolved with counsel, before the first mainnet payment clears."~~* | The original gate answered BT KS-5. The amendment does not dispute the reasoning behind it; the gate is deferred (D5), and R-9 tracks what stays open until the trigger fires |
| D6 | **Flat 10% of gross, seller-side, the platform's only revenue mechanism.** Buyer pays the listed price; creator receives 90%. Exposed as `platform_fee_bps: 1000` | Segment norm (Agent Bazaar, itch.io, Gumroad); undercuts Agensi 3x; one number an agent can reason about |
| D7 | **"X402 Git" is the site name, set by the founder on 2026-08-30 and used on every user-visible surface. The shipping name must not contain "x402", "402" or "git."** Decide by Sep 4 | Rail lock-in (BT KS-6); GitHub trademark |
| D8 | **Launch category is fast-decay artifacts only** | Where "latest version" has real marginal value (BT KS-4) |
| D9 | **API-first: every creator and buyer capability ships as an authenticated endpoint before its web UI, and the web app calls the same endpoint.** The build order (§15) ships the API in week 1 and the first HTML in week 3 | G6 is untestable otherwise; API/site divergence is how Agent Bazaar's product pages came to contain the product's name zero times |
| D10 | **Two supply rails, one pipeline.** Rail A: the creator's own GitHub repo via GitHub App. Rail B: a private repo we create in a platform-owned GitHub org with a per-listing write deploy key. **The App is owned by a different GitHub account from the hosted-repo org**, and hosted repos are sharded across orgs by cohort. Snapshots, not repos, are the product: serving continues through any org suspension | Rail B makes G6 real with two Octokit calls. Separating App and org bounds the blast radius of a suspension to Rail B. Forgejo is the pre-scoped swap if GitHub enforces |
| D11 | **Creator identity is a wallet address; the API key is a scoped, rotatable credential bound to it.** Rotation, payout changes and destructive operations require a signature from the bound address (or GitHub OAuth on Rail A). No email, no GitHub, no KYC on Rail B; the anti-fraud load is caps, holdback, the scan gate and sanctions screening (the licence stopped gating on 2026-09-02, FR-11) | Symmetry with the buyer side. A bearer key held by software will leak; it must not be able to move money or destroy data on its own |
| D12 | **(Revised) Wallet modes.** **`linked`** — the creator supplies a payout address and proves control of it with a signed challenge; the only mode the API accepts. **`issued`** — the SDK and MCP client generate a keypair locally and register the address as `linked`; the server never sees a private key (NG10). **`custodial`** — CDP Server Wallet v2 for GitHub-authenticated human creators only, with CDP policy allow-listing the bound payout address; withdrawal is one click, any time | v1.0's server-side `issued` mode required proving a negative (the key never touched a log, a trace, a cache) on the same deployment that runs untrusted analysis — and the key would land in the agent's context window anyway. Client-side generation gives the agent the keys with zero platform exposure. `custodial` for agents had no recovery root: the CDP key cannot sign a rotation challenge |
| D13 | **(Revised) All settlements land at a platform receiving address; the 10% is split in the ledger; net earnings sweep to the bound payout address after the holdback.** This is custody of creator funds for the holdback window in every mode, and the PRD describes it as such. An on-chain splitter — `payTo` = per-listing escrow, creator claims after `holdback_until`, refund role can only return funds to the original payer — is pre-designed and becomes V0 if counsel does not sign off on the ledger split | An x402 `exact` payment pays one address; taking 10% means receiving and splitting. Calling the modes "non-custodial" (v1.0) was wrong about the earnings even where it was right about the destination wallet |
| D14 | **A creator has two kinds of bearer credential: one long-lived `agent` key (`x4c_live_…`) and short-lived `session` keys (`x4s_live_…`) minted silently, one per browser session.** Both live in an `api_key` table and both are accepted by every creator endpoint; the web guards accept only `session`. The session key row **is** the server-side session record, so sign-out revokes rows, agent-key rotation no longer signs anyone out of the web, and `creator.session_epoch` is retired | The dashboard was borrowing the agent's credential, so signing in on a second browser meant re-issuing the key and breaking the creator's own agents — two things proved two ways, answered by one credential. Amendment, alternatives and migration: "PRD Session Keys.md" (accepted 31 Aug 2026) |

---

## 6. The access-architecture decision: snapshot on release, signed URL on payment

| Option | How | Verdict |
|---|---|---|
| **A. GitHub collaborator invite** | On payment, add the buyer as a read-only collaborator | **Rejected.** Buyer needs a GitHub account and must accept an invite; an agent has neither. Leaks buyer identity to the creator. V1 human add-on |
| **B. Proxy GitHub's tarball live on payment** | Mint an installation token, stream `/tarball/{ref}` | **Rejected.** GitHub in the purchase path, and a creator can push malware after the scan and before the sale |
| **C. Snapshot on release, signed URL on payment** | Store a tarball at release time; on payment issue a short-lived signed URL | **Chosen** |

The artifact a buyer receives is byte-identical to the one analysed and scanned; the scan verdict is bound to `artifact_sha256`. Re-download is an entitlement lookup returning a fresh signed URL. Rail-agnostic.

**No clone needed for the manifest.** `GET /repos/{o}/{r}/git/trees/{sha}?recursive=1` returns every path, blob size and blob SHA in one call — file count, byte totals, text/binary split, extension histogram, directory depth, component inventory, substance class and blob-SHA originality. Add `languages`, `readme`, `license`, `releases`, `compare/{base}...{head}` (per-file additions and deletions for the diff summary) and the SBOM endpoint: ~7 REST calls. The tarball is fetched once for the snapshot, which is also when the scan runs.

**Artifact format:** `zip` of the tree at the ref, `.git` excluded, root directory `<slug>-<version>/`, LICENSE guaranteed present (FR-36). `artifact_sha256` is the hash of the zip bytes. The archive size (`size_bytes`) is shown wherever the artifact is offered. Caps: 200 MB extracted, 20,000 files. *(Amended 2026-08-30. Until then the format was `tar.gz` — see DECISIONS.md, "Zip, not tar.gz".)*

---

## 7. User journeys

### 7.1 Creator — human (web, Rail A)

1. Sign in with GitHub. Install the App on **one repo** (`Contents: read`, `Metadata: read`).
2. Platform runs analysis, stores a snapshot, scans, writes the manifest.
3. Set a price (pre-filled **$9**) and an update price (pre-filled **$5**; "$0 — buy once, updates free" is the celebrated alternative). Earnings preview: "At $9 you keep $8.10."
4. Wallet: connect one (Coinbase Wallet is one click) or "create one for me" (`custodial`).
5. Gates pass → Publish → live. Creator receives `x402git.com/adrian/humanizer`, the resource URL, and a README snippet.

### 7.2 Creator — agent (headless, Rail B)

```
GET  /api/terms
→ 200 { version: "2026-08-29", url, sha256 }

GET  /api/auth/challenge?address=0xPAYOUT
→ 200 { nonce, message, expires_at }

POST /api/creators                                         (Idempotency-Key: <uuid>)
     { handle: "a1b2c3", payout_address: "0xPAYOUT",
       address_proof: { nonce, signature },               # proves control of 0xPAYOUT
       accepted_terms_version: "2026-08-29",
       invite_code: "…", abuse_contact_url?: "https://…" }
→ 201 { creator_id, api_key: "x4c_live_…",                 # shown once; replayable 24h via Idempotency-Key
        handle, payout_address, platform_fee_bps: 1000, holdback_days: 7 }

POST /api/listings                                         (Authorization: Bearer x4c_live_…)
     { slug: "humanizer", source: "hosted",
       ssh_public_key: "ssh-ed25519 AAAA…" }              # per listing — GitHub deploy keys are unique per repo
→ 201 { listing_id, owner: "a1b2c3", slug: "humanizer", status: "draft",
        remote: "git@github.com:x402git-hosted-01/a1b2c3--humanizer.git",
        ssh_host_key_fingerprints: [...], default_branch: "main",
        pricing: { price_micro: 9000000, update_price_micro: 5000000,
                   presets: { price: [1000000,5000000,9000000,19000000],
                              update: [0,3000000,5000000,9000000] } },
        label_endpoint, version_endpoint, resource_endpoint }

     [agent: git push origin main && git push origin v1.0.0]
     # push webhook → analysis → snapshot → scan → release row, within seconds
     # (or: POST /api/listings/{id}/sync { ref?: "main", version: "1.0.0", notes?: "…" })

GET  /api/listings/{id}
→ 200 { status: "draft", licence: { verdict: "pass", spdx: "MIT" },
        latest_release: { version: "1.0.0", scan: "pass", manifest_url } }

PATCH /api/listings/{id}
     { price_micro: 9000000, update_price_micro: 3000000, description: "…", trigger_hint: "…" }
→ 200

POST /api/listings/{id}/publish
→ 200 { status: "live", url, resource_endpoint, version_endpoint, label_endpoint }
   or 409 { code: "listing_not_ready", blocking: ["no_release" | "scan_pending" | "scan_failed" | "description_missing" | "public_repo"] }

… later …
GET  /api/earnings
→ 200 { gross_micro, fee_micro, net_micro, withdrawable_micro, held_micro,
        next_release_at, sales: [{version, kind:"new"|"update", net_micro, settled_at}], next_cursor }
# net earnings sweep to 0xPAYOUT automatically once holdback_until passes; no action required
```

**Success (G6):** registration to live in under 2 minutes, zero browser, zero GitHub account, zero human. Money arrives at the agent's own wallet 7 days after each sale with no further calls.

### 7.3 Buyer — human

Lands on the manifest page. Sees the file tree, sizes, README, class badge, licence, trust report, release log. Connects a wallet, pays USDC, downloads.

### 7.4 Buyer — agent

```
GET  /api/label/adrian/humanizer                 → manifest JSON
GET  /api/v/adrian/humanizer                     → { latest: "1.2.0", published_at, price_micro, update_price_micro, releases_url }

GET  /api/r/adrian/humanizer
→ 402  PAYMENT-REQUIRED: { x402Version: 2,
         accepts: [{ scheme: "exact", network: "base", asset: <USDC>, payTo, maxAmountRequired: "9000000",
                     resource, description, maxTimeoutSeconds, extra: { name, version } }],
         extra: { kind: "new", version: "1.2.0", manifest_url, scan_badge_url, update_price_micro, quote_id } }

GET  /api/r/adrian/humanizer   PAYMENT-SIGNATURE: <signed authorization>
→ 200  { version: "1.2.0", artifact_sha256, download_url (signed, 5 min), expires_at, version_endpoint }
       # granted only after facilitator settle returns a tx hash

… v1.3.0 released …
GET  /api/v/adrian/humanizer   X-Wallet-Signature: <0xBUYER.nonce.sig>       (FR-20)
→ 200 { latest: "1.3.0", owned: "1.2.0", entitled: false, price_kind: "update", price_micro: 3000000 }

GET  /api/r/adrian/humanizer   X-Wallet-Signature: …
→ 402 … extra: { kind: "update", from: "1.2.0", to: "1.3.0",
                 releases: [{ version: "1.3.0", changelog, diff_summary, published_at }] }
   # or 200 immediately if update_price_at_purchase was 0 (lifetime) — see FR-16

GET  /api/r/adrian/humanizer/v/1.2.0   X-Wallet-Signature: …
→ 200 { … fresh signed URL for the version already owned }
```

### 7.5 Release propagation

1. Creator pushes a tag (either rail) or calls `POST /api/listings/:id/sync`.
2. Webhook arrives within seconds → analysis + snapshot + scan → `release` row, `pending → pass | fail`.
3. Agents learn of it by **pull**: the artifact's own preamble (README snippet, FR-30) checks `GET /api/v/…` before each run.
4. Holders pay the lower of their stamped update price and the current one; $0 means immediate 200.

### 7.6 Getting paid — every mode

- **`linked` / client-side `issued`**: net earnings sweep daily to the bound payout address once `holdback_until` passes. Nothing to call.
- **`custodial`** (human, Rail A): balance accrues in the creator's CDP wallet; "Withdraw" sends to the bound payout address, any time, no minimum beyond gas.
- **Changing the payout address** (any mode): signed by the *current* address (or GitHub OAuth on Rail A), takes effect after 48h, announced to the pre-change abuse contact. Sweeps continue to the old address during the delay.

The invariant: **the only funds the platform ever holds against a creator's will are inside the holdback window.**

---

## 8. Functional requirements

### 8.1 Onboarding and identity

- **FR-1** — Rail A: GitHub OAuth + App install with per-repo scope. Never request org-wide write.
- **FR-2** — Headless registration `POST /api/creators`: `handle`, `payout_address` + `address_proof` (signed challenge from that address — EOA `personal_sign` or ERC-1271), `accepted_terms_version` (must equal `GET /api/terms`), `invite_code` (V0), optional abuse contact. Returns a prefixed API key (`x4c_live_…`) shown once; an `Idempotency-Key` replays the identical 201 for 24h so a dropped response does not strand the creator. Unsigned payout addresses are rejected (`payout_address_unverified`); docs state exchange deposit addresses are unsupported.
- **FR-3** — `handle` is the `owner` segment of every URL on both rails; unique; GitHub logins are reserved for their owners on Rail A. `slug` rules: `[a-z0-9-]{2,40}`, unique per owner, reserved words `api v r label`. Slugs are never reused after retirement.
- **FR-4** — API keys are scoped (`listings:write`, `earnings:read`) and rotatable without the old key: `POST /api/auth/rotate-key { address, nonce, signature }`. Keys are registered with GitHub's secret-scanning partner program and matched by our own scanner (FR-35); a match auto-revokes and notifies the abuse contact. Rotation touches the **agent** key only; the short-lived session keys the website runs on, and the scanner's coverage of both prefixes (`x4[cs]_live_`), are specified in "PRD Session Keys.md" (D14).
- **FR-5** — Step-up required (signature from the bound address, or OAuth): payout address change, SSH key change, abuse-contact change, hosted-repo delete, account close. Abuse-contact changes take effect after 48h and are announced to the *old* contact.
- **FR-6** — Terms: `GET /api/terms` returns the current version; a bump requires re-acceptance before the next publish, never for existing sales.

### 8.2 Repos and sync

- **FR-7** — Rail B provisioning: `POST /api/listings { source: "hosted", ssh_public_key }` creates a private repo in the current hosted org and adds the key as a write deploy key **for that repo only** (GitHub does not allow one public key on two repos). `PUT /api/listings/:id/ssh-key` rotates it (step-up). Provisioning uses App installation tokens, never a PAT; the org-admin credential lives in the signing service (§14.8).
- **FR-8** — Sync is event-driven with a manual trigger — no polling:
  1. **Webhook (instant, primary).** `push` (tags), `release`, and `installation` events on both rails. A new tag `vX.Y.Z` cuts a version within seconds. Signature verified (`X-Hub-Signature-256`), deliveries older than 5 minutes rejected, listing resolved by `installation_id` + repo id, never by name.
  2. **Check for releases.** *(Renamed from "Sync now" on 2026-09-01, founder: the old label said *when*, not what. "Sync" also promised a two-way reconciliation the route does not perform — it cuts the newest uncut tag and nothing else — and the new label is honest in the case that matters most, where the answer is that there is nothing new.)* `POST /api/listings/:id/sync { ref?, version?, notes? }` cuts a version from a named ref, or — with neither given — from the repository's newest `vX.Y.Z` tag that has not been cut yet. `version` is required when a ref is given and that ref is untagged. The button in the web UI calls the same route and sends neither, so it means "cut whatever this repo is tagged at". This is also the recovery path for a dropped webhook (GitHub redelivers too), and the only path for tags pushed *before* the listing existed — a repo tagged last week gets no webhook, because nothing was watching it then. *(Amended 2026-09-01.* Until then this line required `version` on every untagged ref including the default HEAD, which is what it sends: the button therefore answered `invalid_version` on every repository, and a listing whose tags predated it had no way to cut a release at all. Reported from production.)
- **FR-9** — Version identity: the tag with a leading `v` stripped, must match `^\d+\.\d+\.\d+`. `UNIQUE (listing_id, version)`; re-tagging returns `version_exists`. "Latest" = newest release with `scan = pass`.
- **FR-10** — Repo detection and display: licence, last 10 release timestamps, computed cadence, repo size, presence of executables. **Public repos are not accepted in V0, on either rail.** Rail A refuses a public repository at listing creation with `422 public_repo`, and the repo picker lists every granted repository but offers a **Create listing** button on the private ones only, marking the public ones `public`; Rail B repos are private by construction. A repo that is made public after it was listed becomes a `public_repo` entry in `blocking[]` and cannot be published until it is private again. *(Amended 2026-08-30. Until then this line read "Public repos are supported on Rail A only" — see DECISIONS.md, "Private repositories only". The picker clause was amended again on 2026-09-01: it had hidden public repos outright, which left a creator unable to tell a repo they had not granted from one that was merely public — see DECISIONS.md, "The repo picker shows everything it can see".)*
- **FR-11** — Three-way licence **signal**, computed on every release cut and stamped on both the listing and the release. Resale-compatible SPDX → `pass`. No licence file → `block`. `NOASSERTION` or a recognised-but-incompatible licence → `manual` (`torvalds/linux` returns NOASSERTION). **No verdict blocks publishing or selling.** The verdict is shown on the manifest, in `GET /api/listings/:id`, and on the creator dashboard, which offers the fix without claiming the listing is stuck. Rail B keeps `POST /api/listings/:id/licence { spdx }`, which commits a LICENSE from an allow-list (MIT, Apache-2.0, BSD-3-Clause, MPL-2.0) — the attestation is made by the registering operator under D4. *(Amended 2026-09-02. Until then a `pass` was required to publish and a per-release `block` de-listed that release from sale — see DECISIONS.md, "The licence gate is a signal, not a gate".)*

### 8.3 Pricing and updates

- **FR-12** — Listing has `price_micro` and `update_price_micro`. Presets per D2a. The pricing screen never renders an empty box, never shows $0.01, shows an earnings preview, and celebrates "$0 updates" as first-class ($0 for the release itself left on 2026-08-31, founder — see D2a). Explicit API values are never rounded. *(Amended 2026-09-01, founder.* "Never shows $0.01" is narrowed to "never suggests $0.01". Both custom-price fields now print the floor beneath them — "$0.01 or more." — because a creator typing into an open box had no way to know how small an amount was permitted, and the first place they learned it was a rejected save. The fields also carry a `pattern` so the browser blocks the submit before the round trip, and `validatePrice` now names the floor in its refusal instead of saying only "raise it". **The floor now also binds a typed update price,** which it previously did not: D2b's arithmetic is about what a settlement costs and does not care which of the two prices is being charged. The $0 update *preset* is untouched — zero is lifetime access under D1/FR-16, and it reaches the server as a preset rather than as something a creator typed, so `actions/save` applies the floor only when `update_choice` is `custom`. **Known gap:** this is enforced on the web form only. `UpdatePriceMicro` still accepts a sub-cent update price over the API, because tightening it would change the published contract and needs a carve-out for the $0 that D1 requires. Decide before the API is called stable. D2b's argument is about an unsuggested minimum *becoming* the suggestion, which is a claim about presets, placeholders and defaults; none of those changed, and the note sits under a field the creator has already chosen to fill in by hand. `validatePrice` in `lib/web/money.ts` still refuses without naming the amount. The $0 update preset also lost its gloss — "$0 — buy once, every release free" is now just "$0", read off `formatPrice` like every other preset.) *(Amended 2026-08-31, founder.* The preview was specified as a sentence with a monthly projection — "At $9 you keep $8.10; 12 sales a month = $97" — and is now an itemised breakdown in a box of its own: buyer pays, platform fee, you receive. The projection is gone; it was a number the platform invented, sitting beside three it computed. What FR-12 still requires is unchanged — the screen says what a sale pays the creator, before they commit to a price.)
- **FR-13** — Every listing API response carries the full `pricing` block (current values, presets, defaults) so agents receive the anchoring context.
- **FR-14** — Comparable-price data (top-decile average by artifact class) is shown only once ≥10 selling listings exist in the class; before that, the default only.
- **FR-15** — **The release log is public and machine-readable.** Every release records version, tag, commit, `artifact_sha256`, published-at, changelog (notes after boilerplate stripping — or the `notes` passed to sync), `diff_summary` (files added/changed/removed, additions/deletions from the compare API, component buckets touched), scan verdict, analyzer version, and the price and update price in force. `GET /api/v/:owner/:slug/releases`, rendered on the manifest page in the platform's frame. Creators cannot delete entries.
- **FR-16** — **Purchase terms are stamped and never worsen.** A purchase stores `update_price_at_purchase`. A holder is charged `min(update_price_at_purchase, current update price)`. A purchase made while the update price was $0 sets `all_versions = true` — lifetime, irrevocably, regardless of later changes. Price changes apply to future purchases only.
- **FR-17** — **The update 402 carries the evidence.** For a holder, the 402 `extra` block includes every release-log entry between the owned version and the latest, and `kind: "update"`. One update price regardless of how many releases are skipped.
- **FR-18** — **Rate-limit update billing.** A holder is charged at most one update per listing per 7 days; releases inside that window are granted free. The window opens on an *update* charge, not on the initial purchase (otherwise FR-34's update 402 could never occur — clarified 29 Aug, see DECISIONS.md). Protects auto-paying agents from an update farm; one WHERE clause.
- **FR-19** — Owned versions stay fetchable forever: `GET /api/r/:owner/:slug/v/:version`. Older versions are not sold to new buyers.

### 8.4 Payments and entitlement

- **FR-20** — **Buyer identity before payment.** `X-Wallet-Signature: <address>.<nonce>.<eip191_sig>` over a challenge from `GET /api/auth/challenge` (5-minute expiry, single use). Accepted on `/api/r/*`, `/api/v/*` and `/api/entitlements`. Without it, `/api/r` quotes the new-buyer price and `/api/v` returns version data only — `?address=` alone never reveals entitlement state (no public purchase-history oracle). The payer in a `PAYMENT-SIGNATURE` must match the signed address when both are present.
- **FR-21** — x402 v2 (`@x402/core` resource-server `verify`/`settle` called directly from the handler — the static-price middleware cannot price per caller). `exact` scheme, USDC on Base, CDP facilitator behind the library's own abstraction. Headers `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`; platform fields under `extra`. One canonical 402 example per kind (`new`, `update`) in the OpenAPI doc.
- **FR-22** — **Grant only on settlement.** A purchase row and download URL are issued only after `settle` returns a tx hash. Verify-only success → `402 settlement_pending`; timeout → `504 settlement_timeout` with `retry_with_same_authorization: true`. The EIP-3009 nonce is stored `UNIQUE` and bound to `{listing_id, version, amount}`; a replay returns the existing purchase; a mismatch returns `authorization_mismatch`.
- **FR-23** — Price quotes carry `quote_id` and `validBefore`; payment against a stale quote after a PATCH returns `409 price_changed` with a fresh 402.
- **FR-24** — Free listings (`price_micro = 0`; creatable until 2026-08-31, now legacy rows only — D2a): `/api/r` returns 200 with no payment; a purchase row is written only when `X-Wallet-Signature` is present (so re-fetch and update pricing work).
- **FR-25** — Fee: 10% of gross computed on insert, `platform_fee_bps: 1000` in the creator API and docs.

### 8.5 Wallets and payouts

- **FR-26** — **Payouts go only to the bound payout address.** No `to` parameter exists anywhere. `linked`: daily sweep of purchases with `holdback_until < now()` and no `payout_id`; `POST /api/payouts/sweep` forces one. `custodial`: one-click withdraw to the bound address. Gas is deducted from the sweep and shown on `GET /api/earnings`.
- **FR-27** — Holdback: **7 days**, fixed (`HOLDBACK_DAYS`). Forfeited only against a platform-executed refund following a takedown (FR-39). Buyer-initiated refunds are V0.5 and, when they ship, revoke the purchase.
- **FR-28** — Ledger correctness: every outbound transfer is a `payout` row created `pending` with an idempotency key *before* broadcast, then `broadcast(tx_hash)`, then `confirmed`; a non-confirmed row blocks further sweeps for that creator; balance checks run in the same DB transaction with `SELECT … FOR UPDATE`; one serialised signer per hot wallet. A daily job reconciles the receiving address's on-chain balance and every recorded tx hash against chain; variance halts sweeps and pages.
- **FR-29** — `GET /api/earnings`: gross, fee, net, withdrawable, held, next release date, per-sale rows (version, kind, amount, time — **never the buyer address or tx hash**), cursor-paginated.

### 8.6 Buy side

- **FR-30** — README snippet generator: a paste-ready preamble telling a downstream agent how to check `GET /api/v/…` and buy, with wording that differs for `update_price = 0` ("updates included") and `> 0` ("updates $X").
- **FR-31** — MCP server (buy side, Streamable HTTP): `get_listing`, `check_version`, `purchase` (takes a pre-signed payment authorization; when unpaid it answers per the x402 MCP transport spec — `isError: true` with the `PaymentRequired` body as `structuredContent`, mirrored in `_meta["x402/error"]` — and it accepts the payment either as the `payment_signature` argument or as `_meta["x402/payment"]`; settlement is confirmed in `_meta["x402/payment-response"]`), `fetch_release`. Each tool is documented as "wraps `<METHOD> <route>`" and calls the same core module (§11). Sell-side MCP is V1: FR-33 makes it redundant in V0. *(Amended 2026-08-30. Until then the unpaid `purchase` was `isError: false` with the 402 under a `payment_required` key — a shape no off-the-shelf x402 MCP client recognises. See DECISIONS.md, "The MCP 402 speaks the transport spec".)* *(Amended 2026-09-02: a fifth tool, `how_to_buy`, wraps nothing — it returns the price, `listing_url`, `skill_url`, `resource_endpoint` and `mcp_url` plus a `with_a_wallet` / `without_a_wallet` paragraph, so a client that cannot sign — every chat model — answers with a referral instead of a dead end. The 402 body's `extra` carries the same four fields plus `instructions` for the same reason. See DECISIONS.md, "The 402 explains itself".)* *(Amended 16 Sep 2026: a sixth tool, `search_listings`, listed first, wraps nothing — free, no wallet, it searches live listings with a passing release by name, description, trigger hint, computed tags and README, filters by a new-buyer price ceiling, and returns the `owner`/`slug` the other tools take. Ordered by match, never by popularity; NG1 amended to allow it. See DECISIONS.md, "Agents can search the live listings".)*
- **FR-32** — `GET /api/entitlements` (with `X-Wallet-Signature`): everything the wallet owns — listing, version, `all_versions`, price paid, tx hash, granted-at. Operators audit what their agents bought.

### 8.7 Sell side

- **FR-33** — Every creator capability is an authenticated JSON endpoint (§9); the web app consumes the same endpoints (D9). OpenAPI is generated from the zod schemas at `GET /api/openapi.json`; every error is `{ code, message, docs_url, details? }` from the catalogue in §9.
- **FR-34** — **Definition of done for G6 — the CI test:** register (API) → provision hosted repo → push tag → PATCH price → publish → buy from wallet B → push second tag → wallet B sees an update 402 at the stamped price → wallet B re-fetches v1 → sweep pays wallet A on Base Sepolia. Runs on every merge.

### 8.8 Trust, safety and compliance — blocking for V0

- **FR-35** — Scan on every release before it can be sold. **Six things block** *(five until 2026-10-25)*: secret detection (gitleaks ruleset applied over text files in-process — no Go binary in the function); dependency CVEs rated HIGH or CRITICAL via `POST https://api.osv.dev/v1/querybatch` from the manifests and lockfiles inside the sold snapshot *(amended 2026-10-25, red team SCAN-2: the default branch's dependency graph only supplements that list and can never downgrade a finding)*, for a dependency resolved to an exact version *(amended 2026-10-15: a CVE returned for a versionless query is disclosed, not blocking — DECISIONS.md, "A CVE found without a version is disclosed, not blocking")*; **a dependency known to be malicious** — an OSV `MAL-` record, or Socket's human-confirmed `malware` alert; **hidden-Unicode instruction smuggling** in a `.md`, frontmatter or tool-description file (tag characters, zero-width runs spelling text), which has no benign use in an artifact of this kind; **a NUL byte in a source, manifest or instruction file** *(added 2026-10-25, red team SCAN-1: one NUL made the file read as binary and switched every text check off for it; such a file is now scanned with the NUL stripped, and the NUL itself blocks)*; and size/zip-bomb limits (§6). A failing release is `fail`; the listing keeps selling its last passing release. No override in V0. Failed snapshots are deleted after the report (hash + findings) is stored.

  **Everything else the scan finds is disclosed, not blocked**: MODERATE/LOW/UNKNOWN CVEs, the computed **capability inventory** — what the artifact can do, read from its own bytes: tools it claims, processes it runs, hosts it talks to, environment variables it reads, what happens at install — textual injection heuristics, and Socket's behavioural and hygiene alerts on the artifact's published dependencies. Socket's model-derived alerts are disclosed as *flagged for review* with an admin alert, and are never a verdict. The report is v2, one `checks[]` row per check (§12), and **the creator can read their own release's full report**, including the `path` and `line` of a secret, which is never public.

  **A check that could not run is a gap, not a failure.** Socket unreachable, over quota or still processing leaves an `unavailable` or `partial` row; **the release sells on the checks that did run** and the rescan cron retries it. Behavioural analysis means Socket over *published packages*; executing creator code stays NG6. *(Amended 2026-09-13. Until then this line named secrets, CVEs and size caps only, said nothing about what happens to everything else it found, and closed "Malware signatures and behavioural analysis are V1" — see "PRD Trust Report.md" §4 and §6, and DECISIONS.md, "The scan blocks on five things and publishes the rest".)*
- **FR-36** — Every artifact served includes the original LICENSE and attribution.
- **FR-37** — Buyer-facing **trust report** on every listing: the verdict, its date and the scanner version, then a row per check saying what ran and what it found, the capability inventory, and the date the advisories behind it were last refreshed. *(Amended 2026-09-13. Until then this read "scan badge with date and scanner version" — one word with a full report behind it that nobody could read, which is the criticism the internal battle test (§6.3a) makes of Agensi. See "PRD Trust Report.md" §5.)*
- **FR-38** — **Sanctions controls, unconditional:** every payout address screened against the OFAC SDN crypto-address list at bind and before every sweep (hit → freeze + compliance ticket); every payer address screened before `settle` (hit → `403 sanctioned_counterparty`, no purchase); `x-vercel-ip-country` in comprehensively sanctioned jurisdictions → `451` on paid and creator routes; screening results and ledger retained 5 years. The creator agreement carries a sanctions representation. This is a sanctions gate, not an identity gate — FR-26 stands.
- **FR-39** — Takedown path: published abuse address and DMCA agent registered before launch; acknowledge ≤24h, act ≤72h; repeat-infringer policy (two upheld notices → creator retired). A takedown may revoke purchases (`revoked_at`) and refund from the holdback; it is the **only** path that revokes access, and it is logged. **This is also the path for a compromised release** — a rescan that finds a blocking finding in a release that already passed raises `release.compromised` (FR-41) and an admin alert, and the listing keeps selling until a human acts here. Nothing pauses or revokes automatically. *(Amended 2026-09-13, founder — "PRD Trust Report.md" §7. The alternative was an automatic `revoked_at` plus a listing pause, which this line reserves for upheld notices.)*
- **FR-40** — Buyer privacy: creators never see buyer addresses or tx hashes (FR-29); entitlement state is never disclosed without a signature (FR-20); **install counts are shown exactly from the first purchase (founder decision 30 Aug); never buyer addresses.** An install is a non-revoked purchase of kind `new` or `free`, counted as distinct buyer addresses per listing; the number is public on the product page and on listing cards, and is hidden — not printed as `0` — when nobody has bought yet. No other adoption metric is published, and no surface may attribute an install to an address, a wallet, a country or a time. The privacy notice states that payments to the platform address are public on-chain.
- **FR-41** — FR-2's abuse webhook: `https` only, resolves to a public unicast IP at call time, no redirects, 5s timeout, HMAC-signed payload `{ event, listing_id, version, code, docs_url, timestamp }` for `release.failed`, `release.compromised`, `listing.takedown`, `payout.sent`. *(Amended 2026-09-13: `release.compromised` added — a nightly rescan found in an already-passing release something that would have blocked it at cut time. The event is a notice, not an action: FR-39 is what acts, by hand. See "PRD Trust Report.md" §7.)*

### 8.9 Lifecycle: retire and delete

- **FR-42** — Listing lifecycle `draft → live → retired`; `live` requires ≥1 passing release and a description. Retire is terminal; slugs are not reused. *(Amended 2026-09-02: `licence = pass` was a third requirement until then — see FR-11.)*
- **FR-43** — **Retire** (`DELETE /api/listings/:id`, "Stop selling"): no new purchases; `/api/r` returns `410 retired` to non-holders; holders keep every version they own (FR-19); manifest page and release log stay up marked "no longer sold". Hosted repos are archived (read-only). App uninstall on Rail A = retire.
- **FR-44** — **Delete a hosted repo** (`DELETE /api/listings/:id/repo`, step-up): removes the git repo and deploy key. Releases with ≥1 purchase are retained (they are the product); releases nobody bought are deleted. A retired listing with zero purchases is hard-deleted after 30 days (tombstoned until then, in case the key that retired it was stolen).
- **FR-45** — Account close: ops-assisted in V0 (email or signed request); allowed once every holdback has cleared. The ledger is retained as required by law; it is a wallet address and amounts.
- **FR-46** — **A buyer never loses a purchased version to a creator action.**

### 8.10 The public manifest — the differentiator (G2)

Full spec in [Quality Signals.md](docs/research/Quality%20Signals.md). V0, not V1. Computed with no creator input, rendered server-side in a frame the creator cannot replace, served at `GET /api/label/:owner/:slug`.

- **FR-47** — **Artifact class badge** — Prompt / Pack / Toolkit / Harness / System — from deduplicated volume with the `unique_5gram >= 0.6` guard (cheap once the tarball is in hand; a volume-only classifier rates slop as a Harness).
- **FR-48** — **Component inventory** as counted nouns: `1 skill · 9 scripts · 3 test files`. Never raw bytes as the headline.
- **FR-49** — File tree, counts, bytes split text/binary, language mix, rendered README, dependency list (from the SBOM, on release only — §14.4), licence, the FR-37 trust report and the capability inventory computed with it, release log, cadence sentence ("ships every ~12 days"). **Amended 1 Sep 2026: also the list price, the update price, and the resource and version URLs.** *(Amended 13 Sep 2026: this item read "scan badge" — see FR-37 and "PRD Trust Report.md" §5.)* The rendered README carries **images, tables and task lists**: a README the creator wrote for GitHub must read here the way it reads there. Images the README references by a relative path are extracted from the snapshot at release time (≤20 files, ≤2 MB each, png/jpg/gif/svg/webp), stored in a public `readme-assets` bucket, mapped on `computed.readme_assets`, and served through `GET /api/label/:owner/:slug/asset/*` (§9). Absolute `https:` sources pass through; `http:` and `data:` are dropped. The sanitiser stays an allow-list.

  **On the price (amended 1 Sep 2026).** The manifest originally carried no price, on the
  reading that price belongs to `/api/v` (FR-20) and the 402 challenge. Observed in the
  field: an agent read the manifest, found `computed.licence: MIT` and no price, and
  reported the listing as free. Silence reads as zero. This discloses nothing new — an
  unauthenticated `GET /api/r` already quotes the list price to anyone who asks — so the
  manifest states it rather than making an agent know to ask twice. D3a is untouched: the
  price is not contents. Per-wallet pricing stays behind the signature on `/api/v`; the
  manifest carries the *list* price only, which is what a `max-age=60` public document can
  truthfully say. `resource_endpoint` and `version_url` go with it because the manifest was
  otherwise a dead end — the challenge links to it via `manifest_url`, and it linked back
  to nothing.
- **FR-50** — **Originality, V0 = blob-SHA overlap** against previously-seen snapshots and a public-repo sample: the share of blobs seen elsewhere, published as a field. A ≥90% overlap with a live listing blocks publish (`derivative_of`). MinHash over normalised token streams is V1.
- **FR-51** — Description and trigger hint are **required** (`description_missing` blocks publish) and badged `self_reported` in the API and the agent reading of the listing page. *Amended 30 Aug 2026 (founder):* the human reading of the listing page prints neither the badge nor a small-print disclosure — a snake_case token beside the blurb read as a defect to the buyer it was meant to inform. The computed/self-reported distinction is carried by the API and the agent reading. Example inputs/outputs are creator-supplied and badged `self_reported` in V0; sandbox-generated examples are V1 (NG6).
- **FR-52** — Every computed number carries computed-at and analyzer version; computed and self-reported fields are separately namespaced and badged; computed fields are undeletable by the creator; never gate computed metadata on a simplicity condition.
- **FR-53** — Check the "all clear" claims first: "no dependencies", "no telemetry", "MIT licensed" are verified against the computed fields and contradicted inline.

Deferred to V1 (were V0 in v1.0): context cost, depth score with percentile, maintainer reality, substantive-release scoring, adoption curve.

---

## 9. API surface, errors, limits

```
Public / buy side
GET  /:owner                            Author page — every live listing of one creator (§14.1)
GET  /:owner/:slug                      Manifest page — server-rendered (§14.1)
GET  /api/label/:owner/:slug            Manifest JSON. Free, cacheable
GET  /api/label/:owner/:slug/asset/*    A README image from the latest passing release (FR-49)
GET  /api/v/:owner/:slug                Latest version + prices; with X-Wallet-Signature: owned, entitled, price_kind
                                        Also `scan`: verdict, at, blocking/disclosed/review counts,
                                        capabilities_summary (added 13 Sep 2026; FR-37)
GET  /api/v/:owner/:slug/releases       Public release log
GET  /api/r/:owner/:slug                The paid resource, latest. 402 → 200
GET  /api/r/:owner/:slug/v/:version     A version the caller owns (X-Wallet-Signature)
GET  /api/entitlements                  What a wallet owns (X-Wallet-Signature)
GET  /api/auth/challenge?address=       Nonce for X-Wallet-Signature / address_proof / rotate-key
POST /api/mcp                           MCP, buy-side tools (Streamable HTTP, stateless). Body ≤ 64 KiB, batch ≤ 10
                                        messages, one rate-limit token per message; GET is 405, no server→client
                                        stream (amended 25 Oct 2026; RED-TEAM AGENT-2, AGENT-3)
GET  /api/openapi.json  ·  GET /api/terms  ·  GET /api/health

Agent discovery (added 31 Aug 2026; see docs/agent-discovery.md)
GET  /.well-known/api-catalog           RFC 9727 linkset: OpenAPI, /docs, terms, status.
                                        Public HTML pages carry RFC 8288 Link headers pointing here
GET  /.well-known/ai-catalog.json       ARD capability manifest (also named by robots.txt Agentmap)
GET  /.well-known/mcp/server-card.json  SEP-1649 server card for /api/mcp
GET  /.well-known/agent-skills/index.json · …/x402git/SKILL.md   Agent Skills Discovery 0.2.0
GET  /openapi.json                      The OpenAPI document at the origin root, the one URL x402scan's crawler reads;
                                        the /api/r template and one concrete path per live listing (fixed new-buyer
                                        price) carry `x-payment-info`; `info` carries a contact and `x-guidance`
GET  /.well-known/x402                  Every live paid resource URL, for x402 indexers that still probe it
GET  /.well-known/mcp-registry-auth     Domain proof for the official MCP Registry (com.x402git/git-x402; server.json)
GET  /.well-known/402index-verify.txt  Domain proof for 402 Index (402index.io); lets us edit our listings there (added 21 Sep 2026)
GET  /{INDEXNOW_KEY}.txt                IndexNow key; a publish, retirement or new release pings the search engines
                                        (added 16 Sep 2026; see docs/research/Agent Discovery Channels.md)

Creator (Bearer x4c_live_…; every route also consumed by the web app)
POST /api/creators                      Register (Idempotency-Key)
GET  /api/creators/me                   Profile, payout address, pending rebind
PATCH /api/creators/me                  Payout address (step-up, 48h), abuse contact (48h)
POST /api/auth/rotate-key               New key by wallet signature; old key revoked
POST /api/listings                      Create (source: github | hosted; ssh_public_key for hosted)
GET  /api/listings/:id                  Status, licence, latest_release, pricing block
PATCH /api/listings/:id                 price_micro, update_price_micro, description, trigger_hint
POST /api/listings/:id/sync             Cut a version now { ref?, version, notes? }
POST /api/listings/:id/licence          Rail B: commit an allow-listed LICENSE
PUT  /api/listings/:id/ssh-key          Rotate deploy key (step-up)
POST /api/listings/:id/publish          draft → live, or 409 listing_not_ready { blocking[] }
DELETE /api/listings/:id                Retire
DELETE /api/listings/:id/repo           Delete hosted repo (step-up); sold releases retained
GET  /api/earnings                      Ledger view, paginated
POST /api/payouts/sweep                 Force a sweep of released balance

Internal
POST /api/webhooks/github               push / release / installation events
GET  /api/cron/sweep  ·  /api/cron/reconcile  ·  /api/cron/rescan   Vercel Cron, daily (rescan: "PRD Trust Report.md" §7, 2026-09-13)
```

**Error catalogue** (`{ code, message, docs_url, details? }`):
payment — `insufficient_balance` `expired_authorization` `replay` `settlement_pending` `settlement_timeout` `authorization_mismatch` `price_changed` `sanctioned_counterparty` · listing — `listing_not_ready` `licence_block` *(retained, no longer emitted — FR-11)* `scan_failed` `version_exists` `description_missing` `retired` `not_entitled` `derivative_of` · auth — `invalid_key` `insufficient_scope` `step_up_required` `terms_version_stale` `payout_address_unverified` `invite_required` · limits — `rate_limited` (with `retry_after_seconds`) `repo_too_large` `too_many_unpublished`.

**Rate limits:** registration 5/hour/IP; listing creation 3 unpublished per creator; pushes 20/hour/repo; `/api/r` 60/min/address; `/api/v` and `/api/label` 600/min/IP (cached); challenge 30/min/address. *(Amended 25 Oct 2026, red team CORE-3/CORE-4/PAY-12.)* Where the address is only named by the caller and not proved (a challenge request, the `from` of an unsettled payment), the per-address limit is counted per (IP, address), under a per-IP cap of 4× that limit: 240/min for `/api/r`, 120/min for challenges. `rotate_key` and `step_up` challenges (and `POST /api/auth/rotate-key`) each have their own bucket.

---

## 10. Metrics

The V0 question: **does a public manifest over a private repo convert where a sealed box does not?** With v1.0: **does anyone use the headless rail?** Every purchase carries `source(web|api|mcp)` and every creator `onboarded_via`, so the human/agent split is a headline result, not hygiene. An `event` table (`manifest_view`, `402_issued`, `settled`, `update_purchase`) backs the rest.

| Metric (60 days post-launch) | Target | Meaning |
|---|---|---|
| Repos listed | 25 | Supply exists |
| Repos listed by people who are not us | 20 | Not just the co-founder's library |
| **Paid purchases** | **50** | The only number that matters |
| Distinct paying wallets | 30 | Not one enthusiast |
| Repeat buyers | 8 | Not a one-time curiosity |
| Update purchases | tracked | The recurring economics showing up without a subscription |
| Share of listings with `update_price = 0` | tracked | Whether creators reach for lifetime |
| GMV | $500 | Sanity floor at a $9 default |
| Median time to live (web / API) | <5 min / <2 min | G1 / G6 |
| Listings created fully headless | ≥5 | The agent rail is used, not just built |
| Purchases with `source ≠ web` | tracked | Agent commerce actually occurring |
| **Manifest views per purchase** | tracked | The core hypothesis |
| Releases failing the scan gate | >0 | The gate does something |
| Sweep success rate | 100% | Money out is never the broken step |

**Kill criteria:** fewer than 10 paid purchases, or fewer than 5 non-founder creators, at 60 days. Shelve it.

---

## 11. Architecture and stack

```
Human creator ──GitHub OAuth──> Web app ─────┐
Agent creator ──API key────────> Creator API ─┤  one creator core
                                              │
   Rail A: creator's repo (GitHub App)        │
   Rail B: hosted org repo + per-repo deploy key
                    │
         push/release webhook ──> analysis (7 REST calls) ──> zip → Supabase Storage
                                     │                          └──> release row (manifest, diff, scan)
                                     └──> scan: secret ruleset in-process + OSV API

Human buyer ──page──> SSR manifest ─┐
Agent buyer ──402───> /api/r ───────┤  lib/core/access.ts  ── @x402/core verify/settle ── CDP facilitator ── Base/USDC
Agent buyer ──MCP───> /api/mcp ─────┘        │
                                             └──> purchase rows → daily sweep (holdback) → creator payout address

Signing service (separate deployment / KMS): GitHub App private key · hosted-org admin token · CDP secret · sweep wallet
```

| Layer | Choice | Why |
|---|---|---|
| App | Next.js 16 App Router on Vercel | SSR by default (§14.1); x402 ecosystem is JS-first |
| Payments | `@x402/core` (+ `@x402/evm`) called directly | Price depends on the caller; the static-route middleware in `@x402/next` cannot express that. **Not `x402-next`** (v1, deprecated) |
| Facilitator | Coinbase CDP via the library's abstraction | No extra interface of our own |
| Custody (`custodial`, humans) | CDP Server Wallet v2 with destination allow-list policy | Keys TEE-held; a leaked CDP credential still cannot redirect funds |
| DB | Supabase Postgres | Postgres + storage + signed URLs in one product |
| Artifact storage | Supabase Storage | `createSignedUrl(path, expiresIn)` is the primitive §6 needs |
| GitHub | GitHub App (`@octokit/app`) for both rails; hosted repos in separate orgs | Per-repo, revocable, auditable; blast radius bounded (D10) |
| Scanning | gitleaks ruleset (TOML) applied in TypeScript; OSV `querybatch` REST; Socket full scans from the artifact zip (`tmp=true`), manifests only; own capability/injection rulesets in TypeScript | No Go binaries in a serverless function. Two tools and no third: our own rules read the artifact's files, Socket reads only the dependency manifests it extracts — the artifact's code never leaves our storage (D3a), and no model is in the loop |
| Secrets | Separate signing service / KMS for the four crown jewels | The web deployment holds only short-lived tokens (§14.8) |
| Buyer wallet (web) | viem + wagmi connect, x402 client signing | Human buyers need a browser wallet |
| Cron | Vercel Cron: sweep, reconcile | Not a worker |

**Deliberately not in V0:** Redis, a queue, a container, a background worker, an ORM, an on-chain splitter (unless D13 forces it), interfaces with one implementation ("facilitator interface", "provisioning interface", "batch-ready settlement" — write the note, not the code).

**The one abstraction that matters — `lib/core/access.ts`.** The only module that knows about entitlements or money. Every surface calls `quote`; only paid paths call `grant`. Do not fork it.

```ts
type Quote =
  | { kind: 'granted';          release: Release; purchase: Purchase }
  | { kind: 'payment_required'; release: Release; price_micro: bigint;
      reason: 'new' | 'update'; releases_since: ReleaseLogEntry[]; quote_id: string }
  | { kind: 'unavailable';      code: 'not_found' | 'retired' | 'no_release' | 'not_entitled' };

quote(ref: ListingRef, buyer: Address | null, version?: string): Promise<Quote>;
toPaymentRequirements(q: PaymentRequiredQuote): PaymentRequirements;   // the only place a 402 body is built
grant(q: PaymentRequiredQuote, buyer: Address, settlement: SettleResult): Promise<Purchase>; // idempotent on nonce; computes fee/net/holdback; stamps update price
downloadUrl(p: Purchase, ttlSec?: number): Promise<{ url; artifact_sha256; version; expires_at }>;
owned(buyer: Address, ref?: ListingRef): Promise<Purchase[]>;
```

`/api/v` = `quote` serialised. `/api/r` = `quote` → `granted ? downloadUrl : verify/settle → grant → downloadUrl`. MCP `check_version` = `quote`; `purchase` = the same three calls. Sweep = `SELECT creator_id, SUM(net_micro) … WHERE holdback_until < now() AND payout_id IS NULL`.

---

## 12. Data model

Five tables. Prices are **integers in micro-USDC** — never floats.

```sql
creator    id · handle UNIQUE · github_user_id?              -- null on Rail B
           onboarded_via(web|api)                            -- keys moved to api_key, D14
           wallet_mode(linked|custodial) · payout_address · cdp_wallet_id?
           pending_payout_address? · rebind_effective_at?    -- 48h rule
           abuse_contact_url? · abuse_contact_email?
           terms_version · terms_accepted_at · created_at

listing    id · creator_id · slug · source(github|hosted)
           installation_id? · github_repo_id · deploy_key_id?
           price_micro · update_price_micro                   -- 0 = lifetime
           description? · trigger_hint?
           licence_spdx? · licence_verdict(pass|manual|block)
           published_at? · retired_at? · created_at
           UNIQUE (creator_id, slug)

release    id · listing_id · version · git_ref · commit_sha
           artifact_sha256 · storage_path · size_bytes
           scan(pending|pass|fail) · scan_report jsonb · scanner_version   -- report v2, below
           manifest jsonb · changelog · diff_summary jsonb
           price_micro_at_publish · update_price_micro_at_publish
           analyzer_version · created_at
           UNIQUE (listing_id, version)

purchase   id · listing_id · release_id · buyer_address
           all_versions bool · update_price_at_purchase      -- FR-16
           kind(new|update|free) · source(web|api|mcp)
           gross_micro · fee_micro · net_micro
           tx_hash · payment_nonce UNIQUE                     -- FR-22
           granted_at · holdback_until · payout_id? · revoked_at?

payout     id · creator_id · amount_micro · gas_micro · to_address
           idempotency_key UNIQUE · tx_hash?
           status(pending|broadcast|confirmed|failed) · created_at
```

Plus `api_key` (D14: one row per credential, `kind` ∈ `agent`|`session`, with `scopes`, `expires_at`, `revoked_at`, `last_used_at`; it replaces `creator.api_key_hash`, `creator.api_key_scopes` and `creator.session_epoch` — schema in "PRD Session Keys.md" §7), `event` (analytics, §10) and `screening` (FR-38 results, 5-year retention).

**`release.scan_report` is a v2 document** *(13 Sep 2026; shape in "PRD Trust Report.md" §4.2)*. It carries `version: 2`, the verdict, the scanner version, and **`checks[]`** — one row per check that ran or was supposed to, each with `id`, `tool`, `tool_version`, `status` (`pass | findings | fail | unavailable | partial`), `at`, a finding count, and, on the Socket row, **`socket_scan_id`** so a scan left processing can be read back later without re-uploading. `findings[]` keeps the v1 shape plus `check`, `public` and `tier` (`blocking | disclosed | review`); `capabilities` is the computed inventory (FR-35); `counts` is the three tiers; **`advisories_refreshed_at`** is moved by the rescan cron while `scanned_at` stays at the cut, so the page can say when the verdict was reached *and* when the advisories behind it were last checked. A v1 report is read through a shim that synthesises `checks[]` from `checked[]`; no rows are migrated, and `scanner_version` says which era a report is from.

**Access check for release N** (the whole model): `purchase WHERE listing_id AND buyer_address AND revoked_at IS NULL AND (release_id = N OR all_versions OR (kind = 'update' AND granted_at > now() - 7 days))`.

**State machines.**
- Listing: `draft → live → retired`. `live` needs a passing release + description. Retire is terminal.
- Release: `pending → pass | fail`. Terminal — a rescan refreshes disclosures and never flips the verdict (FR-39). Latest sellable = newest `pass`. Analysis errors leave `pending` with `scan_report.error`; `sync` re-runs. *(13 Sep 2026: a single check that could not run is an `unavailable` row on the report, not a `pending` release — FR-35.)*
- Purchase: `granted → revoked` (takedown only).
- Payout: `pending → broadcast → confirmed | failed`.

The release log is `SELECT public columns FROM release`. The label is `latest passing release.manifest`. The ledger is a view over `purchase` and `payout`.

---

## 13. x402 integration specifics

- **Network:** Base mainnet; Base Sepolia for development and the FR-34 CI test. **Asset:** USDC.
- **Facilitator:** Coinbase CDP. Zero protocol fee, **$0.001 per settlement above 1,000/month** — the basis of the $0.01 minimum.
- **Scheme:** `exact`. Per-call metering and batch settlement are V1 — noted, not built.
- **Wire format:** x402 v2 — `PAYMENT-REQUIRED` with `accepts[]` (`scheme`, `network`, `asset`, `payTo`, `maxAmountRequired`, `resource`, `description`, `maxTimeoutSeconds`, `extra{name,version}`); `PAYMENT-SIGNATURE` on the paying request; `PAYMENT-RESPONSE` with settlement. Platform fields under top-level `extra`: `kind`, `version`, `from`, `to`, `manifest_url`, `scan_badge_url`, `update_price_micro`, `releases[]`, `quote_id`, `valid_before`, and — for a reader that is not an x402 client (added 2026-09-02, see FR-31) — `instructions`, `listing_url`, `skill_url`, `mcp_url`. The `description` is read inside an agent's reasoning — it is product copy. *(Added 16 Sep 2026.)* The 402 also declares the x402 `bazaar` discovery extension under top-level `extensions`, and `resource` carries `serviceName` and `tags` computed from the manifest; an x402 client echoes both in its payment payload and the CDP facilitator catalogues the resource on settlement (lib/x402/bazaar.ts). No `routeTemplate`: each listing is its own catalogue entry.
- **Receiving address:** platform-controlled, key in the signing service; the split is a ledger insert (D13).
- **Idempotency:** nonce `UNIQUE`, bound to `{listing, version, amount}`; replay returns the existing purchase.

---

## 14. Implementation constraints — the things that will bite

- **14.1 Server-render the manifest, or it does not exist.** Agent Bazaar's product pages contain the product's name zero times. CI check: `curl -s https://x402git.com/adrian/humanizer | grep -c humanizer` must be `> 0`.
- **14.2 `x402-next` is the deprecated v1 package.** Use `@x402/core`, `@x402/evm`; call verify/settle directly (FR-21).
- **14.3 Installation tokens expire in one hour.** Mint, use, discard. Store `installation_id`.
- **14.4 The SBOM endpoint is capped at 100/hour** per installation and Rail B shares it. Run on release only; cache on the release row.
- **14.5 Snapshot before you sell, always.** Both rails.
- **14.6 One public key, one repo.** GitHub rejects a deploy key already used elsewhere; SSH keys are per listing (FR-7).
- **14.7 A bearer key is held by software and will leak.** It cannot move money (FR-26), cannot destroy data without step-up (FR-5), and is auto-revoked when found in a repo (FR-4). There are two kinds (D14): the agent key, which lives until it is rotated, and the website's session keys, which additionally expire and are revoked on sign-out — so a stolen cookie has a shorter life than a stolen agent key, and killing it breaks no agent.
- **14.8 Isolate the crown jewels.** The GitHub App private key, hosted-org admin token, CDP secret and sweep-wallet key live in a separate signing service; the web deployment holds one-hour tokens. Nothing untrusted ever executes in the same process as a secret (NG6).
- **14.9 Deploy keys and DMCA land on your org.** Register a DMCA agent; keep App and hosted orgs separate (D10); treat a GitHub enforcement contact as the Forgejo trigger.

---

## 15. Build order — six weeks of evenings, money first, HTML third

| Week | Ship | Done when |
|---|---|---|
| **1** | Five-table schema. Creator API only (`POST /api/creators`, `POST/PATCH /api/listings`, `source: github`). GitHub App + webhook → analysis → zip to Storage → `release` row with manifest. No UI | A tag push on a linked repo produces a `release` row with a manifest and a stored zip |
| **2** | `lib/core/access.ts`. `/api/r`, `/api/r/v/`, `/api/v`, `/releases`, `X-Wallet-Signature`, `@x402/core` on Base Sepolia. Fee split on insert. Update pricing with stamping | CI: register → link → tag → buy from wallet A → re-fetch → second tag → correct update 402 (or 200 when `update_price = 0`) |
| **3** | SSR manifest page + `/api/label`. GitHub OAuth. Listing page calling the same API. Pricing form ($9 / $5 defaults, presets, earnings preview). Earnings view | §14.1 curl check passes; a human lists a repo end to end |
| **4** | Scan gate (secret ruleset + OSV) + licence signal + publish + retire. Sweep cron with 7-day holdback, payout state machine, sanctions screening. Base mainnet. Signing service | A hardcoded key never becomes sellable; a creator receives USDC at their payout address 7 days after a sale |
| **5** | Rail B provisioning (hosted org, per-listing deploy key, `sync`, `licence`). OpenAPI from zod. README snippet. FR-34 CI test end to end | An agent with only a wallet and an SSH key registers, pushes, publishes, sells to a second wallet, and is paid |
| **6** | Buy-side MCP (4 tools). SDK helper for client-side `issued` keys. Hardening, launch checklist (§19). **Half of this week is slack on purpose** | The co-founder's agent buys from inside Claude Code; a second agent was the seller |

---

## 16. Scope

### V0 (~6 weeks of evenings, assuming an owner)
GitHub OAuth + App (Rail A) · headless registration with signed payout address · hosted private git (Rail B) · price + update price with anchored defaults · x402 v2 `exact` on Base · signed-address buyer identity · stamped purchase terms · public release log · webhook sync + sync-now · the trust report (added 13 Sep 2026): secret + CVE + known-malware + instruction-smuggling scan with its per-check results published, the computed capability inventory, and Socket over the artifact's dependencies · three-way licence signal · 7-day holdback · daily sweep to the creator's wallet · custodial wallet for human creators · sanctions screening · retire / delete hosted repo · SSR manifest + `/api/label` · buy-side MCP · README snippet · OpenAPI + error catalogue.

### V0.5
Buyer-initiated refund window funded from the holdback (revokes the purchase; one per wallet per listing).

Optional buyer email for release notices (added 2026-08-30, not yet specified). A wallet may attach one email, opt-in, and receive one message per new release of a listing it holds — the same fact `/api/v` and `/purchases` already show, delivered instead of polled. Scope to settle before build: storage and deletion of the address (it is the first PII the buyer side would hold), unsubscribe, rate (one per release, never per push), and whether NG7 is amended or this is carved out of it as a notice rather than a push channel.

### V1 — only if V0 shows demand
Delegation-backed automatic recurring billing · `updates_window` (one nullable `covers_until`) · on-chain fee splitter (or V0 if D13 forces it) · sell-side MCP · listing stake (only if caps prove insufficient) · card payments behind the same grant · collaborator-invite add-on · Forgejo swap · MinHash originality over normalised tokens · substantive-release scoring · context cost · depth score · maintainer reality · adoption curve · sandboxed example generation in a microVM · ~~malware/behavioural scanning~~ *(moved to V0, 13 Sep 2026 — FR-35 and "PRD Trust Report.md")* · self-serve account close.

### V2
Eval harness + LLM judge · a catalogue, if and only if it falls out of creators already using V0.

### Cut
Marketplace, search, rankings · ratings, reviews, profiles · subscriptions in V0 · cards/fiat/multi-chain in V0 · push notifications · Verified 25% tier · price-default randomisation · server-side key issuance · `every_push`/`manual` release-policy enum · daily reconciliation *as a sync mechanism* · stake.

### Never
Platform-set prices. A fixed per-transaction fee. Any revenue mechanism beyond the 10%. Price-ascending as a default sort. Fabricated previews. Listing without permission. A server-side path that sees a creator's private key.

---

## 17. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R-1 | Demand does not exist at any price | Critical | Test A before building (BT KS-4) |
| R-2 | Creators self-build the paywall | High | Compete on payouts, compliance, the manifest and the headless rail (BT KS-2) |
| R-3 | MIT redistribution voids the paywall | High | Versioned access + release log; blob-SHA originality in V0, MinHash in V1 (BT KS-3) |
| R-4 | Malicious artifact harms a buyer | Critical | FR-35–39; entity (D5) |
| R-5 | Crypto onboarding cuts the funnel | High | Cards V1 behind the same grant (BT KS-6) |
| R-6 | Anthropic ships paid plugins | High | Private repos, non-Claude agents, sell-side rail nobody has (BT KS-7) |
| R-7 | No owner | Critical | §18 Q1 (BT KS-8) |
| R-8 | GitHub suspends a hosted org | Medium | App in a separate account; orgs sharded; snapshots are the product; Forgejo pre-scoped (D10) |
| R-9 | **Custody and reporting** — platform holds anonymous creators' funds for 7 days in every mode | **High** | Named honestly (D13); custodial mode humans-only. *(Amended 2026-09-04, founder.)* ~~Counsel sign-off or the splitter, as a launch gate.~~ **Deferred (D5):** V0 launches without an entity and before counsel; both follow on traction, trigger in Q9. No entity yet; the custody and reporting questions are with counsel (see D13, Q9). Until then the risk is bounded by the holdback's size and the caps on it. DMCA agent registration follows the entity (§19 step 5); the takedown process in FR-39 runs as published at `/abuse` in the meantime |
| R-10 | Headless listing creation as a spam cannon | High | Caps + invite code (D2c), scan gate, holdback. **The licence no longer gates (FR-11, 2026-09-02)**, so it carries none of this load |
| R-11 | Leaked agent API key | Medium | Cannot move money or delete without step-up; prefixed and auto-revoked (FR-4, FR-5, FR-26) |
| R-12 | Update farm bills auto-paying agents | Medium | Diff in the 402 (FR-17); one charge per 7 days (FR-18); stamped terms (FR-16) |
| R-13 | Sanctioned counterparty | High | Unconditional screening (FR-38) |
| R-14 | Ledger drift / double payout | High | Payout state machine, idempotency, serialised signer, daily reconciliation (FR-28) |
| R-15 | Creators cluster too low to sustain 10% | High | Anchored defaults + earnings maths (D2a); paid updates (D1) |

---

## 18. Open questions and decisions needed

1. **Who owns this?** Nothing in §15 is schedulable until answered.
2. **D13 with counsel** — does the ledger split survive review, or does the splitter move to V0? Includes the reporting posture. ~~Launch gate.~~ *(Amended 2026-09-04, founder: not a launch gate. Deferred with the entity — D5, and the trigger in Q9.)* No entity yet; the custody and reporting questions are with counsel (see D13, Q9).
3. **Confirm the v1.1 cuts** (Paul): stake → caps + invite code; custodial → humans only; `issued` → client-side; sell-side MCP → V1; substantive-billing heuristic → diff-in-402 + 7-day rule. Each is reversible; each costs code.
4. **Launch category** under D8 — pick one.
5. **Free-version positioning** — "free trails paid by one release" (a `free_offset` column) or leave it to the creator?
6. **Name.** No "x402", "402", "git". By Sep 4.
7. **Founder supply** — the co-founder's library seeds V0; report founder/non-founder and human/agent separately.
8. **Invite-code sourcing for Rail B** in V0 — who hands them out, and when does the gate lift?
9. **What is "traction"?** D5 defers the entity and counsel (and, with the entity, the DMCA agent registration) until the product has some, and does not say how much. An unset trigger is how a deferral becomes a permanent state, so this needs a number, and the honest thing to measure is other people's money rather than revenue: the open questions are about the holdback. Candidates, all cheap to read off the ledger — cumulative gross settled, non-founder creators with a bound payout address, peak funds held in the holdback at one time, or days live on mainnet. **Paul picks the measure and the number.** Whatever it is, it belongs in a monitored query, not in someone's memory.

---

## 19. Before you write any code

In this order:

1. ~~**Form the entity** (D5).~~ *(Amended 2026-09-04, founder: deferred until the Q9 trigger. No entity yet; V0 launches without one.)*
2. ~~**Take D13 to counsel** with this document.~~ *(Amended 2026-09-04, founder: deferred (D5).)* No entity yet; the custody and reporting questions are with counsel (see D13, Q9).
3. **Run Test C** (the manifest test from the internal battle test): three repos, hand-built manifests, five people. If the manifest does not change whether they would buy, stop.
4. **Decide the name** (D7).
5. **Launch checklist:** terms + creator agreement + buyer terms published (below) · ~~DMCA agent registered~~ *(Amended 2026-09-04, founder: deferred with the entity, which the registration needs a legal name and address from. The notice-and-takedown policy is published at `/abuse` and says plainly that no agent is registered yet — see R-9)* · abuse address live · OpenAPI at a stable URL · mainnet facilitator credentials · receiving-address and sweep-wallet keys in the signing service (multisig for the receiving address) · kill switches wired (pause registrations, pause publishing, pause payments → 503 not 402, pause sweeps, per-listing takedown) · monitoring: settlement timeouts, sweep failures, reconciliation variance, SBOM cap.

**Creator agreement must cover:** hosting and redistribution licence grant · warranty of rights and originality (made by the operator for agent creators) · licence attestation · 10% fee · 7-day holdback and takedown refunds · retire/delete semantics and buyer retention (FR-46) · ledger retention · sanctions representation · prohibited content · tax responsibility (creators). **Buyer terms:** no warranty; licence passes through; refunds per V0.5; payments are public on-chain.

---

## 20. Appendix — provenance

- Micro-payments as the core thesis → anchored-default pricing with paid updates on pull (BT §5).
- "Scrape the hell out of GitHub" → opt-in-only supply (BT KS-3).
- Marketplace-first → primitive-first (BT §7).
- Trust as roadmap → V0 launch blocker (BT KS-5).
- Everything-at-once → one product, 28 Aug; the manifest kept.
- **v1.0 (29 Aug, Paul):** agent parity both sides; flat 10%; explicit update pricing and release log; instant sync; creator deletion.
- **v1.1 (29 Aug, battle test):** five-table model; buyer identity before payment; payouts only to the bound address; wallet modes corrected and custody named; stamped purchase terms; sanctions screening; buyer privacy; stake, randomisation, substantive-billing heuristic, release-policy enum, reconciliation-as-sync, sell-side MCP, server-side key issuance, sandboxed examples and MinHash moved out of V0; build order reordered money-first with slack. Draft v0.2's `free_offset`, `next_check` hint, and optional demo video are noted as cut or pending (Q5).
