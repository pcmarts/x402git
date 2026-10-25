import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ABUSE_WEBHOOK_EVENT_HEADER, ABUSE_WEBHOOK_SIGNATURE_HEADER } from "./abuse-webhook";
import { ABUSE_EMAIL, ABUSE_POLICY_MARKDOWN, abusePolicyInfo, abusePolicySha256 } from "./abuse";

describe("the notice-and-takedown policy (FR-39)", () => {
  it("is byte-identical to what /abuse.md serves", () => {
    const onDisk = readFileSync(resolve(process.cwd(), "public/abuse.md"), "utf8");
    expect(ABUSE_POLICY_MARKDOWN).toBe(onDisk);
  });

  it("publishes the sha256 of the bytes it serves", () => {
    const onDisk = readFileSync(resolve(process.cwd(), "public/abuse.md"), "utf8");
    expect(abusePolicySha256()).toBe(createHash("sha256").update(onDisk, "utf8").digest("hex"));
    expect(abusePolicyInfo().sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("publishes the contact FR-39 promises a human reads", () => {
    expect(ABUSE_POLICY_MARKDOWN).toContain(ABUSE_EMAIL);
    expect(abusePolicyInfo().email).toBe(ABUSE_EMAIL);
  });

  /**
   * It rendered as bold text on the page for exactly one build. The whole document is
   * an instruction to write to one address; that address is the page's action and it
   * has to be pressable, not typed out by hand from a screen.
   */
  it("makes the address a mailto link everywhere it appears", () => {
    const plain = ABUSE_POLICY_MARKDOWN.match(new RegExp(ABUSE_EMAIL, "g")) ?? [];
    const linked = ABUSE_POLICY_MARKDOWN.match(new RegExp(`\\[${ABUSE_EMAIL}\\]\\(mailto:${ABUSE_EMAIL}\\)`, "g")) ?? [];
    // Each link mentions the address twice — once as label, once as href.
    expect(plain).toHaveLength(linked.length * 2);
    expect(linked.length).toBeGreaterThan(0);
  });

  it("states the FR-39 timelines and the repeat-infringer rule", () => {
    expect(ABUSE_POLICY_MARKDOWN).toMatch(/24 hours/);
    expect(ABUSE_POLICY_MARKDOWN).toMatch(/72 hours/);
    expect(ABUSE_POLICY_MARKDOWN).toMatch(/Two upheld notices retire a creator's account/);
  });

  it("says a takedown is the only thing that revokes a buyer", () => {
    expect(ABUSE_POLICY_MARKDOWN).toMatch(/only circumstance in which a buyer loses/);
  });

  it("asks for every element a notice needs, and warns about false ones", () => {
    expect(ABUSE_POLICY_MARKDOWN).toMatch(/penalty of\s+perjury/);
    expect(ABUSE_POLICY_MARKDOWN).toMatch(/good faith/);
    expect(ABUSE_POLICY_MARKDOWN).toMatch(/signature/);
    expect(ABUSE_POLICY_MARKDOWN).toMatch(/counter-notice/i);
  });

  /**
   * B9. No designated agent is registered and V0 launches that way deliberately (D5,
   * amended 2026-09-04), so the page has to say so rather than imply a filing is in
   * flight. The word "pending" is the specific failure this guards: it was the text
   * until the deferral became a decision, and it would now be a claim about a process
   * that does not exist. Delete this test when B9 closes.
   */
  it("says plainly that no designated agent is registered, and does not imply one is coming", () => {
    expect(ABUSE_POLICY_MARKDOWN).toMatch(/\*\*None is registered\.\*\*/);
    expect(ABUSE_POLICY_MARKDOWN).not.toMatch(/\bpending\b/i); // "Depending" is not the word
    expect(abusePolicyInfo().version).toBe("2026-09-13");
  });

  /**
   * The compensating promise. Without 512(c) safe harbour the timelines are all a
   * complainant actually gets, so they must not be conditioned on the notice being a
   * formal one — which is the corner a page with no registered agent would be tempted
   * to cut.
   */
  it("honours the timelines whether or not a notice is a formal DMCA notice", () => {
    expect(ABUSE_POLICY_MARKDOWN).toMatch(/whether or not it is framed as a\s+formal DMCA notice/);
  });

  /**
   * FR-41 (13 Sep 2026). The webhook was signed and delivered and documented nowhere: a
   * creator receiving one had two headers, no statement of what the HMAC covers, and no
   * way to verify it without guessing. A signature nobody can check is a signature nobody
   * checks. This is the page the payload's own `docs_url` points at, so it is the page
   * that has to say it.
   */
  it("documents the webhook headers, the four events and how to verify the signature", () => {
    // Read off the constants the transport actually sends, so the page cannot drift.
    expect(ABUSE_POLICY_MARKDOWN).toContain(ABUSE_WEBHOOK_EVENT_HEADER);
    expect(ABUSE_POLICY_MARKDOWN).toContain(ABUSE_WEBHOOK_SIGNATURE_HEADER);
    expect(ABUSE_POLICY_MARKDOWN).toMatch(/sha256=<hex>/);
    expect(ABUSE_POLICY_MARKDOWN).toMatch(/HMAC-SHA256 over the \*\*exact bytes we POSTed\*\*/);
    for (const event of ["release.failed", "release.compromised", "listing.takedown", "payout.sent"]) {
      expect([event, ABUSE_POLICY_MARKDOWN.includes(event)]).toEqual([event, true]);
    }
    // A snippet a receiver can paste, and one that compares in constant time.
    expect(ABUSE_POLICY_MARKDOWN).toContain("createHmac");
    expect(ABUSE_POLICY_MARKDOWN).toContain("timingSafeEqual");
  });

  it("carries its version in the text a human reads", () => {
    expect(ABUSE_POLICY_MARKDOWN).toContain(`Version ${abusePolicyInfo().version}.`);
  });
});
