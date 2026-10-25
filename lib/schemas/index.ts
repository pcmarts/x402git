/**
 * lib/schemas — every request and response body on the platform, as zod v4 schemas.
 *
 * Import from here, not from the individual files, for two reasons: the OpenAPI
 * document is built by walking `z.globalRegistry`, so a schema that is never imported
 * is never published; and one import path means one place to look.
 *
 *   import { CreateCreatorRequest, micro } from "@/lib/schemas";
 *
 *   const body = CreateCreatorRequest.parse(await req.json());   // ZodError → 400
 *   const price = micro.parse(body.price_micro);                 // string → bigint
 *
 * Conventions:
 * - Money is a decimal integer string on the wire, bigint in the process.
 * - Every schema carries `.meta({ id })` so it becomes a named OpenAPI component.
 * - Request schemas are named `<Thing>Request`, responses are the bare noun.
 */

export * from "./common";
export * from "./errors";
export * from "./terms";
export * from "./challenge";
export * from "./creators";
export * from "./scan";
export * from "./listings";
export * from "./releases";
export * from "./manifest";
export * from "./payment";
export * from "./earnings";
export * from "./entitlements";
