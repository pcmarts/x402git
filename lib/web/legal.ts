/**
 * lib/web/legal.ts — splitting a published document into a page's parts.
 *
 * The three published documents (lib/terms.ts, lib/buyer-terms.ts, lib/abuse.ts) are
 * frozen markdown that opens the same way: an `# H1`, then a `Version <date>.` line,
 * then the document. A page renders that head as its own chrome — the title as the
 * page's `h1` in the computed face, the version beside the link to the raw file — and
 * the rest as prose. Rendering the constant whole would print the title twice and set
 * the version in the text face, so the head comes off here rather than being duplicated
 * into each page as a prop somebody can get out of step with the file.
 */

/** The `# Title` the document opens with, or null if it does not open with one. */
export function documentTitle(markdown: string): string | null {
  const first = markdown.split("\n", 1)[0] ?? "";
  return first.startsWith("# ") ? first.slice(2).trim() : null;
}

/** Everything after the title and the `Version …` line, with the blank lines trimmed. */
export function documentBody(markdown: string): string {
  const lines = markdown.split("\n");
  let i = 0;
  if (lines[i]?.startsWith("# ")) i += 1;
  while (lines[i]?.trim() === "") i += 1;
  if (/^Version .+\.$/.test(lines[i]?.trim() ?? "")) i += 1;
  while (lines[i]?.trim() === "") i += 1;
  return lines.slice(i).join("\n");
}
