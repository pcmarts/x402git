/**
 * lib/analysis/readme-assets.ts — the images a README points at, made servable (FR-49).
 *
 * A README written for GitHub says `![screenshot](docs/shot.png)`, and until 2026-08-30
 * that rendered on the product page as the literal text `![screenshot](docs/shot.png)`,
 * because a relative path is not an address anywhere but inside the repository. The
 * creator's best work — the diagram, the terminal capture, the before-and-after — was
 * the one part of their README the page refused to show.
 *
 * So the files come with the snapshot. At release time the analyser lists the images the
 * README references, the snapshot keeps those bodies, and they are copied into a
 * **public** bucket at `readme-assets/<listing_id>/<release_id>/<path>`. The README's
 * `src` is rewritten to `/api/label/:owner/:slug/asset/<path>`, which redirects there.
 *
 * Four limits, and each of them is a refusal rather than a tuning knob:
 *
 * - **20 files.** A README that references a hundred images is a gallery, and a gallery
 *   is not a manifest. The first twenty in document order are taken and the rest render
 *   as their markdown source, which is what they did yesterday.
 * - **2 MB each.** Above that it is not a screenshot.
 * - **A closed extension list.** `png jpg jpeg gif svg webp avif`. Not "whatever the
 *   README asked for": this bucket is public and its contents are chosen by a stranger.
 * - **No escaping the repository.** `../../etc/passwd`, an absolute path and a Windows
 *   drive letter are all refused before anything is looked up. The path that reaches
 *   storage is one this module built out of validated segments, never one it was handed.
 *
 * Nothing here fetches anything or touches storage; it is path arithmetic and a filter,
 * so it is testable without a network and is shared by the analyser and the pipeline.
 */

/** The README may reference at most this many images. Document order wins. */
export const MAX_README_ASSETS = 20;

/** Per-file ceiling. A screenshot is not two megabytes; a video frame dump is. */
export const MAX_README_ASSET_BYTES = 2 * 1024 * 1024;

/** Extensions a public bucket will serve. Closed, because the bucket is public. */
export const README_ASSET_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "avif"]);

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  avif: "image/avif",
};

/**
 * The `Content-Type` an extension earns. Unknown extensions never reach here — they were
 * refused by `normaliseAssetPath` — so there is no "octet-stream" fallback to sniff.
 */
export function assetContentType(path: string): string {
  return CONTENT_TYPES[extensionOfPath(path)] ?? "application/octet-stream";
}

/** SVG is markup. Everything else is a bitmap, and the difference decides how it is served. */
export function isSvgPath(path: string): boolean {
  return extensionOfPath(path) === "svg";
}

function extensionOfPath(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/**
 * A markdown `src` → a repository-relative path, or `null`.
 *
 * `base` is the directory the README sits in, because a relative path in a README is
 * relative to that README and not to the repository root — `docs/README.md` saying
 * `![x](shot.png)` means `docs/shot.png`.
 *
 * Returns `null` for anything absolute, anything with a scheme, anything that climbs
 * out of the tree, anything with an extension that is not an image, and anything with a
 * control character or a backslash in it. The survivors are `a/b/c.png`: forward
 * slashes, no `.` or `..` segments, no leading slash.
 */
export function normaliseAssetPath(src: string, base = ""): string | null {
  let raw = src.trim();
  if (raw === "") return null;
  // A scheme, a protocol-relative URL or a Windows drive letter is not a repo path.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//") || /^[a-z]:[\\/]/i.test(raw)) return null;
  if (raw.includes("\\") || /[\u0000-\u001f\u007f]/.test(raw)) return null;

  // A fragment or query on a repository file is decoration; drop it before anything else.
  raw = raw.split("#")[0].split("?")[0];
  if (raw === "") return null;

  try {
    raw = decodeURIComponent(raw);
  } catch {
    return null; // a malformed escape is not a path we are going to guess at
  }
  if (raw.includes("\\") || /[\u0000-\u001f\u007f]/.test(raw)) return null;

  // A leading slash means the repository root on GitHub, so it is honoured and the base
  // is dropped rather than the whole reference being refused.
  const rooted = raw.startsWith("/");
  const segments = [...(rooted ? [] : base.split("/")), ...raw.split("/")];

  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      // Climbing above the repository root is a traversal attempt, not a typo.
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }

  const path = out.join("/");
  if (path === "") return null;
  if (!README_ASSET_EXTENSIONS.has(extensionOfPath(path))) return null;
  return path;
}

/** `docs/README.md` → `docs`; `README.md` → `""`. */
export function directoryOf(path: string | null | undefined): string {
  if (!path) return "";
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "" : path.slice(0, cut);
}

/**
 * The collector the analyser hands to `renderMarkdown` as its `imageSrc` resolver.
 *
 * It is a closure with a set behind it, so one pass over the README both rewrites the
 * `src` attributes and records exactly which files the snapshot has to keep. Two passes
 * would be two chances for the list and the markup to disagree about what is on the page.
 *
 * Absolute `https:` passes through untouched. `http:` is dropped — a mixed-content image
 * on a page served over TLS does not render anyway, so a broken image is all a
 * pass-through would buy. `data:` is dropped: it is the one image source that can carry
 * a payload rather than point at one.
 */
export type AssetCollector = {
  /** Pass to `renderMarkdown({ imageSrc })`. */
  resolve: (src: string) => string | null;
  /** Repository-relative paths the README referenced, in document order. */
  paths: () => string[];
};

export function assetCollector(options: { readmeDir?: string; assetBase?: string | null }): AssetCollector {
  const dir = options.readmeDir ?? "";
  const base = options.assetBase?.replace(/\/$/, "") ?? null;
  const found: string[] = [];

  return {
    resolve(src: string): string | null {
      const trimmed = src.trim();
      if (/^https:/i.test(trimmed)) return trimmed;
      if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) return null; // http:, data:, everything else

      // Without a base there is nowhere to serve a relative image from — the analyser is
      // running outside a listing — so it stays markdown source, as it always did.
      if (!base) return null;

      const path = normaliseAssetPath(trimmed, dir);
      if (!path) return null;
      if (!found.includes(path)) {
        if (found.length >= MAX_README_ASSETS) return null;
        found.push(path);
      }
      return `${base}/${path.split("/").map(encodeURIComponent).join("/")}`;
    },
    paths: () => [...found],
  };
}

/**
 * The link resolver: a relative `[the guide](docs/guide.md)` becomes a GitHub URL when
 * the repository is public, and plain text when it is not.
 *
 * A private repository's file has no address a reader can open, and a link that 404s for
 * everyone but the owner is worse than the words — the same rule the About block already
 * follows for `html_url`. So there is no link, and the label renders as the markdown
 * source it came from.
 */
export function linkResolver(options: { repoHtmlUrl?: string | null; ref?: string | null; readmeDir?: string }) {
  const dir = options.readmeDir ?? "";
  const root = options.repoHtmlUrl?.replace(/\/$/, "") ?? null;
  const ref = options.ref?.trim() || "HEAD";

  return (href: string): string | null => {
    const trimmed = href.trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) {
      // Absolute: the existing allow-list decides, unchanged.
      return absoluteLink(trimmed);
    }
    // A bare `#anchor` points inside the rendered README, which is a fragment this page
    // does not mint ids for. It stays text rather than becoming a link to nowhere.
    if (trimmed.startsWith("#") || trimmed === "") return null;
    if (!root) return null;

    const path = repoRelativePath(trimmed, dir);
    if (!path) return null;
    return `${root}/blob/${encodeURIComponent(ref)}/${path.split("/").map(encodeURIComponent).join("/")}`;
  };
}

/** `normaliseAssetPath` without the image-extension rule: any repository file may be linked. */
function repoRelativePath(src: string, base: string): string | null {
  let raw = src.trim();
  if (raw.includes("\\") || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  const [pathPart, ...rest] = raw.split("#");
  raw = pathPart.split("?")[0];
  if (raw === "") return null;

  try {
    raw = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (raw.includes("\\")) return null;

  const rooted = raw.startsWith("/");
  const segments = [...(rooted ? [] : base.split("/")), ...raw.split("/")];
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  const path = out.join("/");
  // The fragment is deliberately dropped rather than carried: `#heading` on a GitHub
  // blob page is an anchor GitHub mints, and guessing at it produces a link that lands
  // on the file but not on the section, which reads as a bug.
  void rest;
  return path === "" ? null : path;
}

/** The same allow-list `safeUrl` applies, without importing the block renderer. */
function absoluteLink(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "mailto:") return null;
    return parsed.href;
  } catch {
    return null;
  }
}
