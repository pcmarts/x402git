/**
 * lib/x402/bazaar.ts — the Bazaar discovery declaration on the 402.
 *
 * The x402 `bazaar` extension (specs/extensions/bazaar.md; adopted 16 Sep 2026, see
 * docs/research/Agent Discovery Channels.md) is how a paid resource enters the
 * facilitator's discovery index — the one index agents holding USDC actually query
 * (Coinbase Agentic Wallet, AgentKit, AWS AgentCore, third-party wallet plugins).
 *
 * Two facts shape this module:
 *
 * 1. **Cataloguing happens on settlement, not on declaration.** The facilitator indexes a
 *    resource when it processes a payment payload that echoes this extension. An x402
 *    client (`@x402/core` 2.x) echoes it automatically; a hand-rolled signer has to copy
 *    `extensions` from the 402 into its payload, which the buy-a-repo skill now says.
 *    A listing nobody has bought is therefore not in the index yet — that is the
 *    protocol, not a bug here, and the platform does not buy listings to change it: the
 *    first sale is the creator's (DECISIONS.md, 16 Sep 2026). `npm run bazaar:check`.
 * 2. **No `routeTemplate`.** With one, every `/api/r/:owner/:slug` would collapse into a
 *    single catalogue entry named after the platform. Each listing is its own product
 *    with its own description and tags, so each concrete URL is its own entry.
 *
 * Everything here is computed from the manifest (FR-52): the artifact class, the
 * component inventory and the language mix. The creator's own words never reach the
 * `serviceName` or the `tags`; they reach the description through `paymentDescription`,
 * which already badges them as the listing's blurb.
 */

import { declareDiscoveryExtension, isValidServiceName, sanitizeTags } from "@x402/extensions/bazaar";
import type { ListingRef } from "@/lib/core/access";
import { ResourceGrantResponse } from "@/lib/schemas";

/** What the 402 needs from the manifest to describe the listing to an index. */
export type DiscoveryHints = {
  artifactClass: string | null;
  /** Language → bytes, as the manifest stores it. */
  languages: Record<string, number>;
  components: { kind: string; count: number }[];
};

export const EMPTY_HINTS: DiscoveryHints = { artifactClass: null, languages: {}, components: [] };

/** Read the hints off a stored manifest blob; every field is optional and defaults empty. */
export function discoveryHints(manifest: unknown): DiscoveryHints {
  if (!manifest || typeof manifest !== "object") return EMPTY_HINTS;
  const root = manifest as Record<string, unknown>;
  const computed = (typeof root.computed === "object" && root.computed ? root.computed : root) as Record<string, unknown>;

  const artifactClass = typeof computed.artifact_class === "string" && computed.artifact_class ? computed.artifact_class : null;

  const languages: Record<string, number> = {};
  if (computed.languages && typeof computed.languages === "object") {
    for (const [name, bytes] of Object.entries(computed.languages as Record<string, unknown>)) {
      if (typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0) languages[name] = bytes;
    }
  }

  const components: DiscoveryHints["components"] = [];
  if (Array.isArray(computed.component_inventory)) {
    for (const c of computed.component_inventory as unknown[]) {
      if (!c || typeof c !== "object") continue;
      const { kind, count } = c as { kind?: unknown; count?: unknown };
      if (typeof kind === "string" && kind && typeof count === "number" && count > 0) components.push({ kind, count });
    }
  }

  return { artifactClass, languages, components };
}

const SERVICE_NAME_MAX = 32;

/**
 * `owner/slug` when it fits the 32-character limit, else the slug, else the slug cut to
 * fit. The catalogue shows this next to the description; the URL carries the full ref.
 */
export function serviceName(ref: ListingRef): string {
  const full = `${ref.owner}/${ref.slug}`;
  const candidates = [full, ref.slug, ref.slug.slice(0, SERVICE_NAME_MAX)];
  for (const c of candidates) if (isValidServiceName(c)) return c;
  // Unreachable for a valid handle and slug (both are ASCII), kept so the type is honest.
  return "x402git-listing";
}

/**
 * Up to five tags, all computed: the artifact class, then what the analyser counted
 * inside (skills, scripts, prompts…), then the language mix, largest first. Lower-cased
 * because the index matches tags as free text, and de-duplicated in that order.
 */
export function tags(hints: DiscoveryHints): string[] {
  const ordered: string[] = [];
  if (hints.artifactClass) ordered.push(hints.artifactClass);
  for (const c of hints.components) ordered.push(c.kind);
  for (const [name] of Object.entries(hints.languages).sort((a, b) => b[1] - a[1])) ordered.push(name);

  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const raw of ordered) {
    const tag = raw
      .toLowerCase()
      .replace(/[^\x20-\x7e]/g, "")
      .trim()
      .slice(0, 32);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    cleaned.push(tag);
  }
  return sanitizeTags(cleaned) ?? [];
}

/** The `resource` fields the Bazaar reads besides `url` and `description`. */
export function serviceMetadata(ref: ListingRef, hints: DiscoveryHints): { serviceName: string; tags?: string[] } {
  const t = tags(hints);
  return { serviceName: serviceName(ref), ...(t.length > 0 ? { tags: t } : {}) };
}

/** The 200 a buyer receives, as the example the catalogue shows next to the price. */
export function grantExample(ref: ListingRef, version: string, base: string) {
  return {
    version,
    artifact_sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    download_url: `https://storage.example/${ref.owner}/${ref.slug}/${version}.zip?signed=…`,
    expires_at: "2026-09-16T12:05:00.000Z",
    version_endpoint: `${base}/api/r/${ref.owner}/${ref.slug}/v/${version}`,
    manifest_url: `${base}/api/label/${ref.owner}/${ref.slug}`,
    all_versions: false,
  };
}

/**
 * JSON Schema of the 200 body (`ResourceGrantResponse`). Written by hand rather than
 * converted from the zod schema: the conversion emits `$ref`s to the registered
 * sub-schemas (SemVer, Sha256, …) and the Bazaar validator resolves no references.
 * `bazaar.test.ts` holds the property list equal to the zod shape, so it cannot drift.
 */
export const GRANT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    version: { type: "string", description: "Semantic version of the release served." },
    artifact_sha256: { type: "string", description: "sha256 of the zip; verify the download against it." },
    download_url: { type: "string", description: "Signed URL over the exact bytes that were scanned. Valid five minutes." },
    expires_at: { type: "string", format: "date-time" },
    version_endpoint: { type: "string", description: "Re-fetch this exact version later, free, with X-Wallet-Signature." },
    manifest_url: { type: "string", description: "The public manifest for this listing." },
    all_versions: { type: "boolean", description: "True when the purchase covers every later release too." },
  },
  required: ["version", "artifact_sha256", "download_url", "expires_at", "version_endpoint", "manifest_url", "all_versions"],
  additionalProperties: false,
} as const;

/**
 * The `extensions` map for a 402 on `GET /api/r/:owner/:slug`.
 *
 * `declareDiscoveryExtension` leaves the HTTP method to be filled in by the server
 * middleware we do not use, so it is set here: the method is part of `info.input` and
 * of the schema that validates it, and the facilitator validates one against the other
 * before cataloguing.
 */
export function bazaarExtensions(ref: ListingRef, version: string, base: string): Record<string, unknown> {
  const declared = declareDiscoveryExtension({
    output: { example: grantExample(ref, version, base), schema: GRANT_OUTPUT_SCHEMA as unknown as Record<string, unknown> },
  }) as Record<string, DiscoveryDeclaration>;

  const bazaar = declared.bazaar;
  const inputSchema = bazaar.schema.properties.input;
  const required = inputSchema.required ?? [];
  return {
    bazaar: {
      ...bazaar,
      info: { ...bazaar.info, input: { ...bazaar.info.input, method: "GET" } },
      schema: {
        ...bazaar.schema,
        properties: {
          ...bazaar.schema.properties,
          input: {
            ...inputSchema,
            properties: { ...inputSchema.properties, method: { type: "string", enum: ["GET"] } },
            required: required.includes("method") ? required : [...required, "method"],
          },
        },
      },
    },
  };
}

/** The slice of the declaration this module rewrites; the rest passes through untouched. */
type DiscoveryDeclaration = {
  info: { input: Record<string, unknown>; output?: unknown };
  schema: {
    properties: {
      input: { properties?: Record<string, unknown>; required?: string[] } & Record<string, unknown>;
    } & Record<string, unknown>;
  } & Record<string, unknown>;
  routeTemplate?: string;
};
