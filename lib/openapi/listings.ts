/**
 * lib/openapi/listings.ts — one OpenAPI path per live listing.
 *
 * The static document describes `/api/r/{owner}/{slug}` once, as a template. An x402
 * indexer that registers *resources* — x402scan's crawler is the case in hand — fetches a
 * templated path literally, gets a 404, and refuses it: it never fills path parameters,
 * even from examples. What it can register is a concrete URL that answers 402. So the
 * served document also carries every live listing as its own path, with its own
 * summary, the creator's blurb, and a fixed price: the new-buyer price, which is the one
 * number an index can advertise honestly (the 402 a holder receives can only be lower).
 *
 * Generated from the same rows as `sitemap.xml` and `/.well-known/x402`
 * (lib/listings/live.ts), never hand-written (FR-33). A listing that retires drops out on
 * the next request; the document is cached for five minutes at the edge.
 */

import { appUrl } from "@/lib/env";
import { liveListings } from "@/lib/listings/live";
import { priceDecimal } from "@/lib/web/listing-json-ld";

type Json = Record<string, unknown>;

/** `paths` entries for every live listing, keyed by the concrete resource path. */
export async function listingPaths(): Promise<Json> {
  const base = appUrl();
  const paths: Json = {};
  for (const l of await liveListings()) {
    const ref = `${l.handle}/${l.slug}`;
    paths[`/api/r/${l.handle}/${l.slug}`] = {
      get: {
        operationId: `buy_${ref.replace(/[^a-zA-Z0-9]+/g, "_")}`,
        summary: `Buy ${ref}`,
        description: [
          l.description ? `${l.description}` : null,
          `A private git repository sold as a zip over x402. The free manifest is at ${base}/api/label/${ref}; the page a person buys on is ${base}/${ref}.`,
          "Unpaid GET answers 402 with the price and the exact requirement to sign; the same request carrying PAYMENT-SIGNATURE (and extra.quote_id as X-Quote-Id) returns a signed download URL once the payment settles. A holder re-fetches for free with X-Wallet-Signature.",
        ]
          .filter(Boolean)
          .join(" "),
        tags: ["public", "listings"],
        security: [{ walletSignature: [] }],
        parameters: [
          {
            name: "PAYMENT-SIGNATURE",
            in: "header",
            required: false,
            description: "The base64 x402 v2 payment payload. Absent on the first request; present on the paying one.",
            schema: { type: "string" },
          },
          {
            name: "X-Quote-Id",
            in: "header",
            required: false,
            description: "Echo `extra.quote_id` from the 402 you are paying against (FR-23).",
            schema: { type: "string" },
          },
        ],
        "x-payment-info": {
          protocols: [{ x402: {} }],
          price: { mode: "fixed", currency: "USD", amount: priceDecimal(l.priceMicro) },
          description: "USDC on Base; the amount is the new-buyer price. A wallet that already holds an earlier version is quoted the update price instead, never more.",
        },
        responses: {
          "200": {
            description: "Granted. `download_url` is signed and expires in 5 minutes.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ResourceGrant" } } },
          },
          "402": {
            description: "Payment required. Also sent in the `PAYMENT-REQUIRED` header; `extensions.bazaar` is the discovery declaration.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/PaymentRequired" } } },
          },
        },
      },
    };
  }
  return paths;
}
