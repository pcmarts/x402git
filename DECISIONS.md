# DECISIONS

A dated log of implementation decisions that are *not* in [PRD Final.md](PRD%20Final.md).
The PRD stays the spec. Anything here is either additive machinery the PRD's prose
requires but its data model does not name, or a gap the PRD leaves to the implementer.
If an entry ever contradicts the PRD, the PRD changes first.

---

## 2026-08-29 — Ops tables alongside the five-table model

**Decision.** Four tables were added in `supabase/migrations/20260829000100_ops.sql`
(reconciled idempotently by `20260829000200_ops_fixup.sql`), separate from the PRD §12
five-table model:

| Table | Requirement it serves |
|---|---|
| `challenge` | FR-2, FR-4, FR-20 — single-use, 5-minute signed challenges for `address_proof`, `rotate-key`, step-up and `X-Wallet-Signature` |
| `idempotency` | FR-2 — `Idempotency-Key` replays the identical 201 from `POST /api/creators` for 24h |
| `webhook_delivery` | FR-8 — a redelivered GitHub `X-GitHub-Delivery` must not cut a second release |
| `rate_limit` | §9 — registration 5/hour/IP, `/api/r` 60/min/address, challenge 30/min/address, etc. |

**Why it is not a PRD change.** None of them holds product state. They are all
short-lived machinery whose behaviour the PRD already specifies in prose ("5-minute
expiry, single use", "replays the identical 201 for 24h", "deliveries older than 5
minutes rejected", the rate-limit table in §9). No entitlement, price or ledger fact
lives here; `lib/core/access.ts` never reads them. Nothing in §12 changes meaning.

**Rejected alternatives.** Redis for challenges and rate limits — explicitly out of
scope (§11, "Deliberately not in V0"). In-memory counters — a Vercel function is not
one process, so they would not limit anything.

**Consequences.** `rate_limit_hit(bucket, window_seconds)` is a SQL function so the
increment is one atomic statement; the alternative read-modify-write undercounts under
concurrency. RLS is enabled with no policies on all four (the service role bypasses
it), so a leaked publishable key reads nothing.

---

## 2026-08-29 — Four error codes added to the §9 catalogue

**Decision.** `lib/errors.ts` carries the §9 catalogue verbatim plus:
`invalid_request` (400), `invalid_signature` (401), `not_found` (404), `internal` (500),
and `blocked_jurisdiction` (451).

**Why.** FR-33 requires *every* error to be `{ code, message, docs_url, details? }` from
the catalogue. A malformed body, a bad signature, a missing listing and an unhandled
throw are all errors, and §9 names no code for them; without these, those four cases
would be the only responses on the platform that are not catalogue-shaped.
`blocked_jurisdiction` is FR-38's 451, which the §9 list also omits.

---

## 2026-08-29 — `storage_path` and micro-USDC on the wire

**Decision.** Micro-USDC crosses JSON as a **decimal string of an integer**
(`"9000000"`), never a number. `lib/schemas/common.ts` exposes `micro.parse` /
`micro.serialize`; `lib/db/types.ts` exposes `toMicro` / `fromMicro`.

**Why.** `bigint` has no JSON representation, and a JSON number is a double. $9 is
safe as a double today; a lifetime ledger total is not, and the day it stops being
safe there is no error, only a wrong number. One rule everywhere is cheaper than a
rule with exceptions.

---

## 2026-08-29 — Addresses are stored lowercase, returned checksummed

**Decision.** Every column holding an EVM address (`creator.payout_address`,
`creator.pending_payout_address`, `purchase.buyer_address`, `screening.address`,
`challenge.address`) stores the **lowercase** form. API responses render the **EIP-55
checksummed** form. `lib/auth/challenge.ts` exposes both: `dbAddress()` for writes and
lookups, `normaliseAddress()` for output.

**Why.** The migration's CHECK allows either case, so without a rule the same wallet
can be written two ways and `.eq()` silently misses — which on `/api/r` means a paying
holder is quoted the new-buyer price. One canonical form makes every lookup a plain
indexed equality. Lowercase rather than checksummed because it is what `toLowerCase()`
gives you without a library, so a query written in haste is still right.

---

## 2026-08-29 — Three columns for the abuse-contact 48-hour delay

**Decision.** `20260829000300_pending_abuse_contact.sql` adds
`pending_abuse_contact_url`, `pending_abuse_contact_email` and
`abuse_contact_effective_at` to `creator`.

**Why.** FR-5 requires abuse-contact changes to take effect after 48 hours and to be
announced to the *pre-change* contact. §12's creator table has the queue columns for
the identical payout-address rule (`pending_payout_address`, `rebind_effective_at`) but
not for the abuse contact, so the delay could not be represented at all — the change
would have had to apply immediately, which is the failure mode the rule exists to
prevent. Additive; nothing existing changes meaning.

---

## 2026-08-29 — `rate_limit_hit` is a SQL function, and rate limiting fails open

**Decision.** The fixed-window counter is a Postgres function called over `rpc`, and
`lib/auth/rate-limit.ts` allows the request when the counter is unavailable.

**Why.** A read-modify-write from the application undercounts under concurrency, which
is precisely the condition a rate limit exists for; one `INSERT … ON CONFLICT DO UPDATE`
statement cannot. Failing open is the deliberate half: a limiter that takes registration
and every purchase down when its own table is unreachable is a worse outage than the
abuse it prevents. The same reasoning covers FR-38 screening, which also fails open and
records `raw.error` so the gap is auditable afterwards.

---

## 2026-08-29 — `listing.hosted_org`, because D10 shards by cohort

**Decision.** `20260829000400_listing_hosted_org.sql` adds a nullable `hosted_org text`
to `listing`: null on Rail A, the platform-owned org a Rail B repo was provisioned into
on Rail B.

**Why.** D10 shards hosted repos across orgs "by cohort". §12's `listing` records
`github_repo_id` but not *where* that repo lives, so the day the second cohort org opens,
every remote returned for an older listing points at the wrong org — and FR-43's archive
and FR-44's delete address the wrong repository. Resolving the org and name from the id
(`GET /repositories/{id}`) would be a network call on `GET /api/listings/:id`, which
otherwise has none. One nullable column is cheaper and cannot drift.

**Consequences.** `remoteFor()` prefers `hosted_org` and falls back to
`currentHostedOrg()`, which is correct while exactly one org exists. FR-44 nulls the
column along with `github_repo_id` and `deploy_key_id`.

---

## 2026-08-29 — A `manual` licence verdict blocks publish

**Decision.** `POST /api/listings/:id/publish` requires `licence_verdict = 'pass'`.
`null`, `block` and `manual` all return `409 listing_not_ready` with
`blocking: ["licence_block"]`.

**Why.** FR-11 says `NOASSERTION → manual, never block`; FR-42 says `live` requires
`licence = pass`. Both hold if "never block" is read as a statement about the *gate* —
it does not emit `block` as a verdict — rather than about publish. There is no review
queue in V0, so `manual` means "nobody has looked at this yet", and selling code whose
licence nobody has established is the exposure D4 and D5 exist to bound. Rail B has a
way out in one call (`POST /api/listings/:id/licence`); Rail A's is to commit a LICENSE
and re-sync.

**Revisit when** a review queue ships: `manual` should then publish on approval, not on
the absence of review.

---

## 2026-08-29 — `no_release` is a fourth `blocking[]` value

**Decision.** `POST /api/listings/:id/publish` can return
`blocking: ["no_release", …]`. §7.2 enumerates three values —
`scan_pending | licence_block | description_missing`; this adds a fourth for the case
where nothing has been cut at all.

**Why.** FR-42 requires "≥1 passing release" and the three spec values cannot express
its first failure mode. `scan_pending` means "a release exists and its scan has not
passed"; reusing it for "there is no release" tells an agent to wait for a scan that
will never start, when what it must do is call `POST /api/listings/:id/sync`. Every
value in `blocking[]` names the route or field that clears it — that is the contract
that makes one 409 enough — and `no_release` is the only value that names `sync`.

**Consequences.** `PublishBlockingReason` in `lib/schemas/listings.ts` is a four-value
enum in the OpenAPI document, so a client that switches exhaustively on it sees the
fourth case. Callers matching on the three spec values still behave correctly: they
already have to treat an unrecognised blocker as "not ready".

---

## 2026-08-29 — Rail B's invite gate is checked at listing creation, via `onboarded_via`

**Decision.** `POST /api/listings { source: "hosted" }` returns `403 invite_required`
when `RAIL_B_INVITE_CODES` is configured and the creator's `onboarded_via` is not `api`.
With no codes configured there is no gate.

**Why.** D2c requires an invite code for Rail B in V0, but the code is presented at
registration (`POST /api/creators`), not at listing creation, and nothing on `creator`
records that an invite was used. `onboarded_via = 'api'` is the durable evidence that
the creator passed the gate, and it matches the rails as D10 draws them: Rail A is the
web and GitHub path, Rail B is the headless one.

**Rejected alternative.** An `invite_code` field on `CreateListingRequest` — it would
turn a credential that feels single-use into a repeatable one, and the code has already
been spent at registration.

---

## 2026-08-29 — Step-up fields are optional in the schema and required by the handler

**Decision.** `step_up` is `.optional()` on `SshKeyRequest` and `DeleteRepoRequest`; the
handlers call `requireStepUp`, which throws `403 step_up_required`. Ownership is checked
first, before the signature is consumed.

**Why.** A required field yields `400 invalid_request` with a zod issue list. A missing
step-up is not a malformed body — it is a request that needs one more round trip, and
`requireStepUp`'s 403 carries `sign_with` and the two calls that produce a signature.
FR-5 is a workflow; the error that describes the workflow is the useful one. Checking
ownership first means a wrong listing id does not burn a single-use nonce.

---

## 2026-08-29 — `GET /api/listings` reads without `listings:write`

**Decision.** Mutating listing routes require the `listings:write` scope. `GET
/api/listings` and `GET /api/listings/:id` require only a valid key.

**Why.** FR-4 defines two scopes, `listings:write` and `earnings:read`, and §9 names no
read scope for listings. Requiring a *write* scope in order to read is the asymmetry
that gets worked around by granting write everywhere, which is the opposite of what
scoping is for. Both routes return only the caller's own rows, so the widest thing an
`earnings:read` key can see here is data it can already see on `/api/earnings`.

---

## 2026-08-29 — `GET /api/listings` exists, and is in the OpenAPI document

**Decision.** §9 lists no route for "my listings"; one is added, cursor-paginated,
newest first, with the same `Listing` body as `GET /api/listings/:id`.

**Why.** D9 says the web app consumes the same endpoints as an agent, and the creator
dashboard's first screen is a list of the creator's listings. Without this route the
dashboard would either read the database directly — the divergence D9 exists to prevent
— or the API would be missing the one call that makes `GET /api/listings/:id` reachable
for a caller who has lost the id.

## 2026-08-29 — The 402 body carries both spellings of the amount

**Decision.** Each entry of `accepts[]` carries `amount` **and** `maxAmountRequired` with
the identical value, the body carries a top-level `resource` object as well as the
`resource`/`description` strings on the accept, and `lib/schemas/payment.ts` documents
all of it. `lib/core/access.ts#toPaymentRequirements` returns two views of one quote:
`body` (what goes on the wire) and `accepts` (the canonical requirement the facilitator
is called with).

**Why.** PRD §13 names `maxAmountRequired`, `resource` and `description` on the accept.
That is the x402 **v1** field list. `@x402/core` 2.24 validates v2 with
`{ scheme, network, amount, asset, payTo, maxTimeoutSeconds, extra }` on the accept plus
a required top-level `resource: ResourceInfo`, and its zod schema **strips** every field
it does not name — so a v2 client re-signs a stripped copy of whatever we sent. Sending
only the PRD's spelling produces a 402 no v2 client can pay; sending only the library's
produces a 402 that contradicts our own OpenAPI document, which FR-33 makes the
contract. A superset costs about sixty bytes and satisfies both, and because the client
strips the aliases before it signs, the requirement it echoes back in `accepted` still
deep-equals the canonical one the server verifies against.

**Consequences.** `network` is CAIP-2 on the wire (`eip155:84532`), because v2 rejects
anything else; `X402_NETWORK` may still be written `base-sepolia` and
`lib/env.ts#caip2Network` translates. `lib/core/access.test.ts` parses the generated body
against `PaymentRequiredBody`, so the code and the published schema cannot drift apart
silently.

**What would change the PRD.** If §13's field list is meant as normative rather than
illustrative, it should be restated in the v2 names with the v1 names marked as aliases.

---

## 2026-08-29 — `quote_id` is a digest, not a signature

**Decision.** FR-23's `quote_id` is `q_` + a truncated sha256 over
`{listing_id, release_id, price, listing.price_micro, listing.update_price_micro, retired_at, reason}`.
`/api/r` accepts it back in an optional `X-Quote-Id` header and, *independently*, checks
the authorized amount against the current price.

**Why.** A forged quote id buys nothing: the server recomputes the price from the same
rows before it accepts any money, so it is a staleness detector, not a capability. An
HMAC would put a key in the web deployment for no gain. The amount check is the belt: an
agent that pays without echoing the quote id still cannot pay yesterday's price, because
a PATCH changes what `authorization.value` has to equal, and the mismatch is
`409 price_changed` with a fresh 402 attached.

---

## 2026-08-29 — Payout code lives in `lib/payouts/`, and gas is recorded as 0 in V0

**Decision.** `lib/payouts/ledger.ts` (FR-29 reads, the sweep `SELECT`) and
`lib/payouts/sweep.ts` (FR-26 / FR-28 writes) sit outside `lib/core/access.ts`.
`payout.gas_micro` is written `0`.

**Why the split does not break the §11 rule.** "One module knows about entitlements or
money" is about *pricing and entitlement*, and neither file decides either: they sum
`purchase` rows that `grant` wrote and move the total to `creator.payout_address`.
Nothing in `lib/payouts` reads a price, and nothing there can create an entitlement.

**Why gas is 0.** Gas on Base is paid in ETH by the sweep wallet. Reporting it in
micro-USDC needs a price oracle and V0 has none (§11, "deliberately not in V0"). The
column and the FR-26 field exist and report 0 rather than a guessed conversion.

**Related.** When `SWEEP_WALLET_PRIVATE_KEY` is absent — the correct state for the web
deployment (§14.8) — the sweep still writes its `pending` payout row, records an `event`
`sweep_skipped` with `reason: "no_signer"`, and returns `skipped: "no_sweep_signer"`. It
never invents a key and never marks anything paid. `payout` has no notes column, so the
reason lives on the event log.

---

## 2026-08-29 — Purchases are stamped `payout_id` only after the receipt confirms

**Decision.** The sweep writes the `payout` row `pending` before broadcasting (FR-28),
then `broadcast`, then `confirmed` — and only then sets `payout_id` on the purchases.

**Why.** Stamping earlier would make a crashed sweep look paid. Stamping later means a
crash between broadcast and receipt leaves a `pending`/`broadcast` row and unstamped
purchases; FR-28's "a non-confirmed row blocks further sweeps for that creator" then
holds the creator until a human reconciles, which is the failure we want. The idempotency
key is a digest of the exact purchase-id set, so the same sweep retried collides on the
unique index and a genuinely different set does not.

---

## 2026-08-29 — Cron routes, and what FR-28's "variance halts sweeps and pages" means in V0

**Decision.** `GET /api/cron/sweep` and `GET /api/cron/reconcile` run daily from
`vercel.json` and require `Authorization: Bearer $CRON_SECRET` whenever `CRON_SECRET` is
set (`lib/auth/cron.ts`, constant-time). `CRON_SECRET` is declared optional in
`lib/env.ts` so a local `next dev` can run them by hand.

**Reconcile in V0** compares `USDC.balanceOf(PLATFORM_RECEIVING_ADDRESS)` against
`Σ purchase.gross_micro (not revoked) − Σ payout.amount_micro (confirmed)` and records an
`event` named `reconcile` with the variance — every day, whatever the variance is,
because the value of the number is the time series. It does **not** halt sweeps and does
not page: V0 has no paging system, and a halt nobody is watching is worse than an honest
gap in the log. An RPC failure records `error` and a null variance rather than reporting
the whole balance as missing.

---

## 2026-08-29 — A draft listing is `not_found` to a non-holder

**Decision.** `quote` returns `not_found` for a listing with `published_at IS NULL`
unless the caller already holds a purchase for it.

**Why.** §12's listing state machine is `draft → live → retired` and only `live` is
sellable, but §9 names no error for "exists but is not published yet". `not_found` is the
honest answer to the public — a draft is not a public resource, and a distinct code would
confirm to anyone guessing that the slug is taken. Holders are unaffected: the
explicit-version branch (FR-19) resolves before this check, so a release that was ever
sold stays fetchable.
## 2026-08-29 — `release.blob_shas`, the originality corpus

**Decision.** `20260829000500_release_blob_shas.sql` adds `release.blob_shas text[]` (GIN
indexed) plus `release (listing_id, created_at desc)`. FR-50's blob-overlap check reads the
newest passing release of every other live listing and intersects.

**Why it is not a PRD change.** FR-50 requires overlap "against previously-seen snapshots".
There is no public GitHub API for "which repos contain this blob" (QS §5.3), so the corpus is
ours to keep, and §12's `release` row is the only place a snapshot's identity already lives.
It holds no entitlement, price or ledger fact; `lib/core/access.ts` never reads it.

**Rejected alternatives.** Storing the array inside `manifest.computed` — the manifest is
served to buyers and a 20,000-element SHA array is not a buyer-facing field. A separate
`release_blob` row-per-blob table with an index on `blob_sha` — the right shape at scale, and
the migration to it is mechanical, but in V0 it turns one query into a 20,000-element `IN`
list that will not fit in a PostgREST URL.

**Consequences.** Two exclusions are applied before the array is written: the empty blob
`e69de29b…`, and anything under 64 bytes. QS §5.3 names the first trap explicitly; without
both, copy detection fires on every `__init__.py` and `.gitkeep` in existence. `≥0.90`
overlap **with a single live listing** sets `manifest.computed.originality.derivative_of`;
overlap spread across several listings does not, because vendoring a common dependency is
not the same act as republishing someone's artifact.

---

## 2026-08-29 — The scan fails on secrets and on HIGH/CRITICAL CVEs, and nothing else

**Decision.** `lib/scan` returns `fail` when (a) any secret rule matches, (b) any dependency
vulnerability is rated HIGH or CRITICAL, or (c) a §6 size cap is exceeded. MODERATE, LOW and
UNKNOWN severities are recorded on `scan_report` and do not block. A network failure at
OSV records `scan_report.osv_error` and does **not** fail the release.

**Why.** FR-35 mandates the checks but names no threshold. A MODERATE-fails rule fails most
real repositories on transitive dependencies the creator cannot reach, and a gate that always
fires is a gate people learn to ignore — the same reasoning as §14.7's "the key will leak".
Secrets are absolute because §15 week 4's definition of done is "a hardcoded key never becomes
sellable", and unlike a CVE a secret is entirely within the creator's control.

**Consequences.** Severity comes from the advisory's own word (`database_specific.severity`)
first and a computed CVSS v3.1 base score second; `UNKNOWN` never blocks, which is a
deliberate false-negative. `next_page_token` paging continues through empty result pages
(QS §11.3) — a client that stops on an empty set under-reports silently.

**Superseded 2026-09-13 by "The scan blocks on five things and publishes the rest"**
("PRD Trust Report.md"). The threshold this entry set is unchanged — secrets, HIGH/CRITICAL
CVEs and the size caps still block, MODERATE and below still do not. What changed is
"and nothing else": two absolutes are added, and the severities this entry only *recorded*
are now published.

---

## 2026-08-29 — `artifacts/<listing_id>/<version>/<sha256>.tar.gz`

**Decision.** A snapshot is stored at `<listing_id>/<version>/<sha256>.tar.gz` inside the
private `artifacts` bucket. This supersedes the `<creator_handle>/<slug>/<version>.tar.gz`
shape named in `lib/storage.ts`'s docstring.

**Why.** A handle and a slug are mutable; a listing id is not, and FR-42 forbids slug reuse
but not a handle change. Putting the content hash in the path also makes the store
content-addressed: the object at a path is the object that was scanned, so re-running a cut
can never overwrite bytes a buyer already holds an entitlement to.

**Consequences.** On a failing scan the report is written first and the bytes are then
deleted, and `storage_path` is set to `NULL` with them (FR-35) — nothing can sign a URL for
an artifact that no longer exists, and `artifact_sha256` is retained so the report stays
bound to what was scanned.

---

## 2026-08-29 — The artifact is a pure function of the tree

**Decision.** `lib/tar.ts` is a hand-written ustar reader/writer rather than `tar-stream`,
and it writes fixed mtime, uid, gid, mode and owner in sorted path order. Only the executable
bit survives from the source. `gzipSync` at level 9 completes it.

**Why.** §6 makes `artifact_sha256` the hash of the *re-packed* bytes, and D3/§14.5 make that
hash the thing a scan verdict and an entitlement are bound to. If two cuts of the same tree
produced different bytes, "the artifact served is the artifact scanned" would be a claim we
could not verify. Fixing the metadata makes it checkable by anyone with the repo.

**Consequences.** No new runtime dependency. The gzip OS byte is platform-dependent (3 on
Unix), so a hash is reproducible on the same OS family — Vercel and local development are
both Linux/Unix. The §6 caps are enforced *during* decompression, chunk by chunk, because a
200 MB check performed once the buffer exists is not a zip-bomb defence.

---

## 2026-08-29 — The README renderer escapes first and constructs second

**Decision.** `lib/analysis/markdown.ts` is a small Markdown renderer with no dependency on
`marked` or a sanitiser. Every character of the source is HTML-escaped before a single tag is
emitted; the only tags in the output are ones the renderer wrote. `href`/`src` are
allow-listed to `http:`, `https:` and `mailto:`.

**Why.** The README is creator-controlled text rendered server-side into a frame the creator
cannot replace (§14.1, FR-52). Render-then-sanitise makes the security property depend on a
denylist keeping pace with parser quirks; escape-then-construct has no raw-HTML passthrough
to close, because raw HTML is never parsed as HTML.

**Consequences.** Tables, footnotes and inline HTML degrade to text. That is the right trade
for a manifest page; if a creator needs them, the artifact is where they belong.

---

## 2026-08-29 — Revoking a leaked API key rewrites the hash rather than nulling it

**Decision.** `revokeApiKeyByHash` writes `revoked:<reason>:<timestamp>:<hash>` into
`creator.api_key_hash`.

**Why.** FR-4 and §14.7 require a key found in a repository to be auto-revoked, but the column
is `NOT NULL UNIQUE`. `hashApiKey` returns 64 hex characters and can never produce a string
containing a colon, so a revoked row can never be matched by a future bearer token, uniqueness
is preserved, and the audit trail survives. The creator recovers with
`POST /api/auth/rotate-key`, which is wallet-signed and already exists.

---

## 2026-08-29 — Additive manifest fields, and why they are published

**Decision.** `ManifestComputed` gains five optional fields — `engineering`, `cadence`,
`inventory_sentence`, `extensions`, `warnings` — and `Originality` gains `derivative_of`.
All are optional, so every existing consumer keeps parsing.

**Why.** `engineering` carries `unique_5gram_ratio` and `type_token_ratio`, which are the
evidence behind the class badge; QS §3.2 shows a volume-only score rating a 30-second slop
generator level with Anthropic's most substantial skill, so a badge whose guard is invisible
is a badge a buyer has to take on faith. `warnings` names what could not be computed
(`sbom_unavailable`, `tree_truncated`) rather than omitting it silently — FR-52's disclosure
rule read the way it is meant to be read.

---

## 2026-08-29 — Webhook: the pending row comes first, and everything after a valid signature is a 2xx

**Decision.** `cutRelease` resolves the commit, then inserts the `pending` release row, then
runs analysis → snapshot → scan. `POST /api/webhooks/github` returns 401 only for a bad
signature; every other outcome — unknown listing, stale delivery, duplicate delivery,
`version_exists`, an unhandled throw — is a 200 or 202. A delivery whose payload carries no
usable timestamp is accepted rather than refused.

**Why.** §12's release state machine says an analysis error leaves the release `pending` with
`scan_report.error`, which is only representable if the row exists before analysis runs;
`commit_sha` is `NOT NULL`, hence the one extra commit lookup (passed on to `analyze` so it
is not repeated). GitHub disables a webhook that keeps failing, and the creator finds out days
later that nothing has shipped — so a 5xx is the one response this route must never give.
Refusing undateable deliveries would drop `installation_repositories` entirely; the
`X-GitHub-Delivery` UNIQUE already makes a replay a no-op, which is what the freshness rule
is protecting against.

**Consequences.** No queue in V0 (§11): the cut runs inline under Vercel's 300s ceiling.
GitHub's own redelivery and `POST /api/listings/:id/sync` are the recovery paths (FR-8.2).
Only `installation.deleted` retires a listing; `suspend` does not, because a suspension is
reversible on GitHub's side and retirement is terminal (FR-42) — a suspended installation
simply stops cutting releases, because the token mint fails.
## 2026-08-29 — The web session carries the creator's API key, and `SESSION_SECRET`

**Decision.** `lib/web/session.ts` seals a cookie as `x4s.<payload>.<mac>`: the payload is
AES-256-GCM ciphertext (IV prepended, tag appended) and the mac is HMAC-SHA256 over it,
under two keys derived with distinct labels from a new **optional** env var
`SESSION_SECRET`. Absent, it falls back to `sha256("x402git:session-secret:" +
SUPABASE_SECRET_KEY)` so `next dev` works with no extra setup. The cookie holds the
GitHub identity, the GitHub user OAuth token, the creator id, and **the creator's API
key in plaintext inside the ciphertext**.

**Why.** D9 makes the website a client of the API, so the dashboard needs a bearer
credential. Only the sha256 of an API key is stored (`lib/auth/api-key.ts`), so the
plaintext has nowhere to live server-side. Encrypting it and signing the result is the
cheapest place that is not a new table of live credentials. The HMAC is verified first,
in constant time, so a forged cookie never reaches the decryptor. §14.7 still holds: the
key cannot move money (FR-26) and cannot destroy anything without a wallet signature
(FR-5).

**Consequences.** `SESSION_SECRET` must be set explicitly in production — otherwise
rotating the Supabase key signs every creator out. A returning creator whose cookie has
expired has **no** recoverable key, and the dashboard does not paper over that by
silently rotating on sign-in, which would revoke the key their agents are holding.
`/dashboard/key` offers a deliberate re-issue and states that it revokes the previous
key; until then the dashboard renders read-only. A per-session credential separate from
the single `creator.api_key_hash` column would fix this properly and is a V1 change to
the data model, not a V0 one.

**Superseded 2026-08-31 by D14** ("PRD Session Keys.md"). The per-session credential
this entry called a V1 change is now the `api_key` table: signing in mints a short-lived
`session` key (`x4s_live_…`) into this same cookie, so the cookie no longer carries the
agent key, the dashboard is never read-only, and `/dashboard/key` is about agent keys
only. The cookie's crypto — AES-256-GCM inside an HMAC, secret from `SESSION_SECRET`,
MAC checked first — is unchanged; what changed is which credential it carries and that
signing out can now revoke it (FR-57).

---

## 2026-08-29 — Web onboarding writes the creator row directly, not through `POST /api/creators`

**Decision.** `lib/web/onboard.ts` inserts the creator for the FR-1 GitHub path, using
the same primitives the API route uses (`consumeChallenge`, `screen`, `generateApiKey`,
`termsVersion`). Every other dashboard mutation goes over HTTP to the creator API.

**Why.** `POST /api/creators` is FR-2 — *headless* registration — and hard-codes three
things this path must not do: `onboarded_via: "api"`, no `github_user_id`, and D2c's
invite gate, which exists to slow anonymous API registration and has nothing to say to
someone who just proved a GitHub account. §9 lists no route for the web half of FR-1.
The alternative was widening the API route with a mode flag that only the website could
set, which is a worse contract than an honest second caller of the same primitives.

**Consequences.** Two insert sites for `creator`. They share every check that matters
(address proof, sanctions screening, terms version) and differ only in the three columns
that have to differ. The creator row is not written until a wallet is bound, because
`payout_address` is `NOT NULL` and FR-26 pays only to it — between GitHub sign-in and
wallet binding the identity exists solely in the session cookie.

---

## 2026-08-29 — Dashboard forms are HTML posts to route handlers; page reads go straight to the DB

**Decision.** Mutations are `<form method="post">` to route handlers under
`app/dashboard/**/…/route.ts` that call `/api/listings/…`, `/api/creators/me` and so on
with the session's bearer key. Server Actions are not used. Page *reads* bypass HTTP and
go through `lib/web/loaders.ts` against the row types.

**Why (forms).** Next 16 Server Actions do progressively enhance, but they post an opaque
action id to the current URL, which makes "what does this button call" unanswerable from
the HTML and untestable with `curl`. A named route handler is legible to the same reader
the whole product is built for. PRODUCT.md's rule — if a screen does something, an
endpoint does it — reads better when the endpoint is the one in the `action` attribute.

**Why (reads).** The one page whose entire point is being complete and fast in the HTML
(§14.1) should not pay a second cold start, TLS handshake and JSON round trip to fetch
from itself. The loaders return the shapes the zod schemas define, so the two paths
cannot drift about what a listing is. D9 is about capability parity, not about the
website taking the slowest possible route to its own database.

**Consequences.** Outcomes come back as `?ok=` / `?error=` / `?blocking=` on a 303, which
survives a reload, needs no flash storage, and is visible to `curl`. Retire uses a
confirmation *page* (`/dashboard/:id/retire`) rather than a JS dialog, because
`confirm()` does not exist with scripting off and the action is terminal.

---

## 2026-08-29 — Three web-only scope calls: custodial wallets, the pay button, and reserved handles

**Decision, custody (D12).** The one-click custodial wallet is not built. `/dashboard/wallet`
says so in a sentence and every web creator is `wallet_mode: "linked"`. **Why:** shipping
half of it means holding money with the withdrawal path unfinished, and PRD §18 still
lists the counsel outcome on custody as open.

**Decision, the buy button.** The order line on `/:owner/:slug` ships the JavaScript-off
path only: the endpoint, a `curl` snippet, and the 402 flow in words. The "Pay with
wallet" button is present and disabled with an explanation beside it. **Why:** signing an
x402 payment in the browser needs EIP-3009 typed-data signing against `/api/r`, which is
another slice's route and is not built yet; a button that looks live and is not is worse
than one that says what it is. FR-21's rail works today from `curl`, and that is the rail
the buyers who exist use.

**Decision, reserved handles.** `docs`, `dashboard`, `signin`, `api`, `_next` and
`public` cannot be creator handles. **Why:** Next resolves a static segment before a
dynamic one, so a creator holding the handle `docs` would have an unreachable listing
page rather than a broken site. FR-3 already reserves `api v r label` as *slugs*; this is
the same rule one segment to the left. `handleCandidates()` filters them out of the
GitHub path, so a user called `docs` is offered `docs-gh`. **Still open:** `POST
/api/creators` validates `Handle` only, so the headless rail can still take one. The
check belongs in `lib/schemas/common.ts` next to `RESERVED_SLUGS`, and that file is
shared, so it is left for the slice that owns it.

## 2026-08-29 — FR-28 "SELECT … FOR UPDATE" replaced by a partial unique index

PRD FR-28 asks for balance checks inside one DB transaction with `SELECT … FOR UPDATE` and one serialised signer per hot wallet. supabase-js is REST (PostgREST) and cannot hold a row lock across the SELECT → insert → broadcast sequence. Migration `20260829000600_payout_in_flight.sql` adds `payout_one_in_flight_per_creator` — a unique index on `payout(creator_id) WHERE status IN ('pending','broadcast')` — so at most one payout per creator can be open; a concurrent sweep gets `23505` and returns `payout_in_flight` instead of broadcasting. The idempotency key (unique) still guards the identical-set replay. Semantics of FR-28 are unchanged; only the mechanism differs. Revisit when a transactional path (an RPC / edge function) exists.

## 2026-08-29 — FR-18 window opens on an update charge, not the initial purchase

FR-18 ("at most one update charge per 7 days; releases inside the window are free") and §12's access check (`granted_at > now() - 7 days` on any purchase) together made FR-34 — the definition of done, which expects "wallet B sees an update 402 at the stamped price" right after a second tag — unobservable: any purchase opened a free window, so the first update after a purchase was always free. Measured live (BLOCKERS B2). Resolution: the window is scoped to `kind = 'update'` purchases — the initial purchase does not open it; the first update after a purchase is charged at the stamped price (FR-16), and further releases within 7 days of that charge are free. This reading keeps FR-18's purpose (an update farm cannot bill twice in a week) and makes FR-34 runnable. PRD FR-18 and §12 were edited to say so. **Paul to confirm** — it is money semantics: a buyer who bought yesterday pays the update price for today's release, where the previous reading gave it free.

---

## 2026-08-30 — Three real listings under a real creator, not seeded example data

**Decision.** The home page's examples are three live listings on production under the
creator handle `examples`: `humanizer`,
`changelog-writer` and `repo-digest`, each backed by a private repo on `pcmarts` through
the GitHub App, each cut from a real `v1.0.0` tag, priced at $9.00, published. Full
detail in EXAMPLES.md (internal, not published).

**Why not seeded rows.** A demo listing with a hand-written manifest would be the one
page on the site whose computed section is a lie, on the page whose whole argument is
that the computed section cannot be faked by the creator (FR-52, and the "self_reported"
badge that exists to draw the line). Anything in the database that did not come through
`POST /api/listings` → tag → scan → publish would also stop being true the moment the
analyzer version moves. Going through the front door costs one registration and three
tag pushes and cannot drift.

**Why $9.00 and not the $0.10 the harness uses.** Price is part of what a visitor is
being shown. A $0.10 listing reads as a test fixture; $9.00 is what someone would charge
for a small tool, and it makes the fee split and the holdback legible on
`/dashboard/earnings` later. `humanizer` carries `update_price_micro: 0` on purpose, so
one of the three renders D1's lifetime line ("$9 · updates included") and the other two
render an update price.

**Consequences.** The payout address bound to `examples` is a throwaway key generated in
process and stored outside the repo at
`<local key file>` (mode 600), together with
the API key — which `POST /api/creators` returns exactly once, so that file is the only
copy. **Paul rebinds the payout address before anyone buys.** Nothing is at risk in the
meantime: money lands at the platform address (D13) and a sweep pays only the bound
address (FR-26), so a rebind ahead of the first sweep loses nothing.

The three GitHub repositories must not be deleted: the manifest's tree, languages and
README are computed from the repo on each release.

**Observed while doing it.** `repo-digest`'s release was cut by the push webhook (FR-8).
The other two fell back to `POST /api/listings/:id/sync` (FR-8.2) — `changelog-writer`
simply late, and `humanizer` because its tag had been pushed *before* the listing existed
and a delete-then-re-push of the same tag did not produce a release within 90 s. Whether
a recreated tag emits the `push` event the handler matches on is worth checking next time
the webhook path is opened. Separately: the listing page renders the creator description
as plain text, correctly, but the word "docs" pluralises as "docses" in the computed
artifact-class line.

---

## 2026-08-30 — Private repositories only, on both rails

**Decision.** A public repository cannot be listed. `POST /api/listings` with
`source: "github"` resolves the repository through the installation's token and refuses
it with `422 public_repo` unless `private === true`; `publishBlockers` re-checks and
adds `public_repo` to `blocking[]` if the repo has been made public since; the picker on
`/dashboard/new` lists private repositories only. Rail B is unaffected — the repos it
provisions are private by construction. PRD FR-10 was amended to say so (it previously
read "Public repos are supported on Rail A only").

**Why.** Founder decision, and the product argument is the same one the paywall rests
on: what is being sold is access to something that is otherwise unobtainable. A public
repo can be `git clone`d for nothing, so a listing over one is either a donation button
wearing a price or an invitation to a support ticket from the first buyer who finds the
same tree on github.com. Neither is a thing to ship in V0. It also removes the whole
licence question for the awkward middle case — a public repo under a resale-compatible
licence that the seller does not own.

**Why the check is server-side and repeated.** The picker filter is a convenience, not
the rule: `POST /api/listings` is a public creator endpoint and an agent reaches it with
whatever `github_repo_id` it likes, so the visibility is read from GitHub at creation
regardless of what the caller sent. Creation alone is not enough either — visibility is
a property of the repository, not of the listing, and a creator can flip it a minute
later. Publish is the second gate because publish is the moment a listing becomes
buyable. The check is *not* on `sync` or in the webhook: a release cut from a repo that
went public is still a snapshot of a draft nobody can buy, and failing the webhook would
lose the release rather than surface the problem.

**Fail-open at publish.** If GitHub cannot be reached when `publishBlockers` runs, the
blocker is not added. A listing whose repository is genuinely private must not become
unpublishable because the App's token expired or api.github.com is having an hour; the
creation-time check already caught the ordinary case, and a listing that publishes while
GitHub is down is recoverable in a way that a permanent phantom blocker is not.

**Consequences.** `public_repo` is a new §9 catalogue code (422) and a fifth
`PublishBlockingReason`. `repoById` was added to `lib/github/installations.ts` because
`POST /api/listings` accepts `github_repo_id` directly and the id alone says nothing
about visibility — resolving `repo: "owner/name"` already returned it. Reversing this
decision is one predicate in `lib/listings/service.ts` and one filter in
`lib/web/dashboard.ts`; nothing about it is written into the schema.

---

## 2026-08-30 — The agent-first surfaces are hidden, not removed

**Decision.** Every agent-facing affordance in the website's chrome and copy is gone from
the pages a person lands on, and nothing behind any of it changed. Specifically:

| Was | Is |
|---|---|
| Listing page's `Overview / For agents` link strip | No strip. `?view=agent` still serves the full manifest, unlinked, and carries a link back to the product page |
| Home page's **For agents** section (the MCP install line) | Moved verbatim to `/docs#mcp` |
| `OpenAPI` and `Errors` in the header and footer nav | Gone from both. `/docs` links them in its first paragraph and is now a single footer link |
| `Docs` in the header | Footer only. The header slot became **Your purchases** |
| `/how-it-works` — two claims, five headless calls, two `curl` sessions | Three sections of prose: Sell, Buy, Fees. No code block on the page |
| Listing page's `Copy x402 link` (the resource endpoint) | Gone from the listing page. On the home page's example cards it is **Copy link** and copies `https://x402git.com/<owner>/<slug>` |
| Footer line "Every page here works with JavaScript disabled, because agents read the HTML" | "Pay in USDC on Base; the manifest is public and the contents are private" |

**Why.** Founder direction, verbatim in spirit: *"Flag the whole agent-first approach for
now and focus purely on humans — keep it all built, just hide it on the website."* The
agent rail is the product's second claim and it is finished and tested; it was also
occupying the header, the footer, a third of the home page and half of `/how-it-works` on
behalf of a reader who does not arrive through any of those surfaces. An agent's operator
arrives at `/docs` or at `openapi.json`; a person arrives at a listing.

**Why hidden and not deleted.** Every route, every MCP tool and `?view=agent` itself is
untouched and still tested. The change is entirely in what the website *links to*. That
is reversible in one commit, and it costs nothing to be wrong about — whereas deleting
the agent view would break the promise `/docs` makes and the second half of PRODUCT.md's
positioning.

**What guards it.** `app/[owner]/[slug]/page.test.ts` asserts both directions: the
product page contains no `view=agent` string and no `For agents`, and `?view=agent` still
renders the tree, the stamps, the dependency table, the artifact hash and the `curl`
session. `app/_components/chrome.test.ts` pins the nav.

---

## 2026-08-30 — The product page: GitHub's document, Gumroad's order block

**Decision.** `/[owner]/[slug]` was rebuilt from a single scrolling manifest into a
two-column product page. Above `60rem`: a `1fr` body and a `22rem` sticky right column.
Document order — and therefore phone order, and `curl` order — is:

1. **Header.** `owner / slug` as a GitHub reference (owner small and linked, repository at
   Display size), the creator's one-line description, the trigger hint, the
   `self_reported` provenance line, the FR-53 contradiction as one sentence if it fires,
   and a meta row: `v1.0.0 · updated <date> · MIT · Scanned ✓ <date> · Toolkit`.
2. **Buy box.** Price, updates line, one control, a `role="status"` wallet line, "What you
   get" (a `.tar.gz` at the version, the LICENSE, re-download from Your purchases), the
   scan sentence. Under it, unboxed, a `<dl>`: size, files, languages, licence, last
   release, creator.
3. **Body.** README under a `README` heading, the latest release as one line with the
   older ones behind `<details>`, and `What's inside` — a summary carrying files, size and
   dependency count, then the language bar, the top-level folders with counts, and
   `Full file list` / `Dependencies` one disclosure deeper.

**Why the price moved to the top.** The Last Line Rule put the total at the bottom because
that is where a total goes on a *listing*. The founder's direction is that this is a
*product page* — "GitHub meets Gumroad meets x402" — and on a product page a buyer who has
to scroll two thousand words of README to find out what something costs has been failed in
the other direction. "Never bill blind" is now met by document order rather than by
position: the version, the date, the licence, the scan verdict and the artifact class are
all above the box, on every viewport.

**Why the file tree went behind a disclosure.** It is the product's differentiator and it
was also the reason the page read as "one long piece". A person deciding whether to spend
$9 wants the *shape* of the repository — how many files, in what languages, in what
folders, pulling in how many dependencies — and three thousand rows answers none of that
while burying the README. So the shape is computed (`topFolders`, `languageShares`) and
printed, and the rows are one click away. Nothing was dropped: the tree, the dependency
table, the analyzer stamp and the computed-at time are all still in the HTML, and
`?view=agent` still prints every one of them in the flow.

**Why the language bar is grey.** GitHub's bar is the reference; its colour key is not
portable to a system with one accent that belongs to the paid action. The segments are the
existing ink ramp, ordered largest first, and the legend names every one with its
percentage — so the bar is `aria-hidden` decoration over an accessible reading, and no
twelfth colour entered the system.

**Consequences.** `lib/web/manifest-view.ts` grew five pure functions —
`scannedLine`, `licenceShort`, `totalBytes`, `topFolders`, `languageShares` — all unit
tested, all short forms of facts the manifest already carried. DESIGN.md's "there is no
sidebar and no rail", The Last Line Rule and the Buy disclosure were all amended in place
rather than quietly broken.

---

## 2026-08-30 — Buy with your own wallet, in the browser

**Decision.** The listing page can take money. `app/_components/buy-with-wallet.tsx` is the
first `"use client"` component in the product; all of the logic is in
`lib/web/wallet-checkout.ts`, which imports nothing from React, `next/*` or the server.

The sequence is the one `scripts/e2e-buyer.mjs` already proved headlessly, and it is the
library's own — nothing reimplements x402:

```
detectProvider(window)            → window.ethereum, preferring Coinbase, then MetaMask, then Rabby
eth_requestAccounts               → the address
ensureChain(provider, 84532)      → wallet_switchEthereumChain; on 4902, add then switch
GET  /api/v  + X-Wallet-Signature → what this wallet already owns, and its price
GET  /api/r                       → 402
getPaymentRequiredResponse(header, body)
createPaymentPayload(required)    → the wallet signs EIP-3009, via viem over EIP-1193
GET  /api/r + PAYMENT-SIGNATURE + x-quote-id → 200 { version, artifact_sha256, download_url }
getPaymentSettleResponse(header)  → the transaction hash
```

**Decisions inside that.**

- **viem + EIP-1193, no wagmi and no RainbowKit.** viem is already a dependency (the
  server signs and verifies with it); wagmi and RainbowKit are a React state layer and a
  modal for a page that needs one button. No dependency was added at all — `@x402/core`,
  `@x402/evm` and `viem` were all already in `package.json`.
- **`ExactEvmScheme` is handed a three-line adapter, not a wallet abstraction.** It needs
  an `address` and a `signTypedData`; viem's `WalletClient` over
  `custom(window.ethereum)` provides the EIP-712 encoding, which is the part that must
  not be hand-rolled.
- **The x402 client is imported inside the click handler.** `@x402/core` + `@x402/evm` +
  viem is the largest thing on the site; a reader who never presses buy never downloads
  any of it, and the server render never touches it.
- **Every dependency is injected.** `provider`, `fetch` and `baseUrl` are arguments. That
  is what makes `lib/web/wallet-checkout.test.ts` possible (a scripted EIP-1193 provider
  backed by `privateKeyToAccount`, so the payment payload under test is a real one) and
  what makes `scripts/e2e-web-checkout.mjs` possible without a browser.
- **A failure is a value, not an exception.** Fourteen `CheckoutErrorCode`s, each with a
  sentence that names the problem and the recovery, mapped from the §9 catalogue plus the
  four failures that only exist in a browser: no wallet, user rejection, wrong chain,
  network. `settlement_pending` and `settlement_timeout` say "you cannot be charged twice
  — press it again", because that is true and it is the only thing a person can do.
- **The wallet is proved only when it might already own something.** Each
  `X-Wallet-Signature` costs a `personal_sign` prompt and burns a nonce. A wallet that
  owns nothing gets the same 402 anonymously, so the header — and the prompt — is sent
  only when the ownership check found a version, or when the listing is free (a $0 grant
  is still a purchase row and a purchase row belongs to an address).
- **No download URL is ever stored.** A signed URL lasts five minutes by design;
  `/purchases` re-proves the wallet and asks for a fresh one every time, rather than
  keeping a working download link in `localStorage` where anything can read it.

**Verified.** `scripts/e2e-web-checkout.mjs` drives `lib/web/wallet-checkout.ts` — the
same module the component imports, loaded by Node's own type stripping — against
`examples/repo-digest` ($9) on Base Sepolia and settles for real:
`0x4ba95eb6ec417c5ed9d7db55cd16f2cd88df6ded9cfea4970ba90f93c4c36d4b`. See E2E-REPORT.md.

**Not done.** WalletConnect. A phone with no injected provider is told to open the page in
its wallet's own browser, which works today and costs nothing; WalletConnect is a relay, a
project id and a QR modal, and it is the right thing to add when a real mobile buyer asks
for it.

---

## 2026-08-30 — The no-JavaScript rule now applies to `/docs/**` only

**Decision.** "Every page works with JavaScript disabled" is no longer a constraint on the
product page, the home page, `/purchases` or the buy flow. It holds for `/docs/**`. What
survives everywhere is the narrower and more useful half: **the content must be in the
server HTML** (`npm run check:ssr`, §14.1), and **a control that cannot work does not
render** — the buy button's pre-hydration frame is a sentence saying how to pay without
one, never a dead button.

**Why.** Founder direction, given mid-build: the constraint was shaping the design of
pages whose readers all have JavaScript, and the thing it was really protecting — that an
agent can `curl` a manifest and get the manifest — is protected by the SSR check, not by
the absence of client components.

**What actually changed as a result.** Less than the licence allows. The buy button and
`/purchases` are client components because they hold a wallet; the language bar, the
disclosures and the sticky sidebar are all still server-rendered CSS and native HTML,
because that was the better build regardless. No tabs were added: the founder's complaint
was "so much data being presented as one long piece", and a sidebar plus three disclosures
answers that without hiding a document behind a widget.

---

## 2026-08-30 — `alive.current` must be *set* on mount, not only cleared

**Decision.** Any `useRef` used as an "is this component still mounted" guard sets itself
`true` at the top of the mount effect, not just `false` in the teardown:

```ts
useEffect(() => {
  alive.current = true;
  return () => { alive.current = false; };
}, []);
```

**Why.** `reactStrictMode: true` in `next.config.ts` makes React mount, unmount and mount
again in development. A ref that is only ever cleared in the teardown is `false` for the
rest of the component's life, so every `setState` behind an `await` is dropped. In
`buy-with-wallet.tsx` that was one dead button: the connect handler caught the wallet's
rejection, computed the right message, and then threw it away — the box sat on "Opening
your wallet…" forever with nothing in the console.

**How it was caught, and what that says about the test strategy.** Not by
`lib/web/wallet-checkout.test.ts` (the logic was correct), and not by
`scripts/e2e-web-checkout.mjs` (there is no React in it). It took headless Chrome with an
injected `window.ethereum` that refuses — see E2E-REPORT.md, "And once more, in a real
browser". A client component that holds money needs a check that runs React.

---

## 2026-08-30 — The product page: the box above the fold, the README previewed, the creator named

**The direction.** Founder, mid-build: *"The product pages need work. The buy box should
be way further up. The README should just be an expandable, not the whole page like it
currently is. Pull in more stats around the author/creator — official website and any
metadata we can get from the GitHub repo/profile."* Then, an hour later, a correction:
the README should **not** be fully hidden — show the first part rendered, clipped with a
soft fade, over a control that opens the rest.

### 1. The box starts at the top of the right column

**Decision.** On `/[owner]/[slug]` the buy box is grid row 1, level with the `h1`, and
spans both rows; the header occupies column 1 only. On a phone the header carries the
title, the one-line blurb and the meta row and nothing else — the trigger hint and the
provenance sentence moved down into About — and the page's top gutter, the header's
closing gap and the box's padding each drop one step on the spacing scale below `44rem`.

**Why.** The box used to sit under a full-width header, which put the price a header's
height down the page for no reason but markup order. Measured on a 390×844 screen at
2× (headless Chrome, `/examples/humanizer`): the price now lands at ~330px and the
`Connect wallet` button at ~473px, both comfortably inside the first viewport. Desktop
at 1280×900 shows the price, the updates line, the button, "What you get", the
specification list and the top of the Creator block without scrolling.

**What did not move.** Document order is still head → box → body. The version, the date,
the licence, the scan verdict and the artifact class are still *before* the price in the
document on every viewport. Never bill blind survives the change intact; what was cut
was padding, not a buyer's check.

### 2. The README is previewed, not hidden

**Decision.** A section with a heading, rendered, clipped at `min(26rem, 55vh)`, its
bottom edge fading into the paper, over a `Show more` button
(`app/_components/readme-more.tsx`). Not a closed `<details>`.

**Why the first attempt was wrong.** A closed disclosure with a 160-character teaser
fixed the price and broke the README. The opening paragraphs of a README are the best
writing on the page — the creator wrote them for a reader, not for a buyer — and putting
them behind a click sells a sealed box, which is the exact thing this product exists to
refuse. The founder caught it in one line.

**How it is built, and why it is safe.** Progressive enhancement, the same mechanism the
copy control has always used. The whole README is in the server HTML, unclipped and
unhidden; `npm run check:ssr` proves it and an agent's `curl` gets the complete document.
The clip and the button are gated on `<html data-js="on">`, which an inline script sets,
so with scripting off the README is simply long. The same script measures the block and
removes both the clip and the button when the README already fits — a "Show more" on a
six-line README is a lie about how much is left.

**The one gradient in the system.** The fade is `mask-image: linear-gradient(to bottom,
currentColor …, transparent)`. Only the alpha channel is used and the colour is never
painted, so no value enters the ink set. DESIGN.md's Flat Sheet Rule is amended to name
it as the single exception rather than pretending it is not one.

### 3. The repository and the person, from GitHub

**Decision.** Two new blocks — **About** in the body and **Creator** under the buy box —
fed by `lib/github/profile.ts` (the pure requests and narrowing) through
`lib/web/github-profile.ts` (cache, fallback, and a promise never to throw).

- `GET /repositories/{id}` → description, homepage, topics, language, default branch,
  size, created/pushed dates, licence, stars/forks/watchers/open issues, archived,
  private, html_url. By id, never by name, for the same reason FR-8 resolves listings by
  id: a repository can be renamed or transferred and a name is not a key.
- `GET /users/{login}` → name, avatar, bio, blog, company, location, twitter, followers,
  public repos, created_at. Public, but read through the App's installation client
  anyway: 60 requests an hour per IP is not a budget a serverless function shares safely,
  and 5,000 is.
- Rail A reads through the listing's own installation; Rail B through the hosted org's,
  which D10 says is discovered rather than configured. A Rail B listing shows no GitHub
  person at all — the repository's owner is the platform, not the creator — and falls
  back to the handle.

**Three rules, all load-bearing.**

1. **It never breaks the page.** Every exported path returns `null` on any failure. The
   page renders nothing where a profile would have been. Context that can 500 a product
   page is not worth having, and `lib/web/github-profile.test.ts` tests the sparse
   profile and the thrown request before it tests the happy path.
2. **It is not a computed field.** Nothing here feeds the artifact class, the scan, the
   licence gate or the price. It is set in the text face beside computed values set in
   mono, per The Computed / Written Rule.
3. **A zero is not a fact.** A private repository has zero stars because nobody can see
   it, not because nobody liked it. Counts that are zero come back `null` and render
   nothing rather than as a score of 0. The `html_url` is dropped for a private repo and
   the line says `private repository` instead, because a link that 404s for everyone but
   the owner is worse than a sentence.

**Caching: `unstable_cache`, one hour, keyed by repo id and by login.** Next 16 prefers
the `use cache` directive, but that requires the `cacheComponents` flag, which changes
the rendering model of every route in the app — and this page is `force-dynamic` because
it reads a session. Migrating the whole app's rendering model to decorate a sidebar is
the wrong trade. One hour is right for a field a creator edits on GitHub and expects to
see here the same morning, and it keeps a listing page an agent fetches a hundred times a
day down to one GitHub call an hour. Revisit when the app adopts Cache Components.

**Persisted as well as read.** `analyze()` now narrows the repository payload it already
fetches (call 1, free) and makes one extra best-effort call for the owner's profile, and
`composeComputed()` writes both into `Manifest.computed.repo_meta` and
`Manifest.computed.owner` — additive, optional fields on the zod schema, so every stored
manifest still validates. The page reads live first and falls back to that copy object by
object, never field by field: half a live profile mixed with half a stale one is a claim
nobody made. §6's budget goes from about seven REST calls to about eight.

**Why the module is split across `lib/github/` and `lib/web/`.** The analyser must not
import `next/cache`, and the page must not re-implement the narrowing. The pure half
lives in `lib/github/profile.ts` and is shared; `lib/web/github-profile.ts` re-exports it
and adds the caching, the fallback and the try/catch.

### 4. Two smaller cuts made in passing

- **The specification `<dl>` under the box lost Licence and Last release.** Both are in
  the header meta row, sixty pixels away on a desktop and above the price on a phone. A
  fact printed twice in one viewport reads as two facts.
- **The `self_reported` badge now sits beside each claim it qualifies** — the blurb in
  the header and the trigger hint in About — and the provenance sentence names the badge
  once instead of being a third badge that qualifies nothing.

### What could not be done

**"Nothing scrolls for more than ~2 viewports with everything collapsed" holds on
desktop and does not hold on a phone.** Measured at `/examples/humanizer`: 1,576px at
1280×900 (1.75 viewports), 2,723px at 390×844 (3.2 viewports). The phone number is what
the founder's own correction bought — a rendered README preview is a screenful by
definition, and on a phone the sidebar (box, specification, creator) stacks above the
body instead of sitting beside it. Getting to two viewports on a phone would mean cutting
the README preview back to a teaser, which is the change that was just reversed, or
dropping the Creator block, which is the change that was just requested. The trade is
recorded rather than split.

---

## 2026-08-30 — Installs, the author page, README images, and the Gumroad shape

Four founder directions arrived in one session and they turned out to be one change: the
product page stopped being a manifest with a price on it and became a page somebody
decides on. Everything below is additive; nothing computed moved, and nothing that was
public became private or the other way round.

### 1. Install counts are exact, from the first purchase (FR-40 amended)

**The PRD changed first.** FR-40 said adoption metrics were V1, published only at ≥20
distinct buyers, and bucketed. It now says: *install counts are shown exactly from the
first purchase (founder decision 30 Aug); never buyer addresses.*

An **install** is a non-revoked `purchase` row of kind `new` or `free`, counted as
distinct buyer addresses per listing. Three rules, and each is the requirement rather
than taste:

- **`new` and `free` only.** An update is the same wallet buying again. Counting it would
  make a listing with three loyal buyers and nine releases read as twelve installs, which
  is the exact inflation an honest number exists to refuse.
- **Revoked purchases do not count.** FR-39's takedown is the only thing that revokes.
- **Zero is hidden, never printed.** `0 installs` on a listing published this morning
  tells every reader the same discouraging thing, and printing a nought as a statistic is
  already a defect in this system. The buy box says `Be the first to buy it` instead.

`installCounts(listingIds)` in `lib/web/loaders.ts` is **one query for any number of
listings**, and its return type is `Map<listing_id, number>` — the addresses are read
(counting distinct ones is what an install *is*) and they leave the function as a number,
so no caller can print one even by mistake. Tested against the mock database, including
the case that asserts no address appears in the serialised result.

**The bucketing was rejected**, not deferred. A bucket ("10+ buyers") is a number with
its precision removed to protect a buyer, and it does not protect anybody: the count is
of wallets, and a bucket of wallets is no more private than a count of them. What
protects a buyer is that the address is never disclosed, which FR-20 and FR-29 already
require and which nothing here changes.

**One tension, recorded rather than resolved.** The founder asked for the count in *both*
the header meta row and the buy box, and on a desktop both are on screen at once — which
"Don't print the same fact twice in one viewport" would normally forbid. It is kept
because it was asked for by name and because the reference does the same thing (a rating
in the header and beside the button); the two readings are different registers, `1 install`
and `1 person owns this`. If it reads as an echo, the meta row is the one to cut.

### 2. The author page, `/[owner]`

A creator had exactly one kind of URL to hand somebody. Now there is a shelf: every live
listing of one creator, as the same cards the home page uses, over the same loader type.

**It is not a profile**, and DESIGN.md's "Don't build … a profile" is amended to say so
rather than being quietly broken: no follow, no bio written here, no score, no aggregate
rating, no filter, no sort, no "see all". It is a list of things for sale by one person,
plus the GitHub context the product page already shows.

- **Live only, with no exception for the owner.** A page that showed a creator their own
  drafts would be a second dashboard wearing a public page's clothes — the surface where
  somebody screenshots their drafts believing they are published.
- **Reserved handles are refused twice.** `RESERVED_HANDLES` gained `purchases`,
  `how-it-works` and the file-convention names, because until today no route took a
  handle in its first segment and a collision was not possible. `loadAuthorPage` refuses
  them again, so a route added tomorrow cannot be shadowed by a row written yesterday.
- **An empty shelf is a page, not a 404** — a creator may already have sent the link — and
  it is `noindex` while it is empty.

### 3. README images, tables and task lists (FR-49 amended)

`lib/analysis/markdown.ts` was escape-first and constructed-second, which is the right
security model and was also the reason a README's table came out as rows of raw pipes and
a relative image came out as its own markup. **The creator's best work — the screenshot —
was the one part of their README this page refused to show.**

The model did not change. What changed is that `renderMarkdown` now takes two resolvers,
`imageSrc` and `linkHref`, which may only *choose a URL* and never emit markup, and that
it renders tables and task lists.

**The asset pipeline**, end to end:

1. `analyze()` renders the README with a collector as its `imageSrc`. One pass rewrites
   the `src` attributes to `/api/label/:owner/:slug/asset/<path>` **and** records which
   files it referenced — two passes would be two chances for the markup and the list to
   disagree.
2. `snapshot()` gained `retainPaths` and keeps those bodies out of the tarball stream. The
   tarball is streamed once and discarded, so a file not named there cannot be recovered
   without fetching the whole archive again.
3. `cutRelease` copies them into a **second, public** bucket, `readme-assets`, at
   `<listing_id>/<release_id>/<path>` — keyed by release, so v1.0.1's `docs/shot.png` and
   v1.0.0's are two objects and an old release never shows a new release's screenshot.
   Every failure is a warning: a release that failed because a picture would not upload
   would be the wrong failure.
4. The map lands on `Manifest.computed.readme_assets` (additive, optional).
5. `GET /api/label/:owner/:slug/asset/*` resolves the path **as a key into that map** and
   302s to the public URL, cache 1 h. No path arithmetic happens in the route at all,
   which is why no traversal is possible in the route at all.

**Caps**, each a refusal rather than a knob: 20 files, 2 MB each, and a closed extension
list (`png jpg jpeg gif svg webp avif`). Absolute `https:` passes through; `http:` and
`data:` are dropped — the first is mixed content that would not render anyway, the second
is the one image source that carries a payload rather than pointing at one.

**SVG is proxied, not redirected.** The founder's instruction was "serve with CSP sandbox
headers", and a `302` cannot do that: headers on a redirect do not travel to the target.
So an `.svg` is read and served by the route itself with
`Content-Security-Policy: default-src 'none'; sandbox` and `X-Content-Type-Options:
nosniff`; bitmaps still redirect and cost no bandwidth. The underlying object is on the
Supabase host either way — a different origin from the app — so even the direct public
URL cannot reach this site's cookies or DOM. That cross-origin fact is the real
mitigation; the CSP is the belt.

`sanitiseHtml` now allows `img`, with a **narrower** source rule than it applies to
`href`: `https:` or a path under `/api/label/…/asset/`, and nothing else. An `<img>` whose
`src` does not survive is removed rather than left as a broken frame.

**A refused relative link renders as its label; a refused scheme renders as its markdown
source.** `[the guide](docs/guide.md)` against a private repository has no address anybody
can open, but the words are still the creator's sentence, and printing the brackets and
the path turns a sentence into a bug report. A `javascript:` href is somebody trying
something, and the raw text is the disclosure.

**A real bug the tests caught.** The first cut of `readme-assets.ts` had a control-
character guard written as `/[\\u0000-\\u001f\\u007f]/` — a doubled backslash, so the
character class matched a literal `\`, a `u`, digits and a `-` range. It rejected
`docs/my-first-shot.png` and `a.gif`. Path arithmetic over somebody else's repository is
exactly the code that has to be tested rather than read.

### 4. The Gumroad shape

The founder pinned `creatorvc.gumroad.com/l/ISOD9099?layout=profile` as the reference for
structure, not styling. Its shell is client-rendered, so `curl` returns only the title; it
was read by driving headless Chrome over CDP and dumping the laid-out DOM. The structure:
a pinned bar with the price and the action; the creator with a facts row in the header; a
full-width cover; then two columns — title, price, a short "this contains" section, the
long description on the left, and the action plus a facts block on the right.

Mirrored, in our tokens:

- **The cover.** The README's opening image, promoted above the headline and removed from
  the README body so it is on the page once. Only an image the creator put *first* is
  taken — the match is anchored to an optional heading then a paragraph containing nothing
  but an image — because a screenshot four paragraphs down belongs in the sentence it
  illustrates. Never cropped: a crop this page invented would be this page editing
  somebody's README. No image, no placeholder. Capped at `22rem`, and at `9rem` on a
  phone, where every pixel it takes is a pixel between the reader and the price.
- **The creator at the top**, replacing the sidebar block rather than joining it. Two
  creator blocks on one screen is one avatar in two places.
- **The pinned price bar**, on a phone, once the box is off screen. It is an **anchor to
  `#buy`**, not a second buy button: the real control holds wallet and chain state and a
  `role="status"` region, and a second instance would be two components disagreeing about
  which wallet is connected. Because it only exists while the box is gone, the accent
  ground is still on screen exactly once — The One Order Line Rule now holds per viewport,
  not only per page.
- **`This repo contains`** — `4 folders · 9 files · 255 lines of code`, three numbers and
  nothing else, opening "What's inside" the way the reference opens its own. `lines_of_code`
  is a new optional field on `Manifest.computed`, taken from the classifier's `code_lines`
  (significant lines, blanks and comment-only lines removed) so the headline and the
  artifact class cannot tell two stories. Old manifests print two numbers instead of three.
  **Exact, never `20k`:** every other number on the page is checkable against the manifest
  endpoint, and a headline that rounds while the table under it does not is the one place a
  reader would notice.
- **"What's inside" is open by default** and leads with folder rows: a mark, the name, the
  count and byte total, and a line saying what is in it in the analyser's own nouns.

### 5. The icon set

Ten marks on a `0 0 16 16` grid, `stroke-width: 1.25`, square caps, mitred joins,
`currentColor`, no fills — the same hairline the rules on this site are drawn with, at the
same weight, which is the only reason they sit together. Keyed on the analyser's component
buckets so a new bucket cannot invent an eleventh by accident.

`bucketOf` gained an image-extension rule while this was being built: an `.svg` is *text*,
so it fell past every rule to `other`, and a screenshot in `docs/` printed as "1 other
file" on the one section whose job is saying what is inside a repository.

### What could not be done

- **Production must be re-synced.** The database is shared and production is running the
  previous deploy, so the `readme_assets` map and `lines_of_code` on
  `examples/humanizer` were written by a **local** `sync`, which won the race against the
  webhook. Any release cut by production before the next deploy will have neither. After
  deploying, `POST /api/listings/:id/sync` with a fresh tag for each example.
- **The `readme-assets` bucket is created on first use**, like `artifacts`, so there is no
  migration to apply and nothing to run before deploying — but the first release cut in
  production will pay one `createBucket` call.

---

## 2026-08-30 — The home page: one flow, and the claim before the proof

**Direction.** From the founder, on the home page as it stood: *"One flow, not two CTAs"*;
the **Connect my repo** button is to be the first element of the steps row, followed by
`→ Set price → Add wallet → Done`, with the hero button removed and the `h1` and a
one-line pitch above it. Then **How it works** (renamed from "What you get"), then
**Examples**. The bullets lead on the USP — set it up once, then charge for every update.
The example cards lose **Copy link**, keep one **View**, and gain the creator's avatar.

### 1. Step one is the button, not a word describing it

The page asked for the same click twice: a `button[data-variant="github"]` reading
*Connect my repo*, and then, four inches below it, a step named *Connect repo*. The first
cell of the `<ol>` now holds the form and the button, with the same Body Small sub-line
the other three carry. Two mechanics make it look deliberate rather than dropped in:

- `grid-template-rows: subgrid` on each `li` above `48rem`, so the button's 44px row is
  the first row of all four columns and the three names sit on its centre line while the
  four sub-lines sit on one line beneath. Without it the names hug the top of a 44px cell
  and the button reads as a foreign object in a list.
- the arrow, previously hung from the cell's top padding, is now centred on that same
  `--tap`-tall row, so it points at the button.

The One Order Line Rule is unchanged and is in fact better served: there is now exactly
one grounded control on the page instead of one grounded control and a label repeating it.

The second paragraph of the pitch went with the hero button. "Connect a repo, set a price,
get a paid link. Buyers pay in USDC, and you keep 90%" is the steps row and three of the
six bullets, said once more in prose above both.

### 2. How it works, then Examples

A reader who has just been shown where to click asks *what is the deal* before they ask to
see a stranger's listing, so the claim now comes before the proof. The section is six
lines, in the founder's order:

1. **Set it up once, then charge for every update** — the lead, and the only line carrying
   weight, because it is the business and everything under it is a term.
2. Buyers pay in USDC on Base.
3. 10% commission, nothing else.
4. Paid to your own wallet — you own it, so no withdrawal fees; the money sweeps 7 days
   after each sale.
5. Or sell lifetime access instead — $0 updates.
6. Buyers see what's inside before paying.

"10% commission" is a fee disclosure, which PRODUCT.md's voice note ("earnings are what
the creator keeps") would normally refuse. The founder asked for those words and they are
right here: this line is not a price preview beside a field, it is the whole commercial
offer stated once on the page where a creator decides whether to bother, and *nothing
else* is the part that does the work. The 90% framing survives where it belongs — on the
pricing screen, where a number is being set.

**Learn more →** lands on `/how-it-works`, whose Sell and Fees sections were amended the
same day to state the same five facts at length: what charging per update is, the wallet
being yours with nothing to withdraw and no fee for it, and the commission in the same
words. One product, one set of numbers, said twice at two lengths.

The arrow is `::after { content: " →" / "" }`, the same construction the steps row uses,
so no glyph enters the accessible name and no icon is invented for one link.

### 3. The cards: one control, and a face

**Copy link is gone and `app/_components/copy-link.tsx` was deleted**, along with its CSS
and the `.copy` fallback rules — it had no other caller. Two rectangles of equal weight on
a card's floor made the reader choose between them before they knew what was behind
either, and copying a link you have not opened is a creator's action on a row of cards
written for a buyer. `View` now carries `target="_blank" rel="noopener"` and says so in
its accessible name: the home page is where the decision is being made, and sending the
reader away from it to look at an example loses the decision.

In the freed slot, a byline: the creator's GitHub avatar at 24px in the same hairline the
product page's avatar wears, plus the handle in the mono face, as one link to the author
page. `FeaturedListing` became `ListingCard & { avatarUrl: string | null }` and
`lib/web/featured.ts` resolves it through the existing cached, never-throwing
`repoProfile` → `ownerProfile` pair (one hour, two calls per listing at worst, in
parallel). Three rules held while adding it:

- **`null` is a first-class answer.** A Rail B listing is skipped without a call — its
  GitHub owner is the platform's own org — and a revoked installation or a rate limit is a
  `null`. The card then has no byline. A grey circle is a placeholder for a fact.
- **The author page passes no avatar**, because the creator block is already at the top of
  that page and the same face sixty pixels lower is one fact printed twice.
- **The home page still cannot 500 over a picture**: `featuredListings()` is already
  wrapped in `safeFeatured()`, and `avatarFor` cannot throw on its own account.

`Real listings. This is the page a buyer reads before paying you.` was removed as
directed. The cards are three real listings; a sentence explaining that they are real is
the tell of a page that is not sure.

### What was checked, not assumed

- `formatPrice(100_000n)` → `$0.10`. `changelog-writer` at $5 with $0.10 updates renders
  `$5 · updates $0.10` in the server HTML; the sub-cent branch was not reached and the
  two-decimal branch is exercised by `lib/web/money.test.ts`.
- `npm run typecheck`, `npm test` (866), `npm run build`, `npm run detect` and
  `npm run check:ssr` are green, and the home page's new copy — the lead bullet, the
  commission line, the byline and the avatar `<img>` — is in the server HTML.

---

## 2026-08-30 — Zip, not tar.gz

**Decision.** The artifact is a `.zip`, not a `.tar.gz`. PRD §6 was amended. Everything
else about the artifact holds: root directory `<slug>-<version>/`, `.git` excluded,
LICENSE carried through, `artifact_sha256` over the archive bytes, snapshot-before-you-sell.
Alongside the format change, the archive size is now shown wherever the artifact is
offered — the "What you get" bullet and the post-purchase download button both carry
`size_bytes` through `formatBytes`.

**Why.** Every desktop OS opens a zip natively — double-click on Windows, macOS and
every Linux desktop. A `.tar.gz` is a two-step extraction on Windows and a terminal
command for many buyers. The buyer who just paid should not need a second tool to open
what they bought.

**How determinism survived.** `lib/zip.ts` replaces the tar *writer* in the snapshot
path with the same discipline `lib/tar.ts` had: fixed timestamps (the DOS epoch),
fixed modes with only the executable bit preserved, entries in sorted path order, one
fixed deflate level, stored-not-deflated chosen by the bytes alone. The same tree
still always produces the same `artifact_sha256`. Tar remains the *input* format —
GitHub's `/tarball/{ref}` is what the pipeline ingests — so `lib/tar.ts` keeps its
reader, and its writer now serves only the test fixtures. Zip64 is deliberately not
implemented: the §6 caps keep archives far below classic-zip limits, and exceeding a
field throws rather than truncating.

**Consequences.** Storage paths are `<listing_id>/<version>/<sha256>.zip`; the
mime type on the 402 body and the stored object is `application/zip`; the e2e checks
assert the `PK` magic instead of the gzip magic. Releases snapshotted before this date
are `.tar.gz` objects with tar-based hashes; a re-sync re-snapshots them under the new
format, and until then their stored `storage_path` and `artifact_sha256` still describe
exactly the bytes a buyer receives — the invariant is the hash-matches-the-bytes, not
the extension.

---

## 2026-08-30 — The repository speaks for itself

Four product-page changes on the founder's direction, in one sitting.

**The About block is gone.** It interleaved GitHub metadata (topics, homepage, star
counts) with the creator's typed-in prose — the trigger hint — and the direction is
that the page must not create data that does not exist on the repository itself. The
README is the creator's whole pitch, rendered exactly as committed; making it look
good is the seller's job and the seller's leverage. FR-51 is intact: description and
trigger hint are still required inputs, the tagline still carries its `self_reported`
badge in the header, the badge's explaining sentence moved to the body's small print,
and agents still receive the trigger hint via `?view=agent` and the API.

**"What's inside" moved above the README.** The computed contents — files, bytes,
languages, folders, dependencies — are the buyer's fastest check that the thing is
real, so they lead the body. Order: What's inside → README → Releases.

**The buy box itemises its two costs like an invoice.** A `.cost-lines` list —
"Download v1.2.0" against the price at display size, "Future updates" against "Free"
or "$5 each" — replaces the lone price over an updates sentence. Labels in the text
face, amounts in mono on a shared baseline, no number printed twice, one muted
sentence under the lines ("Every later release is yours." / "You're only charged when
you choose to update."). The phone buy bar says "free updates" instead of "updates
included" for the same language.

**The LICENSE bullet left "What you get".** The licence is already in the header meta
row and the file still ships inside the archive (FR-36); a third mention in the same
viewport was a fact printed twice.

---

## 2026-08-30 — Buy with your agent: the endpoint, handable

**Decision.** Under the wallet button, the buy box now offers the listing's x402
endpoint (`/api/r/<owner>/<slug>`) as a copyable row — "Buy with your agent", one
muted sentence saying what the URL does, the URL on sunken paper, and a compact copy
button (`app/_components/copy-endpoint.tsx`, the page's second client component).
A person pastes it to their agent; the agent GETs it, receives the 402 with the price
and the exact bytes to sign, pays, and downloads.

**How it holds the page's rules.** The URL is server HTML — `curl` and scripting-off
readers get the whole fact as selectable text — and only the copy button waits for
hydration, the same no-dead-controls honesty the buy button follows. The block is
gated on `status === "live"`: a retired listing sells nothing, so it hands nothing to
an agent. A `copy` mark (two offset sheets) joined the icon set on the shared grid.

---

## 2026-08-30 — The product page, made a storefront

A second sitting of founder-directed simplification, after "The repository speaks for
itself". Four changes, one direction: the left column is the pitch, the right column
is the deal.

**The h1 is the repository's name alone.** The `owner / slug` breadcrumb read as
plumbing; the creator line directly under the title carries the person. The agent view
and the `<title>` still write the full `owner/slug` reference.

**The creator strip went compact on the product page.** A "CREATOR" kicker, the
avatar and the name, linking to the author page — which already rendered the full
strip and now renders it exclusively: bio, site, socials, public repos, followers,
star total, on-GitHub-since. One page is about the thing, the other about the person,
and each fact is on exactly one of them.

**The header meta row is gone; the buyer's checks live in the buy column.** Version
sits on the Download cost line, installs on the owners line; licence, class and
updated joined the specification list under the box; the scan verdict and its date
folded into the trust sentence ("Scanned ✓ <date> — for secrets and known
vulnerabilities, before listing."). "Never bill blind" now reads: the checks share a
column with the price rather than repeating above it.

**"What's inside" is previewed like the README.** The heading and the counts line
stay above a clipped body (16rem, fading into the paper) with one "Show more"
control. The clip mechanism is the README's own — `readme-more.tsx` now exports the
delegated script as `<ClipScript />`, emitted once per page after the last clipped
section, because a second emission would register a second click listener and every
press would toggle twice.

---

## 2026-08-30 — The MCP 402 speaks the transport spec

**Decision.** The buy-side `purchase` tool (FR-31) now implements the x402 MCP
transport (coinbase/x402, `specs/transports-v2/mcp.md`) instead of a house dialect:

- An unpaid call returns `isError: true` with the `PaymentRequired` body as
  `structuredContent`, the same JSON in `content[0].text`, and a mirror under
  `_meta["x402/error"]` — the field the Cloudflare Agents SDK's `withX402Client`
  detects.
- Payment is accepted as `_meta["x402/payment"]` — either the spec's `PaymentPayload`
  object or the base64 token the Cloudflare client sends — alongside the existing
  `payment_signature` argument, which wins when both are present.
- A settled grant carries `_meta["x402/payment-response"]` (`success`, `transaction`,
  `network`, `payer`), the MCP twin of the `PAYMENT-RESPONSE` header.
- `tools/list` marks `purchase` with `_meta["agents-x402/paymentRequired"]: true`, the
  pre-advertising extension that SDK's clients read. No static `priceUSD` alongside
  it: the price is per listing and per wallet, and `check_version` is the quote.

**Why.** The old shape (`isError: false`, the 402 under a `payment_required` key) was
built on the argument that a 402 is a price, not a failure — an error result pushes an
agent to give up rather than sign. The argument lost to interop: the clients agents
actually run — `withX402Client` in the Cloudflare Agents SDK, and anything written to
the coinbase spec — detect a paid tool by `isError: true` plus attached payment
requirements, and neither would ever have signed against our result. A dialect no
client speaks is not a product opinion. The "price, not failure" reading survives in
the tool description, which is the surface an agent's model actually reads.

**Two collateral fixes, same family.**

- `purchase` no longer declares an `outputSchema`. Its results are a genuine union —
  grant / `PaymentRequired` / §9 error body — and the MCP TypeScript client compiles
  `outputSchema` into an ajv validator (`additionalProperties: false`) that it applies
  to *any* result carrying `structuredContent`, error or not. A client that called
  `tools/list` before `tools/call` (they all do) would have thrown on every 402.
- For the same reason, error results across all four tools now carry the §9 body only
  as JSON in `content[0].text`; `structuredContent` is reserved for results that match
  a declared schema, plus the 402, whose schema is the transport spec's. Error-path
  `_meta["x402/error"]` is deliberately *not* attached to `payment_error` codes: on
  `settlement_pending`/`settlement_timeout` the money may already have moved, and a
  spec client seeing fresh requirements would auto-pay a second authorization.

**Not taken.** The client-side spend cap (`maxPaymentValue`) and payment-confirmation
callback are buyer-SDK concerns, out of scope for the server (founder direction,
30 Aug).

---

## 2026-09-01 — The repo picker shows everything it can see

**Decision.** `/dashboard/new` lists every repository the creator has granted, public
ones included. A public row carries no **Create listing** button — the action cell reads
`public` — and the FR-10 rule is otherwise unchanged: `POST /api/listings` still refuses
a public repo with `422 public_repo`, `publishBlockers` still re-checks, Rail B is still
private by construction. Three things went with it: the caption that counted what was
shown and what was hidden ("31 private repositories available · 4 public ones are not
shown"), the `full_name` column (the row now shows the slug the listing will get, with
the owner on the cell's `title`), and the "Without GitHub" section pointing at the Rail B
`ssh_public_key` route. The table gained a **Last updated** column, and its two headers
are `?sort=updated` (the default) and `?sort=name` links.

**Why.** Founder direction, and the filter was answering the wrong question. A creator
scanning for a repo that is not in the list learns nothing from its absence: they cannot
tell "I never granted it" from "it is public". The caption was the patch for that — a
count of the invisible — and a count is a worse answer than the rows themselves. Showing
the row, greyed and inert, says which of the two it is and what to do about it, and it
does so at the moment of looking rather than after a create call fails.

**Why sort, and why in the URL.** The picker is a list of up to a hundred rows returned
in GitHub's order, which is nobody's mental model. "The thing I was working on
yesterday" is, so `pushed_at` descending is the default. The order is a query parameter
and the headers are plain links, not a script: the sorted page is a real URL, it
server-renders (§14.1), it survives a reload and it works before hydration. Sorting spans
installations deliberately — a creator thinks in repositories, not in which org owns one.

**Consequences.** `privateReposOnly` is gone, replaced by `isSellableRepo` (a predicate
the row uses to decide on the button) and `sortRepoRows` (total and stable in both
orders, tie-breaking on `full_name`, undated repos last). `GithubRepo` now carries
`pushed_at` and `updated_at`. The "Only private repositories can be listed." line under
the intro stays, and is now the sentence that explains the greyed rows rather than the
sentence that explains an absence. Rail B's hosted path is no longer advertised here; it
remains documented at `/docs` with the rest of the routes.

---

## 2026-09-01 — A failed scan says so, and says what to do about it

**Decision.** Three copy-and-contract fixes around a release that failed its scan. The
verdict stays terminal (§12) and nothing about FR-35 changes.

1. `publishBlockers` now pushes `scan_failed` when a release exists and one of them is
   `fail`, and `scan_pending` only while one is genuinely still running. `scan_failed`
   was already in `ListingNotReadyDetails` but not in `PublishBlockingReason`, the enum
   §9 publishes; both now carry it, and PRD §7.2's sketch of the 409 lists all six.
2. A bare `sync` on a repository whose every tag has already been cut answers
   `version_exists` with a sentence rather than a restatement: it names the newest tag,
   says whether that version failed or passed, and says to push a new one.
3. `BLOCKING_COPY.scan_failed` and `RECOVERY.scan_failed` name the three things the scan
   can be — a secret, a HIGH/CRITICAL dependency CVE, a size limit — and say all three
   are in the repository.

**Why.** Founder report: a creator added the missing description, synced, and read the
result as "the scan failed because of the description". The scan has never looked at the
description — `scanArtifact` takes snapshot bytes and nothing else, and the listing row
reaches the release pipeline at exactly one line, copying `description` into the
manifest's `self_reported` block long after the verdict. But nothing on the page said so,
and the two gates sit one row apart on the same checklist, so the inference was the only
one available: the report is unreadable (docs/BACKLOG.md), the recovery line said "read
the scan report" about a document with no URL, the API called a terminal failure
"pending", and Check for releases (then "Sync now") — the one button that looks like a retry — answered "version
1.0.0 already exists". Four surfaces, none of them saying the thing that was true.

**Why the verdict stays terminal.** Founder decision, 1 Sep. A scan verdict is a fact
about one commit's bytes; re-running the same scanner over the same bytes returns the
same answer, so a retry is only meaningful when an upstream advisory changes, and that is
not worth a release-log entry whose verdict can change after a buyer has read it (FR-15
rests on entries being undeletable, which is worth little if they are mutable). The
snapshot is also deleted on failure, so a retry would mean re-fetching from GitHub — a
different operation wearing the word "retry". Cutting a new version is the honest one.

**Consequences.** The publish 409 is now actionable headlessly: an agent that reads
`scan_pending` waits and an agent that reads `scan_failed` cuts a new version, which is
the first time those two have been distinguishable outside the browser. One test in
`app/api/listings/[id]/publish/route.test.ts` pinned the old `scan_pending` and was
amended — it was encoding the defect. Not fixed here: `/docs/errors#scan_pending` and
`#no_release` are dead anchors, because neither is an entry in the §9 error catalogue
while both are values in `blocking[]`.

---

## 2026-09-01 — The OSV query stops asking a question it cannot use the answer to

**Decision.** `dedupePackages` drops a versionless package entry when the same
`ecosystem|name` is pinned by another manifest in the same snapshot. A package named only
by a range, with no lockfile anywhere in the repo, still gets its versionless query.

**Why.** `pcmarts/acl-recovery-tracker` v1.0.2 failed FR-35 on eight blocking HIGH
advisories, one against `react` and seven against `vite`, on a repo running react 19.2.0
and vite 7.3.6. One of them was "Vite before v2.9.13". The repo has **zero** applicable
vulnerabilities: querying only the 545 lockfile-pinned packages returns nothing at all.

The cause is that `exactVersion` cannot pin a caret range, so `package.json`'s
`"vite": "^7.3.6"` produced `{ name: "vite", version: undefined }` while
`package-lock.json` produced `{ name: "vite", version: "7.3.6" }` — and the old dedupe
key, `ecosystem|name|version ?? ""`, treated those as two packages and queried both. A
versionless OSV query is not a narrower question. It is a different one, and OSV answers
it with every advisory ever filed against that package at any version. Twenty duplicates,
one per dependency in `package.json`, every one of them already pinned in the lockfile.

**Why this was the worst possible shape of wrong.** The finding was unfalsifiable. The
advisory does not name a version the creator can compare against what they have, and no
upgrade clears it — v1.0.2 was cut with the commit message "Fix HIGH dependency
advisories" and failed on the same eight it failed on before. Combined with the verdict
being terminal, every attempt burned a version number. And it fires on every lockfile'd
npm project in existence, which is most of Rail A.

**Consequences.** Nothing about the threshold changes: HIGH and CRITICAL still block,
MODERATE and below are still recorded. The scan simply stops asking about versions nobody
is running. Re-running the real scanner over that repo's v1.0.2 tree now returns `pass`
with 0 findings over 545 packages. Existing `fail` releases are not re-scanned — the
verdict is terminal (see "A failed scan says so") — so a listing that failed on this
defect needs a new tag. Worth noting for whoever picks up the backlog item: this whole
diagnosis needed a local checkout and a scanner re-run, because the report the platform
had already written was not readable from anywhere.

---

## 2026-09-02 — The licence gate is a signal, not a gate

**Decision.** No licence verdict blocks anything. `POST /api/listings/:id/publish` no
longer returns `blocking: ["licence_block"]` for any verdict, and
`latestPassingRelease()` no longer skips a release whose `licence_verdict` is `block`.
A listing with no LICENSE at all publishes and sells. This supersedes
"A `manual` licence verdict blocks publish" (2026-08-29) and amends FR-11, FR-42 and G5.

The gate is otherwise untouched: `licenceGate()` still runs on every release cut, still
writes `listing.licence_spdx` / `listing.licence_verdict`, still stamps
`release.licence_verdict`, and the verdict still appears on the manifest, in
`GET /api/listings/:id` and on the creator dashboard. **The scan gate is untouched and
still terminal** — a secret or a HIGH CVE still stops a sale.

**Why.** Founder's call for the first release. Two reasons hold it up:

1. **It never bought what it appeared to buy.** The gate reads GitHub's `spdx_id` and
   passes anything on the allow-list. Nothing in it establishes that the seller *owns*
   the code — fork a GPL project, commit an MIT LICENSE, and it passes clean. The
   exposure D4 and D5 exist to bound is ownership, and the licence gate does not touch
   it. What it did reliably stop was honest creators with unrecognised LICENSE files.
2. **`manual` was a silent rejection.** With no review queue in V0, `manual` meant
   "nobody will ever look". Every `NOASSERTION` repo — `torvalds/linux`, `ffmpeg/FFmpeg`,
   `nodejs/node`, and any repo with a lightly-edited LICENSE — was permanently
   unpublishable with no route out on Rail A.

**Both gates, or neither.** Dropping only the publish gate would have been worse than
leaving it: the listing would go live and then have nothing sellable, because the
per-release `block` filter in `lib/core/access.ts` would refuse the only release it had.
A live listing that cannot be bought, with no error naming the licence, is a harder
failure to diagnose than an honest 409.

**What replaces it.** Nothing enforcing. The dashboard's licence section stopped being a
blocker's fix and became advice — it says what shipping without a licence costs the
creator and their buyers, and how to add one, without claiming the listing is stuck. The
`licence_block` error code stays in the catalogue and in `PublishBlockingReason` for
compatibility; nothing emits it.

**Risk accepted.** Artifacts may now ship with no grant of rights to the buyer, and R-10
loses one of its named mitigations (it kept caps, the invite code, the scan gate and the
holdback). FR-36 — "every artifact carries the original LICENSE and attribution" — is now
best-effort rather than enforced, since there may be no LICENSE to carry.

**Revisit when** the first DMCA or ownership complaint lands, or before mainnet volume
grows past the holdback's ability to refund a takedown. The higher-value gate to build
first is not this one back: it is an SBOM licence check (an MIT repo vendoring GPL passes
today) and a real ownership attestation on the Rail B `licence` endpoint.

## 2026-09-02 — The 402 explains itself, and the agent link is a prompt

**What happened.** The first thing people did with the "Buy with your agent" link was
paste it into claude.ai or ChatGPT. The model's fetch tool surfaced a 402 status and no
body, and the model said, correctly, that it had hit a paywall it could not get past —
no `accepts`, no price, no idea where the procedure lived. The bare endpoint is the
right hand-off for exactly one reader: an x402 client with a key in its environment.

**Three tiers, not two.** A *signing agent* needs the URL and nothing else. A *shell
agent* (Claude Code, Codex, Cursor) can hold a key and sign, but only if it is told the
procedure — instructions are the product for it. A *sandboxed chat model* cannot sign
and never will: NG10 means this server never holds a key, so it cannot sign on the
model's behalf either, and giving the model the MCP server does not change that. The
most a chat model can do is read the listing, quote the price, and hand the person a
page to buy on or a skill to give a shell agent. That is a useful answer; the bare
endpoint produced none.

**Decisions.**

1. **The paste is a prompt, not a URL.** `app/_components/copy-endpoint.tsx` now hands
   over four lines from `lib/web/agent-prompt.ts`: the ask, the listing page (a 200,
   readable as markdown), the buy skill, and the endpoint last. Each tier finds what it
   needs; none finds a dead end. The block wears the dashboard's `.snippet` shape and
   wraps rather than scrolls, because a prompt is read before it is pasted.
2. **The 402 body carries `extra.instructions`, `listing_url`, `skill_url`, `mcp_url`.**
   One sentence saying this is a paywall and not a fault, where the procedure is, where
   a person can buy, and that the manifest is free. An x402 client never reads them; a
   `curl -i`, a shell agent, and any fetch tool that keeps non-2xx bodies now learn the
   whole flow from the first response. Additive: `lib/schemas/payment.ts` requires them,
   so the OpenAPI document and the wire agree.
3. **A fifth MCP tool, `how_to_buy`.** Free, no wallet, listed first, wraps nothing: the
   price, the same four URLs, and a `with_a_wallet` / `without_a_wallet` paragraph the
   model can answer with verbatim. The server's `instructions` tell a client that cannot
   sign to start there and not to report the paywall as broken. The server card, the
   docs page and the docs markdown list five tools and say the server is addable as a
   custom connector by URL, with no login.

**What was not done, and why.** No custody, no server-side signing, no "buy on behalf
of" — NG10 and D12 stand, and a chat-model checkout would be exactly that. No HTML
variant of the 402 on `Accept: text/html` yet; the JSON `instructions` line covers
`curl` and most fetch tools, and a browser paste lands on a JSON body that now names
the listing page in its first hundred characters. Revisit if analytics show
`/api/r/*` 402s from browser user-agents.

*Reviewed the same day.* Two defects and one drift source found and fixed. `how_to_buy`
referred people to retired listings and to live listings with no passing release, with
a price on the referral; it now carries `for_sale` and says "not for sale" in both
paragraphs when the page would show no buy control. The 402's prose said "on Base"
regardless of `accepts[0].network`, which on the FR-34 Sepolia environment would have
sent a reader to sign for the wrong EIP-712 domain; the chain name is now derived from
the network. And the five hand-off URLs plus the procedure sentence were spelled in four
places; they now come from `lib/buy-links.ts`, a leaf with no imports that lib/core,
lib/web, lib/mcp, lib/openapi and app/ all read, so the OpenAPI examples are generated
from the same functions as the wire. The markdown reading of a listing now prints the
same prompt the HTML page does. Left as is, with reasons: the `PAYMENT-REQUIRED` header
still carries the whole body including the prose (§13 says body and header are one
payload; a kilobyte is not worth breaking that), and `/api/r` does not yet answer
`Accept: text/markdown` — that is the mechanism the site already uses for agents, and
the right shape for the revisit above.

---

## 2026-09-06 — the first sweep ran short, and the payout escape hatch got built

**What happened.** The 03:00 UTC cron swept for the first time — FR-34's last clause,
open since the overnight build as BLOCKERS.md B4. It found **nine** creators with
released balances, not the four B4 had estimated, owing 1035000 micro-USDC in total. The
sweep wallet held 600000. It paid five (495000), reverted on the sixth for insufficient
USDC, and never broadcast for the last three.

The reverted row went to `failed`, which the sweep treats as retryable. The three that
never broadcast went to `pending`, which blocks every future sweep for that creator
(FR-28, `inFlightPayout`) and which `lib/payouts/sweep.ts` deliberately refuses to clear
itself: "pending/broadcast are indeterminate and only ops may clear them". B8 had
recorded that no tooling existed to make that determination. So four creators were
wedged, three of them permanently without a human.

**The fix, and why it is shaped this way.** `scripts/ops-clear-stuck-payout.mjs` is the
missing hatch. It does not trust the database: for each stuck row it scans the sweep
wallet's outbound ERC-20 `Transfer` logs and asks whether that exact amount ever reached
that exact address. Only a provably-unpaid row is cleared, and it is set to `failed`
rather than deleted, so the retry already in `openPayout` reopens it under a `:r2` key.
A row with a `tx_hash`, or one whose payment is found on chain, is reported and left
alone — that is a reconciliation question, not a retry. Dry run by default.

The funding target in `scripts/b4-fund-sweep-wallet.mjs` went from 600000 to 1000000
micro. The number was never the point: it was a *guess* about a set the ledger already
knew the size of, and it is now set clear of it rather than close to it.

**Outcome.** All nine creators are paid on chain — 1035000 micro confirmed, the sweep
wallet down by exactly that. Both wallet A addresses recorded in
docs/archive/E2E-REPORT.md were paid with the balance delta verified to the micro, which
is the assertion B4 existed to make. B4 is closed.

**What it cost to learn, and what it would have cost later.** Nothing: it was testnet
money and the failure mode was fail-safe in the direction that matters — no creator was
double-paid, and no row was cleared that could not be proved unpaid. The same sequence on
mainnet is a wallet running dry mid-payout, four creators silently unpaid, and three of
them stuck until someone notices. The reconciliation job (FR-28) would have flagged the
variance; nothing would have unwedged the rows.

**The other thing it found.** The `examples` creator has accrued $28.80 of released
earnings to the throwaway payout wallet from B7, which the sweep could not pay and which
now blocks that creator. Escalated in BLOCKERS.md B7 — the rebind has to land before the
row is cleared, or clearing it just pays the throwaway.

---

## 2026-09-06 — the kill switches, and what "pause payments" actually means

**Decision.** PRD §19's launch checklist requires five kill switches and none existed.
Four are now global states in an `ops_switch` table, flipped with
`scripts/ops-switch.mjs` and read through `lib/ops/switches.ts`; the fifth is per-listing
and is an action, `scripts/ops-takedown.mjs`. **Why this is not a PRD change:** §19 names
all five and this is their implementation. What follows is the part §19 does not say.

**"Pause payments" is ambiguous until you say what it exempts.** The switch sits in
`purchaseFlow` after the already-owned early return and skips `priceMicro === 0`:

- A wallet that **already owns** a version still fetches it. FR-19 promises re-fetch
  forever, and an incident is not a reason to break that. A pause stops money moving; it
  is not a revocation, and the one thing in this product that revokes a buyer is a
  takedown.
- A **$0 listing** still serves. No money moves, so a payments pause has nothing to say.
- What stops is issuing a 402 and accepting an authorization, **503 and never 402**,
  because a 402 is an instruction to sign against a quote and a paused endpoint cannot
  honour one. Answering 402 while paused would have agents signing payments into a wall.

The same reasoning shapes the others: an idempotent replay of a registration that already
succeeded still replays, and re-publishing an already-live listing is still a no-op 200.
A pause stops the transition, not the retry of something already done.

**It fails open, deliberately.** A switch that cannot be read is off. This table is a way
to stop commerce on purpose; it must never become the reason commerce stopped by
accident. A database that cannot answer this query cannot serve a purchase either —
`quote` reads the listing on the same connection — so failing open costs nothing real and
removes a class of self-inflicted outage. Cached ten seconds: far below the time it takes
a human to decide to flip one, far above the request rate where a per-request read would
matter.

**A caller is never told which switch or why.** `reason` is operator prose for whoever
reads the table at 3am. A pause usually means an incident, and an incident is not
something to narrate to strangers while it is running.

**The takedown refuses to revoke silently.** FR-39 says a takedown "may revoke purchases
and refund from the holdback". The revoke half is a column; the refund half is money
leaving an address, and V0 has no path that sends USDC to a buyer — payouts go only to a
creator's bound address and no `to` parameter exists anywhere (FR-26). So `revoke` prints
what is owed to whom and refuses without `--i-have-refunded`. Revoking without refunding
takes someone's money and their goods, and the tool should make that impossible by
accident and awkward on purpose.

---

## 2026-09-07 — `/admin`, and an allow-list of GitHub logins to reach it

**Decision.** A new server-rendered surface, `app/admin/page.tsx`, lists every creator's
listings newest-first with a tally, a filter strip and a per-listing flag column. It is
gated by `ADMIN_GITHUB_LOGINS` — a comma-separated list of GitHub logins, matched
case-insensitively against the identity the FR-1 OAuth session already proves
(`lib/admin/guard.ts`). Its read path is `lib/admin/feed.ts`, which is the only module in
the product that queries across creators.

**Why it is not a PRD change.** The PRD does not describe an operator surface at all — §19
asks for monitoring of settlement, sweeps and reconciliation, and `scripts/ops-status.mjs`
answers that. This answers a different question the PRD leaves to the implementer: *what
is going up, across everyone, and is any of it wrong?* No requirement, route in §9, or
table in §12 changes meaning. `lib/core/access.ts` is untouched and unread by this page:
nothing here quotes, grants or moves money.

**Why logins and not a database flag or a shared secret.** An `is_admin` column is a row
somebody can write, and it would put the answer to "who can read everything" in the same
database the surface reads. A shared password has no name on it and cannot be taken from
one person. The env var is deploy-time, per-person, and revoked by editing one value.
Logins rather than creator handles because an operator is not necessarily a seller —
requiring a bound payout address before you can look at a dashboard is a strange thing to
ask of the person looking because something appears wrong.

**This gate fails closed**, which is the opposite of `lib/ops/switches.ts` and deliberate.
A switch that cannot be read must never be the reason commerce stopped; an allow-list that
cannot be read must never admit anybody. An unset or blank `ADMIN_GITHUB_LOGINS` admits
nobody, on production, on a preview and on `next dev` alike — there is no development
escape hatch, because the database `next dev` points at is the real one
(docs/archive/E2E-REPORT.md). A signed-in non-admin gets a 404 rather than a 403, so the
surface does not confirm itself to someone probing it; a signed-*out* reader is sent to
GitHub, because nothing has been proven either way at that point.

**Consequences.**

- `ADMIN_GITHUB_LOGINS` is the **root** half of the list; see the follow-up entry below.
  It is absent from `.env.example`, which this session could not write.
- Every purchase read on the page is `.eq("chain_id", paymentChain().chainId)` and the
  page names the chain it is reporting on, for the reason migration `20260906010000`
  gives: one Supabase project serves both networks and an unfiltered sum reads testnet
  traffic as revenue. `chain_id` is now declared on `PurchaseRow` and `PayoutRow`.
- Buyer addresses are not selected by `lib/admin/feed.ts`. The column never enters the
  process, so nothing downstream can print one — the same posture `installCounts` takes
  for FR-40.
- The page is read-only. Takedown stays `scripts/ops-takedown.mjs` and the kill switches
  stay `scripts/ops-switch.mjs`: both move real state, and neither should be a button
  sitting beside a hundred rows.

---

## 2026-09-07 — Administrators are a table plus an unrevocable root list

**Decision.** The entry above chose an environment variable over a database column and
gave the reason: "an `is_admin` column is a row somebody can write, and it would put the
answer to *who can read everything* in the same database the surface reads." The founder
asked to be able to choose administrators from the product. That is a real requirement
and the objection above is a real risk, so the answer is both, split by what each half is
good at (`supabase/migrations/20260907000000_admin.sql`, `lib/admin/people.ts`):

| Half | Where | Who edits it |
|---|---|---|
| **root** | `ADMIN_GITHUB_LOGINS` | a deploy, and nothing else |
| **granted** | `admin` table | any administrator, from `/admin/people` |

The guard admits the union. The table is seeded with `pcmarts`, so `/admin` works on a
deployment that has never set the variable.

**What the root half buys, and why it is not redundant.** It is the half no click can
change. Every failure mode of a self-service admin list ends in the same place — the last
administrator is revoked, or revokes themselves, and the surface needed to undo it is the
surface now locked — and a list the application cannot write is the answer to all of them.
`revokeAdmin` therefore refuses two things outright: a root login (not this table's to
take) and yourself (never the thing somebody meant to click). Neither refusal is
load-bearing on its own; together with root they make the door unlosable.

**It fails safe, which is not the same as failing closed.** If the `admin` table cannot
be read — most likely because this migration has not run — `adminRows` returns empty and
logs. The result is a *smaller* set of administrators, never a larger one. Compare
`lib/ops/switches.ts`, which fails open on purpose: a switch that cannot be read must
never be the reason commerce stopped, and an allow-list that cannot be read must never be
the reason a stranger got in.

**Rows are never deleted**, as in `api_key`. Revoking writes `revoked_at` and
`revoked_by`, so the table answers who was let in, by whom, when, and when they were let
go. `granted_by` is taken from the caller's session and never from the form.

**Identity is the GitHub login**, not `creator.id`. An operator is not necessarily a
seller, and requiring a bound payout address before somebody can look at a dashboard is a
strange thing to ask of the person looking because something appears wrong. Logins are
stored lowercase because GitHub compares them that way.

**Consequences.** Access is checked on every admin page load, so a revoked administrator's
next click is a 404 — there is no session to expire. Adding somebody sends nothing; they
become an administrator the next time they sign in with that account.

---

## 2026-09-07 — What else went on `/admin`, and what deliberately did not

**Decision.** Three surfaces, which are the three questions an operator arrives with:

- **`/admin`** — what went up, across every creator (the entry above).
- **`/admin/creators`** — who is putting it up. Sign-up date, rail, listing and sales
  counts, last activity, payout address, and three flags: `no-listing` (onboarding that
  stopped), `rebinding` (a payout change inside its FR-5 window, so sweeps are still
  going to the old address), `custodial` (D11 — money the platform is holding). The
  roster is not derivable from the feed: a creator who never listed anything is invisible
  there and is exactly the row worth seeing.
- **`/admin/people`** — who is allowed to look.

Plus **one ops line on `/admin`**: which kill switches are thrown and which payouts are
stuck (`lib/admin/ops.ts`). Both are pure database, so the page still renders without
touching an RPC. The detail table appears only when something is wrong; a standing
"all clear" panel is a panel an operator learns to stop reading.

**A creator's payout address is shown; a buyer's address is not, anywhere.** FR-40 keeps
buyers from sellers, and `lib/admin/feed.ts` and `lib/admin/creators.ts` do not select the
column at all, so nothing downstream can print one even by mistake. A creator's payout
address is their own, is already on their own earnings page, is a public value on a public
chain, and is the first thing anybody needs when a creator says they have not been paid.

**What did not go on, and why.** No takedown button, no kill-switch toggle, no
clear-stuck-payout action. `scripts/ops-takedown.mjs`, `scripts/ops-switch.mjs` and
`scripts/ops-clear-stuck-payout.mjs` keep those. Each of them either stops commerce or
moves somebody's money, and none of them should be one mis-click from a table of a
hundred rows; the page's job is to make you reach for the script knowingly, which is why
the ops detail prints the command beside the problem. `npm run ops:status` also stays the
full ops answer — it reads the chain and compares the sweep wallet's balance against what
is owed, and a page should not wait on Base to render.

**Consequences.** A third responsive tier, `data-col="wide"` (hidden below 82rem), joins
`dense` (60rem) and `optional` (40rem) in `app/globals.css`. One column earns it: a payout
address is 42 monospace characters that must not be broken across lines, because half an
address cannot be checked against an explorer.

---

## 2026-09-07 — `manifest_view`, and why the admin section needed one event outside itself

**Decision.** `app/[owner]/[slug]/page.tsx` records a `manifest_view` event on every
non-draft render, with `props.view` distinguishing the human reading from `?view=agent`.
This is the only change made outside `/admin` while building the admin surfaces.

**Why.** PRODUCT.md names one number as the answer to the product's whole hypothesis —
"does a public manifest over a private repo convert where a sealed box does not?" — and
that number is **manifest views per purchase**. Nothing recorded a view. The §10 `event`
table had `402_issued`, `settled`, `download`, the `sweep_*` family and the rest, all of
them on the money side of the funnel and none of them a denominator. An analytics page
built on that table could show conversion *from a quote*, which is useful, and could not
show the thing the company is actually testing.

The cost is one fire-and-forget insert on a page that is already `force-dynamic` and
already does several reads. `record` swallows its own errors (lib/events.ts), so an
analytics failure cannot fail a page render, and a draft previewed by its own owner is
not counted.

**The number is not backfillable, and the page says so.** `MANIFEST_VIEW_SINCE` in
`lib/admin/activity.ts` is the moment recording started; `viewsPerPurchase` is null for
any window that reaches back before it, and `/admin/activity` prints the reason instead
of a ratio. This was not theoretical: the first render of that page showed `0.2` — four
views recorded minutes earlier over eighteen purchases from the preceding month — which
is not a small number but a meaningless one. A guard on "are there any views" was not
enough; the guard has to be on "does the window lie entirely after instrumentation".

**Consequences.** From 2026-10-07 the 30-day window becomes meaningful and the constant
can go. `all` never will be. Agent and human readings are distinguishable in `props`, so
the ratio can later be computed either way without a second event.

---

## 2026-09-07 — `Owed` and `Blocked` are different money

**Decision.** `/admin/money` splits released-but-unswept net into `owedMicro` (what the
next sweep will actually pay) and `blockedMicro` (what it will skip, because that creator
has a payout stuck at `pending` or `broadcast`).

**Why.** `lib/payouts/sweep.ts` stamps a purchase with its `payout_id` only *after* the
transfer confirms (W1.1, and deliberately — the alternative risks double-paying). So
money behind a stuck payout still reads as unswept. A single "owed" figure would
therefore tell an operator the next run pays it; `payout_one_in_flight_per_creator`
guarantees the run instead skips that creator with `payout_in_flight`, and somebody has
to clear the payout by hand first.

This was found by the page itself on its first load against production: it reported
`Owed now $28.80` beside an ops panel reporting one payout of exactly $28.80 stuck since
the previous day. The two lines were the same money, described as two different states,
and only one of the descriptions was true.

**Consequences.** The split is the 2026-09-06 incident rendered as a standing line rather
than a post-mortem. `Blocked` appears only when it is non-zero, in Fail Red, and names
the script that clears it. The invariant the tests hold: `held + owed + blocked + paidOut
= net`.

---

## 2026-09-07 — A scripted fetch is a buyer here, not a bot

**Decision.** `lib/web/user-agent.ts` excludes only **search indexers, link previewers and
uptime monitors** from the `manifest_view` count. `curl`, `wget`, `python-requests`,
`Go-http-client`, `node-fetch` and a headless browser all count as views, and a *missing*
user-agent counts as a view too.

**Why it is the opposite of a normal bot filter.** Half of PRODUCT.md's audience is
agents, and robots.txt already says in its own words that "an agent reading a manifest
before it pays is the product working as designed". A generic bot filter drops exactly
that traffic. Since the purchase those agents make stays in the denominator, excluding
their view would make the manifest look like it converts *worse* the more agent buyers
arrive — the precise inversion of the metric's purpose. The first draft of this file did
exactly that; it was caught in review, not in production.

**Consequences.** `bot` is matched as a whole token, and a token merely *ending* in `bot`
needs four characters in front of it — `googlebot`, `bingbot`, `yandexbot` and
`semrushbot` pass, the phone that reports itself as `CUBOT NOTE 20` does not. The bias is
stated once and applied everywhere: when in doubt, count it as a potential buyer.

---

## 2026-09-07 — Flow narrows with the window; balances never do

**Decision.** On `/admin/money`, gross, fee, what creators keep, sales and buyers are
scoped to the selected window. Held, owed, blocked, paid out and gas are **always
lifetime**, and the page says which is which.

**Why.** Windowing everything was the tidier-looking choice and it was wrong. At
`?window=24h` on a quiet day it printed `Owed now $0.00` while $28.80 sat blocked behind
a stuck payout — a balance question answered with a flow number, and the most
misreadable sentence the page could produce. A balance has no window: "owed now" means
what is owed now.

**Consequences.** `totalsFrom` runs twice over two populations rather than growing a
second arithmetic path, and the page labels the flow half with the window name. Also
recorded here because the same distinction is what makes `Blocked` correct (see above):
both are answers to "what is true right now", not "what happened lately".

---

## 2026-09-08 — Vercel moves by transfer; the database has to be rebuilt

**Decision.** The org move runs on two different mechanisms, one per platform. The Vercel
project is **transferred** into team `<vercel team>` — the same project, re-parented, over the REST
transfer-request endpoints (`POST /v9/projects/{id}/transfer-request`, then `PUT
/v9/projects/transfer-request/{code}` scoped to the destination team). The database is
**rebuilt**: migrations pushed to the fresh project `<project-ref>`, writes frozen with
the §19 kill switches, data copied with `pg_dump`, objects copied and re-hashed. Executed
2026-09-08 with a ten-minute freeze, 21:48–21:58 UTC; the run's record is
`docs/archive/MIGRATION-PRD.md`.

**Why Vercel is transferred.** All 33 production env vars are marked sensitive, and a sensitive
value cannot be read back out of Vercel — `vercel env pull` returns it masked. So a rebuild's
env step is not "copy 33 rows", it is "hope that every one of 33 secrets still exists in a local
file", and the CDP keys, the GitHub App PEM and the sweep-wallet key are precisely the values
you discover are missing at the moment production stops working. A transfer keeps them because
it never reads them, and keeps the project id, the deployment history, the `x402git.com` domain
attachment, the git connection and both cron definitions with them. The consequence worth
naming: **the domain never repoints.** The draft's cutover step was `vercel domains move`, with
"expect seconds of 404" written next to it. That window is gone, and so is the second deployment
it existed to bridge. One `vercel domains move x402git.com <vercel team>` was still needed on the day
— the DNS zone's own ownership does not follow the project — but it re-parents a zone that keeps
serving the same records for the same project, which is not the same thing as repointing a live
domain at a second deployment.

**Why the database is not.** Transfer was the preferred route on this side too — it would have
kept the ref, the URL, the keys, the region, the buckets and the migration history, and reduced
the whole database half to one click. The dashboard refuses it: the source organisation's type does not permit
transferring the project out. There is no way around it in code, either — `https://api.supabase.com/api/v1-json`
has no transfer endpoint, verified, and the CLI has no subcommand for one. So the copy runs, and
with it everything the copy drags along: a freeze, a `pg_dump`, a storage script, a re-hash of
38 artifacts against their `artifact_sha256`, and a row-count-and-sums comparison on both sides.
The invariants that hold *by construction* on the Vercel side have to be *proved* on this one.
That asymmetry is the whole shape of the run: transfer where it is allowed, prove where it is
not.

**The region pin stands, and its timing is the interesting part.** The new database is in
`eu-west-2`; functions run in `iad1`. Roughly 80 ms of Atlantic per Postgres round trip, on a
manifest page that makes several, so `vercel.json` gets `"regions": ["lhr1"]`. What matters is
*when* it deploys: the same deploy that switches `SUPABASE_URL`, not before. Shipped early it
would move the app to London while its database was still in Virginia — the exact mistake, run
backwards. The rule underneath is that the functions go wherever the database is, and the
database's location is the input, never the other way round.

**`SESSION_SECRET` becomes explicit because this run forces the question.** Unset, `lib/env.ts`
derives it from a hash of `SUPABASE_SECRET_KEY`, and its own comment warns what that means:
rotate the database key and every creator is logged out. A new Supabase project *is* a new
secret key, so the session key changes whether or not anybody decides it should. The choice is
therefore not "log people out or don't", it is "log them out once, knowingly, with a key that is
no longer the database's" — and that is the choice. Two real creators re-login. The cookie key
and the database key stop being the same string.

**`ADMIN_GITHUB_LOGINS=pcmarts` gets set for a related reason.** Production had it from
2026-09-07 but preview did not, so on preview the one row in the `admin` table was the only way
into `/admin` — the exact single point of failure the variable exists to remove (2026-09-07,
"Administrators are a table plus an unrevocable root list"). The root half is the half no click
can revoke; leaving it empty in either environment gives that up for nothing. Both now have it.

**B7 does not gate the move.** The draft said close blocker B7 first — a `pending` payout row
blocking the `examples` creator's sweep — and that was wrong on inspection: the row is copied
like every other row, and the rebind, the funding and the sweep then happen against the new
database. Nothing about the blocker is easier or harder for having been copied, and a payout
stuck at `pending` is a state the schema already expresses. What does still gate the run is the
cron window: freeze and cut over well clear of 03:00–04:00 UTC, because production is on Base
mainnet and no-double-sweep is a claim about real money.

**No storage hostname is baked into product data — the draft said otherwise and was wrong.** The
plan carried a step to rewrite four `release.manifest` rows said to embed
`<old-project-ref>.supabase.co`, and a backlog item to stop it recurring. Both rested on a bad
match: those four rows matched `%supabase.co%` because their README *text* links to
`https://supabase.com`. The rewrite ran and touched 0 rows. README image URLs are computed at
request time from `SUPABASE_URL`, not stored — verified after cutover, the asset route now 302s
to `<project-ref>.supabase.co` and the image loads. So the cutover never depended on a
data rewrite, the backlog item is deleted rather than deferred, and the standing rule holds: the
only place a host may appear is an env var.

**Two CLI facts this run paid to learn.** The `supabase` CLI auto-loads `.env`, and *its* load
wins over the process environment — exporting `SUPABASE_DB_PASSWORD` in the shell does not
override what the file says. Commands aimed at the new project therefore have to pass
`-p "$NEW_PGPASSWORD"` explicitly, which is what `scripts/with-env.mjs` wraps. And on CLI
2.116.0, `supabase db query` only reaches a project when called as
`--linked --project-ref <ref>`; that path goes through the Management API and needs no password
at all.

**Consequences.** Rollback is asymmetric, matching the mechanisms. Vercel rolls back at any
time by transferring the project the other way. The database rolls back by putting the six old
`SUPABASE_*` rows back (production and preview), reverting the `lhr1` pin and redeploying — free
until the kill switches are resumed, because until then the two databases are identical, and an
export of the delta afterwards. Resuming the switches is the commit point, which is why the smoke
tests happen before it; on the day that was 21:58 UTC. The old database is paused, not deleted,
for 30 days, and its own ops switches are left paused as well; a paused database cannot be read
or written by a forgotten copy of a key.

---

## 2026-09-09 — B7 closes, and the sweep that closed it had to run from a laptop

**What happened.** `node scripts/ops-clear-stuck-payout.mjs` scanned the sweep wallet's
outbound transfers over the last 120000 blocks — four of them — and found the one stuck
row from 2026-09-06: `<uuid>`, 28800000 micro-USDC bound
for the throwaway `0xe0d6…3d23`, with no `tx_hash` and no matching `Transfer` on chain.
Provably unpaid, so `--apply` set it to `failed`, which is the state the sweep's own
retry path reopens. Paul funded the Base Sepolia sweep signer
`<sweep signer>` to 30.00 USDC from a faucet at 09:00–09:01
UTC. The next sweep paid **28800000 micro-USDC to
`<payout address>`**, tx
`0xcf22aa392084c212737fa358ea2eddacd5e03e032ce46ab420dcbbdd3bd5bba8`, confirmed, four
purchases swept. Checked against the chain rather than against our own row: receipt
status success in block 46588236, and the ERC-20 `Transfer` log pays exactly 28.80 USDC
to exactly that address. B7 is closed.

**Why it had to be driven locally, which is the part worth recording.** Production has
been on Base mainnet since the 2026-09-07 cutover, and every surface filters on
`paymentChain().chainId` (migration `20260906010000` — one Supabase project serves both
networks). The B7 row and the whole of the `examples` creator's balance are Base Sepolia.
So the 03:00 UTC sweep cron on production will never see them, no matter how long it
runs, and no amount of funding a wallet changes that: the rows are on the wrong chain for
the deployment that owns the cron. Pointing production at Sepolia to clear a testnet row
is not a trade anybody should make. So a local `next dev` was started with the Sepolia
sweep signer injected from the gitignored wallet file, and `GET /api/cron/sweep` was
called on localhost.

**A one-off transfer script would have moved the same money and proved nothing.** The
point of going through the cron route is that it is the same code path — `inFlightPayout`,
`openPayout`, the FR-27 holdback filter, the confirm-then-stamp order from W1.1, and
`payoutAddressFor`. Money leaving a wallet is not the assertion; the sweep working is.

**The FR-5 rebind landed in the same pass, because that is where it lands.** The rebind
queued on 2026-09-06 became effective 2026-09-08 18:56 UTC, but nothing runs at that
moment — `payoutAddressFor` resolves it lazily, at the next payout, which is why B7's
ordering caveat was written the way it was. The `examples` creator's `payout_address` is
now `0x2cac7b3c…`, with `pending_payout_address` and `rebind_effective_at` both null. The
48-hour window is not a timer that fires; it is a condition read at the moment money moves.

**`examples-creator.local.json` can now be deleted.** B7 said "do not delete it until the
rebind has landed" because it was the only credential that could authorise one. The
rebind has landed, the throwaway `0xE0d6…3d23` is bound to nothing and holds nothing on
either network, and a loose private key with no remaining job is only a liability. That
caveat is spent.

**Where it left the ledger.** `npm run ops:status` afterwards: 10 confirmed payouts, 5
failed, released-and-unswept $0.00, no stuck rows. The `Blocked` line on `/admin/money`
that existed to describe this money now has nothing to describe.

---

## 2026-09-09 — FR-34 is green on Rail B, and Rail A is no longer a headless rail

**The harness was stale before it was wrong.** The first run failed on both rails at step
2 with an HTTP 400. `GET /api/auth/challenge` has required a `purpose` parameter since the
W2.2 hardening (`supabase/migrations/20260830001000_challenge_purpose.sql`): a challenge is
bound to the one action it authorises, so a signature collected to prove an address cannot
be replayed as proof of wallet ownership, and the route refuses to mint an unbound one.
`scripts/e2e-fr34.mjs` still asked the old way in two places. Fixed to ask for what each
call site actually consumes — `purpose=address_proof` for the registration signature that
`POST /api/creators` checks, `purpose=wallet_ownership` for the one the `X-Wallet-Signature`
header carries. `scripts/e2e-buyer.mjs` had the identical bug in its own `walletSignature()`
and got the identical fix; `scripts/e2e-web-checkout.mjs` never calls the endpoint.

Worth naming as a class rather than an incident: the harness is not run on every change, so
a hardening commit can invalidate it in silence and the only signal is the next run failing
at a step that has nothing to do with what is being tested. That is nine days of drift found
by running it, which is an argument for running it more often, not for trusting it less.

**Rail B: 13 passed, 0 failed, 1 skipped, complete.** Run against a local dev server
pointed at the production (new) database, on Base Sepolia. It covered registration, a
provisioned hosted repo, a git push over the deploy key, 1.0.0 cut, `PATCH` pricing,
publish, the buyer's 402 → sign → 200, a 1.1.0 push, the update 402 at the stamped price,
the owned-version re-fetch, the earnings ledger at 10%, and the manifest in server HTML
(`check:ssr` found the slug six times). Two real Base Sepolia settlements, both recorded on
`purchase` with `chain_id` 84532: the new purchase
`0x4b1e336ff05b8f74519bf7b01a5477e815281cbbf1008cc70dfc77a06137faae` (100000 micro) and the
update `0xe935a8a977c831b68bc8ae4aa86cf3eebec965006309e3d8f7b4a543b41294e1` (50000 micro).

**The one skip is the holdback doing its job.** Step 13's sweep returned
`nothing_to_sweep`: the sale is inside FR-27's seven days, next release
2026-09-16T09:08:14Z. A pass there would have meant the holdback was not holding. The step
still asserted the thing it exists to assert — that no `to` parameter exists on the payout
path (FR-26).

**Rail A failed at step 3, and that is the correct answer.** The 400 reads "A github
listing requires a linked GitHub identity, so the App installation can be verified as
yours." The check is in `resolveRailARepo` (`lib/listings/service.ts`), added by `d7ebc40`
("Security audit: close the Rail A ownership bypass and the mediums"). An installation id
is a small enumerable integer, so the ownership check has to be unconditional — anything
conditional is a bypass you can guess your way into — and a creator with no `github_user_id`
has nothing to verify an installation against. Refusal is the only safe answer available.
A creator registered headlessly has no linked GitHub identity by construction, so the
harness's `--rail a` path is unreachable **by design**. This is not a regression and should
not be treated as one: FR-34 is the definition of done for the *headless* rail, that rail is
Rail B, and Rail B is green.

**What is left of it is a documentation problem, not a security one.** The harness still
advertises `--rail a`, and `--rail both` therefore exits 1 on a run where nothing is
actually broken — a red result that means "this cannot be tested this way", which is the
worst thing a test can say without saying it. Covering Rail A end to end now needs a web
OAuth session that a script cannot obtain unattended, a test-only way to link an identity,
or an explicit decision that Rail A is proven through the dashboard instead. Recorded in
docs/BACKLOG.md.

**Cleanup, on the standing rule: retire, never delete.** The run's published listing
`e2e-b-1007-252b` was retired rather than removed, because the two settlements above are
the FR-34 proof and deleting the listing would delete the evidence. Every e2e listing in
the database is now retired — 13 e2e creators and 12 e2e listings in total —
`https://x402git.com/sitemap.xml` carries 0 e2e URLs, and the retired page still renders
200 (FR-43).

---

## 2026-09-10 — The x402 dependency is watched on purpose, not on notice

**Decision.** `@x402/core`, `@x402/evm` and `@x402/fetch` moved to 2.25.0, and the review
that produced the bump became a repeatable one: `npm run x402:check`
(`scripts/x402-upstream-check.mjs`) with its watermark in
`scripts/x402-upstream.state.json`, and the standing verdicts in docs/x402-upstream.md.

**Why a script rather than a reminder.** Upstream merges dozens of commits a week across
seven SDKs, and a version number does not tell you which of them can reach this codebase.
The check asks the four questions that can: are we behind on the four packages we import,
what do the changelog sections above our version say, has a new file appeared under
upstream `docs/extensions/` or `docs/schemes/` (the only signal that a *capability* is new
rather than a fix), and what landed under `typescript/` since the watermark. It exits 1 on
news and 0 on a quiet week, so it can be run on a schedule without producing noise.

**What 2.25.0 needed from us: nothing.** Typecheck and 1371 tests pass unchanged. Its
breaking note — `buildPaymentRequirements()` now throws instead of answering 402 with an
empty `accepts` when no scheme server is registered for the scheme and network — cannot
reach us, because `resourceServer()` registers `eip155:*` and that covers both networks we
price on. Its process-exit-on-eager-sync-failure change is likewise unreachable while we
keep skipping `initialize()`.

**The one finding with product consequences is discovery, and it was not adopted here.**
The CDP facilitator serves a Bazaar index of 14,202 paid resources, including a
facilitator-computed usage block per entry, and none of the resources is ours. Getting
listed is a real distribution surface and a real design question — a per-buyer price in an
index that advertises one `amount`, a `routeTemplate` for `/api/r/[owner]/[slug]`, and
FR-45 removal latency — so it went to docs/BACKLOG.md, which is where the working
agreement says it goes before the PRD.

---

## 2026-09-13 — `/admin` can act now: switches and takedown, on pages of their own

**Decision.** The founder asked for more operator functionality. Triaged, and built in this
order:

| Built | What | Why now |
|---|---|---|
| `/admin/listings/:id` | releases, **scan findings**, licence, sales/owed on this chain, recent events, takedown form | a `scan failed` flag had nowhere to go but `psql`; `release.scan_report` had no reader (BACKLOG) |
| `/admin/creators/:handle` | payout address and pending rebind, abuse contact, unpaid/held, payouts with tx links, listings, API keys (never hashes) | "I have not been paid" and "my agent stopped working" are the two support questions, and both needed SQL |
| `/admin/ops` | the four kill switches, pause (reason + typed name) and resume (typed name); stuck payouts with the clearing command | see below |
| `/admin/audit` | switch changes and takedowns (web and script), plus admin grants/revokes, in one timeline | an action surface without a record of who acted is not one |
| `requireAdminRoute` origin check | a cross-site `Origin` on an admin POST answers 404 | the POSTs now stop commerce; `SameSite=lax` alone was the only defence |

**This reverses part of 2026-09-07 ("What else went on `/admin`, and what deliberately did
not").** That entry kept switches and takedown as scripts because none of them "should be one
mis-click from a table of a hundred rows". The objection was to *placement*, and it still
holds: no control sits in a table row. What it missed is that the scripts need a checkout and
`.env.local` with the database secret key — exactly what an operator lacks on a phone during
the incident a switch exists for. So each control is on its own page, is confirmed by typing
(the switch name, or `owner/slug`), requires a reason where the script does, is re-checked on
the server (`lib/admin/controls.ts`), and writes an audit event with the session's login.

**What stayed a script, and why.**

- `revoke` (FR-39). V0 has no automated buyer refund (FR-26), so revoking from a button would
  take money and goods together. The listing page prints the exact command.
- Clearing a stuck payout. It has to prove on chain that the transfer never landed first; that
  scan is the script's whole job.

**The audit trail is the `event` table**, not a new one: the takedown script already writes
`takedown_retired` / `takedown_revoked` there. Web actions add `props.by` (login, from the
session) and `props.via = "admin"`; new names are `switch_paused` / `switch_resumed`. Unlike
`record`, an audit insert failure is surfaced on the page — a pause with no name on it is worse
than an ugly notice. Admin grants are read from the `admin` table's own stamps rather than
copied.

**Deferred, with the reason.** Revoking a creator's API keys (needs step-up thinking, and FR-4's
scanner already revokes on a leak); suspending a creator for repeat infringement (FR-39 names
it but there is no column — PRD and schema first); refunds (no path, FR-26); creator notes
(migration for little gain at 2 creators); emailing creators (no mail infrastructure); CSV
export of sales (easy, wait until someone asks for it for tax); impersonation (never).

**Consequences.** The feed and roster now link a row to its admin detail page rather than to
the public page in a new tab; the public pages are one click further, from the detail page.
The admin nav has seven entries.

---

## 2026-09-13 — The admin section, re-laid out around the operator's first question

**Decision.** A layout pass over `/admin`, from screenshots at 1440px and 390px. What changed
and the problem each one answers:

| Change | Problem it answers |
|---|---|
| `/admin` is an **Overview**: *Needs you* (every open problem, each linked to where it is fixed), *Last 7 days* beside *Right now*, five newest listings, five latest operator actions | "Is anything wrong?" was one line of a tally above 25 rows; its answer was split across Listings, Money, Activity and Creators |
| The listings table moved to **`/admin/listings`**, defaulting to **Active** (live + draft) | 14 of 25 rows were retired test runs; the table spent most of itself on rows nobody acts on |
| Sub-nav marks the **current section**, groups *look* (Overview…Activity) apart from *act* (Ops, Audit, Admins), drops "Your dashboard" (the header has Dashboard), and **scrolls sideways on a phone** | No current-page state; eight links wrapped to three lines and filled a third of the first phone screen |
| **Tables stack into ruled rows** under 40rem, with a `data-lead` cell on the first line | Slugs broke one character per line; the money table overflowed the screen by 78px |
| The activity **stream hides page views** unless `?views=1` | Of 60 rows, most were `manifest_view`, burying settlements, sweeps and reconciles |
| A clean scan pass is **one line**, not a heading, a paragraph and "No findings."; the **takedown is a closed `<details>`** that opens itself when a submission bounced | Detail pages read as long forms rather than reports |
| Ops rows link **Pause… / Resume…** to the form with the switch preselected | The switch table and the form were disconnected |
| Long standing paragraphs (views-per-purchase caveat, money's privacy note) cut to one line or moved into the row they qualify | Prose an operator reads once, repeated every visit |

**What did not change.** No new visual vocabulary, still no control in a table row that acts on
its own (the Ops links go to the typed-confirmation form), and every page still works with
scripting off; the sub-nav is a client component only for `usePathname`, which renders on the
server.

**Consequences.** `adminFilter` takes a fallback, so the listings page defaults to `active`
while other callers keep `all`. `loadActivity` takes `{ streamViews }`. The `loadMoney` and
`loadAdminFeed` tests now pin `Date` to their fixture's `NOW`; they had started failing on
2026-09-13 because their "last 7 days" fixtures aged out.

---

## 2026-09-13 — The scan blocks on five things and publishes the rest

**Decision.** "PRD Trust Report.md" is accepted, and it **supersedes "The scan fails on
secrets and on HIGH/CRITICAL CVEs, and nothing else" (2026-08-29)**. The gate keeps that
entry's three absolutes and gains two, and the verdict stops being the only thing the scan
says. Three tiers, one of them new:

| Tier | Effect | What lands here |
|---|---|---|
| **blocking** | `fail`, terminal, bytes deleted | secrets · HIGH/CRITICAL CVEs · §6 size caps · **an OSV `MAL-` record on a dependency** · **a Socket confirmed `malware` alert** · **hidden-Unicode instruction smuggling** in a `.md`, frontmatter or tool description |
| **disclosed** | sells, and says so on the listing, in the manifest and on `/api/v` | MODERATE/LOW/UNKNOWN CVEs · the computed capability inventory · textual injection heuristics · Socket capability and hygiene alerts |
| **review** | disclosed as "flagged for review", admin alert, **never a verdict** | Socket's model-derived types — `gpt*`, `skill*`, `potentialVulnerability`, `didYouMean`, `troll` |

**Why the two new absolutes.** `MAL-` was a live hole, not a tightening: OSV ingests
`ossf/malicious-packages`, those records carry no CVSS vector and no severity word, so
`severityOf` returned `UNKNOWN` and the 2026-08-29 rule let them through. A dependency OSV
itself calls malware was passing the gate. Hidden Unicode is the other end of the same
argument — tag characters and zero-width runs spelling text have no benign use in a skill
file, so blocking on them fires on nobody honest. Both satisfy the test the old entry set:
a gate that always fires is a gate people learn to ignore, and neither of these fires on a
real repository. **Founder decision on the smuggling half, 13 Sep 2026** — with the fallback
named in advance: if it false-positives on emoji flag sequences, which also use tag
characters, it drops to `disclosed`.

**Why a third tier at all.** MODERATE and LOW CVEs were being recorded and never shown, and
"what can this artifact do" was not being asked. Both are the buyer's business and neither
should stop a sale. `disclosed` is what a finding is when the honest answer is "here it is,
you decide" — which is also the answer to the criticism `docs/research/Battle Test.md` §6.3a
makes of Agensi, that the badge has nothing behind it.

**No model reads a repository.** Every check we run is a deterministic rule with a version
number, reproducible by the creator from the bytes and the rule — that is what lets us
publish a finding at all. Socket uses models internally for some alert types; those are the
`review` tier, disclosed with the classifier named, never a verdict. Socket publishes 94.5%
precision on its skill classifier: one flag in eighteen is wrong, and the creator it lands on
can neither see why nor fix it.

**Two tools, and the line between them.** Our own rules in `lib/scan/` read the artifact's
own files; Socket reads only the dependency manifests it extracts from the uploaded zip. The
artifact's code never leaves our storage (D3a), and we never re-implement package behaviour
analysis. Snyk was considered and rejected — its REST API is Enterprise-only and its CLI
uploads the creator's source.

**A vendor outage does not stop the platform selling. Founder decision, 13 Sep 2026.** A
Socket check that cannot run is an `unavailable` row on the report and the release cuts on
the checks that did; the rescan cron retries it. OSV's outage leaving a release `pending`
was right when OSV was the only dependency check; making every release on the platform
depend on a second vendor's uptime is the always-firing gate wearing a different hat, and
"dependency behaviour: not yet checked, retrying" is an honest line to print. Socket is built
on the free tier — 500 units/hour, 1,000 full scans/month, ~7 units a release — and the
conversation with Socket happens when a month of real volume gives us numbers to bring
(**founder, 13 Sep 2026**).

**A rescan refreshes disclosures; it never changes a verdict. Founder decision, 13 Sep
2026.** The verdict is terminal (2026-09-01, "A failed scan says so") and that holds in both
directions. If the nightly rescan finds in a selling release something that would have
blocked it at cut time, that is a takedown question: `release.compromised` on the FR-41
webhook, an admin alert, the finding on `/admin/listings/:id`, and the listing keeps selling
until a human uses the FR-39 control. The alternative — an automatic `revoked_at` and a
listing pause — takes a buyer's money and their goods together on a rule with no human in
it, and FR-39 reserves revocation for upheld notices.

**Consequences.** `scan_report` becomes v2 with a `checks[]` row per check; v1 reports are
read through a shim that synthesises the rows from `checked[]`, and nothing is migrated —
`SCANNER_VERSION` says which era a report is from. `UNKNOWN` still never blocks *as a
severity*, but an advisory id beginning `MAL-` now blocks whatever its severity fields say,
which is the one place the old rule was inverted. Releases that failed under the old rule are
not re-scanned and releases that passed are not re-judged. The build order is the proposal's
§9: `MAL-` first and on its own, then the published report, then our own capability and
injection modules, then Socket, then the rescan cron.

---

## 2026-09-13 — Admin notifications go to Telegram, outbound only

**Decision.** FR-35 and FR-39 both say "admin alert" and nothing sent one. `lib/notify/`
does now: `notifyAdmin(event)` posts to a Telegram channel the founder already reads, in
four kinds — `creator_joined`, `listing_created`, `payment_settled` and `error`. Two env
vars (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_ID`, read through `telegramConfig()` in
`lib/env.ts`); unset either and every send is a silent no-op, which is what previews and
local development get. The operator doc is docs/ADMIN-NOTIFICATIONS.md.

**Why Telegram.** No inbound webhook, no route to register, nothing reachable from the
internet — the bot only ever calls out to `api.telegram.org`. It is also somewhere the
one person who acts on these already looks, which is the whole requirement. Nothing in a
message is a control: no button does anything, because FR-39 is the only path that acts.

**Alternatives.** Email — no mail infrastructure, and the admin section already deferred
emailing creators for that reason (2026-09-13, the admin controls entry). Slack — a
workspace nobody is in. A Sentry-style error tool — later, and this is not a replacement
for one: there are no stack traces, no grouping and no release tracking here. Vercel
Queues — durable delivery machinery for four messages a day.

**Bounded, and it cannot fail its caller.** `notifyAdmin` never throws and never rejects
— including on a bug in its own formatter — exactly like `record()` in `lib/events.ts`
and `sendAbuseWebhook` in `lib/abuse-webhook.ts`: a Telegram outage must not be able to
fail a paid request or a cron. The ceiling lives in the transport rather than at the call
sites, so it holds however it is called: `sendTelegram` aborts at 3 seconds, which is the
most a settlement can pay for a notification, and is well past the point where a buyer
should be waiting on one.

**The throttle, and why it is only best-effort.** Same `where:code` at most once per 10
minutes, at most 20 error posts per rolling hour, in process; suppressed sends return
`reason: "throttled"`. Fluid Compute reuses instances but does not promise to, so two
instances can each post once. The alternative — a table and a write on every error path —
is machinery in the way of the thing that is already broken, to prevent a duplicate
message.

**Privacy is the `lib/admin/feed.ts` line.** No buyer address, no payout address, no API
key, no token in any message (FR-40); a sale is a listing, a version, an amount, a kind, a
source and a chain. Every money message names its chain, because one Supabase project
serves Base and Base Sepolia. Everything user-supplied is HTML-escaped — a slug is a
creator-supplied string and the parse mode is HTML.

**What it does not do.** It does not pause, revoke, refund or retire anything; FR-39
remains the only path that acts, by hand. It does not notify free grants (a `$0` grant is
not a payment), catalogue 4xx errors (FR-33 makes those an expected shape), downloads, or
crons that ran normally. And it is lossy on purpose: every notified event is also an
`event` row, and `/admin/activity` is the complete list.

**Consequences.** `npm run telegram:check` (`scripts/telegram-check.mjs`) is the preflight
— `getMe`, `getChat`, is the bot an admin — with `--send` for one sample per kind. The
token is a bearer credential in a URL path, so rotation is BotFather `/revoke` then
`vercel env rm` / `vercel env add … production --sensitive` and a redeploy; between the
two, every send is a 401 and nothing else breaks.

**14 Sep 2026 — operator actions post too, as a fifth kind.** `admin_action` (🔒) covers
everything on the `/admin/audit` trail: both kill switches, both halves of a takedown, and
granting or revoking an administrator, from the web (`recordAdminAction`,
`grantAdmin`/`revokeAdmin`) and from `scripts/ops-takedown.mjs`. **It is never throttled**
— the throttle is for `kind: "error"`, and there is at most one operator action a week;
two inside ten minutes means two people reached for the same switch during the same
incident, which is exactly the pair worth waking up for, and the suppressed one would be
the one you did not do yourself. The message goes out **whether or not the audit row
saved**, carrying the insert error on a `⚠️` line when it did not: the pause has already
happened by then, and the run with no durable row is the run where the phone is the whole
record. The script duplicates the 🔒 shape by hand rather than the formatter — there is
still no TypeScript loader for `.mjs` — but not the wire: `scripts/lib/telegram.mjs` is
now the one transport both scripts post through.

---

## 2026-09-14 — `/admin/creators` becomes `/admin/users`, buyers are on it, and test users are hidden

**Decision.** The roster is now everybody the platform has met (`app/admin/users/page.tsx`,
`lib/admin/users.ts`). An **account** is a `creator` row, listed or not; a **wallet** is an
address that bought without one, and a creator whose payout address bought something is
one row, not two. "Creator" is a filter — an account with a live listing — beside Buyers,
Not listed, Web and API. `/admin/creators` redirects there with the Creators filter on;
each creator's own page stays at `/admin/creators/:handle`.

**Buyer addresses are now shown to administrators.** This reverses the 2026-09-07 line
"a buyer's address is not shown, anywhere" on the founder's direction ("what about people
who purchase and don't create?"). A buyer has no identity but the address, so a Users page
without it could not list one. FR-40 is untouched: it keeps buyers from *creators*, and
nothing added here reaches a creator's page. Two edges stay closed — Telegram names a
labelled wallet as "a buyer wallet", never its address, and the Vercel analytics mirror
carries no props for the new events.

**Test users are hidden by default.** Most of the roster was the e2e harness. A user is test
when an operator marked them (`user_label`, migration 20260914000000), otherwise when the
harness made them (`e2ea…`/`e2eb…`), otherwise when all their on-chain activity is on a
testnet *and nothing of theirs is live* — a creator with a live listing who has only traded
on Sepolia so far is testing before mainnet, not a fixture. The label wins in both
directions, so `examples` can be marked test. Marking is a row button because it is a label: reversible, it moves no money
and stops nothing, unlike the actions 2026-09-07 kept off tables. Each mark is an
`event` row (`user_marked_test` / `user_marked_real`) on `/admin/audit`, and posts to Telegram.

**Money is read one network at a time, mainnet by default**, with a Testnet switch. The old
page read the configured chain, which on a Sepolia deployment made every harness purchase
look like revenue.

**Consequences.** Every column sorts, by URL (`?sort=gross&dir=asc`), so a view survives a
reload and works with scripting off. The address column is shortened, and whole in its
title, Copy and Basescan link — which retires 2026-09-07's `data-col="wide"` argument for
this table: the check against an explorer is now one click rather than a careful read.

---

## 2026-09-14 — Mainnet or testnet is one switch for the whole admin section

**Decision.** A Mainnet | Testnet switch sits in the admin nav, beside Sign out, and every
admin page reads through it (`lib/admin/network.ts`, `app/admin/network/route.ts`). It is a
POST form that sets a year-long `x4_admin_net` cookie and returns the operator to the page
they were on, query string and all, so it works with scripting off and survives across
pages. **Mainnet is the default.** Every loader that used to read `paymentChain().chainId`
— listings, users, money, activity, ops, both detail pages, the overview — now takes the
chain from the switch instead. Users lost its "Money on" dropdown to it.

**Why.** On the founder's direction: "we're seeing a blend of testnet and mainnet activity
which isn't helpful". Production has been on Base mainnet since 2026-09-07 while local and
preview runs keep writing Sepolia rows into the same project. The money reads were already
single-chain, but on the *deployment's* chain, so the question an operator can answer
depended on which deployment they opened. And `/admin/activity` was not chain-scoped at
all: the `event` table had no chain, so its funnel counted Sepolia harness purchases beside
mainnet manifest views.

**`event` gains `chain_id`** (migration 20260914010000). `record()`, the listings and
release event writers, and `recordAdminAction` stamp the writing deployment's chain
(`recordedChainId()`, null rather than a throw on a misconfigured network). The script
takedown writer does not, so its rows are null, appear only on `/admin/audit`, and are
absent from Activity on both networks. Existing rows were attributed best-effort, and the
migration states its rules: before the cutover Sepolia; sweep events by their payout's
chain; purchase events Sepolia while no mainnet purchase exists; harness listings Sepolia;
everything else since the cutover mainnet. A dry run put 20 of 20 `settled` rows on Sepolia
(matching `/admin/money`) and 369 of 372 manifest views on mainnet.

**What the switch does not change.** Audit and Admins are not chain-scoped, because an
operator action and an administrator are neither network's. Listings and users are not
hidden by network — a listing has no chain — only their money columns swap; the Users
page's Real/Test filter remains the way to hide harness rows.

## 2026-09-16 — The Bazaar lists a repo on its first sale, and the platform does not make that sale

The x402 `bazaar` extension is declared on every 402 (lib/x402/bazaar.ts), and the CDP
facilitator catalogues a resource only when it settles a payment that echoes the
declaration. So a listing enters the Bazaar — the one index agents holding USDC actually
query — on its first purchase, and not before.

The build offered to make that first purchase from a platform wallet for every live
listing, so nothing would be undiscoverable for want of a sale. Declined (founder): buying
every repo that goes live is a cost that scales with the catalogue, pays creators with
the platform's money, and puts a platform-owned wallet on every install count. The first
sale is the creator's to earn, and the moment it lands the listing is indexed with a
`quality` block a competitor cannot fake. What stays: the declaration on every 402, the
skill telling hand-rolled clients to echo it, and `npm run bazaar:check`, which reports
whether each listing is declared and whether it is indexed. `--pay` remains on the script
for a creator who wants to be their own first buyer; the platform never runs it.


## 2026-09-16 — Agents can search the live listings

**Context.** The MCP server could sell an agent anything it already knew the
`owner/slug` of, and give it no way to learn one. Every tool took a name. An agent
asked "find me a skill that writes changelogs" had nothing to call, so the server was
useful only after a person had found the listing somewhere else. The founder: "I want
the users to be able to use it to search and find skills."

**Decision.** A sixth MCP tool, `search_listings`, listed first. Free, no wallet, wraps
no route. It takes a plain-words `query` (empty lists everything), an optional
`max_price_micro` ceiling on the new-buyer price, and a `limit` (default 10, max 25), and
returns `total` plus, per result, the `owner` and `slug` the other tools take, the
creator's description and trigger hint, the latest version, both prices, the computed
artifact class, tags and inventory, the query words it matched, and the listing and
manifest URLs. `MCP_SERVER_VERSION` and `server.json` go to 0.2.0.

**NG1 is amended, narrowly.** NG1 ruled out "a browsable marketplace, catalogue,
search, filters, categories or rankings". Search is now in for agents; the rest is not.

- *The set is what is already public.* Live, not retired, with a release that passed the
  scan: the rows `sitemap.xml`, `/.well-known/x402` and `/openapi.json` already enumerate
  (lib/listings/live.ts). Nothing becomes discoverable that was not.
- *No ranking.* Results are ordered by how many query words matched, then by where
  (name 5, description and trigger hint 3, computed tags 3, README 1), then by name.
  Never by sales, installs, views or recency. A ranking is a thing creators compete for
  and a platform tunes; NG1's reason — creators bring their own audience — still holds,
  and an order that is a pure function of the query and the listing's own text does not
  undermine it.
- *No browse page, no categories.* This is a tool an agent calls, not a storefront.

**How it matches.** A query word matches a word in a field that starts with it
(`skill` finds `skills`; `git` does not find `digit`), after dropping stopwords. The
computed tags are the ones the 402's Bazaar declaration already carries (lib/x402/bazaar.ts),
so `skill` finds listings with a skill inside. In memory, one query for the listings and
one for their passing releases; the catalogue is tens of listings. When it is thousands,
this becomes Postgres full-text search with the same fields and weights, and the tool's
contract does not change.

**Not done.** No HTTP route: the search is MCP-only, so an agent with curl cannot call it
the way it can call the other tools' routes. `GET /api/search` would be the natural
twin if shell agents ask for it.

## 2026-09-16 — Operators can download any stored release, without buying it and without telling the creator

**Context.** Deciding a takedown notice, an abuse report or a `review`-tier scan flag
often needs the files, not the findings. The only way to get them was to buy the
listing, or to pull the object out of the private bucket by hand with the secret key.
The founder: "is it possible for me, as an admin, to download that listing without having
to pay?", and then "make sure that the creator doesn't get notified", and "add that to
the terms as well".

**Decision.** A Download button beside each stored release on `/admin/listings/:id`. It
POSTs to `/admin/listings/:id/releases/:releaseId/download`, which answers 303 to a
one-minute signed URL for the exact `storage_path` buyers get (lib/admin/download.ts).

- *Not a purchase.* Nothing imports `lib/core/access.ts`; no `purchase` row, so sales,
  install counts, earnings and the Bazaar's first-sale signal do not move.
- *No record, no download.* An `artifact_downloaded` audit row (by, `owner/slug@version`,
  release id, sha256) is written first, and if it does not save the download is refused.
  It appears on `/admin/audit` and posts to the operators' Telegram chat like every
  other admin action.
- *The creator is not told.* The `event` table is read only by the admin section, and
  no abuse-webhook event exists for this. None should be added.

**The creator agreement goes to 2026-09-16.** New §3.4 says administrators may download
and read any uploaded release, sold or not, to investigate a scan finding, abuse report
or takedown notice or to keep the service running; that it is not a purchase; that each
download is logged with the administrator; and that the creator is not notified. The
version default in `lib/env.ts` moves with it (`TERMS_VERSION` is not set on Vercel).

**Not done: FR-6's re-acceptance is not enforced.** The agreement and FR-6 say a new
version requires re-acceptance before a creator's next publish. Nothing checks
`creator.terms_version` at publish; only `POST /api/creators` compares versions. Creators
who registered under 2026-08-29 keep publishing under it until that gate is built.

## 2026-10-15 — A CVE found without a version is disclosed, not blocking

**Context.** A listing, `example-seller/example-listing` v1.0.0, failed its scan on six
HIGH/CRITICAL advisories against numpy and scipy, several from 2014–2019 that no current
numpy has. Its `requirements.txt` names packages without an `==` pin, so the scanner asked
OSV about `numpy` at no version, and OSV answered with every advisory ever filed against
it. The finding is unfalsifiable: the creator can upgrade all they like and the same
advisories come back. The 2026-09-01 dedupe fix ("a pinned version beats no version")
only covered packages pinned somewhere else in the repo.

**Decision.** A HIGH or CRITICAL CVE blocks only when the dependency was queried at an
exact version. A versionless hit is `disclosed` at its OSV severity — still public, still
on the manifest, so the buyer can read it — and the release sells. An OSV `MAL-` record
blocks with or without a version, because it condemns the package name, not a version.
Amends FR-35 (and G5's "HIGH/CRITICAL CVEs" reads the same way). Code: `osvFinding` in
lib/scan/index.ts.

**Not done.** Already-failed releases stay failed; a scan verdict is terminal. The
creator cuts a new version (or pins) to get a passing one.
