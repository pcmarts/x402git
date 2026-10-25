/**
 * The contents column shared by /docs and /docs/errors (2026-08-30, founder: the docs
 * page is dense — "give it a side menu like a regular docs page").
 *
 * One nav, both pages, whole surface: each docs page is a title row with its sections
 * under it, and the count beside each section comes from the same registry and
 * catalogue the pages render — a section can no more go missing from this menu than a
 * route can go missing from the contract. Anchors and ink only: /docs must work with
 * script off, so there is no scrollspy and no toggle. Above 64rem the CSS sticks it
 * beside the reading; below, the same element is the ruled line of anchors the page
 * always had.
 *
 * The section titles live here, not in the pages, so the menu and the headings it
 * points at are one list — the pages import them.
 */

import "@/lib/openapi/routes";
import { registeredRoutes } from "@/lib/openapi/registry";
import { ERROR_CODES, ERRORS, type ErrorGroup } from "@/lib/errors";

export const TAG_ORDER = ["public", "creator", "auth", "internal"] as const;

/** Section headings on /docs. The ids stay the raw tag names, so an anchor shared
 *  before 2026-08-30 still lands. */
export const TAG_TITLE: Record<string, string> = {
  public: "Public",
  creator: "Creator",
  auth: "Identity",
  internal: "Internal",
};

export const GROUP_ORDER: ErrorGroup[] = ["payment", "listing", "auth", "limits", "generic"];

export const GROUP_TITLE: Record<ErrorGroup, string> = {
  payment: "Payment",
  listing: "Listing",
  auth: "Identity",
  limits: "Limits",
  generic: "General",
};

type DocsPath = "/docs" | "/docs/errors";

type Section = { id: string; label: string; count?: number };

/** A docs page in the menu: its title as a link, its sections as rows. `data-here`
 *  marks the current page's list so the phone strip can show this page's sections
 *  and only the other page's title. */
function Group({ href, title, sections, current }: { href: DocsPath; title: string; sections: Section[]; current: DocsPath }) {
  const here = current === href;
  return (
    <>
      <p>
        <a href={href} aria-current={here ? "page" : undefined}>
          {title}
        </a>
      </p>
      <ul data-here={here ? "" : undefined}>
        {sections.map((s) => (
          <li key={s.id}>
            <a href={`${href}#${s.id}`}>
              {s.label}
              {s.count ? <span className="count">{s.count}</span> : null}
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}

export function DocsNav({ current }: { current: DocsPath }) {
  const routes = registeredRoutes();
  const routeSections: Section[] = [
    ...TAG_ORDER.map((tag) => ({
      id: tag,
      label: TAG_TITLE[tag],
      count: routes.filter((r) => r.tags.includes(tag)).length,
    })).filter((s) => s.count > 0),
    { id: "mcp", label: "MCP" },
    { id: "limits", label: "Rate limits" },
  ];
  const errorSections: Section[] = GROUP_ORDER.map((group) => ({
    id: group,
    label: GROUP_TITLE[group],
    count: ERROR_CODES.filter((code) => ERRORS[code].group === group).length,
  })).filter((s) => s.count > 0);

  return (
    <nav className="docs-nav" aria-label="Documentation">
      <Group href="/docs" title="API routes" sections={routeSections} current={current} />
      <Group href="/docs/errors" title="Error codes" sections={errorSections} current={current} />
      <p>
        <a href="/api/openapi.json">openapi.json</a>
      </p>
    </nav>
  );
}
