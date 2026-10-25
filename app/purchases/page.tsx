/**
 * GET /purchases — everything a wallet owns, and a fresh download link for any of it.
 *
 * The one page on this site with no server-side state at all, because it must not have
 * any: entitlement is answered only to a signature from the address being asked about
 * (FR-40, FR-32), so the server cannot know whose purchases to render until a wallet
 * has proved itself in the browser. There is no session, no cookie and no account.
 *
 * What is server-rendered is the frame and the explanation — what this page is, what it
 * needs, and where an agent reads the same list — so the page says something true to a
 * reader before any wallet is connected, and to `curl`. The agent line sits in the small
 * print rather than behind the JavaScript check, because the buyer-operator whose agents
 * paid is reading with script on.
 */

import type { Metadata } from "next";
import { Purchases } from "@/app/_components/purchases";
import { appUrl, paymentChain } from "@/lib/env";
import { agentPurchasesPrompt } from "@/lib/web/agent-prompt";
import { currentSession } from "@/lib/web/current";
import { chainInfo } from "@/lib/web/wallet-checkout";
import { AgentLogos } from "../_components/agent-logos";
import { AgentPrompt } from "../_components/agent-prompt";
import { SiteFooter, SiteHeader } from "../_components/chrome";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your purchases",
  description: "Connect the wallet you paid with to re-download any version it owns.",
  alternates: { canonical: "/purchases" },
  // Nothing here is public and nothing here is indexable: the page is empty until a
  // wallet proves itself.
  robots: { index: false },
};

export default async function PurchasesPage() {
  const session = await currentSession();
  const chain = chainInfo(paymentChain().chainId);
  const prompt = agentPurchasesPrompt({ appUrl: appUrl() });

  return (
    <>
      <SiteHeader signedIn={Boolean(session)} />
      {/* `main.purchases` (globals.css) wears /signin's centred door until the wallet
          component proves an address, then falls back to document flow for the table. */}
      <main className="purchases">
        <h1>Your purchases</h1>
        <p className="written measure">
          Connect the wallet you paid with.
          <br />
          Re-download anything it bought, even after the creator stops selling it.
        </p>

        <Purchases chainName={chain.name} />

        {/* The other door, as /signin and the listing page hand it over: a prompt to paste
            and the agents it is written for. The buyer whose agent paid never had a browser
            wallet, so the button above cannot reach that key and the agent has to ask.
            Server-rendered, so it is there with script off. Hidden once the ledger is up
            (globals.css). `display: contents` keeps the wrapper out of the layout; it
            exists for the analytics listener. */}
        <div className="agent-handoff" data-track="agent_prompt_copied" data-track-prompt="purchases" style={{ display: "contents" }}>
          <AgentPrompt prompt={prompt} what="The purchases prompt" lede="Paid through an agent? Ask it:" />
          <AgentLogos prompt={prompt} what="The purchases prompt" />
        </div>
      </main>
      <SiteFooter signedIn={Boolean(session)} />
    </>
  );
}
