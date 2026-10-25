/**
 * lib/indexnow.ts — tell the search engines a listing page changed.
 *
 * IndexNow (indexnow.org) is the push half of search indexing: one POST with the URLs
 * that changed, and Bing, Yandex, Naver, Seznam and Yep index them without waiting
 * for a crawl. Bing's index is what ChatGPT search reads, so this is the shortest
 * path from "published" to "findable by topic in a chat product" — see
 * docs/research/Agent Discovery Channels.md, recommendation 2. Google does not take
 * IndexNow; it has the sitemap and Search Console.
 *
 * Three rules:
 *
 * 1. **It never fails the caller.** A publish, a retirement or a release cut has already
 *    happened by the time this runs; an index that did not hear about it is a chore, not
 *    a reason to roll back. Every failure is returned, logged, and swallowed.
 * 2. **It is off without a key.** `INDEXNOW_KEY` absent means `skipped`, so a preview
 *    deployment or a local run never pings a search engine about a URL it cannot serve.
 * 3. **The key is verifiable, at the root.** The engine fetches `keyLocation` and expects
 *    the key as the body — and a key file only vouches for URLs *under its own path*, so
 *    one under `/.well-known/` would verify nothing (IndexNow answers 422, found out
 *    16 Sep 2026). It is therefore `/<key>.txt`: a rewrite in next.config.ts sends that
 *    to `app/.well-known/indexnow-key.txt/route.ts`, which answers only for the real key.
 */

import { appUrl, env } from "@/lib/env";

export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/IndexNow";

/** Where the engine reads the key back: the site root, so it vouches for every URL. */
export function indexNowKeyPath(key: string): string {
  return `/${key}.txt`;
}

export type IndexNowResult = { status: "sent"; urls: string[] } | { status: "skipped"; reason: string } | { status: "failed"; reason: string };

type Deps = { fetch?: typeof fetch; timeoutMs?: number };

/** Announce the given site paths (`/owner/slug`) as changed. Resolves; never rejects. */
export async function notifyIndexNow(paths: string[], deps: Deps = {}): Promise<IndexNowResult> {
  const key = env().INDEXNOW_KEY;
  if (!key) return { status: "skipped", reason: "INDEXNOW_KEY is not set" };
  if (paths.length === 0) return { status: "skipped", reason: "nothing to announce" };

  const base = appUrl();
  const host = new URL(base).host;
  const urls = paths.map((p) => (p.startsWith("http") ? p : `${base}${p.startsWith("/") ? p : `/${p}`}`));
  const doFetch = deps.fetch ?? fetch;

  try {
    const res = await doFetch(INDEXNOW_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host, key, keyLocation: `${base}${indexNowKeyPath(key)}`, urlList: urls }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 5000),
    });
    // 200 and 202 both mean accepted; anything else is the engine declining.
    if (res.status === 200 || res.status === 202) return { status: "sent", urls };
    const reason = `IndexNow answered ${res.status}`;
    console.warn(`[indexnow] ${reason} for ${urls.join(", ")}`);
    return { status: "failed", reason };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn(`[indexnow] ${reason} for ${urls.join(", ")}`);
    return { status: "failed", reason };
  }
}
