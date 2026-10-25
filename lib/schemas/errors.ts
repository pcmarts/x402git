/**
 * lib/schemas/errors.ts — the wire shape of every error (FR-33).
 *
 * The catalogue itself lives in lib/errors.ts; this is only its zod mirror, so the
 * OpenAPI document can point at it. Keep the two in step: the `code` enum is derived
 * from the catalogue, so adding a code there adds it here automatically.
 */

import * as z from "zod";
import { ERROR_CODES } from "@/lib/errors";

export const ErrorCodeEnum = z.enum(ERROR_CODES as [string, ...string[]]).meta({
  id: "ErrorCode",
  description: "The PRD §9 error catalogue.",
});

export const ErrorBody = z
  .object({
    code: ErrorCodeEnum,
    message: z.string(),
    docs_url: z.string(),
    details: z.unknown().optional(),
    /** Only on `rate_limited`. */
    retry_after_seconds: z.number().int().nonnegative().optional(),
  })
  .meta({
    id: "Error",
    description: "Every error on every route. `docs_url` anchors into /docs/errors.",
    examples: [
      {
        code: "invite_required",
        message: "A valid invite code is required to register through the API.",
        docs_url: "https://x402git.com/docs/errors#invite_required",
      },
    ],
  });

/** `listing_not_ready` carries what is blocking (§7.2). */
export const ListingNotReadyDetails = z
  .object({
    blocking: z.array(z.enum(["scan_pending", "scan_failed", "licence_block", "description_missing", "no_release", "derivative_of", "public_repo"])),
  })
  .meta({ id: "ListingNotReadyDetails" });

export type ErrorBodyOutput = z.infer<typeof ErrorBody>;
