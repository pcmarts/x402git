/**
 * One published document, set as a page.
 *
 * The three of them — the creator agreement, the buyer terms and the abuse policy —
 * are frozen markdown constants that also serve as static files, and this is the human
 * reading of whichever one it is handed. There is no second copy of any of the text:
 * the page renders the same constant the `.md` file mirrors and the API hashes, so a
 * page and a file can no more disagree than a route can go missing from the contract.
 *
 * The document goes through the same two functions a README does — `renderMarkdown`
 * then `sanitiseHtml`, never one without the other — because there is one answer on
 * this site to "what markup may a document ship", and a second renderer for text we
 * happen to trust would be a second answer to maintain.
 *
 * Set per the Computed / Written Rule: the title and the version line are chrome and
 * stay in the computed face; the document itself is prose a person wrote for another
 * person to read, so it is `.written` and carries the measure.
 *
 * `baseHeadingLevel: 1` and not the 2 a README gets, because these documents are not
 * READMEs: their `#` has already been lifted out to be the page's `h1`, so the sections
 * they actually contain are `##` and must land as `h2`. At 2 they landed as `h3` under
 * an `h1` and the outline skipped a level on every one of them.
 */

import { renderMarkdown } from "@/lib/analysis/markdown";
import { documentBody, documentTitle } from "@/lib/web/legal";
import { sanitiseHtml } from "@/lib/web/sanitise-html";

type Props = {
  /** The frozen constant. Its `# Title` and `Version …` line become the page's head. */
  markdown: string;
  version: string;
  /** The raw file this page is the reading of, e.g. `/abuse.md`. */
  sourcePath: string;
};

export function LegalDocument({ markdown, version, sourcePath }: Props) {
  const title = documentTitle(markdown);
  const html = sanitiseHtml(renderMarkdown(documentBody(markdown), { baseHeadingLevel: 1 }));

  return (
    <article>
      <h1>{title}</h1>
      <p className="muted">
        Version {version} · <a href={sourcePath}>{sourcePath.replace(/^\//, "")}</a>
      </p>
      <div className="written" dangerouslySetInnerHTML={{ __html: html }} />
    </article>
  );
}
