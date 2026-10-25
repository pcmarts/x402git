import { describe, expect, it } from "vitest";
import { jsonLdSafe } from "./json-ld";

describe("jsonLdSafe (W2.7)", () => {
  it("escapes every < so a </script> in an input cannot close the tag", () => {
    const out = jsonLdSafe({ name: "danger </script><script>alert(1)</script>" });
    expect(out).not.toContain("</script>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("\\u003c");
  });

  it("remains valid JSON that parses back to the original value", () => {
    const value = { a: "1 < 2", nested: { b: "</script>" } };
    expect(JSON.parse(jsonLdSafe(value))).toEqual(value);
  });

  it("leaves input without angle brackets byte-identical to JSON.stringify", () => {
    const value = { "@context": "https://schema.org", name: "X402 Git" };
    expect(jsonLdSafe(value)).toBe(JSON.stringify(value));
  });
});
