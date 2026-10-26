/**
 * lib/openapi.ts — the OpenAPI 3.1 document, built from the zod schemas (FR-33).
 *
 * Nothing here is hand-written JSON. Components come from `z.globalRegistry` — every
 * schema that carries `.meta({ id })` — and paths come from `lib/openapi/registry.ts`.
 * Adding a route or a field means editing the schema, never this file.
 *
 * The build is lazy and memoised: it walks the whole schema graph, which is not work
 * worth doing at import time in a serverless function that may never serve /openapi.json.
 *
 *   import { openApiDocument } from "@/lib/openapi";
 *   return Response.json(openApiDocument());
 */

import * as z from "zod";
import { appUrl } from "@/lib/env";
import { ERRORS, type ErrorCode } from "@/lib/errors";
import type { NormalisedRoute, ParamSpec, SecurityScheme } from "@/lib/openapi/registry";
import { registeredRoutes } from "@/lib/openapi/registry";
// Side effects: registering every schema in the global registry, and every route.
import "@/lib/schemas";
import "@/lib/openapi/routes";

type Json = Record<string, unknown>;

let cached: Json | null = null;

/** The document. Memoised; call `resetOpenApiCache()` in a test that mutates routes. */
export function openApiDocument(): Json {
  if (cached) return cached;
  cached = build();
  return cached;
}

export function resetOpenApiCache(): void {
  cached = null;
}

function build(): Json {
  const base = appUrl();
  const components: Json = {};
  const schemas = registrySchemas();
  const extraSchemas: Json = {};

  const paths: Json = {};
  for (const route of registeredRoutes()) {
    const path = (paths[route.path] as Json | undefined) ?? {};
    path[route.method] = operation(route, base, extraSchemas);
    paths[route.path] = path;
  }

  components.schemas = { ...schemas, ...extraSchemas };
  components.securitySchemes = {
    apiKey: {
      type: "http",
      scheme: "bearer",
      description: [
        "`Authorization: Bearer <key>`. Scoped (`listings:write`, `earnings:read`); a bearer key cannot move money (FR-26) and cannot destroy data without a step-up signature (FR-5).",
        "",
        "There are two kinds. Every route that takes this scheme accepts either:",
        "",
        "- **Agent key**, `x4c_live_…` — long-lived, one per creator, shown once when it is issued and never again, rotatable without the old key (`POST /api/auth/rotate-key`). This is the one an agent holds; it is the only one you can be given.",
        "- **Session key**, `x4s_live_…` — minted for a browser session when a creator signs in to the website, never shown to anyone, expires with the session and dies on sign-out. It exists because the site calls these same endpoints (D9).",
      ].join("\n"),
    },
    walletSignature: {
      type: "apiKey",
      in: "header",
      name: "X-Wallet-Signature",
      description:
        "`<address>.<nonce>.<eip191_signature>` over the message from GET /api/auth/challenge (FR-20). Single use, 5-minute expiry. Without it, /api/r quotes the new-buyer price and /api/v returns version data only.",
    },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "X402 Git",
      version: "0.0.1",
      summary: "Paid access to private git repos over x402, paid in dollars (USDC on Base, USDT0 on Arbitrum or Stellar), for humans and agents.",
      description: [
        "Every creator and buyer capability is an authenticated JSON endpoint before it is a web page (D9); the web app calls these same routes.",
        "",
        "**Money.** Every amount is micro-dollars (6 decimals) encoded as a decimal integer string: `\"9000000\"` is $9.00, in whichever token the listing is paid — USDC and USDT0 are both a dollar. Never a JSON number, because a JSON number is a double.",
        "",
        "**Errors.** Every error on every route is `{ code, message, docs_url, details? }` from the catalogue below.",
        "",
        "**Payment.** x402 v2, `exact` scheme. A 402 carries one `accepts` entry per rail the listing offers — USDC on Base, USDT0 on Arbitrum, USDT0 on Stellar — and a listing's `payment_options` says the same in words. Access is granted only after the facilitator's `settle` returns a transaction hash.",
      ].join("\n"),
      // The platform's code is public under the AGPL (LICENSE at the repository root).
      // 3.1 takes an SPDX `identifier`; `url` and `identifier` are mutually exclusive.
      license: { name: "AGPL-3.0-only", identifier: "AGPL-3.0-only" },
      // Read by x402scan's crawler (@agentcash/discovery): the contact for ownership
      // verification and for a merchant page, and one paragraph of guidance an agent
      // gets before it fetches anything else. The published mailbox is the abuse
      // contact (§19); it is the one address a person answers.
      contact: { name: "X402 Git", email: "abuse@x402git.com", url: `${base}/abuse` },
      "x-guidance": `Every listing is a private git repository sold as a zip over x402 (USDC on Base, USDT0 on Arbitrum or on Stellar — each listing's payment_options says which). Read the free manifest at GET /api/label/{owner}/{slug} first; GET /api/r/{owner}/{slug} answers 402 with the price and the exact requirement to sign, and 200 with a signed download URL once the payment settles. Echo extra.quote_id as X-Quote-Id and extensions.bazaar in the payment payload. The full procedure is at ${base}/.well-known/agent-skills/buy-a-repo/SKILL.md; the same tools are an MCP server at ${base}/api/mcp. Every live resource is listed at ${base}/.well-known/x402.`,
    },
    servers: [{ url: base }],
    externalDocs: { url: "https://github.com/pcmarts/x402git", description: "Source code and security policy" },
    tags: [
      { name: "public", description: "Free and unauthenticated, or paid with x402." },
      { name: "auth", description: "Challenges and key rotation." },
      { name: "creator", description: "Bearer key: an agent key (`x4c_live_…`) or a website session key (`x4s_live_…`)." },
      { name: "internal", description: "Webhooks and cron. Not for callers." },
    ],
    paths,
    components,
  };
}

// --- components ---------------------------------------------------------------

/** Every schema carrying `.meta({ id })`, as `#/components/schemas/<id>`. */
function registrySchemas(): Json {
  // Next bundles `lib/schemas` once per route while `zod` itself stays a single external
  // instance, so at build time the global registry can hold two copies of a schema under
  // one id and `toJSONSchema` refuses. Keep the first copy of each id in a local registry.
  const local = z.registry<{ id?: string; description?: string }>();
  for (const [id, schema] of z.globalRegistry._idmap.entries()) {
    const meta = z.globalRegistry.get(schema) ?? { id };
    local.add(schema as z.ZodType, { ...meta, id });
  }
  const converted = z.toJSONSchema(local, {
    uri: (id) => `#/components/schemas/${id}`,
    target: "draft-2020-12",
  }) as { schemas: Record<string, Json> };

  const out: Json = {};
  for (const [id, schema] of Object.entries(converted.schemas)) {
    if (!id || id === "undefined") continue;
    const copy = { ...schema };
    delete copy.$schema;
    delete copy.$id;
    out[id] = copy;
  }
  return out;
}

/**
 * A `$ref` when the schema is registered, an inline JSON Schema otherwise. Any `$defs`
 * an inline conversion produces are hoisted into components so no reference dangles.
 */
function schemaObject(schema: z.ZodType, extraSchemas: Json): Json {
  const id = idOf(schema);
  if (id) return { $ref: `#/components/schemas/${id}` };

  const converted = z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }) as Json;
  delete converted.$schema;
  const defs = converted.$defs as Record<string, Json> | undefined;
  delete converted.$defs;
  if (defs) {
    for (const [key, value] of Object.entries(defs)) {
      if (!(key in extraSchemas)) extraSchemas[key] = value;
    }
  }
  return rewriteRefs(converted);
}

function idOf(schema: z.ZodType): string | undefined {
  const meta = schema.meta?.() as { id?: unknown } | undefined;
  return typeof meta?.id === "string" ? meta.id : undefined;
}

function rewriteRefs(value: unknown): Json {
  return JSON.parse(JSON.stringify(value).replaceAll("#/$defs/", "#/components/schemas/")) as Json;
}

// --- operations ---------------------------------------------------------------

function operation(route: NormalisedRoute, base: string, extraSchemas: Json): Json {
  const op: Json = {
    operationId: route.operationId,
    summary: route.summary,
    tags: route.tags,
  };
  if (route.description) op.description = route.description;
  if (route.status === "planned") {
    op["x-status"] = "planned";
    op.description = `${route.description ? `${route.description}\n\n` : ""}_Documented, not yet implemented._`;
  }
  // An explicit empty `security` says "public on purpose": crawlers that infer an auth
  // mode per operation (x402scan's) warn on every operation that says nothing at all.
  op.security = route.security.map(securityRequirement);
  for (const [key, value] of Object.entries(route.extensions ?? {})) op[key] = value;

  const params = (route.params ?? []).map((p) => parameter(p, extraSchemas));
  if (params.length > 0) op.parameters = params;

  if (route.request) {
    op.requestBody = {
      required: true,
      ...(route.request.description ? { description: route.request.description } : {}),
      content: { [route.request.contentType]: { schema: schemaObject(route.request.schema, extraSchemas) } },
    };
  }

  op.responses = responses(route, base, extraSchemas);
  return op;
}

function securityRequirement(scheme: SecurityScheme): Json {
  return { [scheme]: [] };
}

function parameter(p: ParamSpec, extraSchemas: Json): Json {
  return {
    name: p.name,
    in: p.in,
    required: p.required ?? p.in === "path",
    ...(p.description ? { description: p.description } : {}),
    schema: { ...(p.schema ? schemaObject(p.schema, extraSchemas) : { type: "string" }), ...(p.example ? { example: p.example } : {}) },
  };
}

function responses(route: NormalisedRoute, base: string, extraSchemas: Json): Json {
  const out: Json = {};

  for (const r of route.responses) {
    const body: Json = { description: r.description };
    const contentType = r.contentType ?? "application/json";
    if (r.schema || r.examples) {
      const content: Json = {};
      if (r.schema) content.schema = schemaObject(r.schema, extraSchemas);
      if (r.examples) {
        content.examples = Object.fromEntries(
          Object.entries(r.examples).map(([name, value]) => [name, { summary: `kind: ${name}`, value }]),
        );
      }
      body.content = { [contentType]: content };
    }
    if (r.headers) body.headers = Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k, { description: v, schema: { type: "string" } }]));
    out[String(r.status)] = body;
  }

  // Expand the catalogue codes into one response per status, listing every code that
  // can produce it and giving a copy-pasteable example body for each.
  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of route.errors ?? []) {
    const status = ERRORS[code].status;
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  for (const [status, codes] of byStatus) {
    const key = String(status);
    if (out[key]) continue; // an explicit response wins (the 402 on /api/r)
    out[key] = {
      description: codes.map((c) => `\`${c}\` — ${ERRORS[c].message}`).join("\n"),
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/Error" },
          examples: Object.fromEntries(codes.map((c) => [c, { value: errorExample(c, base) }])),
        },
      },
      ...(codes.includes("rate_limited") ? { headers: { "retry-after": { description: "Seconds to wait.", schema: { type: "string" } } } } : {}),
    };
  }

  if (Object.keys(out).length === 0) out["200"] = { description: "OK" };
  return out;
}

function errorExample(code: ErrorCode, base: string): Json {
  const body: Json = { code, message: ERRORS[code].message, docs_url: `${base}/docs/errors#${code}` };
  if (code === "rate_limited") body.retry_after_seconds = 60;
  if (code === "listing_not_ready") body.details = { blocking: ["description_missing"] };
  return body;
}
