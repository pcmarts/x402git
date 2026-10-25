import { describe, expect, it } from "vitest";
import { UNIQUE_5GRAM_GUARD, bucketsTouched, classify, inventoryOf, inventorySentence, typeTokenRatio, unique5GramRatio } from "./classify";
import { bucketOf, isLicenceFile, isTextPath } from "./files";

function tree(files: Record<string, string>, extra: string[] = []) {
  return { textFiles: new Map(Object.entries(files)), allPaths: [...Object.keys(files), ...extra] };
}

/** Realistic code: distinct identifiers throughout, so five-token windows rarely repeat. */
function realCode(lines: number, offset = 0): string {
  return Array.from(
    { length: lines },
    (_, i) => `export function step${offset + i}(input${offset + i}: string) { return transform${offset + i}(input${offset + i}, ${offset + i}); }`,
  ).join("\n");
}

/**
 * Padded code, in the shape Quality Signals §3.2 measured: near-identical blocks that
 * differ only in one identifier. Volume looks substantial; the 5-gram ratio collapses.
 */
function paddedCode(copies: number, blockLines = 20): string {
  const out: string[] = [];
  for (let copy = 0; copy < copies; copy++) {
    for (let line = 0; line < blockLines; line++) {
      out.push(`export function step${line}(input: string) { return transform${copy}(input, ${line}); }`);
    }
  }
  return out.join("\n");
}

describe("artifact class (FR-47, Quality Signals §3.1)", () => {
  it("calls two files of prose a Prompt", () => {
    const result = classify(tree({ "SKILL.md": "Rewrite the text so it sounds human. Trigger on humanise." }));
    expect(result.artifact_class).toBe("Prompt");
  });

  it("calls documentation-only content with several files a Pack", () => {
    const result = classify(
      tree({ "SKILL.md": "one", "reference/a.md": "two", "reference/b.md": "three", "reference/c.md": "four" }),
    );
    expect(result.artifact_class).toBe("Pack");
  });

  it("calls a small script a Toolkit", () => {
    const result = classify(tree({ "README.md": "docs", "scripts/run.py": realCode(60) }));
    expect(result.artifact_class).toBe("Toolkit");
  });

  it("calls substantial code with tests a Harness", () => {
    const result = classify(
      tree({
        "README.md": "docs",
        "src/a.ts": realCode(300, 0),
        "src/b.ts": realCode(300, 1000),
        "src/c.ts": realCode(300, 2000),
        "tests/a.test.ts": realCode(40, 3000),
      }),
    );
    expect(result.artifact_class).toBe("Harness");
  });

  it("calls a large, tested, many-file artifact a System", () => {
    const files: Record<string, string> = { "README.md": "docs", "tests/main.test.ts": realCode(50, 900_000) };
    for (let i = 0; i < 40; i++) files[`src/mod${i}.ts`] = realCode(90, i * 1000);
    const result = classify(tree(files));
    expect(result.artifact_class).toBe("System");
  });

  it("caps a padded artifact at Pack — the guard is the whole point (§3.2)", () => {
    // Volume alone would rate this a Harness; deduplicated it is padding.
    const result = classify(tree({ "README.md": "docs", "src/pad.ts": paddedCode(200), "src/more.ts": paddedCode(60) }));

    expect(result.metrics.code_lines).toBeGreaterThan(4000);
    expect(result.metrics.unique_5gram_ratio).toBeLessThan(UNIQUE_5GRAM_GUARD);
    expect(result.artifact_class).toBe("Pack");
    expect(result.guard_note).toMatch(/unique 5-gram/);
  });

  it("does not cap a genuinely substantial artifact", () => {
    const result = classify(tree({ "README.md": "docs", "src/real.ts": realCode(1200) }));
    expect(result.metrics.unique_5gram_ratio).toBeGreaterThan(0.85);
    expect(result.artifact_class).toBe("Harness");
    expect(result.guard_note).toBeUndefined();
  });

  it("flags random-word prose, which n-grams score as maximally novel (§3.3)", () => {
    // 3,000 distinct words: unique 5-grams are 1.0, but the type-token ratio inverts.
    const slop = Array.from({ length: 3000 }, (_, i) => `lexeme${i}`).join(" ");
    const result = classify(tree({ "SKILL.md": slop, "a.md": "x", "b.md": "y" }));
    expect(result.metrics.doc_unique_5gram_ratio).toBeGreaterThan(0.9);
    expect(result.metrics.type_token_ratio).toBeGreaterThan(0.9);
    expect(result.metrics.padding_suspected).toBe(true);
    expect(result.metrics.effective_doc_words).toBeLessThan(1500);
  });
});

describe("dedup metrics (§3.3)", () => {
  it("separates padded from real code", () => {
    expect(unique5GramRatio(paddedCode(50).split(/\s+/))).toBeLessThan(UNIQUE_5GRAM_GUARD);
    expect(unique5GramRatio(realCode(200).split(/\s+/))).toBeGreaterThan(0.9);
  });

  it("returns 1 for a stream too short to measure", () => {
    expect(unique5GramRatio(["a", "b"])).toBe(1);
  });

  it("computes the type-token ratio", () => {
    expect(typeTokenRatio(["a", "a", "b", "b"])).toBe(0.5);
    expect(typeTokenRatio([])).toBe(0);
  });
});

describe("component inventory (FR-48)", () => {
  it("counts concrete nouns, not bytes", () => {
    const inventory = inventoryOf([
      "SKILL.md",
      "scripts/one.py",
      "scripts/two.py",
      "scripts/three.py",
      "tests/a.test.py",
      "reference/api.md",
      "assets/logo.png",
    ]);
    const counts = Object.fromEntries(inventory.map((c) => [c.kind, c.count]));
    expect(counts.skills).toBe(1);
    expect(counts.scripts).toBe(3);
    expect(counts.tests).toBe(1);
    expect(counts.references).toBe(1);
    expect(counts.assets).toBe(1);
  });

  it("renders the FR-48 sentence", () => {
    expect(inventorySentence([{ kind: "skills", count: 1 }, { kind: "scripts", count: 9 }, { kind: "tests", count: 3 }])).toBe(
      "1 skill · 9 scripts · 3 test files",
    );
  });

  it("prefers the more specific claim: a test inside scripts/ is a test", () => {
    const inventory = inventoryOf(["scripts/thing.test.py"]);
    expect(inventory).toEqual([{ kind: "tests", count: 1 }]);
  });

  it("names the buckets a diff touched (FR-15)", () => {
    expect(bucketsTouched(["SKILL.md", "scripts/a.py", "docs/guide.md"])).toEqual(["skills", "scripts", "docs"]);
  });

  /**
   * FR-48's headline is counted nouns a buyer can act on. Before `source` existed, a
   * TypeScript, Go or Java repository — the commonest shape on the platform — was
   * described as "12 other files".
   */
  it("calls source files source files, not other files (FR-48)", () => {
    const inventory = inventoryOf(["src/index.ts", "src/lib/parse.go", "Cargo.toml", "logo.png", "weird.xyz"]);
    const counts = Object.fromEntries(inventory.map((c) => [c.kind, c.count]));
    expect(counts.source).toBe(2);
    expect(counts.config).toBe(1);
    expect(counts.assets).toBe(2);
    expect(counts.other).toBeUndefined();
    expect(inventorySentence(inventory)).toBe("2 source files · 1 config file · 2 assets");
  });

  it("still prefers the more specific bucket to source", () => {
    const counts = Object.fromEntries(
      inventoryOf(["scripts/deploy.ts", "tests/a.test.ts", "examples/demo.ts", "skills/x/run.ts"]).map((c) => [c.kind, c.count]),
    );
    expect(counts).toEqual({ skills: 1, scripts: 1, tests: 1, examples: 1 });
  });
});

/**
 * FR-11's gate is asymmetric: a missed licence file plus GitHub's `NOASSERTION` — which
 * licensee returns for anything it cannot match at 98% similarity (QS §11.5) — turns a
 * `manual` review into a hard `block`. Dual-licensed projects ship `LICENSE-MIT` and
 * `LICENSE-APACHE`; REUSE-compliant ones ship `LICENSES/`.
 */
describe("isLicenceFile (FR-11, FR-36)", () => {
  it("recognises every licence filename in wide use", () => {
    for (const path of [
      "LICENSE",
      "LICENCE",
      "LICENSE.md",
      "LICENSE.txt",
      "license",
      "COPYING",
      "COPYING.LESSER",
      "UNLICENSE",
      "LICENSE-MIT",
      "LICENSE-APACHE",
      "LICENSE_APACHE-2.0.txt",
      "LICENSES/MIT.txt",
      "licenses/Apache-2.0.txt",
    ]) {
      expect(isLicenceFile(path), path).toBe(true);
    }
  });

  it("treats a licence as text however it is named (FR-49)", () => {
    // `LICENSE-MIT` has no known extension and no known bare name; without the licence
    // rule it was binary, so its bytes landed in `bytes_binary` and its bucket was `assets`.
    expect(isTextPath("LICENSE-MIT")).toBe(true);
    expect(isTextPath("LICENSES/Apache-2.0.txt")).toBe(true);
    expect(bucketOf("LICENSE-MIT")).toBe("docs");
  });

  it("does not count the licence text as the creator's writing (FR-47)", () => {
    // GPL-3.0 is ~5,600 words: on its own it clears the 2,500-word `Pack` threshold.
    const gpl = "freedom software program source code copyright license ".repeat(1200);
    const withLicence = classify(tree({ "COPYING": gpl, "prompt.md": "Do the thing." }));
    const withoutLicence = classify(tree({ "prompt.md": "Do the thing." }, ["COPYING"]));

    expect(withLicence.metrics.doc_words).toBe(withoutLicence.metrics.doc_words);
    expect(withLicence.artifact_class).toBe(withoutLicence.artifact_class);
  });

  it("does not mistake a nested or unrelated file for a licence", () => {
    for (const path of [
      "src/LICENSE",
      "vendor/dep/LICENSE",
      "README.md",
      "licenses.json",
      "LICENSE-CHECK/report.txt",
      "licensing.md",
    ]) {
      expect(isLicenceFile(path), path).toBe(false);
    }
  });
});
