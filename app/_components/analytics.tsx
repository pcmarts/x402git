"use client";

/**
 * Vercel Web Analytics (2026-09-13, founder) — page traffic across the whole site, which
 * the §10 `event` table does not have: it records a view only on the listing page, and
 * nothing about referrers, countries or devices. Cookieless, first-party script.
 *
 * Two things are kept out before an event leaves the browser:
 *
 * - **`/admin` and `/dashboard` are not tracked.** They are operators and creators
 *   looking at their own screens, not traffic, and counting them would put the founder
 *   in the numbers the PRD wants split by founder and non-founder.
 * - **Query strings are dropped**, except `view` (human or agent reading of a listing)
 *   and the `utm_*` campaign tags, which are how a creator's link in a tweet or README
 *   shows up as a source. Dashboard and admin redirects carry `?ok=` / `?error=`
 *   sentences, and admin search carries `?q=` — which can be a payout address. None of
 *   that belongs in a third party's store, and those paths are excluded anyway; this is
 *   the belt to that.
 *
 * **Custom events from server-rendered markup** go through one delegated listener here,
 * so a server component never has to become a client component to be counted. Mark the
 * element and it is tracked:
 *
 *   <form data-track="sign_in_started" data-track-from="signin">   → on submit
 *   <a data-track="agent_reading_opened">                           → on click
 *   <div data-track="agent_prompt_copied"> …<button>… </div>        → on a button inside
 *
 * `data-track-*` attributes become properties (`data-track-from` → `from`), two at most
 * (Vercel Pro's limit). A button inside a tracked form is left to the form's submit, so
 * one press is one event. Client components that know more — the buy button — call
 * `track` themselves. Server events are mirrored separately (lib/analytics/vercel.ts).
 */

import { track } from "@vercel/analytics";
import { Analytics, type BeforeSendEvent } from "@vercel/analytics/next";
import { useEffect } from "react";

const PRIVATE = /^\/(admin|dashboard)(\/|$)/;

export function beforeSend(event: BeforeSendEvent): BeforeSendEvent | null {
  let url: URL;
  try {
    url = new URL(event.url);
  } catch {
    return null;
  }
  if (PRIVATE.test(url.pathname)) return null;

  const kept = [...url.searchParams].filter(
    ([key, value]) => (key === "view" && (value === "human" || value === "agent")) || /^utm_(source|medium|campaign|term|content)$/.test(key),
  );
  url.search = "";
  for (const [key, value] of kept) url.searchParams.append(key, value);
  url.hash = "";
  return { ...event, url: url.toString() };
}

/** `data-track-from="signin"` → `{ from: "signin" }`, two properties at most. Pure. */
export function trackedProps(dataset: DOMStringMap): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(dataset)) {
    if (!key.startsWith("track") || key.length === 5 || value === undefined) continue;
    if (Object.keys(out).length >= 2) break;
    out[key[5].toLowerCase() + key.slice(6)] = value.slice(0, 255);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function SiteAnalytics() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      const control = target?.closest("button, a[data-track]");
      if (!control || control.closest("form[data-track]")) return;
      const host = control.closest<HTMLElement>("[data-track]");
      if (host?.dataset.track) track(host.dataset.track, trackedProps(host.dataset));
    };
    const onSubmit = (e: SubmitEvent) => {
      const form = e.target instanceof HTMLFormElement ? e.target : null;
      if (form?.dataset.track) track(form.dataset.track, trackedProps(form.dataset));
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onSubmit, true);
    };
  }, []);

  return <Analytics beforeSend={beforeSend} />;
}
