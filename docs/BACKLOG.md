# BACKLOG

Ideas that are agreed in principle and not designed yet. Nothing here is a commitment
until it is in [PRD Final.md](../PRD%20Final.md), and an idea goes into the PRD before it
gets built. An item that has been taken up is **marked accepted where it stands**, with the
PRD text and the answers to its open questions, rather than deleted — the questions are the
part worth keeping, and the answer to one of them is usually the reason the design came out
the way it did.

---

## Buyers signal which public repos they used a listing in

**Founder idea, 30 Aug 2026. Not designed yet.**

Let a buyer point at a public repository of their own and say "I used this listing here",
so a listing page can show where its code actually ended up. Social proof from the buy
side rather than from a rating, which the product refuses (PRODUCT.md: this is not a
marketplace, and no surface may imply a second side of the market).

Everything about it is open. In particular: how a claim is proved rather than typed;
how it survives FR-40, which says a buyer address is never disclosed and an install
count is the only adoption number published; whether the repository has to contain the
artifact for the claim to stand; and whether an unverifiable claim is worth showing at
all next to computed fields the platform guarantees.

---

## Socket for malicious-dependency detection

**Founder intent, 31 Aug 2026. Designed 13 Sep 2026 in
[PRD Trust Report.md](proposals/PRD%20Trust%20Report.md) (§6.2) and accepted the same day —
it is in the PRD now (FR-35, §11, §16) and phase 2b of that document builds it. Left here
for the questions below and how each was answered.**

**How the open questions were answered.** Pricing: build on Socket's free tier — 500 units
an hour, 1,000 full scans a month, ~7 units a release — and open the conversation when a
month of volume gives us numbers to bring (§10 Q4). Block or disclose: Socket's confirmed
`malware` blocks and nothing else of Socket's does; its behavioural and hygiene alerts are
disclosed and its model-derived alerts are `review` flags that are never a verdict (§4.1,
§6.2). Per-check publication: that became the whole point of the document — `scan_report`
is v2 with a row per check, and the Agensi criticism is answered in §5.
`ossf/malicious-packages` needed no integration at all: it is already inside OSV as `MAL-`
records, which now block (§6.1, §6.3).

Add [Socket](https://socket.dev) alongside the OSV query in `lib/scan/osv.ts`. OSV only
knows about published advisories; Socket analyses what a package's code actually does —
install scripts, network access, filesystem writes, obfuscation — and flags malicious
packages before any CVE exists. That is the gap FR-35's dependency check cannot close on
its own, and it is the class of attack that is actually hitting registries: the malicious
package is usually new, not vulnerable.

Cheap companion worth doing at the same time: `ossf/malicious-packages`, a free feed of
known-malicious packages published in OSV format, consumable through the `querybatch`
path that already exists.

Open questions. Pricing is seat-based ($25/dev/month, free tier 1,000 scans/month), which
does not map to a marketplace scanning other people's repositories — a per-scan API
arrangement needs a conversation with them before this is designed. Whether a Socket
finding blocks a release or is recorded as a disclosure, given DECISIONS.md's reasoning
that a gate which always fires teaches people to ignore it. And how much of the verdict
can still be published per-check: "the badge has nothing behind it" is the criticism
`docs/research/Battle Test.md` §6.3a levels at Agensi, and a black-box vendor call must
not cost us the answer to *why* a scan passed.

Belongs with the rest of FR-35's deferred V1 half (malware and behavioural analysis) —
agent-artifact checks like install-time execution, tool-description injection and
capability disclosure, which no vendor sells off the shelf. *(That half is no longer
deferred: it moved to V0 on 13 Sep 2026, and the three checks named in this paragraph are
our own modules, not a vendor's — §4.3 and §6.1 of the proposal.)*

---

## A creator can read the scan report that failed their release

**Founder report, 1 Sep 2026. Designed 13 Sep 2026 in
[PRD Trust Report.md](proposals/PRD%20Trust%20Report.md) (§4.2, §4.4) and accepted the same
day — FR-35 now says the creator can read their own release's full report, and phase 1 of
that document builds it. Left here for the questions below and how each was answered.**

**How the open questions were answered.** Which surface: both — a creator-authenticated
report on `GET /api/listings/:id`, and the dashboard's "Security scan" row linking to it,
because D9 makes the browser one client of the API. A secret's `path` and `line`: shown to
the creator, never on any public surface, along with the secret's *length* and never its
value — the path is the creator's own file, and withholding it is the complaint this entry
makes. The `pending`-forever case gets its words: "known-vulnerability check could not run;
retrying". The two adjacent defects below were fixed on 2026-09-01 — see DECISIONS.md,
"A failed scan says so, and says what to do about it".

`scanArtifact` produces a finding per problem — `rule_id`, `severity`, `description`, and
for a secret the `path` and `line` — and `cutRelease` stores the lot on
`release.scan_report`. Nothing ever reads that column back. Not `GET /api/listings/:id`
(whose `latest_release` is the newest *passing* release, so a failure is invisible there),
not the dashboard (one table cell reading the word `fail`), not the public release log,
which is right to withhold it. FR-35 requires the report to be *stored* and never says it
must be readable, so the creator-facing half was never specified and never built.

What the creator gets instead is the verdict word and a fix line that points at a document
with no URL: `/docs/errors` says "Read the scan report on the release, fix the finding,
and cut a new release" (`lib/web/error-recovery.ts`). The scanner knows the file and the
line number and does not say. The worst shape of it is the FR-4 case — one of our own keys
committed to the repo is revoked on the hit, and an agent-key hit takes the creator's live
web sessions with it, so the sequence is: push a tag, scan fails, you are signed out, and
the explanation is in a jsonb column with no reader.

Open questions. Which surface — a `scan` section on the dashboard's release row, a
creator-authenticated field on `GET /api/listings/:id`, or both, given D9 says the browser
is one client of the API. Whether a secret finding's `path` and `line` can be shown even to
the creator, or only the rule id: the path is a map to the secret for anyone who cloned the
repo before the tag, and the snapshot is deleted but the commit is not. Nothing goes on the
public log either way. And what the `pending`-forever cases say — an OSV outage leaves
`scan_report.osv_error` and no report at all, which is a third state the copy does not have
words for.

Two adjacent defects that are not this idea and should be fixed regardless: the API's
`publishBlockers` pushes `scan_pending` when no release has passed and never `scan_failed`,
even though `scan_failed` is in the `blocking[]` enum — so an agent publishing headlessly is
told to wait for a scan that is terminally failed. And a bare `sync` on a repo whose only
tag already failed answers `version_exists` rather than saying every tag has been cut.

---

## The FR-34 harness cannot exercise Rail A unattended

**Found by the 2026-09-09 FR-34 run, 9 Sep 2026. Not designed yet.**

`--rail a` has been unreachable since commit `d7ebc40` ("Security audit: close the Rail A
ownership bypass and the mediums"). `resolveRailARepo` (`lib/listings/service.ts`) refuses
a `github` listing from a creator with no `github_user_id` — an installation id is a small
enumerable integer, so the ownership check has to be unconditional, and there is nothing to
verify an installation against without a linked identity. A creator registered headlessly
has no such identity by construction. The refusal is correct; what is wrong is that the
harness still advertises the flag, so `--rail both` exits 1 on a run where the only failing
thing is the test's own assumption. See DECISIONS.md, 2026-09-09.

Three shapes it could take, none chosen. **A test-only identity link** — an endpoint or
script that stamps `github_user_id` on a creator outside the OAuth flow, which is fast and
puts a bypass of an ownership check into the codebase, gated on an env var that must never
be true in production. **A recorded OAuth session** — reuse a real signed-in cookie in the
harness, which proves the real path but needs a credential kept somewhere, refreshed by
hand, and never committed. **Or accept that Rail A is proven through the web dashboard**,
which is how a Rail A creator actually arrives, and make `--rail a` say so — print what
covers it and exit 0 rather than failing — leaving the headless harness scoped to the
headless rail, which is what FR-34 has always meant.

Open either way: whether anything then checks Rail A on a schedule, or whether "proven by
the dashboard" quietly means "proven the last time somebody clicked through it".

---

## List our paid resources in the x402 Bazaar

**Found by the 2026-09-10 upstream review, 10 Sep 2026. Accepted and built 16 Sep 2026**
(PRD §9 and §13; `lib/x402/bazaar.ts`, `/.well-known/x402`, `scripts/bazaar-check.mjs`;
research in [research/Agent Discovery Channels.md](research/Agent%20Discovery%20Channels.md)).
The open questions, answered: a per-buyer price is advertised as the new-buyer price and
the 402 the agent then receives is the one that binds, never higher; a delisted listing is
*not* removed by the facilitator (no mechanism exists), its URL simply stops answering
402, which is what 17% of the index already does; and the entries are per listing, not one
for the platform, because `routeTemplate` was left out. What was not known on 10 Sep: the
facilitator catalogues only on a settlement whose payload echoes the declaration, so a
listing with no sales is declared but not yet indexed. The platform does not seed it: the
first sale is the creator's (founder, 16 Sep 2026; DECISIONS.md). `npm run bazaar:check`
reports the state.

The CDP facilitator we settle mainnet through serves `GET /discovery/resources`, an index
of 14,202 paid x402 resources, and none of them is ours. A resource enters it by declaring
the `bazaar` extension on its priced route; entries carry the payment terms, an
input/output example, and a facilitator-computed `quality` block (30-day calls, 30-day
unique payers, last called). That last part is a usage signal a competitor cannot fake,
and it is adjacent to the quality-signal differentiator.

Open. We do not use the static-price middleware, so the declaration has to be attached
where requirements are built (`lib/core/access.ts` → `lib/x402/server.ts`), and it needs a
`routeTemplate` for `/api/r/[owner]/[slug]` that passes the facilitator's `matches_resource`
check. It also adds a dependency, `@x402/extensions`. Unresolved: whether a per-buyer price
can be represented honestly in an index whose entries advertise one `amount`; whether a
delisted or takedown'd listing is removed from the index promptly enough for FR-45; and
whether being indexed alongside 14,202 API endpoints helps a product that sells artifacts
rather than calls. Background in [x402-upstream.md](x402-upstream.md).

---

## Two rough edges from the first trust-report backfill

**Founder-facing observation, 14 Sep 2026. Not designed yet; both are small.**

The backfill of the eight live listings ("PRD Trust Report.md" §7) published two things
that read wrong:

- **Socket's repo-level alerts wear a package name.** `missingLockfile` (and the other
  repository-only alerts — `oversizedManifest`, `unresolvedPomReference`, the `gha*`
  family) arrive on a synthetic artifact Socket calls "Socket SBOM Resolver", and
  `describeSocketAlert` prints it as `Socket SBOM Resolver (transitive) — no lockfile…`.
  A repo-level alert should carry no package qualifier at all: `No lockfile, so installs
  are not reproducible.`
- **`$NAME` in a JavaScript file is not a shell variable.** `evidence-slice-auditor`
  reports `reads the environment variable JSON` because a `${JSON.stringify(…)}` template
  literal in `src/audit.mjs` matched the shell-style `$X` rule. In `.js/.mjs/.cjs/.ts`
  only `process.env.X` counts; the `$X` rule belongs to shell, Makefile and workflow files.

Both are one-table edits in `lib/scan/socket.ts` and `lib/scan/capabilities.ts` with a
test each, and a backfill (`?mode=backfill`) republishes the fix.

---

## Ideas noted in October 2026

**Ideas, October 2026. Not designed yet.**
Most of these run into PRODUCT.md, which says the product is **not** a marketplace,
catalogue, search, ratings or profiles, and bans "marketplace" language. That line has to
be changed on purpose, in PRODUCT.md and the PRD, before any of this is built. It should not
erode one feature at a time. The agreed order: profiles and leaderboards first, then
discovery.

### Creator profiles worth having

The co-founder's point: a profile today is the GitHub data and nothing else, and nothing
links to it. Proposed: on opt-in, enrich the profile from public data (socials,
YouTube, picture, bio), pitched as "do agents agree on who you are". Plus a featured repo
and links. Open: consent and what to do when the data is stale or wrong; whether scraped
fields are shown as the creator's own words; FR-40 (no buyer addresses), which limits what
a profile can say about sales.

### Leaderboards and seasons

The MVP hook for creators. Keep it simple: make a profile and you are on the leaderboard,
with no points algorithm. Seasons reset every two months. Early-cohort status ("creator
#3"). Open: what ranks a creator (sales and installs are the only numbers we publish, and
both are easy to game with self-purchases); what the reward is and who pays for it.
Background reading: Octalysis (Yu-kai Chou), Hooked (Nir Eyal).

### An explained trust score for agents

A score per listing, out of 100, that comes with the reasons behind it, so an agent can
check why. A manual 1–10 score was rejected for that reason. It would sit next to the
trust report (licence, our scan, Socket), not replace it. Open: whether a single number
contradicts the trust report's "disclose, don't verdict" stance (PRD Trust Report.md) and
the Substance Classifier draft's "never a verdict"; what goes into it beyond the scan
(social signals, YouTube mentions, installs).

### "Connect / hire" next to "buy"

For expensive listings (agent operating systems at around $500): a second call to action,
for example a Calendly link, so a business can hire the creator to set it up. Open: whether
the platform takes any part of that (it can't see it); spam and abuse; Paul flagged it as
scope creep ("Upwork for AI builders").

### Discovery as an e-commerce catalogue

The co-founder: categories with faceted navigation, so there are many unique, indexable pages, and
the site works with Google Shopping and agent shopping. It needs about 10 good listings
first. Open: whether to organise by category or by creator (Paul: by what they make, rolled
up to the creator); how it relates to the "headless marketplace for agents" idea and to
[agent-discovery.md](agent-discovery.md); thin-content risk while there are few listings.

### Questions a buyer asks, and what already answers them

What stops a listing that doesn't contain working code, how a buyer checks it before
paying, how refunds work without escrow, what stops leaks, whether the platform can be
trusted with source, XSS on listing pages, a very large LFS repo, and a 1¢ price.
Already answered by what exists: the free pre-purchase manifest and the scanned
`artifact_sha256`; the 200 MB / 20,000-file caps; server-rendered React with the README
sanitised twice and the JSON-LD through `jsonLdSafe`. Leaks are not ours to solve, and the
answer is the release stream (D1, D2a), not DRM. The rest is below.

**Wording.** Say "7-day holdback", not "escrow". The PRD calls it a holdback on purpose
(D13, R-9): "escrow" implies a neutral, regulated third party and promises a refund path
that does not exist yet.

### A price floor that rises with artifact size

D2b's $0.01 floor only covers the facilitator fee against the commission, not storage and
egress, which grow with the artifact. Open: floor as a function of `size_bytes`
(stepped bands or per-MB); whether it also binds the update price; how it is stated without
breaking D2b's "never surfaced as a suggestion" (FR-12 already prints the floor as a
constraint under an opened custom field, which is the precedent); what happens to listings
already priced under the new floor (FR-16: purchase terms never worsen for existing holders).

### README-vs-code scoring

An answer to "I can't verify it's useful before I buy". Score
whether the code backs up what the README claims: features named in the README that have
no matching files, a README that is most of the substance, a large README over a stub tree.
Belongs inside [the explained trust score](#an-explained-trust-score-for-agents) as one of
its reasons, and next to the substance class, which already measures some of this. Same
open question as the trust score: a number versus "disclose, don't verdict". No model in
the loop for the scan (§11), so either this is deterministic or that line changes first.

### A security page

x402git is open source under AGPL-3.0-only, which answers "can I trust it with my source"
for anyone who reads the code. Open: a short security page (where artifacts live, who can
read them, that we never hold a creator key, NG10) and a bug bounty, which answer the same
question without anyone having to read the code.

### Detect Git LFS repos

A repo that keeps its assets in LFS snapshots as pointer stubs — the GitHub tarball does not
resolve LFS objects — so it passes every check and sells files that aren't there: a
mislabelled listing. Detect `filter=lfs` in `.gitattributes`, or
files that begin `version https://git-lfs.github.com/spec/`. Open: block (a new FR-35
blocking class, which needs the PRD first) or disclose on the manifest; whether to ever
resolve LFS objects (no: the caps would refuse a large one anyway).

### Buyer-initiated refunds from the holdback

Already in the PRD as V0.5 (FR-27, §16: one per wallet per listing, revokes the purchase).
The case for pulling it forward: the money already sits at the platform for
seven days, so the missing piece is the buyer's request and the revoke, not a new money
system. Until it ships, "7-day holdback" answers who holds the money, not "can I get it
back". Open: the refund window against the holdback (a refund after payout comes from us);
abuse — buy, download, refund — since revoking access cannot take back bytes already
fetched; whether a refund is only allowed before the first download.
