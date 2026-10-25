/**
 * GET /signin — the sign-in page, and where a failed OAuth round trip lands.
 *
 * One door, two ways through it. The heading; the GitHub button, for the person who
 * sells through GitHub; and under it the headless rail, handed over the way the listing
 * page hands over buying — not explained, but as a prompt to paste into an agent
 * (2026-09-13, founder). The button is a GET form to `/api/auth/github`, the same
 * control the home page uses, so it works with JavaScript off. The scope is explained
 * where it is asked for, on GitHub's own consent screen.
 *
 * The prompt is one row (app/_components/agent-prompt.tsx) so it reads as the
 * alternative to the button and not as a second door. It names the sell skill and the
 * OpenAPI document, which between them are the whole procedure; /docs stays where the
 * reader who wants the long form is sent. Under the row, the agents it is written for
 * (agent-logos.tsx) — the same marks the listing page shows a buyer, and clicking one
 * copies the prompt too.
 *
 * Nothing for buyers. The page used to end with small print sending a buyer to
 * /purchases (2026-08-30 to 2026-09-13); it went because the header already carries
 * that link on every page, nothing ever redirects a buyer here, and the heading already
 * says which door this is. Before that it explained the OAuth scope and the headless
 * rail in prose, which is documentation, not a door.
 */

import type { Metadata } from "next";
import { appUrl } from "@/lib/env";
import { agentSellPrompt } from "@/lib/web/agent-prompt";
import { optionalSession } from "@/lib/web/current";
import { AgentLogos } from "../_components/agent-logos";
import { AgentPrompt } from "../_components/agent-prompt";
import { SiteFooter, SiteHeader } from "../_components/chrome";
import { GitHubMark } from "../_components/github-mark";

export const metadata: Metadata = {
  title: "Sign in to sell",
  robots: { index: false, follow: false },
  description: "Sign in with GitHub to list a private repository. Read-only scope; repository access comes from installing the app on one repo.",
};

export const dynamic = "force-dynamic";

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const { error, next } = await searchParams;
  const signedIn = Boolean(await optionalSession());
  const destination = next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
  const sellPrompt = agentSellPrompt({ appUrl: appUrl() });

  return (
    <>
      <SiteHeader signedIn={signedIn} />
      {/* `main.auth` (globals.css) centres the column between the chrome and runs the
          button the column's width — the shape every sign-in screen has taught. */}
      <main className="auth">
        <h1>Sign in to sell</h1>

        {error ? (
          <p role="alert" data-status="fail">
            {error}
          </p>
        ) : null}

        <form method="get" action="/api/auth/github" data-track="sign_in_started" data-track-from="signin">
          <input type="hidden" name="next" value={destination} />
          <button type="submit" data-variant="github">
            <GitHubMark />
            Continue with GitHub
          </button>
        </form>

        {/* `display: contents` so the wrapper exists only for the analytics listener
            (app/_components/analytics.tsx) and changes nothing about the layout. */}
        <div data-track="agent_prompt_copied" data-track-prompt="sell" style={{ display: "contents" }}>
          <AgentPrompt prompt={sellPrompt} what="The sell prompt" lede="Or tell your agent to sell:" />
          <AgentLogos prompt={sellPrompt} what="The sell prompt" />
        </div>
      </main>
      <SiteFooter signedIn={signedIn} />
    </>
  );
}
