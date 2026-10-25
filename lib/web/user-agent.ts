/**
 * lib/web/user-agent.ts — is this reader an indexer?
 *
 * Exists for exactly one measurement. PRODUCT.md's hypothesis is decided by *manifest
 * views per purchase*, and `app/robots.txt/route.ts` deliberately invites indexing —
 * "search=yes … that is how a buyer finds a listing". So the listing page is crawled on
 * purpose, and every crawl would otherwise land in the denominator of the number the
 * company is testing, making the manifest look like it converts far worse than it does.
 *
 * **A scripted fetch is not an indexer, and on this site it is probably a buyer.** This
 * is the rule that shapes the list below, and it is the opposite of what a normal
 * bot-filter does. `curl`, `python-requests` and a Go HTTP client are how an agent reads
 * a manifest before it pays; robots.txt says so in its own words ("an agent reading a
 * manifest before it pays is the product working as designed"), and agents are half of
 * PRODUCT.md's audience. Excluding them would drop the *buyer class this product exists
 * for* from the numerator while their purchase stayed in the denominator — the precise
 * inversion of the error this module was written to prevent.
 *
 * So only three things are excluded: **search indexers, link previewers, and uptime
 * monitors.** Each of them fetches without any possibility of buying.
 *
 * Two things this is not:
 *
 * - **Not a gate.** Nothing is refused, rate-limited or served differently. A crawler
 *   gets the identical page; the only consequence is a boolean on an analytics row.
 *   A user-agent is self-reported and trivially forged, which is fatal for access
 *   control and perfectly adequate for keeping Googlebot out of a conversion rate.
 * - **Not a view of the machine reading.** `?view=agent` carries that on its own axis
 *   (`props.view`), so human-vs-agent and buyer-vs-indexer stay separable.
 */

/**
 * Matched as whole words, not substrings. `bot` as a substring flags `CUBOT NOTE 20` —
 * a real phone — and dropping a real view is the expensive error here.
 */
const BOT_WORDS = ["bot", "bots", "crawler", "spider", "slurp", "crawl"];

/** Matched as substrings, because each is a distinctive product name on its own. */
const BOT_NAMES = [
  "facebookexternalhit",
  "embedly",
  "quora link preview",
  "skypeuripreview",
  "whatsapp",
  "telegrambot",
  "slackbot",
  "discordbot",
  "uptimerobot",
  "pingdom",
  "statuscake",
  "datadog synthetics",
  "newrelicpinger",
  "lighthouse",
  "chrome-lighthouse",
];

/**
 * Is this user-agent a search indexer, link previewer or uptime monitor?
 *
 * A missing user-agent is **not** treated as one. Every browser sends one and most
 * crawlers do too; the fetchers that omit it are scripts, and on this site a script is
 * more likely an agent evaluating a purchase than a crawler. The module's bias is
 * consistent throughout: when in doubt, count it as a potential buyer.
 */
export function isLikelyBot(userAgent: string | null | undefined): boolean {
  const ua = String(userAgent ?? "").trim().toLowerCase();
  if (ua.length === 0) return false;
  if (BOT_NAMES.some((name) => ua.includes(name))) return true;
  return hasBotToken(ua);
}

/**
 * Split on everything that is not a letter — `googlebot/2.1` yields `googlebot` — then
 * accept a token that either *is* one of the words or *ends* in one with at least four
 * letters in front of it.
 *
 * That length rule is the whole trick. `<name>bot` with no separator is the near-universal
 * shape (`googlebot`, `bingbot`, `yandexbot`, `ahrefsbot`, `semrushbot`), and it cannot be
 * told from `cubot` — a real Android phone — by structure alone. Four characters admits
 * every crawler above and refuses `cubot`, whose prefix is two.
 */
function hasBotToken(ua: string): boolean {
  for (const token of ua.split(/[^a-z]+/)) {
    if (token.length === 0) continue;
    for (const word of BOT_WORDS) {
      if (token === word) return true;
      if (token.endsWith(word) && token.length - word.length >= 4) return true;
    }
  }
  return false;
}
