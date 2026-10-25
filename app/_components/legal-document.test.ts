/**
 * The published documents, as pages. The outline is the thing under test: these are
 * legal documents, and a reader who navigates by headings gets the whole of one or
 * misses a section.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ABUSE_POLICY_MARKDOWN, ABUSE_POLICY_VERSION } from "@/lib/abuse";
import { BUYER_TERMS_MARKDOWN, BUYER_TERMS_VERSION } from "@/lib/buyer-terms";
import { TERMS_MARKDOWN } from "@/lib/terms";
import { LegalDocument } from "./legal-document";

const DOCUMENTS = [
  ["the creator agreement", TERMS_MARKDOWN, "2026-09-16", "/terms.md", "Creator agreement"],
  ["the buyer terms", BUYER_TERMS_MARKDOWN, BUYER_TERMS_VERSION, "/buyer-terms.md", "Buyer terms"],
  ["the abuse policy", ABUSE_POLICY_MARKDOWN, ABUSE_POLICY_VERSION, "/abuse.md", "Reporting abuse"],
] as const;

describe("LegalDocument", () => {
  for (const [name, markdown, version, sourcePath, title] of DOCUMENTS) {
    describe(name, () => {
      const html = renderToStaticMarkup(LegalDocument({ markdown, version, sourcePath }));

      it("makes the document's title the page's only h1", () => {
        expect(html.match(/<h1>/g)).toHaveLength(1);
        expect(html).toContain(`<h1>${title}</h1>`);
      });

      /** The defect this test was written for: `##` landed as `h3` under the `h1`. */
      it("lands every section at h2, skipping no level", () => {
        const sections = markdown.split("\n").filter((l) => l.startsWith("## ")).length;
        expect(sections).toBeGreaterThan(0);
        expect(html.match(/<h2>/g) ?? []).toHaveLength(sections);
        expect(html).not.toContain("<h3>");
      });

      it("prints the version once, as chrome, beside the file it mirrors", () => {
        expect(html).toContain(`Version ${version}`);
        expect(html).toContain(`href="${sourcePath}"`);
        // The version line is the page's, not the document's: the constant's own
        // `Version …` line must not come through into the prose as well.
        expect(html.match(new RegExp(`Version ${version}`, "g"))).toHaveLength(1);
      });

      it("sets the document in the text face and the head in the computed one", () => {
        expect(html).toContain('<div class="written"');
        expect(html).not.toContain('<h1 class="written"');
      });
    });
  }
});
