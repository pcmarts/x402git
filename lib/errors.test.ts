import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError, z } from "zod";
import { notifyAdmin } from "@/lib/notify";
import { ApiError, ERRORS, ERROR_CODES, describeThrown, errorResponse, handle, toApiError } from "./errors";

vi.mock("@/lib/notify", () => ({ notifyAdmin: vi.fn(async () => ({ delivered: true })) }));

describe("the §9 catalogue", () => {
  it("carries every code the PRD names", () => {
    const fromPrd = [
      "insufficient_balance", "expired_authorization", "replay", "settlement_pending", "settlement_timeout",
      "authorization_mismatch", "price_changed", "sanctioned_counterparty",
      "listing_not_ready", "licence_block", "scan_failed", "version_exists", "description_missing", "retired",
      "not_entitled", "derivative_of",
      "invalid_key", "insufficient_scope", "step_up_required", "terms_version_stale", "payout_address_unverified", "invite_required",
      "rate_limited", "repo_too_large", "too_many_unpublished",
    ];
    for (const code of fromPrd) expect(ERROR_CODES).toContain(code);
  });

  it("adds the four uniform fallbacks FR-33 needs", () => {
    expect(ERRORS.invalid_request.status).toBe(400);
    expect(ERRORS.invalid_signature.status).toBe(401);
    expect(ERRORS.not_found.status).toBe(404);
    expect(ERRORS.internal.status).toBe(500);
  });

  it("gives every code a non-empty message and a plausible status", () => {
    for (const code of ERROR_CODES) {
      expect(ERRORS[code].message.length).toBeGreaterThan(10);
      expect(ERRORS[code].status).toBeGreaterThanOrEqual(400);
      expect(ERRORS[code].status).toBeLessThan(600);
    }
  });
});

describe("errorResponse", () => {
  it("is { code, message, docs_url } with an anchor into /docs/errors", async () => {
    const res = errorResponse(new ApiError("invite_required"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("invite_required");
    expect(body.docs_url).toMatch(/\/docs\/errors#invite_required$/);
    expect(body.message).toBe(ERRORS.invite_required.message);
  });

  it("puts retry_after_seconds and a retry-after header on rate_limited", async () => {
    const res = errorResponse(new ApiError("rate_limited", { retryAfterSeconds: 42 }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect((await res.json()).retry_after_seconds).toBe(42);
  });

  it("carries details through", async () => {
    const res = errorResponse(new ApiError("listing_not_ready", { details: { blocking: ["scan_pending"] } }));
    expect((await res.json()).details).toEqual({ blocking: ["scan_pending"] });
  });
});

describe("toApiError", () => {
  it("turns a ZodError into 400 invalid_request with the issues in details", () => {
    const parsed = z.object({ handle: z.string() }).safeParse({ handle: 1 });
    const error = toApiError(parsed.error as ZodError);
    expect(error.code).toBe("invalid_request");
    expect(error.status).toBe(400);
    expect((error.details as { issues: unknown[] }).issues.length).toBe(1);
  });

  it("turns a malformed JSON body into 400, not 500", () => {
    expect(toApiError(new SyntaxError("Unexpected token")).code).toBe("invalid_request");
  });

  it("turns anything else into 500 internal", () => {
    expect(toApiError(new Error("kaboom")).code).toBe("internal");
  });
});

describe("handle", () => {
  it("passes a success through untouched", async () => {
    const wrapped = handle(async () => new Response("ok", { status: 201 }));
    expect((await wrapped()).status).toBe(201);
  });

  it("converts a thrown ApiError", async () => {
    const wrapped = handle(async () => {
      throw new ApiError("retired");
    });
    const res = await wrapped();
    expect(res.status).toBe(410);
    expect((await res.json()).code).toBe("retired");
  });

  it("converts a ZodError thrown by .parse()", async () => {
    const wrapped = handle(async () => {
      z.object({ a: z.string() }).parse({});
      return new Response("unreachable");
    });
    const res = await wrapped();
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_request");
  });

  it("never leaks an unexpected error's message to the caller", async () => {
    const wrapped = handle(async () => {
      throw new Error("connection string postgres://user:hunter2@host");
    });
    const res = await wrapped();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("internal");
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });
});

describe("handle — the unhandled throw is the one worth a phone buzz (ADMIN-NOTIFICATIONS.md)", () => {
  beforeEach(() => {
    vi.mocked(notifyAdmin).mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("names the request path when the first argument is a NextRequest", async () => {
    const wrapped = handle(async (_req: { nextUrl: { pathname: string } }) => {
      throw new TypeError("kaboom");
    });
    await wrapped({ nextUrl: { pathname: "/api/r/adrian/humanizer" } });

    expect(notifyAdmin).toHaveBeenCalledWith({ kind: "error", where: "/api/r/adrian/humanizer", message: "TypeError: kaboom" });
  });

  it("falls back to `handler` for a cron route's bare Request, and never throws on a junk argument", async () => {
    const wrapped = handle(async (_arg: unknown) => {
      throw { message: "Invalid API key", code: "401", hint: null };
    });

    await wrapped(new Request("https://x402git.test/api/cron/rescan"));
    await wrapped(undefined);
    await wrapped("not a request");

    expect(notifyAdmin).toHaveBeenCalledTimes(3);
    for (const [event] of vi.mocked(notifyAdmin).mock.calls) {
      expect(event).toEqual({ kind: "error", where: "handler", message: "Invalid API key (code 401)" });
    }
  });

  it("says nothing for a catalogue error, a ZodError or malformed JSON — those are answers, not faults", async () => {
    await handle(async () => {
      throw new ApiError("retired");
    })();
    await handle(async () => {
      z.object({ a: z.string() }).parse({});
      return new Response("unreachable");
    })();
    await handle(async () => {
      throw new SyntaxError("Unexpected token");
    })();

    expect(notifyAdmin).not.toHaveBeenCalled();
  });
});

describe("describeThrown", () => {
  it("names a PostgrestError, which is a plain object and not an Error", () => {
    // The shape supabase-js rejects with. `String(e)` gives "[object Object]", which is
    // how a dead database credential once turned every route into a silent 500.
    const postgrest = { message: "Invalid API key", code: "401", hint: "Double check the provided API key for typos.", details: null };
    const line = describeThrown(postgrest);
    expect(line).toContain("Invalid API key");
    expect(line).toContain("401");
    expect(line).not.toContain("[object Object]");
  });

  it("keeps the Error spelling for a real Error", () => {
    expect(describeThrown(new TypeError("nope"))).toBe("TypeError: nope");
  });

  it("falls back to JSON for an object with no message, and never throws", () => {
    expect(describeThrown({ a: 1 })).toBe('{"a":1}');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(describeThrown(circular)).toBe("[unserialisable throw]");
    expect(describeThrown(undefined)).toBe("undefined");
  });
});
