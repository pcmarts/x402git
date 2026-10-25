/**
 * lib/openapi/registry.ts — the route registry the OpenAPI document is built from.
 *
 * FR-33: OpenAPI is generated from the zod schemas, never hand-written.
 *
 * Register a route at module scope from `lib/openapi/routes.ts` (or from any module
 * that file imports). The short form is enough for most routes:
 *
 *   registerRoute({
 *     method: "post",
 *     path: "/api/listings/{id}/publish",
 *     summary: "Publish a listing",
 *     auth: "apiKey",
 *     params: [{ name: "id", in: "path", schema: z.uuid() }],
 *     response: PublishResponse,
 *     errors: ["listing_not_ready", "invalid_key", "rate_limited"],
 *   });
 *
 * `response` is shorthand for a single 200; use `responses` when a route has more than
 * one success shape (the 402 on /api/r, say). `errors` lists catalogue codes and
 * lib/openapi.ts expands each into a documented response with an example body.
 *
 * Paths use OpenAPI `{braces}`, not Next's `[brackets]`.
 *
 * Registration is idempotent on `${method} ${path}`: re-registering replaces the entry,
 * so hot reload and duplicate imports are harmless. Routes that are not built yet are
 * still registered, marked `status: "planned"` — the document is the contract the rest
 * of the build works against.
 */

import type { ZodType } from "zod";
import type { ErrorCode } from "@/lib/errors";

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

/**
 * `apiKey` = `Authorization: Bearer …` — an agent key (`x4c_live_…`) or a website session
 * key (`x4s_live_…`); both are accepted everywhere (FR-56) and the document describes both
 * on the scheme itself. `walletSignature` = `X-Wallet-Signature`.
 */
export type SecurityScheme = "apiKey" | "walletSignature";

export type ParamSpec = {
  name: string;
  in: "path" | "query" | "header";
  required?: boolean;
  description?: string;
  schema?: ZodType;
  /**
   * A value that works. x402scan's prober fills a templated path from
   * `parameters[].schema.example` before it fetches; without one it substitutes
   * `test` and reports the 404 as "no valid x402 response".
   */
  example?: string;
};

export type ResponseSpec = {
  status: number;
  description: string;
  schema?: ZodType;
  /** Keyed examples, e.g. `{ new: {...}, update: {...} }` per FR-21. */
  examples?: Record<string, unknown>;
  headers?: Record<string, string>;
  contentType?: string;
};

export type RouteSpec = {
  method: HttpMethod;
  path: string;
  summary: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  /** Omit for a public route. A single scheme or a list; `auth` and `security` are the same field. */
  auth?: SecurityScheme | SecurityScheme[];
  security?: SecurityScheme[];
  params?: ParamSpec[];
  request?: ZodType | { schema: ZodType; description?: string; contentType?: string };
  /** Shorthand for a single 200 response. */
  response?: ZodType;
  responses?: ResponseSpec[];
  /** Catalogue codes this route can return; expanded into responses by lib/openapi.ts. */
  errors?: ErrorCode[];
  /** Documented but not built yet. Defaults to "live". */
  status?: "planned" | "live";
  /**
   * OpenAPI specification extensions (`x-…`) copied onto the operation verbatim. Used
   * for `x-payment-info`, the field x402 indexers (x402scan) read to find paid routes.
   */
  extensions?: Record<`x-${string}`, unknown>;
};

/** A RouteSpec with the shorthands resolved. This is what lib/openapi.ts consumes. */
export type NormalisedRoute = Omit<RouteSpec, "auth" | "request" | "response" | "responses" | "tags" | "operationId"> & {
  operationId: string;
  tags: string[];
  security: SecurityScheme[];
  request?: { schema: ZodType; description?: string; contentType: string };
  responses: ResponseSpec[];
};

const registry = new Map<string, NormalisedRoute>();

export function registerRoute(spec: RouteSpec): void {
  registry.set(`${spec.method} ${spec.path}`, normalise(spec));
}

export function registerRoutes(specs: RouteSpec[]): void {
  for (const s of specs) registerRoute(s);
}

/** Every registered route, in registration order. */
export function registeredRoutes(): NormalisedRoute[] {
  return [...registry.values()];
}

export function findRoute(method: HttpMethod, path: string): NormalisedRoute | undefined {
  return registry.get(`${method} ${path}`);
}

/** Tests only. */
export function clearRoutes(): void {
  registry.clear();
}

function normalise(spec: RouteSpec): NormalisedRoute {
  const security = spec.security ?? (spec.auth === undefined ? [] : Array.isArray(spec.auth) ? spec.auth : [spec.auth]);

  const request =
    spec.request === undefined
      ? undefined
      : "schema" in spec.request
        ? { schema: spec.request.schema, description: spec.request.description, contentType: spec.request.contentType ?? "application/json" }
        : { schema: spec.request as ZodType, contentType: "application/json" };

  const responses = [...(spec.responses ?? [])];
  if (spec.response && !responses.some((r) => r.status === 200)) {
    responses.unshift({ status: 200, description: "OK", schema: spec.response });
  }

  return {
    method: spec.method,
    path: spec.path,
    summary: spec.summary,
    description: spec.description,
    operationId: spec.operationId ?? operationIdFor(spec.method, spec.path),
    tags: spec.tags ?? [defaultTagFor(spec.path)],
    security,
    params: spec.params,
    request,
    responses,
    errors: spec.errors,
    status: spec.status ?? "live",
    extensions: spec.extensions,
  };
}

/** `get /api/listings/{id}/publish` → `getApiListingsByIdPublish`. Stable and unique. */
function operationIdFor(method: HttpMethod, path: string): string {
  const parts = path
    .split("/")
    .filter(Boolean)
    .map((seg) => (seg.startsWith("{") ? `by-${seg.slice(1, -1)}` : seg));
  return method + parts.map((p) => p.replace(/(^|[-_])(\w)/g, (_m, _s, c: string) => c.toUpperCase())).join("");
}

function defaultTagFor(path: string): string {
  if (path.startsWith("/api/webhooks") || path.startsWith("/api/cron")) return "internal";
  if (path.startsWith("/api/creators") || path.startsWith("/api/listings") || path.startsWith("/api/earnings") || path.startsWith("/api/payouts")) {
    return "creator";
  }
  if (path.startsWith("/api/auth")) return "auth";
  return "public";
}
