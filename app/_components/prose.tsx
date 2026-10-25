/**
 * app/_components/prose.tsx — backticks in a copy string, rendered as code.
 *
 * The docs pages keep their copy in plain-string tables (`TAG_BLURB`, `RECOVERY`) so
 * the catalogue they are keyed off stays the single source of the route and error
 * lists. Those strings were written in the register the rest of the repo is written
 * in, with `identifiers` in backticks — and a backtick is not markup to a browser, so
 * they were reaching the page as literal characters on the two pages an agent is most
 * likely to read.
 *
 * Two splits, no parser: `**` segments are strong, then backtick segments are code.
 * The registry's route descriptions (`lib/openapi/routes.ts`) use both, and since
 * 2026-08-30 they render on `/docs` rather than only in the OpenAPI document.
 */

function ticked(text: string) {
  return text.split("`").map((part, i) =>
    i % 2 === 1 ? (
      // eslint-disable-next-line react/no-array-index-key -- the index is the position
      <code key={i}>{part}</code>
    ) : (
      // eslint-disable-next-line react/no-array-index-key -- the index is the position
      <span key={i}>{part}</span>
    ),
  );
}

export function Ticks({ text }: { text: string }) {
  const parts = text.split("**");
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          // eslint-disable-next-line react/no-array-index-key -- the index is the position
          <strong key={i}>{ticked(part)}</strong>
        ) : (
          // eslint-disable-next-line react/no-array-index-key -- the index is the position
          <span key={i}>{ticked(part)}</span>
        ),
      )}
    </>
  );
}
