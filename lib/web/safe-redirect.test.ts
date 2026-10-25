import { describe, expect, it } from "vitest";
import { safeReturnPath } from "./safe-redirect";

// appUrl() defaults to http://localhost:3000 in tests, so the origin backstop compares
// against that origin. Every crafted off-site path must fall back; one legal path passes.
describe("safeReturnPath (W2.1)", () => {
  const bs = String.fromCharCode(0x5c); // backslash, without tripping source escaping
  const ctrl = String.fromCharCode(0x01);

  it("rejects a backslash-smuggled open redirect and every off-site variant", () => {
    expect(safeReturnPath(`/${bs}evil.com`)).toBe("/dashboard");
    expect(safeReturnPath("//evil.com")).toBe("/dashboard");
    expect(safeReturnPath(`/${bs}/evil.com`)).toBe("/dashboard");
    expect(safeReturnPath(`/${bs}${bs}evil.com`)).toBe("/dashboard");
    expect(safeReturnPath("https://evil.com")).toBe("/dashboard");
    expect(safeReturnPath("javascript:alert(1)")).toBe("/dashboard");
    expect(safeReturnPath(`/dash${ctrl}board`)).toBe("/dashboard");
  });

  it("passes a legal same-origin path through unchanged, query and hash intact", () => {
    expect(safeReturnPath("/dashboard/x?y=1#z")).toBe("/dashboard/x?y=1#z");
  });

  it("falls back for a non-string or empty input", () => {
    expect(safeReturnPath(undefined)).toBe("/dashboard");
    expect(safeReturnPath(null)).toBe("/dashboard");
    expect(safeReturnPath("")).toBe("/dashboard");
    expect(safeReturnPath(42)).toBe("/dashboard");
  });

  it("honours a custom fallback", () => {
    expect(safeReturnPath("//evil.com", "/dashboard/key")).toBe("/dashboard/key");
  });
});
