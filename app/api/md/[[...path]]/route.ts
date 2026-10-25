/**
 * GET /api/md/… — the markdown reading of a public page.
 *
 * Nothing links here. It is the destination of the `Accept: text/markdown` rewrites in
 * next.config.ts: an agent asks for `/{owner}/{slug}` with that header, Next routes the
 * request here without a redirect, and the URL the agent asked for is the URL it read.
 * HTML stays the default for everything that does not ask.
 *
 * The path is the page's own path, so this route is a switch and lib/web/markdown.ts is
 * the writer. Loading is the page's loader in every case — `loadListingByPath`,
 * `loadAuthorPage` — because a markdown reading that answered from a different query
 * than the HTML would be a second product with the same URL.
 *
 * `x-markdown-tokens` is an estimate, not a count: four characters per token is the
 * rule of thumb every tokenizer disagrees with, and a client deciding whether a
 * document fits in its context wants the number before it downloads, not a precise one.
 * It is labelled as an estimate for that reason.
 */

import { NextResponse } from "next/server";
import { appUrl } from "@/lib/env";
import { handle } from "@/lib/errors";
import { authorMarkdown, docsMarkdown, errorsMarkdown, homeMarkdown, howItWorksMarkdown, listingMarkdown } from "@/lib/web/markdown";
import { loadAuthorPage, loadListingByPath, manifestFor } from "@/lib/web/loaders";

export const dynamic = "force-dynamic";

/** Rough, and honest about it: ~4 characters per token. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function markdown(text: string): NextResponse {
  return new NextResponse(text, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "x-markdown-tokens": String(estimateTokens(text)),
      // The HTML and the markdown are one resource negotiated on `Accept`; a shared
      // cache that ignored that would serve one reader the other's document.
      vary: "accept",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=60, s-maxage=300, stale-while-revalidate=86400",
    },
  });
}

/**
 * One fixed document for every miss (SCAN-10). It never echoes the path: the path is
 * whatever a stranger typed into a link, and quoting it back — a newline is enough to
 * break out of a code span — let anyone publish markdown of their choosing from this
 * origin. No CORS header and no shared caching either: nothing cross-origin reads a
 * miss, and a 404 cached at the edge would outlive the listing that fixes it.
 */
const NOT_FOUND_TEXT = "# Not found\n\nThere is no public page at this address. Listings live at `/{owner}/{slug}` and creators at `/{owner}`.\n";

function notFound(): NextResponse {
  return new NextResponse(NOT_FOUND_TEXT, {
    status: 404,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "x-markdown-tokens": String(estimateTokens(NOT_FOUND_TEXT)),
      vary: "accept",
      "cache-control": "no-store",
    },
  });
}

async function render(segments: string[], base: string): Promise<NextResponse> {
  const path = segments.join("/");

  if (path === "") return markdown(homeMarkdown(base));
  if (path === "how-it-works") return markdown(howItWorksMarkdown(base));
  if (path === "docs") return markdown(docsMarkdown(base));
  if (path === "docs/errors") return markdown(errorsMarkdown(base));

  // `/{owner}/{slug}` — a listing. Drafts are not readable by URL here either.
  if (segments.length === 2) {
    const [owner, slug] = segments;
    const bundle = await loadListingByPath(owner.toLowerCase(), slug.toLowerCase());
    if (!bundle || bundle.status === "draft") return notFound();
    const manifest = bundle.latest ? manifestFor(bundle, bundle.latest) : null;
    return markdown(listingMarkdown(bundle, manifest, base));
  }

  // `/{owner}` — everything one creator sells.
  if (segments.length === 1) {
    const page = await loadAuthorPage(segments[0]);
    if (!page) return notFound();
    return markdown(authorMarkdown(page, base));
  }

  return notFound();
}

export const GET = handle(async (_req: Request, ctx: { params: Promise<{ path?: string[] }> }) => {
  const { path } = await ctx.params;
  return await render(path ?? [], appUrl());
});
