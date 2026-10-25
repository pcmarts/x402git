/**
 * GET /api/terms — FR-6, and the buyer terms of §19.
 *
 * `version` is what `accepted_terms_version` must equal on POST /api/creators.
 * `sha256` is the hash of the exact bytes served at `url`, so a caller can prove the
 * text it agreed to is the text we published. `buyer_terms` says the same three things
 * about the document a buyer is bound by, which is published rather than accepted.
 */

import { NextResponse } from "next/server";
import { buyerTermsInfo } from "@/lib/buyer-terms";
import { handle } from "@/lib/errors";
import { TermsResponse } from "@/lib/schemas";
import { termsInfo } from "@/lib/terms";

export const GET = handle(async () =>
  NextResponse.json(TermsResponse.parse({ ...termsInfo(), buyer_terms: buyerTermsInfo() }), {
    headers: { "cache-control": "public, max-age=300, s-maxage=3600" },
  }),
);
