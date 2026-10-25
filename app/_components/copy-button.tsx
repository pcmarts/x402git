"use client";

/**
 * app/_components/copy-button.tsx — one control, for the values a creator has to hand
 * to something else: the public URL, the resource endpoint, the README preamble.
 *
 * The same honesty rule copy-endpoint.tsx works under: the value itself is always in
 * the server HTML, selectable, so `curl` and a reader with scripting off lose nothing.
 * The button renders only after mount, because `navigator.clipboard` needs a secure
 * context and a user gesture, and a control in the server HTML that cannot work is a
 * lie the page tells before it has loaded.
 *
 * Inset, since 2026-09-01 (on the founder's direction): the button sits *inside* the
 * field that holds the value, at its trailing edge, rather than beside it as a second
 * rectangle — the shape a reader has met on every site that hands over a token. Where
 * it sits is the caller's business (`.copyline`, `.snippet`); what it is is this file's.
 * It keeps its word, because nothing in this icon set is ever the only carrier of
 * meaning; the word simply sets at label size so the control reads as chrome on the
 * field rather than as an action competing with Save.
 */

import { useEffect, useState } from "react";
import { Icon } from "@/app/_components/icons";

export function CopyButton({ value, what }: { value: string; what: string }) {
  const [mounted, setMounted] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  if (!mounted) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard refused (an insecure context, a permissions policy). The value is
      // sitting right there as selectable text, so failing silently loses nothing.
    }
  };

  return (
    <>
      <button type="button" className="copy" onClick={copy} aria-label={`Copy ${what}`}>
        <Icon name="copy" />
        {copied ? "Copied" : "Copy"}
      </button>
      <span role="status" className="sr-only">
        {copied ? `${what} copied` : ""}
      </span>
    </>
  );
}
