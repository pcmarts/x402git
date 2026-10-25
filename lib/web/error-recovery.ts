/**
 * lib/web/error-recovery.ts — the way out of each error, one line per code.
 *
 * Not a restatement of `ERRORS[code].message` (lib/errors.ts): an error that names the
 * problem but not the recovery is half an error. The message is the platform's; this is
 * the instruction to the caller.
 *
 * It lives here, not in the page, because it now has two readers — /docs/errors renders
 * it as HTML and lib/web/markdown.ts renders it as markdown for `Accept: text/markdown`
 * — and a second copy of a recovery line is how the two readings start disagreeing
 * about what to do next. `Partial`, so a new code compiles before its recovery is
 * written; both readings simply print the message alone until it is.
 */

import type { ERRORS } from "@/lib/errors";

export const RECOVERY: Partial<Record<keyof typeof ERRORS, string>> = {
  insufficient_balance: "Fund the payer address with USDC on the network named in the 402 and retry.",
  expired_authorization: "Request the resource again to get a fresh 402, then sign that one.",
  replay: "The authorization was already settled. Re-fetch the resource; the existing purchase is returned.",
  settlement_pending: "Verification succeeded but settlement has not confirmed. Retry with the same authorization.",
  settlement_timeout: "Retry with the same authorization. It has not been consumed.",
  authorization_mismatch: "The signed amount, listing or version does not match the quote. Take a fresh 402.",
  price_changed: "A fresh 402 is attached to the response. Sign that one.",
  sanctioned_counterparty: "No retry will succeed. Contact the abuse address if you believe this is wrong.",
  listing_not_ready: "The `blocking` array names what is missing. Fix each, then publish again.",
  // Retained for the published error catalogue; no route has emitted it since the
  // licence gate came off (2026-09-02).
  licence_block: "No longer returned. A missing or unrecognised licence does not block publishing or selling.",
  // The blocking set is named in full since "PRD Trust Report.md" §4.1 (13 Sep 2026)
  // added two members to it, and the report that says which one fired is now readable:
  // GET /api/listings/{id} carries `scan_report` on the release it belongs to.
  scan_failed:
    "The scan found one of the five things that block a release — a secret, a HIGH or CRITICAL dependency CVE, a dependency known to be malicious, hidden-Unicode instruction smuggling in a text or tool-description file, or a size-limit breach. `scan_report` on GET /api/listings/{id} names the finding, its rule and its path and line. Fix it in the repository and cut a new version: the verdict is terminal, so the same version cannot be re-scanned.",
  version_exists: "Tags are immutable here. Cut a new release rather than moving the tag.",
  description_missing: "PATCH the listing with a description and a trigger hint, then publish.",
  retired: "This listing is no longer sold. Holders can still fetch every version they own.",
  not_entitled: "This wallet has not bought that version. Fetch the resource to be quoted a price.",
  derivative_of: "The artifact overlaps an existing listing by 90% or more. It cannot be published.",
  public_repo: "Only private repositories can be listed. Make the repository private on GitHub, then create the listing again.",
  invalid_key:
    "Check the `Authorization: Bearer x4c_live_…` header, or rotate the agent key with a wallet signature. A website session key returns this once it expires or you sign out — sign in again.",
  insufficient_scope: "Rotate the key to get one carrying the scope this route needs.",
  step_up_required: "Sign a fresh challenge from the bound payout address and send it as `step_up`.",
  terms_version_stale: "Fetch GET /api/terms and accept the version it returns.",
  payout_address_unverified: "GET /api/auth/challenge?address=…&purpose=address_proof, sign the message, and resend it as `address_proof`.",
  invite_required: "API registration needs an invite code in this version.",
  invalid_signature: "The nonce is unknown, expired, already used, or the signature does not recover to that address. Take a new challenge.",
  rate_limited: "Wait `retry_after_seconds` and retry. The window is fixed, not sliding.",
  repo_too_large: "The cap is 200 MB and 20,000 files. Trim the repository or split the listing.",
  too_many_unpublished: "Publish or retire an existing draft first.",
  blocked_jurisdiction: "This service is not available where the request originated.",
  invalid_request: "The `details.issues` array names the field and the reason for each failure.",
  not_found: "Check the owner, slug and version. Draft listings are not readable by their URL.",
  internal: "Retry. If it persists, the error is ours and the request id in the response headers identifies it.",
};
