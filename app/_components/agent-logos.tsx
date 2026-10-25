"use client";

/**
 * app/_components/agent-logos.tsx — the agents a prompt is written for, each one a
 * way to copy it.
 *
 * A row of the marks Agensi ships under "Works with the AI tools you already use"
 * (2026-09-13, founder — "I like all the icons", "keep the hover tips too"), brought
 * into public/logos/ with the flat blacks set to this sheet's ink and Manus's rounded
 * white plate removed, because nothing here is rounded and nothing sits on a second
 * ground. Claude keeps its orange; a logo recoloured is a different logo.
 *
 * Each mark carries its name as a tooltip drawn in CSS (`.agent-logo .tip`), so it
 * shows on hover and on keyboard focus with no script and is in the server HTML for
 * `curl`. Later the same day the marks became controls (founder): clicking one copies
 * the prompt, and the tip says "Copied" for two seconds in place of the name — the
 * confirmation sits exactly where the reader is already looking. The same honesty rule
 * as copy-button.tsx: the server HTML carries the row as images with names, and the
 * marks turn into buttons only after mount, because a button that cannot reach the
 * clipboard is a lie the page tells before it has loaded. A screen reader hears each
 * name once — the wrapper owns it, the `img` is decorative and the tip is hidden from
 * the tree — and one live region announces the copy.
 */

import { useEffect, useState } from "react";

/** In the order Agensi lists them. Name is the tooltip and the accessible name; the
 *  file is the mark under public/logos/. */
export const AGENTS = [
  { name: "Claude Code", src: "/logos/claude.svg" },
  { name: "Cursor", src: "/logos/cursor.svg" },
  { name: "Codex CLI", src: "/logos/openai.svg" },
  { name: "GitHub Copilot", src: "/logos/copilot.svg" },
  { name: "Gemini CLI", src: "/logos/gemini.svg" },
  { name: "OpenClaw", src: "/logos/openclaw.png" },
  { name: "Manus", src: "/logos/manus.svg" },
  { name: "Grok", src: "/logos/grok.svg" },
] as const;

export function AgentLogos({ prompt, what }: { prompt: string; what: string }) {
  const [mounted, setMounted] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async (name: string) => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(name);
    } catch {
      // Clipboard refused (an insecure context, a permissions policy). The prompt is
      // on the page as selectable text, so failing silently loses nothing.
    }
  };

  return (
    <>
      <ul className="agent-logos" aria-label="Agents this works with">
        {AGENTS.map((a) => {
          const mark = <img src={a.src} alt="" width={24} height={24} loading="lazy" decoding="async" />;
          const tip = (
            <span className="tip" aria-hidden="true">
              {copied === a.name ? "Copied" : a.name}
            </span>
          );
          return (
            <li key={a.name}>
              {mounted ? (
                <button
                  type="button"
                  className="agent-logo"
                  aria-label={`Copy ${what} for ${a.name}`}
                  data-copied={copied === a.name ? "" : undefined}
                  onClick={() => copy(a.name)}
                >
                  {mark}
                  {tip}
                </button>
              ) : (
                <span className="agent-logo" role="img" aria-label={a.name} tabIndex={0}>
                  {mark}
                  {tip}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <span role="status" className="sr-only">
        {copied ? `${what} copied` : ""}
      </span>
    </>
  );
}
