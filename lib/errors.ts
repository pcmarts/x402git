/**
 * lib/errors.ts — the PRD §9 error catalogue, one place.
 *
 * Every error body on every route is `{ code, message, docs_url, details? }` (FR-33).
 * `docs_url` is `${NEXT_PUBLIC_APP_URL}/docs/errors#<code>`.
 *
 * Use it like this in a route handler:
 *
 *   export const POST = handle(async (req: NextRequest) => {
 *     const body = CreateCreatorRequest.parse(await req.json());  // ZodError → 400 invalid_request
 *     if (!ok) throw new ApiError("invite_required");
 *     return NextResponse.json(...);
 *   });
 */

import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { appUrl } from "@/lib/env";
import { notifyAdmin } from "@/lib/notify";

export type ErrorGroup = "payment" | "listing" | "auth" | "limits" | "generic";

export type ErrorSpec = { status: number; message: string; group: ErrorGroup };

/**
 * PRD §9 catalogue, verbatim in code order, plus four additions the PRD's prose
 * implies but the list omits (see DECISIONS.md 2026-08-29):
 *   invalid_signature (FR-20), blocked_jurisdiction (FR-38, 451),
 *   invalid_request / not_found / internal (the uniform fallbacks FR-33 needs).
 *
 * Plus `public_repo` (422), FR-10 as amended 2026-08-30: private repositories only.
 */
export const ERRORS = {
  // --- payment (§8.4) --------------------------------------------------------
  insufficient_balance: { status: 402, group: "payment", message: "The payer does not hold enough of the listing's asset to cover this price." },
  expired_authorization: { status: 402, group: "payment", message: "The payment authorization has expired. Request a fresh quote." },
  replay: { status: 409, group: "payment", message: "This payment authorization has already been used." },
  settlement_pending: { status: 402, group: "payment", message: "Payment verified but not yet settled. Access is granted only after settlement." },
  settlement_timeout: { status: 504, group: "payment", message: "Settlement did not confirm in time. Retry with the same authorization." },
  authorization_mismatch: { status: 400, group: "payment", message: "The payment authorization does not match this listing, version or amount." },
  price_changed: { status: 409, group: "payment", message: "The price changed since this quote was issued. A fresh 402 is attached." },
  sanctioned_counterparty: { status: 403, group: "payment", message: "This address appears on a sanctions list. No payment can be processed." },

  // --- listing (§8.2, §8.9) --------------------------------------------------
  listing_not_ready: { status: 409, group: "listing", message: "This listing cannot go live yet." },
  // Retained in the catalogue for compatibility; no route has emitted it since the
  // licence gate came off (2026-09-02, DECISIONS.md).
  licence_block: { status: 409, group: "listing", message: "No resale-compatible licence was found for this repository." },
  scan_failed: { status: 409, group: "listing", message: "The security scan failed for this release." },
  version_exists: { status: 409, group: "listing", message: "That version already exists for this listing." },
  description_missing: { status: 409, group: "listing", message: "A description and a trigger hint are required before publishing." },
  retired: { status: 410, group: "listing", message: "This listing is no longer sold." },
  not_entitled: { status: 403, group: "listing", message: "This wallet does not own that version." },
  derivative_of: { status: 409, group: "listing", message: "This artifact substantially overlaps an existing listing." },
  public_repo: { status: 422, group: "listing", message: "Only private repositories can be listed. Make the repository private and try again." },
  // Open releases (25 Oct 2026, HackMeridian): the opening date is a promise to the
  // people who already paid, so it can be brought forward and never pushed back.

  // --- auth (§8.1) -----------------------------------------------------------
  invalid_key: { status: 401, group: "auth", message: "The API key is missing, malformed or revoked." },
  insufficient_scope: { status: 403, group: "auth", message: "The API key does not carry the scope this route requires." },
  step_up_required: { status: 403, group: "auth", message: "This action requires a fresh signature from the bound payout address." },
  terms_version_stale: { status: 409, group: "auth", message: "The accepted terms version is not the current one." },
  payout_address_unverified: { status: 400, group: "auth", message: "The payout address was not proved by a valid signed challenge." },
  invite_required: { status: 403, group: "auth", message: "A valid invite code is required to register through the API." },
  invalid_signature: { status: 401, group: "auth", message: "The wallet signature is missing, malformed, expired or already used." },

  // --- limits (§9, D2c) ------------------------------------------------------
  rate_limited: { status: 429, group: "limits", message: "Too many requests. Retry after the interval given." },
  repo_too_large: { status: 413, group: "limits", message: "The repository exceeds the 200 MB / 20,000 file cap." },
  too_many_unpublished: { status: 409, group: "limits", message: "You already have the maximum number of unpublished listings." },

  // --- generic ---------------------------------------------------------------
  blocked_jurisdiction: { status: 451, group: "generic", message: "This service is unavailable in your jurisdiction." },
  // §19 kill switches. 503 and never 402: a 402 is an instruction to sign an
  // authorization, and an endpoint that has been paused cannot honour one. Deliberately
  // says nothing about which switch or why — see lib/ops/switches.ts.
  paused: { status: 503, group: "generic", message: "This is temporarily unavailable. Try again shortly." },
  invalid_request: { status: 400, group: "generic", message: "The request body or parameters did not validate." },
  not_found: { status: 404, group: "generic", message: "No such listing, version or resource." },
  internal: { status: 500, group: "generic", message: "Something went wrong on our side." },
} as const satisfies Record<string, ErrorSpec>;

export type ErrorCode = keyof typeof ERRORS;

export const ERROR_CODES = Object.keys(ERRORS) as ErrorCode[];

export function docsUrl(code: ErrorCode): string {
  return `${appUrl()}/docs/errors#${code}`;
}

export type ErrorBody = {
  code: ErrorCode;
  message: string;
  docs_url: string;
  details?: unknown;
  /** Only on `rate_limited`. */
  retry_after_seconds?: number;
};

export type ApiErrorOptions = {
  /** Override the catalogue message when a specific one helps the caller. */
  message?: string;
  /** Machine-readable extras: `{ blocking: [...] }`, `{ issues: [...] }`, a fresh 402 body. */
  details?: unknown;
  /** Required in practice for `rate_limited`. */
  retryAfterSeconds?: number;
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  readonly retryAfterSeconds?: number;

  constructor(code: ErrorCode, options: ApiErrorOptions = {}) {
    const spec = ERRORS[code];
    super(options.message ?? spec.message);
    this.name = "ApiError";
    this.code = code;
    this.status = spec.status;
    this.details = options.details;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  toBody(): ErrorBody {
    const body: ErrorBody = { code: this.code, message: this.message, docs_url: docsUrl(this.code) };
    if (this.details !== undefined) body.details = this.details;
    if (this.code === "rate_limited") body.retry_after_seconds = this.retryAfterSeconds ?? 60;
    return body;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError || (typeof e === "object" && e !== null && (e as { name?: string }).name === "ApiError");
}

/** Normalise anything thrown into an ApiError. ZodError → 400 invalid_request. */
export function toApiError(e: unknown): ApiError {
  if (isApiError(e)) return e as ApiError;
  if (e instanceof ZodError) {
    return new ApiError("invalid_request", {
      details: {
        issues: e.issues.map((i) => ({ path: i.path.join("."), code: i.code, message: i.message })),
      },
    });
  }
  if (e instanceof SyntaxError) {
    // `await req.json()` on a malformed body.
    return new ApiError("invalid_request", { message: "The request body is not valid JSON." });
  }
  return new ApiError("internal");
}

/** Build the JSON response for an error. Accepts an ApiError or anything thrown. */
export function errorResponse(err: unknown): NextResponse<ErrorBody> {
  const apiError = toApiError(err);
  const headers: Record<string, string> = {};
  if (apiError.code === "rate_limited") headers["retry-after"] = String(apiError.retryAfterSeconds ?? 60);
  return NextResponse.json(apiError.toBody(), { status: apiError.status, headers });
}

/**
 * One line describing something that was thrown, for a log — never for a response body.
 *
 * `String(e)` is not enough, and the gap is not theoretical. supabase-js rejects with a
 * `PostgrestError`, which is a **plain object**, not an `Error`: `{ message, code, hint,
 * details }`. Coercing it gives `[object Object]`, so a dead database credential shows
 * up in the log as `[unhandled] [object Object]` and every route just 500s with nothing
 * to go on. Reading `message`/`code`/`hint` off the object turns that back into
 * `Invalid API key (code 401)`, which names the fault.
 *
 * It stays deliberately shallow: `details` can echo a row, and a log line is not a place
 * for user data.
 */
export function describeThrown(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (typeof e === "object" && e !== null) {
    const o = e as { message?: unknown; code?: unknown; hint?: unknown };
    const message = typeof o.message === "string" && o.message.length > 0 ? o.message : null;
    if (message) {
      const code = o.code === undefined || o.code === null ? "" : ` (code ${String(o.code)})`;
      const hint = typeof o.hint === "string" && o.hint.length > 0 ? ` — ${o.hint}` : "";
      return `${message}${code}${hint}`;
    }
    try {
      return JSON.stringify(e).slice(0, 300);
    } catch {
      return "[unserialisable throw]";
    }
  }
  return String(e);
}

/**
 * The route this handler was called for, when the first argument is a `NextRequest`.
 *
 * Read through `unknown` rather than typed: `handle` wraps anything with a `(…args)`
 * signature — a cron route takes a bare `Request`, a test calls the wrapper with no
 * arguments at all — and a notifier is the last place that should throw on a shape it
 * did not expect.
 */
function requestPath(arg: unknown): string | null {
  const nextUrl = (arg as { nextUrl?: unknown } | null | undefined)?.nextUrl;
  const pathname = (nextUrl as { pathname?: unknown } | null | undefined)?.pathname;
  return typeof pathname === "string" && pathname.length > 0 ? pathname : null;
}

/**
 * Wrap a route handler so every failure becomes a catalogue error.
 * Unknown throws are logged (message only, never the request body) and returned as 500 internal.
 */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response> | Response): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (!isApiError(e) && !(e instanceof ZodError) && !(e instanceof SyntaxError)) {
        console.error("[unhandled]", describeThrown(e));
        // ADMIN-NOTIFICATIONS.md, 13 Sep 2026. This branch is already the definition of
        // "nobody expected this": a catalogue error is a documented answer to a bad
        // request and stays silent, an unhandled throw is a 500 somebody has to know
        // about. Every API route and the three `app/api/cron/*` routes reach it, so one
        // call here covers all of them; `notifyAdmin` throttles the repeats and never
        // throws, which is why there is no try/catch around the alert on the error path.
        await notifyAdmin({ kind: "error", where: requestPath(args[0]) ?? "handler", message: describeThrown(e) });
      }
      return errorResponse(e);
    }
  };
}
