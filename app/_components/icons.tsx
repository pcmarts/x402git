/**
 * app/_components/icons.tsx — the drawn marks, and the only ones in the product.
 *
 * Added 2026-08-30 for "What's inside", which is the section that has to do the most
 * work on the page: it is the answer to *what am I actually buying*, and until now it
 * was a two-column table of names and numbers that a reader had to assemble into a
 * shape in their own head. A folder row with a mark on it is read as a folder before it
 * is read at all.
 *
 * Five rules, and they are what make this a set rather than a pile of SVGs:
 *
 * 1. **One grid, one weight.** Every icon is drawn inside `0 0 16 16`, on half-pixel
 *    coordinates so a 1px stroke lands on the pixel grid at 1× and stays crisp, with
 *    `stroke-width` 1.25 and no fills. It is the same hairline the rules on this site
 *    are drawn with, at the same weight, which is the whole reason they sit together.
 * 2. **Square ends, mitred joins.** `--radius` is `0` and nothing in this system is
 *    rounded. A rounded cap would be the one soft edge on a page of printed rules.
 * 3. **`currentColor`, always.** No icon carries a colour. They inherit Ink in a table
 *    row and Ash in a muted one, and The Closed Ink Set Rule is never touched.
 * 4. **Never the only carrier of meaning.** Every icon on this site sits beside the word
 *    it illustrates, and is `aria-hidden`. A reader who cannot see it loses nothing —
 *    which is also why there is no icon-only control anywhere, with one recorded
 *    exception: the card rail's arrow pair (founder, 2026-08-30), whose words ship as
 *    screen-reader text and whose position the counter between them prints.
 * 5. **No emoji, ever.** An emoji is somebody else's drawing at somebody else's weight
 *    in somebody else's palette, and it changes on every operating system.
 *
 * The set is small on purpose: ten marks, mapped from the analyser's own component
 * buckets (`lib/analysis/files.ts`) so a new bucket cannot invent an eleventh by accident
 * — `iconFor` falls back to the file mark rather than to nothing.
 */

import type { ComponentBucket } from "@/lib/analysis/files";

export type IconName =
  | "folder"
  | "file"
  | "doc"
  | "code"
  | "terminal"
  | "check"
  | "config"
  | "image"
  | "spark"
  | "star"
  | "copy"
  | "book"
  | "arrow-left"
  | "arrow-right";

type IconProps = {
  name: IconName;
  /** Only ever 16 in this product; the prop exists so a caller cannot hard-code a size. */
  size?: number;
};

/**
 * Every mark, as path data on the shared grid. Data rather than components so the whole
 * set is one object a reader can take in at once, and so adding one is a visible act.
 */
const PATHS: Record<IconName, string[]> = {
  // A folder: the tab is a step in the top edge, not a second shape.
  folder: ["M1.5 12.5v-9h4l1.5 2h7.5v7z"],
  // A sheet with its corner turned. The fold is the second path, so the outline stays one stroke.
  file: ["M3.5 14.5v-13h6l3 3v10z", "M9.5 1.5v3h3"],
  // The same sheet with text on it: documentation, references, examples, templates.
  doc: ["M3.5 14.5v-13h6l3 3v10z", "M9.5 1.5v3h3", "M5.5 8.5h5", "M5.5 11.5h5"],
  // Angle brackets: source.
  code: ["M6 4.5L2.5 8L6 11.5", "M10 4.5L13.5 8L10 11.5"],
  // A prompt and a rule: a script is a thing you run.
  terminal: ["M1.5 2.5h13v11h-13z", "M4.5 6L7 8.5L4.5 11", "M8.5 11h3.5"],
  // A tick inside the sheet: a test file is a claim that was checked.
  check: ["M3.5 14.5v-13h6l3 3v10z", "M9.5 1.5v3h3", "M5.5 10L7.25 11.75L10.5 8.5"],
  // Two tracks with a handle each: configuration, and CI, which is configuration that runs.
  config: ["M1.5 5.5h13", "M1.5 10.5h13", "M5.5 3.5h2v4h-2z", "M9.5 8.5h2v4h-2z"],
  // A frame with a horizon and a sun: an asset is a picture until proven otherwise.
  image: ["M1.5 3.5h13v9h-13z", "M1.5 10L5 6.5L8 9.5L10 7.5L14.5 12", "M10.5 5.5h1.5v1.5h-1.5z"],
  // A four-point star: a skill, an agent, a command, a hook — the things that act.
  spark: ["M8 1.5L9.5 6.5L14.5 8L9.5 9.5L8 14.5L6.5 9.5L1.5 8L6.5 6.5z"],
  // GitHub's five-point star, drawn on this grid at this weight rather than borrowed as
  // the `★` character — a glyph is somebody else's drawing at somebody else's weight,
  // and it is also announced by a screen reader as "black star".
  star: ["M8 1.5L9.53 5.9L14.18 6L10.47 8.8L11.82 13.26L8 10.6L4.18 13.26L5.53 8.8L1.82 6L6.47 5.9z"],
  // Two sheets, the front one whole and the back one peeking out: a copy.
  copy: ["M5.5 4.5h9v10h-9z", "M2.5 11.5v-10h9"],
  // GitHub's open book, drawn on this grid: two leaves meeting at the spine. The
  // README's mark, and nothing else's.
  book: ["M8 3.5C6.5 2.3 4.5 2 1.5 2.5v10c3-.5 5 -.2 6.5 1", "M8 3.5c1.5-1.2 3.5-1.5 6.5-1v10c-3-.5-5-.2-6.5 1", "M8 3.5v10"],
  // The card rail's paging chevrons — the `code` brackets' geometry, one bracket at a
  // time, centred on the grid.
  "arrow-left": ["M9.5 3.5L5 8L9.5 12.5"],
  "arrow-right": ["M6.5 3.5L11 8L6.5 12.5"],
};

/**
 * One mark. `aria-hidden` and `focusable="false"` without exception: every use on this
 * site has the word beside it, and an icon that announces itself in a table of file
 * paths would read every row twice.
 */
export function Icon({ name, size = 16 }: IconProps) {
  return (
    <svg
      className="icon"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/**
 * The analyser's bucket → its mark.
 *
 * The buckets are the product's own vocabulary (FR-48 counts nouns out of them), so the
 * icons are keyed on them rather than on file extensions: a reader who has learned that
 * a four-point star means "a thing that acts" has learned it once, and it holds for a
 * skill, an agent, a command and a hook alike.
 */
const BUCKET_ICONS: Record<ComponentBucket, IconName> = {
  skills: "spark",
  commands: "spark",
  agents: "spark",
  hooks: "spark",
  mcp_servers: "spark",
  workflows: "spark",
  tests: "check",
  ci: "config",
  scripts: "terminal",
  source: "code",
  references: "doc",
  examples: "doc",
  templates: "doc",
  docs: "doc",
  config: "config",
  assets: "image",
  other: "file",
};

/** A bucket's mark, or the sheet for anything this set does not know about. */
export function iconFor(bucket: string | null | undefined): IconName {
  return BUCKET_ICONS[bucket as ComponentBucket] ?? "file";
}
