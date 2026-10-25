/**
 * lib/listings — the creator's listing lifecycle (§8.2, §8.3, §8.9).
 *
 * Import from here, not from the files inside:
 *
 *   import { createListing, publishListing } from "@/lib/listings";
 *
 * `service.ts` owns the database and the GitHub calls; `view.ts` is the pure shaping
 * layer that turns rows into the API's `Listing` body. Nothing in either module knows
 * about entitlements or money movement — that is `lib/core/access.ts` alone.
 */

export * from "./service";
export * from "./view";
