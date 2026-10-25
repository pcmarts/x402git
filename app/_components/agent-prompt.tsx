/**
 * app/_components/agent-prompt.tsx — a prompt, on one line, fading where it runs past
 * the row, with Copy carrying the whole string.
 *
 * The copy row this site already uses for a URL (`.copyline`), because this is the same
 * act: a value you hand to something else. The fade costs nothing, since the button
 * holds every character; and the whole prompt is in the server HTML, selectable, so a
 * reader with scripting off can still drag it out.
 *
 * Born on the listing dashboard (2026-08-31, founder: "many won't know how to do this")
 * for the two repository jobs that page can ask for but cannot do — add a licence, push
 * a tag. Moved here 2026-09-13 when /signin got the same row for the other door: a person
 * who arrived meaning to sell and whose agent will do the selling. One row, not the
 * listing page's several-line `.snippet`, because on both these pages the row sits
 * beside a control and must not outweigh it.
 */

import { CopyButton } from "@/app/_components/copy-button";

export function AgentPrompt({ prompt, what, lede }: { prompt: string; what: string; lede: string }) {
  return (
    <div className="agent-prompt">
      <p className="lede">{lede}</p>
      <p className="copyline">
        <code>
          <span className="url">{prompt}</span>
        </code>
        <CopyButton value={prompt} what={what} />
      </p>
    </div>
  );
}
