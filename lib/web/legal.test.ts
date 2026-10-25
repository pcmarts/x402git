import { describe, expect, it } from "vitest";
import { ABUSE_POLICY_MARKDOWN } from "@/lib/abuse";
import { BUYER_TERMS_MARKDOWN } from "@/lib/buyer-terms";
import { TERMS_MARKDOWN } from "@/lib/terms";
import { documentBody, documentTitle } from "./legal";

const DOCUMENTS = [
  ["the creator agreement", TERMS_MARKDOWN, "Creator agreement"],
  ["the buyer terms", BUYER_TERMS_MARKDOWN, "Buyer terms"],
  ["the abuse policy", ABUSE_POLICY_MARKDOWN, "Reporting abuse"],
] as const;

describe("splitting a published document (lib/web/legal.ts)", () => {
  for (const [name, markdown, title] of DOCUMENTS) {
    describe(name, () => {
      it("finds its title", () => {
        expect(documentTitle(markdown)).toBe(title);
      });

      it("drops the title and the version line from the body", () => {
        const body = documentBody(markdown);
        expect(body.startsWith("# ")).toBe(false);
        expect(body).not.toMatch(/^Version /);
        expect(body.trimStart()).toBe(body);
      });

      it("keeps every section heading", () => {
        const sections = markdown.split("\n").filter((l) => l.startsWith("## "));
        expect(sections.length).toBeGreaterThan(0);
        for (const heading of sections) expect(documentBody(markdown)).toContain(heading);
      });
    });
  }

  it("leaves a document with no head alone", () => {
    expect(documentTitle("Just a paragraph.\n")).toBeNull();
    expect(documentBody("Just a paragraph.\n")).toBe("Just a paragraph.\n");
  });
});
