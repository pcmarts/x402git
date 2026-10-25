/**
 * app/_components/copy-endpoint.tsx — "Buy with your agent".
 *
 * The x402 endpoint is the product's other front door: an agent GETs it, receives a
 * 402 carrying the price and the exact bytes to sign, pays, and gets the download.
 * Until 2026-09-02 this block handed over that URL and nothing else, and the first
 * thing most readers did with it was paste it into a chat model — which saw a 402
 * status with no body and said the paywall was in the way. That is the wrong hand-off
 * for every agent except the one that already speaks x402.
 *
 * So what is handed over now is a prompt (lib/web/agent-prompt.ts): the ask, the
 * listing page a fetch tool can actually read, the skill that holds the procedure,
 * and the endpoint last. An agent with a wallet buys; one without reads the listing
 * and tells the person what to do.
 *
 * One row, since 2026-09-13 (founder): the same `.copyline` /signin hands the sell
 * prompt over in — the prompt on one line, fading where it runs past the row, Copy
 * inset at the trailing edge and carrying every line. It wore the four-line `.snippet`
 * until then, and four wrapped URLs were the loudest thing under the price; the reader
 * does not need to read the prompt to hand it on, and the agent does the reading.
 *
 * The prompt is server HTML — `curl` and a reader with scripting off get every line,
 * selectable. Only the copy button waits for hydration (copy-button.tsx).
 *
 * Between the heading and the prompt sits a row of the agents the prompt is written
 * for (2026-09-13, founder) — app/_components/agent-logos.tsx, where each mark is
 * also a way to copy the prompt. The heading names the act, the row names who can do
 * it, the prompt is the thing to paste: read top-down it is one sentence.
 *
 * The sentence under the heading went on 2026-09-02 (founder), on the same rule the
 * dashboard's prose follows: it described what the block plainly is, and the prompt's
 * own first line — "Buy {owner}/{slug} from X402 Git for me." — says it in the reader's
 * own words. The heading names the act; the text is the thing.
 */

import { AgentLogos } from "@/app/_components/agent-logos";
import { CopyButton } from "@/app/_components/copy-button";
import { agentBuyPrompt } from "@/lib/web/agent-prompt";

export function CopyEndpoint({ owner, slug, appUrl }: { owner: string; slug: string; appUrl: string }) {
  const prompt = agentBuyPrompt({ owner, slug, appUrl });

  return (
    <div className="agent-buy" data-track="agent_prompt_copied" data-track-prompt="buy">
      <h2>Buy with your agent</h2>
      <AgentLogos prompt={prompt} what="The agent prompt" />
      <p className="copyline">
        <code>
          <span className="url">{prompt}</span>
        </code>
        <CopyButton value={prompt} what="The agent prompt" />
      </p>
    </div>
  );
}
