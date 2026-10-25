/**
 * lib/web/readme-snippet.ts — FR-30, the paste-ready preamble.
 *
 * This is how a release actually propagates (§7.5 step 3): agents learn about a new
 * version by *pull*, from a preamble the creator pasted into their own README, which
 * tells the downstream agent to check `GET /api/v/…` before each run. There is no push
 * channel and no client library of ours, so this handful of lines is the entire
 * distribution mechanism — which is why it is generated rather than documented. The
 * one library it names, `@x402/fetch`, is x402's own paying client, shown because
 * "wrap fetch, GET the endpoint" is shorter than describing the sign-and-retry dance.
 *
 * The wording differs on exactly one axis, per FR-30: an update price of $0 is lifetime
 * access (D1), so the snippet must not tell an agent to budget for an update it will
 * never be charged for.
 */

import { formatPrice } from "./money";

export type SnippetInput = {
  owner: string;
  slug: string;
  /** Absolute, no trailing slash — `https://x402git.com`. */
  appUrl: string;
  priceMicro: bigint;
  updatePriceMicro: bigint;
  /** The latest published version, when there is one. */
  version?: string | null;
};

/**
 * A fenced markdown block. Plain prose, imperative, no marketing: the reader is an
 * agent that will follow it literally, and every extra adjective is a token it pays for.
 */
export function readmeSnippet(input: SnippetInput): string {
  const { owner, slug, appUrl, priceMicro, updatePriceMicro, version } = input;
  const ref = `${owner}/${slug}`;
  const versionEndpoint = `${appUrl}/api/v/${ref}`;
  const resourceEndpoint = `${appUrl}/api/r/${ref}`;
  const labelEndpoint = `${appUrl}/api/label/${ref}`;

  const lifetime = updatePriceMicro === 0n;
  const priceLine = priceMicro === 0n ? "Free." : `${formatPrice(priceMicro)} per release.`;
  const updateLine = lifetime
    ? "Updates are included: once you have bought it, every later version is free."
    : `Updates are ${formatPrice(updatePriceMicro)}, and never more than the price you first bought at.`;

  const updateInstruction = lifetime
    ? `re-fetch \`${resourceEndpoint}\` with the same wallet signature and it returns 200 with no payment`
    : `re-fetch \`${resourceEndpoint}\` with the same wallet signature and pay the 402 it returns; the 402 carries the changelog and the diff for every release you skipped`;

  return [
    `## ${ref}${version ? ` — v${version}` : ""}`,
    "",
    `${priceLine} ${updateLine}`,
    "",
    "Before each run, check for a newer version:",
    "",
    "```",
    `GET ${versionEndpoint}`,
    "```",
    "",
    `It returns \`{ latest, published_at, price_micro, update_price_micro, releases_url }\`. With an \`X-Wallet-Signature\` header it also returns what your wallet already owns and what the next fetch would cost it.`,
    "",
    "If `latest` is newer than the version you hold, " + updateInstruction + ".",
    "",
    "To buy it the first time, pay the 402 from the resource endpoint:",
    "",
    "```",
    `GET ${resourceEndpoint}`,
    "```",
    "",
    ...(priceMicro === 0n
      ? []
      : [
          "Any x402 client can pay it. With `@x402/fetch`, paying is one wrapped `fetch`:",
          "",
          "```js",
          'import { wrapFetchWithPayment } from "@x402/fetch";',
          'import { x402Client } from "@x402/core/client";',
          'import { ExactEvmScheme } from "@x402/evm/exact/client";',
          'import { privateKeyToAccount } from "viem/accounts";',
          "",
          'const pay = x402Client.fromConfig({ schemes: [{ network: "eip155:*", client: new ExactEvmScheme(privateKeyToAccount(process.env.WALLET_KEY)) }] });',
          `const res = await wrapFetchWithPayment(fetch, pay)("${resourceEndpoint}");`,
          "```",
          "",
        ]),
    `The public manifest — file tree, sizes, licence, dependencies, scan result, release log — is at \`${labelEndpoint}\` and needs no payment. Read it before you buy.`,
    "",
  ].join("\n");
}
