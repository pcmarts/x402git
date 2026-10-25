/**
 * lib/web/json-ld.ts — serialise a JSON-LD object for a `<script type="application/ld+json">`
 * block safely.
 *
 * `JSON.stringify` alone is safe only while every input is static; the moment any field
 * carries user or repo text, a literal `</script>` in a string would close the script tag
 * early and let markup escape. Escaping `<` as `<` keeps the payload valid JSON while
 * making that impossible, so the helper is safe to reach for at every JSON-LD site (W2.7).
 */

export function jsonLdSafe(obj: unknown): string {
  return JSON.stringify(obj).replace(/</g, "\\u003c");
}
