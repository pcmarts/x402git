/**
 * The one-field search the admin tables share.
 *
 * A real `<form method="get">`, so the query lands in the URL: a search survives a
 * reload, can be pasted to somebody else, and works before hydration and with script
 * off. That also means the state has one home — no component holds a copy of what the
 * URL already says.
 *
 * `hidden` carries the filter the page is already on, because a GET form replaces the
 * whole query string: without it, searching inside `Needs review` would silently drop
 * you back into `All` and return rows the filter had excluded.
 *
 * The submit button is present rather than relying on Enter — a lone text input with no
 * visible verb is a control people are not sure is live.
 */

export function SearchBox({
  action,
  q,
  label,
  placeholder,
  hidden,
}: {
  action: string;
  q?: string;
  label: string;
  placeholder: string;
  hidden?: Record<string, string | undefined>;
}) {
  return (
    <form method="get" action={action} className="searchbox" role="search">
      {Object.entries(hidden ?? {}).map(([name, value]) =>
        value === undefined ? null : <input key={name} type="hidden" name={name} value={value} />,
      )}
      <label htmlFor="admin-q">{label}</label>
      <input
        id="admin-q"
        name="q"
        type="search"
        defaultValue={q ?? ""}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
      />
      <button type="submit">Search</button>
      {q && q.trim().length > 0 ? <a href={action}>Clear</a> : null}
    </form>
  );
}
