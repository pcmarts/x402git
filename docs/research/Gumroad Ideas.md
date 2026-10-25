# Ideas from the Gumroad codebase

Source: https://github.com/antiwork/gumroad (Rails + React), shallow-cloned to `/tmp/gumroad` on 2026-08-30. File paths below are relative to that clone. Everything is filtered against PRD Final v1.1 — in particular NG1 (no browse/rankings), NG2 (no reviews/profiles), NG5 (no subscriptions), NG7 (no notifications), NG9 (no fees beyond 10%).

The short version: Gumroad's *big* features (discover, reviews, email broadcasts, affiliates, workflows) are all things the PRD deliberately cut. What's worth taking is a layer of small mechanics — mostly around the buyer's post-purchase experience, the creator's product list, and access-token hygiene — where Gumroad has spent fifteen years finding the sharp edges and we currently have nothing.

---

## Tier 1 — small, on-PRD, do these

### 1. Buyer receipt as a durable page (and the same template for both web and email later)
We have no buyer-facing receipt at all: the entitlement row exists but the buyer has nothing to look at, link to, or expense. Gumroad renders the *mailer HTML* as a web page (`app/controllers/purchases_controller.rb` `#receipt`), so there's one template. Contents worth mirroring (`app/presenters/receipt_presenter/*`, `app/views/customer_mailer/receipt/`): order id, date, total, product card + creator link, the *download button*, and the refund/terms as they stood at purchase.

For us: `/purchases/:entitlement_id` (or `/r/:o/:s/receipt?tx=…`) showing tx hash, block time, amount in USDC, version bought, licence, artifact sha256, and the re-download button. Because payment is on-chain, the receipt is also the proof — link the tx on Basescan. No email needed (NG7); the page is the receipt.

### 2. Distinct "why you lost access" pages instead of a generic 404/403
`app/controllers/url_redirects_controller.rb` `check_permissions` — refunded, revoked, expired each land on their own page with one sentence of explanation. Our only revocation path is takedown (FR-39); a buyer hitting `/api/r/…` after a takedown should get a page saying "This listing was removed following a takedown notice on {date}; your payment was refunded to {wallet} in tx {hash}". We have all that data. Half a day.

### 3. Snapshot the terms/licence onto the entitlement
`app/models/purchase_refund_policy.rb` copies the refund policy onto the purchase at checkout so the buyer's terms are frozen. We already snapshot the artifact (sha256) — extend that to snapshot `licence` and the terms version (`/api/terms` presumably has one) onto the entitlement row. Makes item 1 honest and settles later disputes for free.

### 4. `content_updated_at` on the listing, and "updated since you bought" in `/purchases`
`app/modules/with_product_files.rb:117` bumps a timestamp whenever content changes; the library sorts by it. We cut versions from tags, so we know this exactly. On `/purchases`, show "v1.4 available (you own v1.2) — $3 update" per row, sorted by newest update. This is the pull-based update economy of D1 made visible without any notification infra (NG7 stays intact).

### 5. Product table: totals footer row + sales count links to the ledger
`app/javascript/components/ProductsPage/ProductsTable.tsx`. Columns: name with public URL as a small second line, Sales, Revenue, Price, Status; footer row sums Sales and Revenue; the Sales number links to the earnings ledger filtered to that listing. Our `/dashboard` is currently a list; this is an afternoon and makes it feel like a business.

### 6. "Can't publish without a bound wallet" banner, stacked above the dashboard
`app/javascript/components/DashboardPage.tsx` shows "You haven't connected a payout method yet, so you won't be able to publish products until you do" with a direct link. Check whether we already block publish on no-wallet; if we do, surface it as a banner rather than a publish-time error. If we don't, we should — a listing that sells with nowhere to sweep to is a support ticket.

### 7. Getting-started checklist on the empty dashboard
Same file. Cards: connect GitHub / bind wallet / create listing / publish / first sale / first sweep, each with a `completed` predicate over data we already have; hides itself when all done; minimise state in `localStorage`. Our dashboard empty state is "the whole page" per the comment in `app/dashboard/page.tsx` — this replaces it with something that tells a creator exactly what's left.

### 8. Sticky CTA bar via IntersectionObserver
`app/javascript/components/Product/Layout.tsx` `CtaBar`: when the main buy button scrolls out, a fixed bar appears with price + name + CTA. We have a mobile sticky buy bar; Gumroad does it on desktop too (top-anchored) and triggers on visibility rather than viewport width. Small refinement.

### 9. Collapsible description with the full HTML kept in DOM
`app/javascript/components/Product/CollapsibleDescription.tsx` — mobile clamp at 400px with gradient mask and "Read more"; the full text stays server-rendered so SSR/SEO (and our `check:ssr`) are unaffected. Our README section is "clipped" — check that the clip is CSS, not truncation, so agents and crawlers get the whole thing.

### 10. Shareable pre-configured buy links
`useSelectionFromUrl` in `app/javascript/components/Product/index.tsx` reads `?version=`, `?price=` etc. For us: `?v=1.3` preselects a version on the listing page and the x402 endpoint. Trivial, and useful for creators linking from a changelog.

### 11. Permalink rename with redirect
`app/models/link.rb:191-218` — custom permalink with uniqueness + old-slug redirect on rename. Do we redirect when a creator changes a slug? If not, it's a 301 lookup on a `previous_slugs` column; every external link to a listing otherwise dies silently.

---

## Tier 2 — worth a PRD line, then build

### 12. Access-token verbs on the entitlement: `revoke` / `undo_revoke`, plus a named-reasons hash
`app/models/license.rb` and `PUT /v2/sales/:id/revoke_access` / `undo_revoke_access`. Today our only revocation is takedown. Adding an explicit, logged, reversible `revoked_at` with a `revoke_reason` enum (takedown, chargeback-equivalent, operator) costs nothing now and is what FR-39 "it is logged" wants. Gumroad's habit of returning *hashes of named reasons* rather than booleans (`recommendable_reasons` in `app/modules/product/recommendations.rb`) is the right shape for our `contradiction notices` and publish blockers too — one source of truth that both the UI and the API error body read from.

### 13. The suspension safety rail
`app/modules/user/risk.rb` `refuse_unauthorized_suspension_clear`: any transition back to "compliant" must explicitly pass `clear_suspension: true`, checked under a row lock, because an unrelated review once silently un-suspended a pirated-content seller for 8 days. Our repeat-infringer retire (FR-39) should have the same guard: nothing but an explicit operator action with a reason can un-retire.

### 14. Exponential-backoff rate limiting, keyed by the right thing
`config/initializers/rack_attack.rb` `throttle_with_exponential_backoff` — one declaration yields tiers where limit = rpm × level over 8^level seconds. Two lessons in the file's comments apply directly: match paths by regex so `.json` variants don't get their own budget, and throttle by *target* (for us: per-listing on `/api/r/`, per-wallet on `/api/auth/challenge`) as well as by IP. We have per-creator caps (D2c) but I found no request-rate limiting on the API surface.

### 15. Email/identity normalisation in blocklists
`app/models/blocked_customer_object.rb` `comparable_email` strips `+tags` and dots before matching. Our abuse-contact and any future creator-blocklist should normalise the same way; for wallets the analogue is checksum-insensitive comparison, which is worth a grep to confirm we do everywhere.

### 16. Webhook SSRF defence and a "test ping" button
`app/models/resource_subscription.rb` `valid_post_url?` resolves the hostname and rejects reserved ranges at create time *and* again at delivery. We have an HMAC abuse webhook (FR-41) and creator-configurable URLs; make sure the outbound URL is validated the same way. The per-sale "re-ping" button (`app/controllers/purchases/pings_controller.rb`) is a nice touch if we ever add creator sale webhooks (NG7-adjacent — a pull-side ping to the creator's own URL is arguably not "notifications infra", but it needs a PRD sentence).

### 17. Edge-cache legal/marketing pages only when the request carries no cookies
`app/controllers/home_controller.rb` `EDGE_CACHEABLE_ACTIONS`. Our `/`, `/how-it-works`, `/docs`, `/terms` are static-ish; if any of them set a session cookie unconditionally, they can't be edge-cached. Worth a check in the Vercel deployment.

### 18. `/features.md` served as `text/markdown`
`FeaturesMarkdownGenerator` — a markdown version of the marketing page for LLM consumption. We're agent-first; a `/llms.txt` or `/docs.md` that mirrors `/docs` is the same idea and costs nothing given the docs are already markdown-ish.

### 19. Balance as a state machine with "amounts only change while unpaid"
`app/models/balance.rb` — one row per (creator, day, currency), `unpaid → processing → paid`, and a validation that the amount is immutable once it leaves `unpaid`. Our ledger + holdback + sweep probably already behaves like this; the validation is the part worth copying because it turns a class of double-sweep bugs into a DB error.

### 20. Payout period as an itemised ledger card, reused for next / in-flight / past
`app/javascript/components/Payouts/index.tsx` `Period`. Our `/dashboard/earnings` has a single "Sales" section. A "Next sweep" card (sales − 10% − holdback still locked = sweepable now) plus one card per past sweep with the tx hash, each with "Download CSV", is the layout creators expect, and the data is all in the ledger.

---

## Off the table (PRD non-goals) — noted so we don't relitigate them by accident

| Gumroad feature | Blocked by | Note |
|---|---|---|
| Discover, taxonomy, sort keys, `is_recommendable` gate | NG1 | The `is_recommendable` *shape* (named reasons) is still worth copying — item 12 |
| Reviews, ratings histogram, seller reputation line | NG2 | |
| Creator profile sections, theme, custom domains | NG2 | `/[owner]` explicitly refuses this |
| Email broadcasts, workflows, "notify customers of changes" alert | NG7 | Item 4 gets most of the value without email |
| Affiliates (basis points, per-product) | NG9 | 10% only; affiliate cut would be a second revenue mechanism |
| Discover fee (30% when the platform found the buyer) | NG1, NG9 | Interesting model if NG1 is ever revisited; the "you only pay more when *we* found the buyer" framing is the honest version of a marketplace fee |
| Offer/discount codes | not an NG, but nothing asks for it | Cheap model (`app/models/offer_code.rb`: percent *or* cents, max uses, valid_at/expires_at, per-product). Price-presets already cover "$0 for a while". Skip unless a creator asks |
| Pay-what-you-want, PPP, buyer-local currency | not needed | Single currency, micro-USDC |
| Gift purchases, custom fields, upsell modals | no | |
| Embed/overlay widgets | partially covered by `/api/snippet` | A `<script>`-free `<a href>` buy link with `?v=` (item 10) is the sane subset |

---

## Two engineering habits from the repo, independent of any feature

- **Every risk/admin action writes a `Comment` row** with `author_id` *or* `author_name`, so system jobs are attributable. We log takedowns (FR-39); a single `audit_log` table with the same author-or-name column would cover takedown, retire, sweep, rebind, and key reissue uniformly.
- **The code comments explain the incident that caused the rule.** `MAX_FAILED_FINGERPRINTS = 4` comes with the story; the unblock-scoped-to-buyer fix quotes "71% of hand-unblocked buyers were still blocked". Our PRD does this in the decision table; worth continuing at the code level for things like `HOLDBACK_DAYS`.

## Suggested order

1, 4, 5, 6, 7 first (one or two days total, all inside current PRD scope, all visible to users). Then 2 + 3 + 12 together as "the entitlement knows its own history". 14 and 16 before the FR-34 end-to-end is called done, since they're the cheapest hardening on the headless rail. The rest as they come up.
