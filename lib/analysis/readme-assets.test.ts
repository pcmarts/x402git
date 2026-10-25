/**
 * lib/analysis/readme-assets.test.ts — FR-49's path arithmetic.
 *
 * This module decides which files out of somebody else's repository get copied into a
 * **public** bucket, so the tests that matter are the refusals: a traversal, an absolute
 * path, a scheme, an extension that is not an image, a control character. A path this
 * module accepts is a path a stranger chose, and the only thing standing between that
 * and the bucket is this file.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_README_ASSETS,
  assetCollector,
  assetContentType,
  directoryOf,
  isSvgPath,
  linkResolver,
  normaliseAssetPath,
} from "./readme-assets";
import { renderMarkdown } from "./markdown";

describe("normaliseAssetPath", () => {
  it("resolves against the README's own directory", () => {
    expect(normaliseAssetPath("shot.png", "docs")).toBe("docs/shot.png");
    expect(normaliseAssetPath("./img/a.png", "docs")).toBe("docs/img/a.png");
    expect(normaliseAssetPath("../a.png", "docs/deep")).toBe("docs/a.png");
  });

  it("treats a leading slash as the repository root, as GitHub does", () => {
    expect(normaliseAssetPath("/docs/a.png", "somewhere")).toBe("docs/a.png");
  });

  it("refuses a path that climbs out of the repository", () => {
    expect(normaliseAssetPath("../../etc/passwd.png", "")).toBeNull();
    expect(normaliseAssetPath("../a.png", "")).toBeNull();
    expect(normaliseAssetPath("docs/../../a.png", "")).toBeNull();
  });

  it("refuses a scheme, a protocol-relative URL and a drive letter", () => {
    expect(normaliseAssetPath("https://example.com/a.png")).toBeNull();
    expect(normaliseAssetPath("data:image/png;base64,AAA")).toBeNull();
    expect(normaliseAssetPath("//example.com/a.png")).toBeNull();
    expect(normaliseAssetPath("C:/x/a.png")).toBeNull();
  });

  it("refuses a backslash, which is not a path separator in a repository", () => {
    expect(normaliseAssetPath("docs\\a.png")).toBeNull();
  });

  it("refuses anything that is not one of the six image extensions", () => {
    expect(normaliseAssetPath("docs/a.js")).toBeNull();
    expect(normaliseAssetPath("docs/a.html")).toBeNull();
    expect(normaliseAssetPath("docs/a")).toBeNull();
    expect(normaliseAssetPath("docs/a.png.js")).toBeNull();
    for (const ext of ["png", "jpg", "jpeg", "gif", "svg", "webp", "avif"]) {
      expect(normaliseAssetPath(`a.${ext}`)).toBe(`a.${ext}`);
    }
  });

  it("drops a query and a fragment, and decodes an escape once", () => {
    expect(normaliseAssetPath("docs/a.png?raw=true")).toBe("docs/a.png");
    expect(normaliseAssetPath("docs/a.png#x")).toBe("docs/a.png");
    expect(normaliseAssetPath("docs/my%20shot.png")).toBe("docs/my shot.png");
  });

  it("keeps an ordinary hyphenated name, which an over-eager control-character guard once ate", () => {
    expect(normaliseAssetPath("docs/my-first-shot.png")).toBe("docs/my-first-shot.png");
  });

  it("refuses a malformed escape rather than guessing", () => {
    expect(normaliseAssetPath("docs/%zz.png")).toBeNull();
  });
});

describe("directoryOf", () => {
  it("is the README's folder, and empty at the root", () => {
    expect(directoryOf("docs/README.md")).toBe("docs");
    expect(directoryOf("README.md")).toBe("");
    expect(directoryOf(null)).toBe("");
  });
});

describe("assetCollector", () => {
  const base = "/api/label/adrian/humanizer/asset";

  it("rewrites a relative image and records the path once", () => {
    const c = assetCollector({ readmeDir: "", assetBase: base });
    expect(c.resolve("docs/shot.png")).toBe(`${base}/docs/shot.png`);
    expect(c.resolve("./docs/shot.png")).toBe(`${base}/docs/shot.png`);
    expect(c.paths()).toEqual(["docs/shot.png"]);
  });

  it("passes an absolute https image through untouched", () => {
    const c = assetCollector({ assetBase: base });
    expect(c.resolve("https://img.shields.io/badge/x-y.svg")).toBe("https://img.shields.io/badge/x-y.svg");
    expect(c.paths()).toEqual([]);
  });

  it("drops http and data, which are the two that cannot be allowed", () => {
    const c = assetCollector({ assetBase: base });
    expect(c.resolve("http://example.com/a.png")).toBeNull();
    expect(c.resolve("data:image/svg+xml,<svg onload=alert(1)>")).toBeNull();
  });

  it("stops at the cap and leaves the rest as markdown source", () => {
    const c = assetCollector({ assetBase: base });
    for (let i = 0; i < MAX_README_ASSETS; i++) expect(c.resolve(`a${i}.png`)).not.toBeNull();
    expect(c.resolve("one-too-many.png")).toBeNull();
    expect(c.paths()).toHaveLength(MAX_README_ASSETS);
  });

  it("resolves nothing relative without a base — a repo analysed outside a listing", () => {
    const c = assetCollector({ assetBase: null });
    expect(c.resolve("docs/shot.png")).toBeNull();
    expect(c.resolve("https://example.com/a.png")).toBe("https://example.com/a.png");
  });

  it("percent-encodes each segment on the way out, so a space cannot split the path", () => {
    const c = assetCollector({ assetBase: base });
    expect(c.resolve("docs/my shot.png")).toBe(`${base}/docs/my%20shot.png`);
  });
});

describe("linkResolver", () => {
  const resolve = linkResolver({ repoHtmlUrl: "https://github.com/adrian/humanizer", ref: "abc123", readmeDir: "" });

  it("points a relative link at the repository when it is public", () => {
    expect(resolve("docs/guide.md")).toBe("https://github.com/adrian/humanizer/blob/abc123/docs/guide.md");
  });

  it("renders a relative link as text when the repository is private", () => {
    const priv = linkResolver({ repoHtmlUrl: null });
    expect(priv("docs/guide.md")).toBeNull();
  });

  it("leaves an absolute link to the existing allow-list", () => {
    expect(resolve("https://example.com/a")).toBe("https://example.com/a");
    expect(resolve("mailto:a@b.com")).toBe("mailto:a@b.com");
    expect(resolve("javascript:alert(1)")).toBeNull();
  });

  it("refuses a bare fragment, which points at an id this page does not mint", () => {
    expect(resolve("#install")).toBeNull();
  });

  it("refuses a link that climbs out of the repository", () => {
    expect(resolve("../../../etc/passwd")).toBeNull();
  });
});

describe("content types", () => {
  it("names each extension, and knows which one is markup", () => {
    expect(assetContentType("a.png")).toBe("image/png");
    expect(assetContentType("a.jpg")).toBe("image/jpeg");
    expect(assetContentType("a.svg")).toBe("image/svg+xml");
    expect(isSvgPath("docs/a.svg")).toBe(true);
    expect(isSvgPath("docs/a.png")).toBe(false);
  });
});

/**
 * The join between the two halves of FR-49: the renderer recognises the tag, the
 * collector records the file, and the snapshot keeps it. A raw `<img>` had the first
 * half missing until 2026-09-01, so the file was never retained either — the picture
 * and the bytes behind it are one feature, and this is the test that says so.
 */
describe("a raw <img> reaches the collector (FR-49)", () => {
  const base = "/api/label/pcmarts/portfolio/asset";

  it("records the path a raw tag points at, so the release retains the file", () => {
    const c = assetCollector({ readmeDir: "", assetBase: base });
    const html = renderMarkdown('<div align="center">\n\n<img src="docs/screenshot.png" alt="The app" width="100%">\n\n</div>', {
      imageSrc: c.resolve,
    });

    expect(html).toContain(`<img src="${base}/docs/screenshot.png"`);
    expect(c.paths()).toEqual(["docs/screenshot.png"]);
  });
});
