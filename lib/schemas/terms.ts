/** lib/schemas/terms.ts — FR-6 and §19. `GET /api/terms`. */

import * as z from "zod";
import { Sha256 } from "./common";

const Document = z.object({
  version: z.string().min(1),
  url: z.string(),
  sha256: Sha256,
});

export const TermsResponse = Document.extend({
  /**
   * §19. The terms a *buyer* is bound by, published alongside the creator agreement.
   * Additive: the top-level fields still describe the creator agreement, because
   * `accepted_terms_version` is about that document and nothing else. Nothing records a
   * buyer's acceptance — a buyer is a wallet address, and what binds a purchase is
   * stamped on the purchase itself (FR-16).
   */
  buyer_terms: Document,
}).meta({
  id: "Terms",
  description:
    "The current creator agreement, plus the buyer terms. `accepted_terms_version` on POST /api/creators must equal the top-level `version`; `buyer_terms` is published for reading and is never accepted.",
  examples: [
    {
      version: "2026-09-16",
      url: "https://x402git.com/terms.md",
      sha256: "0".repeat(64),
      buyer_terms: { version: "2026-09-03", url: "https://x402git.com/buyer-terms.md", sha256: "0".repeat(64) },
    },
  ],
});

export type TermsResponseOutput = z.infer<typeof TermsResponse>;
