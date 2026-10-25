/**
 * lib/openapi/routes.ts — every route in PRD §9, registered.
 *
 * Routes that are not built yet are registered anyway, marked `status: "planned"`.
 * That is the point: the OpenAPI document is the contract the rest of the build works
 * against, and D9 says the API exists before its UI. When you implement one, change
 * `status` to "live" and correct the schemas if reality differed.
 *
 * Importing this module has the side effect of registering. `lib/openapi.ts` imports it.
 */

import * as z from "zod";
import {
  ChallengeResponse,
  CreateCreatorRequest,
  CreateCreatorResponse,
  CreateListingRequest,
  CreateListingResponse,
  CreatorMeResponse,
  DeleteRepoRequest,
  DeleteRepoResponse,
  EarningsResponse,
  EntitlementsResponse,
  LicenceRequest,
  LicenceResponse,
  ListingListResponse,
  ListingResponse,
  Manifest,
  PublishBlockingReason,
  PatchListingRequest,
  PaymentRequiredBody,
  PublishResponse,
  ReleaseLogResponse,
  ResourceGrantResponse,
  RetireResponse,
  RotateKeyRequest,
  RotateKeyResponse,
  SshKeyRequest,
  SshKeyResponse,
  SweepResponse,
  SyncRequest,
  SyncResponse,
  TermsResponse,
  UpdateCreatorRequest,
  UpdateCreatorResponse,
  VersionResponse,
} from "@/lib/schemas";
import { PAYMENT_REQUIRED_EXAMPLE_NEW, PAYMENT_REQUIRED_EXAMPLE_UPDATE } from "./examples";
import { registerRoute } from "./registry";

// The examples are a live listing (docs/EXAMPLES.md): a crawler that fills the template
// from them reaches a real 402, which is how x402scan decides the route is x402-paid.
const owner = { name: "owner", in: "path", required: true, description: "The creator handle.", example: "examples" } as const;
const slug = { name: "slug", in: "path", required: true, description: "The listing slug.", example: "humanizer" } as const;
const id = { name: "id", in: "path", required: true, description: "The listing id.", schema: z.uuid() } as const;
const cursor = { name: "cursor", in: "query", description: "Opaque pagination cursor from `next_cursor`." } as const;

// ---------------------------------------------------------------------------
// Public / buy side
// ---------------------------------------------------------------------------

registerRoute({
  method: "get",
  path: "/{owner}/{slug}",
  summary: "The manifest page",
  description: "Server-rendered HTML (§14.1). The text is in the server response, not fetched by script.",
  tags: ["public"],
  params: [owner, slug],
  responses: [{ status: 200, description: "The manifest page", contentType: "text/html" }],
  errors: ["not_found"],
});

registerRoute({
  method: "get",
  path: "/api/label/{owner}/{slug}",
  summary: "The public manifest",
  description: "Free, cacheable, unauthenticated. Computed fields and self-reported fields are separately namespaced (FR-52).",
  params: [owner, slug],
  response: Manifest,
  errors: ["not_found", "rate_limited"],
});

registerRoute({
  method: "get",
  path: "/api/v/{owner}/{slug}",
  summary: "Latest version and prices",
  description:
    "With a valid `X-Wallet-Signature` this also returns `owned`, `entitled` and `price_kind`. Without one it is version data only: `?address=` alone never reveals entitlement state (FR-20). `scan` is the latest release's trust report in three numbers (\"PRD Trust Report.md\" §5) — absent, never zeroed, when there is no report to read.",
  auth: "walletSignature",
  params: [owner, slug],
  response: VersionResponse,
  errors: ["not_found", "invalid_signature", "rate_limited"],
});

registerRoute({
  method: "get",
  path: "/api/v/{owner}/{slug}/releases",
  summary: "The public release log",
  description:
    "FR-15. Every release, with changelog, diff summary, scan verdict and the prices in force. Creators cannot delete entries, failing releases are published too, and a retired listing keeps its log (FR-43). Pages newest-first by `cursor`.",
  params: [owner, slug, cursor],
  response: ReleaseLogResponse,
  errors: ["not_found", "rate_limited"],
});

/**
 * `x-payment-info` — what an x402 indexer reads off an OpenAPI operation to know it is
 * paid. x402scan's crawler (`@agentcash/discovery`) reads `GET /openapi.json` at the
 * origin — next.config.ts serves this document there too — and wants the structured
 * form: `protocols` as objects keyed by protocol, `price` with a `mode`. A bare
 * `["x402"]` is its legacy form and draws a warning. The price is per listing and per
 * buyer, so it is `dynamic`; the 402 itself carries the number.
 */
const X_PAYMENT_INFO = {
  "x-payment-info": {
    protocols: [{ x402: {} }],
    price: { mode: "dynamic", currency: "USD" },
    description: "The price is per listing and is quoted in the 402; a holder re-fetches for free. Every live resource is listed at /.well-known/x402.",
  },
} as const;

registerRoute({
  method: "get",
  path: "/api/r/{owner}/{slug}",
  summary: "Buy or fetch the latest release",
  description:
    "402 then 200. Send the payment authorization in `PAYMENT-SIGNATURE`; access is granted only after the facilitator's `settle` returns a transaction hash (FR-22). A free listing returns 200 immediately (FR-24), as does a holder whose purchase was stamped `all_versions` (FR-16).",
  extensions: X_PAYMENT_INFO,
  auth: "walletSignature",
  params: [
    owner,
    slug,
    { name: "PAYMENT-SIGNATURE", in: "header", description: "The base64 x402 v2 payment payload. Absent on the first request; present on the paying one." },
    {
      name: "X-Quote-Id",
      in: "header",
      description:
        "FR-23. Echo `extra.quote_id` from the 402 you are paying against. **Required for priced listings** (any price above zero); a priced buy that omits it is rejected `price_changed`. A quote that is no longer current also returns `409 price_changed` with a fresh 402 in `details.payment_required`.",
    },
  ],
  responses: [
    { status: 200, description: "Granted. `download_url` is signed and expires in 5 minutes.", schema: ResourceGrantResponse },
    {
      status: 402,
      description:
        "Payment required. Also sent in the `PAYMENT-REQUIRED` header. For a **priced** listing you must echo `extra.quote_id` from this body back as the `x-quote-id` request header on the paying request — it is **required** when the price is above zero, and a priced buy that omits it is rejected `price_changed` (FR-23). Free ($0) grants do not need it.",
      schema: PaymentRequiredBody,
      // FR-21: one canonical example per kind.
      examples: { new: PAYMENT_REQUIRED_EXAMPLE_NEW, update: PAYMENT_REQUIRED_EXAMPLE_UPDATE },
    },
  ],
  errors: [
    "not_found",
    "retired",
    "invalid_signature",
    "insufficient_balance",
    "expired_authorization",
    "replay",
    "settlement_pending",
    "settlement_timeout",
    "authorization_mismatch",
    "price_changed",
    "sanctioned_counterparty",
    "blocked_jurisdiction",
    "rate_limited",
  ],
});

registerRoute({
  method: "get",
  path: "/api/r/{owner}/{slug}/v/{version}",
  summary: "Re-fetch a version you own",
  description: "FR-19 / FR-46. Owned versions stay fetchable forever, including after the listing retires.",
  auth: "walletSignature",
  params: [owner, slug, { name: "version", in: "path", required: true, description: "e.g. 1.2.0" }],
  response: ResourceGrantResponse,
  errors: ["not_found", "not_entitled", "invalid_signature", "rate_limited"],
});

registerRoute({
  method: "get",
  path: "/api/entitlements",
  summary: "What this wallet owns",
  description: "FR-32. Requires `X-Wallet-Signature`: entitlement state is never disclosed without a signature (FR-40).",
  auth: "walletSignature",
  params: [cursor],
  response: EntitlementsResponse,
  errors: ["invalid_signature", "rate_limited"],
});

registerRoute({
  method: "get",
  path: "/api/auth/challenge",
  summary: "Get a challenge to sign",
  description:
    "FR-20. Single use, 5-minute expiry. A challenge is bound to one `purpose` — `address_proof` on registration, `step_up` on a payout change, `rotate_key`, or `wallet_ownership` for the `X-Wallet-Signature` header — and a signature is refused on any other path (W2.2). `purpose` is required; there is no default. A payout rebind additionally requires `new_payout_address`: the signed message names the incoming address, and the signature authorises that one change only.",
  params: [
    { name: "address", in: "query", required: true, description: "The address that will sign." },
    {
      name: "purpose",
      in: "query",
      required: true,
      description: "The action this signature authorises: `address_proof`, `step_up`, `rotate_key`, or `wallet_ownership`.",
    },
    {
      name: "new_payout_address",
      in: "query",
      required: false,
      description: "For a `step_up` challenge that will authorise a payout rebind: the address payouts should move to. The signed message names it, and PATCH /api/creators/me refuses a rebind signed without it.",
    },
  ],
  response: ChallengeResponse,
  errors: ["invalid_request", "rate_limited"],
});

registerRoute({
  method: "get",
  path: "/api/terms",
  summary: "The creator agreement and the buyer terms",
  description: "FR-6 and §19. `accepted_terms_version` on POST /api/creators must equal the top-level `version`. `buyer_terms` carries the same three fields for the terms a buyer is bound by.",
  response: TermsResponse,
});

registerRoute({
  method: "get",
  path: "/api/openapi.json",
  summary: "This document",
  description: "FR-33. Generated from the zod schemas.",
  responses: [{ status: 200, description: "An OpenAPI 3.1 document" }],
});

registerRoute({
  method: "get",
  path: "/api/health",
  summary: "Is the platform answering",
  description:
    "One cheap round trip to the database, the dependency every paid path shares. `status` is `ok` or `degraded`; the facilitator, GitHub and Storage are deliberately not probed. Never cached. This is the `status` target in /.well-known/api-catalog.",
  responses: [{ status: 200, description: "`{ status, checks: { database }, latency_ms, time }`" }],
});

registerRoute({
  method: "get",
  path: "/.well-known/api-catalog",
  // Explicit: the derived id would carry the dot from `.well-known` and some clients
  // generate method names straight from it.
  operationId: "getWellKnownApiCatalog",
  summary: "Where to start, if nobody told you",
  description:
    "RFC 9727. A linkset (`application/linkset+json`) naming this document, `/docs` and `/api/terms`, anchored on the API and on the MCP server. The home page and every manifest page carry RFC 8288 `Link` headers pointing here, so an agent needs one HEAD request and no prior knowledge of §9.",
  responses: [{ status: 200, description: "A linkset", contentType: "application/linkset+json" }],
});

registerRoute({
  method: "get",
  path: "/api/snippet/{owner}/{slug}",
  summary: "The README snippet",
  description:
    "FR-30. The paste-ready preamble that tells a downstream agent to check `GET /api/v/…` before each run, as `text/markdown`. The wording differs for `update_price_micro = 0` (updates included) and `> 0`.",
  params: [owner, slug],
  responses: [{ status: 200, description: "The snippet", contentType: "text/markdown" }],
  errors: ["not_found", "rate_limited"],
});

registerRoute({
  method: "post",
  path: "/api/mcp",
  summary: "Buy-side MCP server (Streamable HTTP)",
  description:
    "FR-31. JSON-RPC 2.0 over Streamable HTTP, stateless. Six tools: `search_listings` (free, no wallet: live listings by what they do, each result carrying the `owner` and `slug` the other tools take and its `payment_options` — the networks and tokens it can be paid in, so an agent can filter to what it can pay), `how_to_buy` (free, no wallet: whether the listing is for sale, the price, its `payment_options`, the listing page, the skill and the endpoint — the tool a client that cannot sign answers with; pass `network` and it answers `cannot_pay: true` with the options that exist when none is yours), `get_listing` (wraps `GET /api/label/:owner/:slug`), `check_version` (wraps `GET /api/v/:owner/:slug`), `purchase` (wraps `GET /api/r/:owner/:slug`; takes a pre-signed `PAYMENT-SIGNATURE` and returns the 402 body as structured content when unpaid) and `fetch_release` (wraps `GET /api/r/:owner/:slug/v/:version`). The last four call the same core module (§11); purchases are recorded with `source: mcp`. A request body may be at most 64 KiB (413 above that) and a JSON-RPC batch at most 10 messages (400 above that); each message in a batch counts against the rate limit, and a batch that does not fit is refused whole. `GET` is 405: the server is stateless and offers no server-to-client stream. Connect with `npx @modelcontextprotocol/inspector --transport http --server-url ${APP_URL}/api/mcp`.",
  params: [
    { name: "Accept", in: "header", required: true, description: "Must list both `application/json` and `text/event-stream`." },
    { name: "MCP-Protocol-Version", in: "header", description: "Sent by the client on every request after `initialize`." },
  ],
  responses: [{ status: 200, description: "A JSON-RPC response", contentType: "application/json" }],
  errors: ["rate_limited"],
});

// ---------------------------------------------------------------------------
// Creator
// ---------------------------------------------------------------------------

registerRoute({
  method: "post",
  path: "/api/creators",
  summary: "Register (headless)",
  description:
    "FR-2. Send `Idempotency-Key: <uuid>` and the identical 201 replays for 24 hours, so a dropped response does not strand you without your API key. Rate limit: 5 per hour per IP.",
  params: [{ name: "Idempotency-Key", in: "header", description: "A uuid. Replays the identical 201 for 24 hours." }],
  request: CreateCreatorRequest,
  responses: [{ status: 201, description: "Registered. `api_key` is shown once.", schema: CreateCreatorResponse }],
  errors: ["invalid_request", "payout_address_unverified", "terms_version_stale", "invite_required", "sanctioned_counterparty", "blocked_jurisdiction", "rate_limited"],
});

registerRoute({
  method: "get",
  path: "/api/creators/me",
  summary: "The authenticated creator",
  auth: "apiKey",
  response: CreatorMeResponse,
  errors: ["invalid_key", "rate_limited"],
});

registerRoute({
  method: "patch",
  path: "/api/creators/me",
  summary: "Change payout address or abuse contact",
  description:
    "FR-5. Both need `step_up` — a signature from the *currently* bound payout address — except adding a payout rail the account has no address on yet (`stellar_payout_address` with `stellar_proof` on an EVM account, `payout_address` with `payout_proof` on a Stellar-only one), which from a dashboard session key needs only that proof and is live at once. A payout change must be signed over a challenge minted with `new_payout_address=<the new address>` on GET /api/auth/challenge, so the signature names where the money will go. A payout change takes effect at once, or after the configured rebind delay and sweeps continue to the old address until then; an abuse-contact change also takes 48 hours and is announced to the old contact.",
  auth: "apiKey",
  request: UpdateCreatorRequest,
  response: UpdateCreatorResponse,
  errors: ["invalid_request", "invalid_key", "step_up_required", "payout_address_unverified", "sanctioned_counterparty", "rate_limited"],
});

registerRoute({
  method: "post",
  path: "/api/auth/rotate-key",
  summary: "Rotate the API key with a wallet signature",
  description: "FR-4. No Authorization header: the signature from the bound payout address is the credential. The old key is revoked immediately.",
  request: RotateKeyRequest,
  response: RotateKeyResponse,
  errors: ["invalid_request", "invalid_signature", "not_found", "rate_limited"],
});

registerRoute({
  method: "post",
  path: "/api/listings",
  summary: "Create a listing",
  description:
    "Rail B (`source: hosted`) provisions a private repo and adds `ssh_public_key` as a write deploy key for that repo only (FR-7, §14.6); the 201 carries the remote, the default branch and github.com's SSH host key fingerprints so the next call is `git push`. Rail A (`source: github`) needs `installation_id` plus either `github_repo_id` or `repo: \"owner/name\"`, and the repository must be **private** — a public one is refused with `422 public_repo` (FR-10). Caps: 3 unpublished listings per creator (D2c). Open releases (25 Oct 2026): `open_release: true` with `public_repo_url` and `open_after_days` sells each release early from this private repository and promises it goes public in that other, public one that many days after it is cut; the repository being sold is still private and still refused if public. `offered_networks` (25 Oct 2026) sells the listing on only those CAIP-2 networks, each one this deployment serves and the creator can be paid on; omitted or `null` is every rail they can be paid on.",
  auth: "apiKey",
  request: CreateListingRequest,
  responses: [{ status: 201, description: "Created, in `draft`.", schema: CreateListingResponse }],
  errors: ["invalid_request", "invalid_key", "insufficient_scope", "invite_required", "not_found", "public_repo", "too_many_unpublished", "rate_limited"],
});

registerRoute({
  method: "get",
  path: "/api/listings",
  summary: "Your listings",
  description: "The authenticated creator's own listings, newest first. Every entry carries the same `pricing` block as GET /api/listings/{id} (FR-13).",
  auth: "apiKey",
  params: [cursor, { name: "limit", in: "query", description: "1-100. Defaults to 50." }],
  response: ListingListResponse,
  errors: ["invalid_request", "invalid_key", "rate_limited"],
});

registerRoute({
  method: "get",
  path: "/api/listings/{id}",
  summary: "Listing status, licence, latest release, pricing",
  description:
    "`latest_release` is the newest release with `scan = pass` (FR-9), and `newest_release` is the newest of any verdict when the two differ — the release that failed is the one whose report a creator needs. Both carry `scan_report`, the full trust report including the path and line of a secret (\"PRD Trust Report.md\" §4.4); it is served here and nowhere else, and never on the list route. Another creator's id returns 404, never 403.",
  auth: "apiKey",
  params: [id],
  response: ListingResponse,
  errors: ["invalid_request", "invalid_key", "not_found", "rate_limited"],
});

registerRoute({
  method: "patch",
  path: "/api/listings/{id}",
  summary: "Change price, update price, description, trigger hint, offered networks or the open-release promise",
  description:
    "FR-16: price changes apply to future purchases only. Explicit API values are never rounded (FR-12). Open releases (25 Oct 2026): `open_release: true` with `public_repo_url` (a different, public repository — never the one being sold) and `open_after_days` (1 to 90) makes every cut from now on an open release that goes public that many days after it is cut. Like a price, the number applies to future cuts only: a release already cut keeps the `opens_at` it was sold with. `offered_networks` (25 Oct 2026) chooses which rails the listing is sold on, each one this deployment serves and the creator can be paid on, and the 402's `accepts` and `payment_options` follow at once; `null` goes back to every rail.",
  auth: "apiKey",
  params: [id],
  request: PatchListingRequest,
  response: ListingResponse,
  errors: ["invalid_request", "invalid_key", "insufficient_scope", "not_found", "retired", "rate_limited"],
});

registerRoute({
  method: "post",
  path: "/api/listings/{id}/sync",
  summary: "Cut a version now",
  description:
    "FR-8. Also the recovery path for a dropped webhook, and the only path for a tag pushed before the listing existed. With no `ref` and no `version`, cuts the repository's newest `vX.Y.Z` tag that has not been cut yet; `version` is required when a `ref` is given and that ref is untagged.",
  auth: "apiKey",
  params: [id],
  request: SyncRequest,
  responses: [{ status: 202, description: "Accepted; analysis, snapshot and scan follow.", schema: SyncResponse }],
  errors: ["invalid_request", "invalid_key", "insufficient_scope", "not_found", "retired", "version_exists", "repo_too_large", "rate_limited"],
});

registerRoute({
  method: "post",
  path: "/api/listings/{id}/licence",
  summary: "Commit an allow-listed LICENSE (Rail B)",
  description: "FR-11. MIT, Apache-2.0, BSD-3-Clause or MPL-2.0, committed to `main`. The attestation is made by the registering operator (D4).",
  auth: "apiKey",
  params: [id],
  request: LicenceRequest,
  response: LicenceResponse,
  errors: ["invalid_request", "invalid_key", "insufficient_scope", "not_found", "retired", "rate_limited"],
});

registerRoute({
  method: "put",
  path: "/api/listings/{id}/ssh-key",
  summary: "Rotate the deploy key",
  description: "FR-7 / FR-5. Step-up required. One public key, one repo (§14.6): the new key is added before the old one is removed.",
  auth: "apiKey",
  params: [id],
  request: SshKeyRequest,
  response: SshKeyResponse,
  errors: ["invalid_request", "invalid_key", "insufficient_scope", "step_up_required", "not_found", "retired", "rate_limited"],
});

registerRoute({
  method: "post",
  path: "/api/listings/{id}/publish",
  summary: "Publish: draft → live",
  description:
    "FR-42. Needs a licence pass, at least one passing release, a description, and — on Rail A — a repository that is still private (FR-10). A 409 `listing_not_ready` carries `details.blocking[]` with every unmet requirement at once. Publishing a live listing is an idempotent 200.",
  auth: "apiKey",
  params: [id],
  responses: [
    { status: 200, description: "Live.", schema: PublishResponse },
    {
      status: 409,
      description: "Not ready. `details.blocking[]` lists every unmet requirement.",
      schema: z
        .object({ code: z.literal("listing_not_ready"), message: z.string(), docs_url: z.string(), details: z.object({ blocking: z.array(PublishBlockingReason) }) })
        .meta({ id: "ListingNotReady" }),
    },
  ],
  // Every unmet requirement is reported as `listing_not_ready` with `details.blocking[]`
  // (documented in the 409 above), never as a bare `licence_block` / `scan_failed` /
  // `description_missing`. Listing codes the handler cannot emit are not listed here.
  errors: ["invalid_key", "insufficient_scope", "not_found", "retired", "listing_not_ready", "rate_limited"],
});

registerRoute({
  method: "delete",
  path: "/api/listings/{id}",
  summary: "Retire (stop selling)",
  description: "FR-43. Terminal. Holders keep every version they own; the manifest and release log stay up, marked no longer sold. A hosted repo is archived, not deleted.",
  auth: "apiKey",
  params: [id],
  response: RetireResponse,
  errors: ["invalid_key", "insufficient_scope", "not_found", "retired", "rate_limited"],
});

registerRoute({
  method: "delete",
  path: "/api/listings/{id}/repo",
  summary: "Delete the hosted repo",
  description: "FR-44. Step-up required. Releases with at least one purchase are retained — they are the product (FR-46).",
  auth: "apiKey",
  params: [id],
  request: DeleteRepoRequest,
  response: DeleteRepoResponse,
  errors: ["invalid_request", "invalid_key", "insufficient_scope", "step_up_required", "not_found", "rate_limited"],
});

registerRoute({
  method: "get",
  path: "/api/earnings",
  summary: "The ledger view",
  description:
    "FR-29. Sale rows carry version, kind, amount and time — never the buyer address, never the transaction hash (FR-40) — and the rail they settled on: `network` (CAIP-2) and `asset_symbol` (`USDC`, `USDT0`). `by_rail` splits the totals the same way, one entry per network and token: each sale is paid out on the network and in the token it was paid in, so that is where it lands.",
  auth: "apiKey",
  params: [cursor],
  response: EarningsResponse,
  errors: ["invalid_key", "insufficient_scope", "rate_limited"],
});

registerRoute({
  method: "post",
  path: "/api/payouts/sweep",
  summary: "Force a sweep of the released balance",
  description:
    "FR-26. Payouts go only to the bound payout address; there is no `to` parameter. Normally the daily cron does this and you never call it. Without `?network=` every EVM rail is swept (Base USDC, Arbitrum USDT0, …), each in the token its sales were paid in; `?network=eip155:<chainId>` sweeps one EVM rail and `?network=stellar:pubnet` (or `stellar:testnet`) the Stellar one. The body is the first rail's sweep; `rails` beside it lists every rail swept with its `network`, `asset_symbol` and, when nothing moved, `skipped` (`nothing_to_sweep`, `no_gas_float`, `payout_in_flight`, …).",
  auth: "apiKey",
  response: SweepResponse,
  errors: ["invalid_key", "sanctioned_counterparty", "rate_limited"],
});

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

registerRoute({
  method: "post",
  path: "/api/webhooks/github",
  summary: "GitHub webhook",
  description:
    "FR-8. `push` (version tags), `release` (published), `installation` and `installation_repositories`. The signature is verified over the raw body; deliveries older than 5 minutes are refused; `X-GitHub-Delivery` is deduplicated; the listing is resolved by installation and repo id, never by name. Every outcome after a valid signature is a 2xx, so a failure never teaches GitHub to disable the hook.",
  tags: ["internal"],
  responses: [
    { status: 200, description: "Handled: a release was cut, listings were retired, or the delivery was a duplicate." },
    { status: 202, description: "Accepted but not acted on: unknown listing, stale delivery, ignored event, or a refusal such as `version_exists`." },
  ],
  errors: ["invalid_signature"],
});

registerRoute({
  method: "get",
  path: "/api/cron/sweep",
  summary: "Daily sweep",
  description:
    "FR-26 / FR-28. Vercel Cron. Every creator with a released balance, on every EVM rail, from the one sweep wallet; `?network=eip155:<chainId>` runs one rail. A rail whose sweep wallet holds no native gas is skipped (`no_gas_float`) before any payout row is written.",
  tags: ["internal"],
  responses: [{ status: 200, description: "Swept" }],
});

registerRoute({
  method: "get",
  path: "/api/cron/promises",
  summary: "Daily open-release promise check",
  description:
    "Open releases (25 Oct 2026). Every release whose `opens_at` has passed and whose promise is still `pending` is checked once against its public repository: the release commit must be reachable there under the same licence. The verdict is written with evidence. The same check also runs when a listing is read, so this covers the pages nobody visits. Vercel Cron.",
  tags: ["internal"],
  responses: [{ status: 200, description: "Checked" }],
});

registerRoute({
  method: "get",
  path: "/api/cron/reconcile",
  summary: "Daily reconciliation",
  description: "FR-28. Reconciles the receiving address's on-chain balance and every recorded tx hash against chain. Variance halts sweeps.",
  tags: ["internal"],
  responses: [{ status: 200, description: "Reconciled" }],
});
