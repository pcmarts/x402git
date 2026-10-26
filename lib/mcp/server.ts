/**
 * lib/mcp/server.ts — the buy-side MCP server (FR-31).
 *
 * Six tools. Four are thin wrappers over a route that already exists:
 *
 *   get_listing    wraps GET /api/label/:owner/:slug
 *   check_version  wraps GET /api/v/:owner/:slug
 *   purchase       wraps GET /api/r/:owner/:slug
 *   fetch_release  wraps GET /api/r/:owner/:slug/v/:version
 *
 * The "wraps" line is in each tool's description on purpose: an agent that has the MCP
 * server and an agent that has curl are buying the same thing on the same terms, and
 * the description is how the first one learns it can become the second. Nothing here
 * decides entitlement or money — `check_version` is `quote` serialised and `purchase`
 * is `lib/x402/flow.ts#purchaseFlow`, the identical sequence `/api/r` runs (§11).
 *
 * The fifth, `how_to_buy` (2026-09-02), wraps nothing: it is `check_version` plus the
 * three URLs and two paragraphs that turn a client *without* a wallet into a referral
 * instead of a dead end. A chat model connected to this server — claude.ai, ChatGPT —
 * cannot sign, and never will (NG10: the server never sees a key, so it cannot sign on
 * the model's behalf either). What such a client can do is read the listing, quote the
 * price, and hand the person the page to buy on or the skill to give a shell agent.
 * `how_to_buy` says all of that in one call, so the model does not have to work it out
 * from a 402 it cannot act on.
 *
 * The sixth, `search_listings` (16 Sep 2026), is the way in for an agent that does not
 * already know an `owner/slug`: it searches the live listings by what they do. It wraps
 * no route either — it reads the same rows as `sitemap.xml` (lib/listings/search.ts) —
 * and it exists under an amendment to NG1 that allows search and still forbids ranking.
 *
 * ## The payment argument
 *
 * `purchase` takes a **pre-signed** payment. The server never sees a private key
 * (NG10, D12): the agent calls `purchase` without one, gets the 402 back, signs the
 * EIP-3009 authorization locally, and calls `purchase` again with it — as the
 * `payment_signature` argument, or as `_meta["x402/payment"]` (the spec's
 * `PaymentPayload` object or its base64 encoding; the argument wins when both are sent).
 *
 * The unpaid result follows the x402 MCP transport spec (FR-31, amended 30 Aug):
 * `isError: true` with the `PaymentRequired` body as `structuredContent` and in
 * `content[0].text`, mirrored under `_meta["x402/error"]` — the shapes the Cloudflare
 * Agents SDK's `withX402Client` and spec-built clients detect and sign against. A 402
 * is still the price, not a failure; the description says so, because the description
 * is what the agent's model reads. A settled grant confirms the transaction in
 * `_meta["x402/payment-response"]`.
 *
 * ## Wallet identity
 *
 * `wallet_signature` is the same `<address>.<nonce>.<sig>` value the HTTP routes take in
 * `X-Wallet-Signature` (FR-20), verified through the same `walletFrom`. A challenge is
 * single-use, so each tool call needs a fresh one from `POST /api/auth/challenge`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import * as z from "zod";
import { walletFrom, WALLET_SIGNATURE_HEADER } from "@/lib/auth/wallet-signature";
import { buyLinks, chainLabel, signAndRetry, stellarCli } from "@/lib/buy-links";
import { type PaymentOption, paymentOptionsFor } from "@/lib/core/access";
import { appUrl } from "@/lib/env";
import { ApiError, toApiError } from "@/lib/errors";
import { versionStatus } from "@/lib/listings/version";
import { openReleaseView } from "@/lib/listings/view";
import { refreshPromiseOnRead } from "@/lib/release/promise";
import { OpenReleaseBlock } from "@/lib/schemas";
import { loadListingByPath, manifestFor } from "@/lib/web/loaders";
import { formatPrice } from "@/lib/web/money";
import { SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, searchListings } from "@/lib/listings/search";
import { purchaseFlow, refetchVersion } from "@/lib/x402/flow";
import { type Jurisdiction, jurisdictionOf } from "@/lib/x402/jurisdiction";

export const MCP_SERVER_NAME = "git-x402";
export const MCP_SERVER_VERSION = "0.2.1";
export const MCP_SERVER_TITLE = "X402 Git — buy private repos over x402";
export const MCP_SERVER_DESCRIPTION =
  "Find and buy private git repositories and agent skills over x402 — USDC on Base, USDT0 on Arbitrum or USDT0 on Stellar, whichever the listing offers. Search live listings by what they do, read a listing's free manifest — file tree, licence, dependencies, security scan — then pay and pull, with no account and no human in the loop.";

/**
 * What `initialize` says about the server, and what the server card mirrors. Directories
 * (Smithery among them) build the listing page from these fields — description, homepage
 * and icon — rather than from anything sent at publish time. The PNG is
 * `app/icon.svg` rasterised; some readers will not render an SVG.
 */
export function mcpServerInfo(base: string) {
  return {
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
    title: MCP_SERVER_TITLE,
    description: MCP_SERVER_DESCRIPTION,
    websiteUrl: base,
    icons: [
      { src: `${base}/icon-512.png`, mimeType: "image/png", sizes: ["512x512"] },
      { src: `${base}/icon.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
    ],
  };
}

/**
 * The tools of FR-31, in the order an agent uses them: find a listing, then `how_to_buy`
 * — the one to read before anything that needs a wallet.
 */
export const TOOL_NAMES = ["search_listings", "how_to_buy", "get_listing", "check_version", "purchase", "fetch_release"] as const;

const owner = z.string().describe("The creator handle, e.g. `adrian`.");
const slug = z.string().describe("The listing slug, e.g. `humanizer`.");
const walletSignature = z
  .string()
  .describe(
    "An `X-Wallet-Signature` value: `<address>.<nonce>.<signature>`, where the nonce comes from `GET /api/auth/challenge` and the signature is over the challenge message — EIP-191 (hex) from an EVM wallet, SEP-53 (base64) from a Stellar key. Single use.",
  );

/**
 * `payment_options` as every tool prints it (JOURNEYS B4a): the networks a listing can be
 * paid on, from `paymentOptionsFor` — the function behind the 402's `accepts`, so an
 * agent can filter to what it can pay before it ever sees a 402.
 */
const paymentOptionsSchema = z
  .array(
    z.object({
      network: z.string().describe("CAIP-2: `eip155:8453` is Base, `eip155:42161` is Arbitrum, `stellar:pubnet` is Stellar."),
      asset: z.string().describe("The token on that network: an ERC-20 address on an EVM chain (Base, Arbitrum), a `C…` contract on Stellar."),
      asset_symbol: z.string().describe("`USDC` on Base, `USDT0` on Arbitrum and on Stellar."),
      amount: z.string().describe("The `amount` the 402's accepts entry for this network carries, in the token's smallest unit."),
      how: z.string().describe("One sentence: how a wallet on this network pays."),
    }),
  )
  .describe("Every network this listing can be paid on, Base first when offered. Empty means nothing here can be bought with any wallet.");

/**
 * The open-release promise (25 Oct 2026, docs/HACKMERIDIAN-STRATEGY.md §6a), the same
 * shape the listing JSON carries. Null on an ordinary listing. Read from stored columns
 * after the on-read check, so an agent and the page never disagree about a status.
 */
const openReleaseSchema = OpenReleaseBlock.nullable().describe(
  "Present when the release being sold is an open release: sold early from a private repository, promised to go public in `public_repo_url` on `opens_at` under `licence`. `open_after_days` is the project's standing rule (each release opens that many days after its cut). `status` is `pending` until the date, then `opened_on_time` (with `evidence_url`, the public commit) or `overdue`; `ineligible` means a check at cut failed and `checks` says which. Null on an ordinary listing.",
);

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

/**
 * `req` is only ever read for FR-38's geo headers: `purchase` runs the same
 * `purchaseFlow` as `GET /api/r`, and that gate needs to know where the caller is. A
 * server built without one (a test, an in-process transport) simply has no geo, which
 * is the same as a request the platform edge did not annotate — never a block.
 */
export function buildMcpServer(req?: Request): McpServer {
  const base = appUrl();
  const jurisdiction: Jurisdiction | null = req ? jurisdictionOf(req) : null;

  const server = new McpServer(
    mcpServerInfo(base),
    {
      instructions: [
        `Paid access to private git repositories over x402, at ${base}. Listings are paid in dollars: USDC on Base, USDT0 on Arbitrum or on Stellar, or several — each listing's \`payment_options\` says which.`,
        "",
        "Looking for something rather than a named listing? `search_listings` finds live repos and agent skills by what they do — free, no wallet. Each result carries the `owner` and `slug` every other tool takes, and its `payment_options` — the networks and tokens it can be paid in — so you can skip what your wallet cannot pay.",
        "Then `how_to_buy`: it is free, needs no wallet, and returns the price, the `payment_options`, the listing page, the step-by-step skill and the endpoint — everything you or the person you are helping needs. Pass the `network` you pay on: if the listing offers nothing on it, the answer is `cannot_pay: true` with the options that do exist. If you cannot sign transactions, that is the tool to answer with: give the person the listing URL to buy on themselves, or the skill URL to hand to an agent that has a wallet. Do not tell them the paywall is broken.",
        "Read `get_listing` before you buy: the manifest is free, it is the file tree, licence, dependencies and security-scan result of the exact bytes you would receive.",
        "`check_version` tells you the latest version and what it would cost this wallet.",
        '`purchase` follows the x402 MCP transport: with no payment attached it returns `isError: true` with the `PaymentRequired` body as structured content, mirrored in `_meta["x402/error"]`. Sign the `accepts` entry whose `network` is yours — never index 0 by position: a listing that takes both lists Base first, a Stellar-only listing lists Stellar first — locally with your own key (this server never sees a private key) and call `purchase` again with the payment as `payment_signature` or `_meta["x402/payment"]`. On Stellar, `npx x402git-stellar buy <owner>/<slug>` does the whole exchange.',
        "`fetch_release` re-fetches a version you already own, forever, for free.",
        "Money is micro-dollars as a decimal string: 9000000 is $9.00, in USDC on Base, USDT0 on Arbitrum or USDT0 on Stellar; each counts as $1.",
      ].join("\n"),
    },
  );

  server.registerTool(
    "search_listings",
    {
      title: "Find repos and agent skills for sale",
      description:
        "Free, no wallet needed. Searches every live listing — private repos, agent skills, prompt packs, toolkits — by what it does: the name, the creator's description and \"use this when\" line, the computed tags (artifact class, what is inside such as `skills` or `scripts`, languages) and the README. Describe the job in plain words, e.g. `humanize ai writing` or `changelog from git history`; leave `query` empty to list everything. Results are ordered by how many of your words matched and where, then by name — never by sales or popularity. Each result has the `owner` and `slug` the other tools take: read `get_listing` for the file tree and security scan, then `how_to_buy`.",
      inputSchema: {
        query: z
          .string()
          .max(200)
          .optional()
          .describe("What you need the code or skill to do, in plain words. Omit or leave empty to list every live listing."),
        max_price_micro: z
          .string()
          .regex(/^\d{1,15}$/)
          .optional()
          .describe("Only listings a new buyer can get for at most this much, in micro-dollars: `5000000` is $5, `0` is free only."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(SEARCH_MAX_LIMIT)
          .optional()
          .describe(`How many results to return, 1–${SEARCH_MAX_LIMIT}. Default ${SEARCH_DEFAULT_LIMIT}; \`total\` says how many matched.`),
      },
      outputSchema: {
        query: z.string(),
        total: z.number().int().describe("How many listings matched, before `limit`."),
        results: z.array(
          z.object({
            owner: z.string(),
            slug: z.string(),
            description: z.string().nullable().describe("The creator's own blurb. Self-reported, unverified."),
            trigger_hint: z.string().nullable().describe("The creator's \"use this when…\" line. Self-reported, unverified."),
            latest: z.string().describe("The version a purchase delivers today."),
            price_micro: z.string().describe("Micro-dollars for a new buyer. `9000000` is $9."),
            price_usd: z.string(),
            update_price_micro: z.string().describe("`0` means updates are included for life once bought (FR-16)."),
            artifact_class: z.string().nullable().describe("Computed: Prompt, Pack, Toolkit, Harness or System."),
            tags: z.array(z.string()).describe("Computed from the artifact, never from the creator's words."),
            inventory: z.string().nullable().describe("Computed, e.g. `1 skill · 9 scripts · 3 test files`."),
            matched: z.array(z.string()).describe("The words of your query this listing matched."),
            listing_url: z.string(),
            manifest_url: z.string(),
            payment_options: paymentOptionsSchema,
          }),
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, max_price_micro, limit }) =>
      await run(
        async () =>
          await searchListings({
            query,
            maxPriceMicro: max_price_micro === undefined ? undefined : BigInt(max_price_micro),
            limit,
          }),
      ),
  );

  server.registerTool(
    "how_to_buy",
    {
      title: "How to buy this listing — with or without a wallet",
      description:
        "Free, no wallet needed. Returns whether the listing is for sale, its latest version and new-buyer price, its `payment_options` (the networks and tokens it can be paid in — USDC on Base, USDT0 on Arbitrum or on Stellar, or several), the listing page a person can buy on, the step-by-step skill an agent with a wallet follows, the raw x402 endpoint, and this server's URL. Pass `network` (the CAIP-2 id your wallet pays on) and, when the listing offers nothing on it, the answer is `cannot_pay: true` with the options that exist — not a procedure you cannot follow. If you cannot sign transactions, answer the person with `without_a_wallet`; if you can, follow `with_a_wallet` or call `purchase`.",
      inputSchema: {
        owner,
        slug,
        network: z
          .string()
          .optional()
          .describe(
            "Optional. The CAIP-2 network(s) your wallet can pay on, comma-separated: `eip155:8453` (Base), `eip155:42161` (Arbitrum), `stellar:pubnet` (Stellar). When none of them is offered, the result says `cannot_pay: true` and lists `payment_options`.",
          ),
      },
      outputSchema: {
        owner: z.string(),
        slug: z.string(),
        status: z.enum(["draft", "live", "retired"]),
        for_sale: z.boolean().describe("False when retired or when no release has passed the scan; then nothing here can be bought."),
        latest: z.string().nullable(),
        price_micro: z.string().describe("Micro-dollars for a new buyer. `9000000` is $9. A wallet that already owns a version is quoted less by `check_version`."),
        price_usd: z.string().describe("The same price as dollars, the way the site prints it: `$9`, `$9.50`, `$0`."),
        update_price_micro: z.string().describe("`0` means updates are included for life once bought (FR-16)."),
        listing_url: z.string().describe("The page. Server-rendered; readable as markdown with `Accept: text/markdown`."),
        manifest_url: z.string().describe("The free public manifest: tree, licence, dependencies, scan."),
        skill_url: z.string().describe("The full buying procedure, as an Agent Skill. Hand this to an agent that has a wallet."),
        resource_endpoint: z.string().describe("The x402 endpoint. GET it to receive the 402; pay it to receive the download."),
        mcp_url: z.string(),
        payment_options: paymentOptionsSchema,
        open_release: openReleaseSchema,
        cannot_pay: z
          .boolean()
          .optional()
          .describe("Present and true only when you named a `network` and the listing offers nothing on it. Then `with_a_wallet` says so and `payment_options` is what does exist."),
        with_a_wallet: z.string().describe("What an agent with a wallet should do, per network the listing takes."),
        without_a_wallet: z.string().describe("What to tell a person when you cannot sign."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ owner, slug, network }) =>
      await run(async () => {
        const status = await versionStatus({ owner, slug }, null);
        const links = buyLinks({ owner, slug, appUrl: base });
        // The networks this listing takes, from the creator's bound addresses (BUILD §0b
        // B4): the same function behind the 402's `accepts`, so the two cannot disagree.
        const bundle = await loadListingByPath(owner.toLowerCase(), slug.toLowerCase());
        // An open release whose date has passed is checked on read, so the status an
        // agent is told is the one the page shows (lib/release/promise.ts).
        if (bundle) await refreshPromiseOnRead(bundle);
        const options = bundle ? paymentOptionsFor(bundle.creator, bundle.listing) : [];
        const wanted = (network ?? "")
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean);
        const payable = wanted.length === 0 ? options : options.filter((o) => wanted.includes(o.network));
        const cannotPay = wanted.length > 0 && payable.length === 0;
        const price = BigInt(status.price_micro);
        const priceUsd = formatPrice(price);
        const priceLabel = price === 0n ? "free" : priceUsd;
        const name = `"${owner}/${slug}"`;

        // The page shows no buy control for these, and `/api/r` answers `retired` or
        // `no_release`; a referral to either would be the dead end this tool exists to
        // remove, with a price on it. `versionStatus` already 404s a draft.
        const forSale = status.status === "live" && status.latest !== null;
        const optionLabel = (o: PaymentOption) => `${o.asset_symbol} on ${chainLabel(o.network)}`;
        const optionsSentence = options.length ? options.map(optionLabel).join(" or ") : "no network this deployment offers";
        const [withWallet, withoutWallet] = !forSale
          ? status.status === "retired"
            ? [
                `Not for sale: this listing has been retired. Nothing can be bought; a wallet that already owns a version can still re-fetch it with \`fetch_release\`, free, forever.`,
                `Tell the person: ${name} is no longer sold on X402 Git. Anyone who bought it keeps their access and can re-download at ${links.listing_url}; nobody can buy it now.`,
              ]
            : [
                `Not for sale yet: no release has passed the security scan, so \`/api/r\` answers \`no_release\`. Watch \`check_version\` for a \`latest\` version before trying to pay.`,
                `Tell the person: ${name} on X402 Git has no release that passed the security scan yet, so it cannot be bought today. The page is ${links.listing_url}.`,
              ]
          : cannotPay
            ? [
                `You cannot pay for ${name} on ${wanted.join(" or ")}: it takes ${optionsSentence}. Do not sign anything; a payment on a network the listing does not offer cannot settle. ` +
                  `Tell the person, or hand it to a wallet on one of those networks (${options.map((o) => o.how).join(" ")})`,
                `Tell the person: ${name} is ${priceLabel} on X402 Git and takes ${optionsSentence}, which is not what your wallet pays on. ` +
                  `They can buy it at ${links.listing_url} with a wallet on one of those networks. ` +
                  `Before anyone pays, the free manifest at ${links.manifest_url} shows the file tree, licence, dependencies and security scan.`,
              ]
            : [
                `Price: ${priceLabel}, in ${payable.map(optionLabel).join(" or ")}. GET ${links.resource_endpoint} for the 402, then pay the accepts entry whose network is yours: ` +
                  payable
                    .map((o) =>
                      o.network.startsWith("eip155:")
                        ? `on ${chainLabel(o.network)}, ${signAndRetry(links, chainLabel(o.network))}`
                        : `on ${chainLabel(o.network)}, ${o.how}`,
                    )
                    .join(" ") +
                  ` ${links.skill_url} has the exact headers. The server never sees your key.`,
                `You cannot pay for this; a wallet has to sign. Tell the person: ${name} is ${priceLabel} on X402 Git, paid in ${optionsSentence}. ` +
                  `They can buy it themselves at ${links.listing_url}${options.some((o) => o.network.startsWith("eip155:")) ? " with a browser wallet" : ""}${options.some((o) => o.network.startsWith("stellar:")) ? `, or from the command line with \`${stellarCli("buy", `${owner}/${slug}`, base)}\` and a Stellar wallet` : ""}, or give the prompt on that page to an agent that has a wallet. ` +
                  `Before anyone pays, the free manifest at ${links.manifest_url} shows the file tree, licence, dependencies and security scan.`,
              ];

        return {
          owner,
          slug,
          status: status.status,
          for_sale: forSale,
          latest: status.latest,
          price_micro: status.price_micro,
          price_usd: priceUsd,
          update_price_micro: status.update_price_micro,
          ...links,
          payment_options: options,
          open_release: bundle ? openReleaseView(bundle.listing, bundle.latest) : null,
          ...(cannotPay ? { cannot_pay: true } : {}),
          with_a_wallet: withWallet,
          without_a_wallet: withoutWallet,
        };
      }),
  );

  server.registerTool(
    "get_listing",
    {
      title: "Read the public manifest",
      description:
        "Wraps `GET /api/label/:owner/:slug`. The free, unauthenticated manifest for a listing's latest passing release: file tree, sizes, licence, dependencies, security-scan result and release log. Costs nothing and needs no wallet, so read it before you buy. Computed facts and the creator's own claims are separately namespaced (`computed` vs `self_reported`).",
      inputSchema: { owner, slug },
      outputSchema: {
        owner: z.string(),
        slug: z.string(),
        version: z.string(),
        artifact_sha256: z.string(),
        published_at: z.string().nullable().optional(),
        status: z.enum(["live", "retired"]).describe("`retired` still reads: holders keep their access (FR-43)."),
        manifest_url: z.string(),
        payment_options: paymentOptionsSchema,
        open_release: openReleaseSchema,
        computed: z.unknown().describe("Everything the analyser measured from the artifact."),
        self_reported: z.unknown().describe("The creator's own description and trigger hint."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ owner, slug }) =>
      await run(async () => {
        const bundle = await loadListingByPath(owner.toLowerCase(), slug.toLowerCase());
        if (!bundle || bundle.status === "draft") throw new ApiError("not_found");

        // Open releases: a promise whose date has passed is checked on this read.
        await refreshPromiseOnRead(bundle);
        const release = bundle.latest;
        if (!release) throw new ApiError("not_found", { message: "This listing has no passing release yet." });

        const manifest = manifestFor(bundle, release);
        if (!manifest) throw new ApiError("not_found", { message: "The manifest for this release has not been computed yet." });

        return {
          ...manifest,
          status: bundle.status === "retired" ? "retired" : "live",
          manifest_url: bundle.endpoints.label_endpoint,
          payment_options: paymentOptionsFor(bundle.creator, bundle.listing),
          open_release: openReleaseView(bundle.listing, release),
        };
      }),
  );

  server.registerTool(
    "check_version",
    {
      title: "Latest version and this wallet's price",
      description:
        "Wraps `GET /api/v/:owner/:slug`. The cheap call to make before every run: the latest version, when it was published, and the price. With `wallet_signature` it also answers what that wallet already owns and what the *next* fetch would cost it — `price_kind` is `new`, `update`, `free` or `owned`. Without one it never reveals what any address owns.",
      inputSchema: { owner, slug, wallet_signature: walletSignature.optional() },
      outputSchema: {
        owner: z.string(),
        slug: z.string(),
        latest: z.string().nullable(),
        published_at: z.string().nullable(),
        price_micro: z.string().describe("Micro-dollars. `9000000` is $9.00."),
        update_price_micro: z.string().describe("`0` means updates are included for life once bought (FR-16)."),
        status: z.enum(["draft", "live", "retired"]),
        releases_url: z.string(),
        resource_endpoint: z.string(),
        owned: z.string().nullable().optional().describe("Only with a wallet signature: the newest version this wallet holds."),
        entitled: z.boolean().optional().describe("Only with a wallet signature: true when the next fetch is free."),
        all_versions: z.boolean().optional(),
        price_kind: z.enum(["new", "update", "free", "owned"]).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ owner, slug, wallet_signature }) =>
      await run(async () => await versionStatus({ owner, slug }, await walletFor(wallet_signature))),
  );

  server.registerTool(
    "purchase",
    {
      title: "Buy the latest release (x402)",
      description:
        'Wraps `GET /api/r/:owner/:slug` — the same quote → screen → verify → settle → grant sequence, with the purchase recorded as `source: mcp`. Call it once with no payment: you get the x402 `PaymentRequired` body back. It arrives as `isError: true` per the x402 MCP transport, but it is not a failure — it is the price. `accepts` has one entry per network the listing takes (USDC on Base, USDT0 on Arbitrum, USDT0 on Stellar); sign the one whose `network` is yours — never index 0 by position — with your own key (this server never sees it): an EIP-3009 authorization on an EVM network (Base, Arbitrum), a Soroban transfer auth entry on Stellar (`npx x402git-stellar buy <owner>/<slug>` does it). Then call again with the payment as the base64 `payment_signature` argument or as `_meta["x402/payment"]`. On success you get the version, the sha256 of the artifact, a signed download URL that expires in five minutes, and the settlement transaction in `_meta["x402/payment-response"]`. Access is granted only after the facilitator returns a transaction hash. A $0 listing returns `granted` on the first call.',
      inputSchema: {
        owner,
        slug,
        payment_signature: z
          .string()
          .optional()
          .describe(
            'A base64 x402 payment payload signed locally against the `accepts` entry whose `network` is yours, from a previous call. Equivalent to `_meta["x402/payment"]`; this argument wins when both are present. Omit both to get the 402.',
          ),
        wallet_signature: walletSignature
          .optional()
          .describe(
            "Optional `<address>.<nonce>.<signature>`. Send it to be quoted *your* price rather than the new-buyer price; when both are present the payer in the authorization must be the same address.",
          ),
        quote_id: z
          .string()
          .optional()
          .describe(
            "Required for any priced listing: echo `payment_required.extra.quote_id` from the 402 you are paying against. Omitting it on a priced buy is rejected `price_changed`; echoing a stale one is also `price_changed` with a fresh 402. Optional only for $0 listings.",
          ),
      },
      // No outputSchema on purpose: the results are a union — a grant, the transport
      // spec's `PaymentRequired`, or a §9 error body — and MCP clients compile
      // `outputSchema` into a validator (`additionalProperties: false`) applied to any
      // `structuredContent`. Declaring the grant shape would make every 402 a
      // client-side schema error.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      // The Agents SDK extension for pre-advertising paid tools; its clients append
      // the charge to the description. No `priceUSD` alongside it: the price is per
      // listing and per wallet, and `check_version` is the quote.
      _meta: { "agents-x402/paymentRequired": true },
    },
    async ({ owner, slug, payment_signature, wallet_signature, quote_id }, extra): Promise<CallToolResult> => {
      try {
        const buyer = await walletFor(wallet_signature);
        const outcome = await purchaseFlow({
          owner,
          slug,
          buyer,
          paymentSignature: payment_signature ?? paymentFromMeta(extra?._meta),
          quoteId: quote_id ?? null,
          source: "mcp",
          jurisdiction,
        });

        if (outcome.kind === "payment_error") {
          // The retryable money codes still deserve a fresh 402, exactly as `/api/r`
          // attaches one under `details.payment_required`. Deliberately no
          // `_meta["x402/error"]` here: on `settlement_pending` / `settlement_timeout`
          // the money may already have moved, and a spec client that sees fresh
          // requirements auto-signs a *second* authorization.
          throw new ApiError(outcome.code, {
            message: outcome.message,
            details: { ...(outcome.details as Record<string, unknown> | undefined), payment_required: outcome.requirements.body },
          });
        }

        if (outcome.kind === "payment_required") {
          // The x402 MCP transport (specs/transports-v2/mcp.md): `PaymentRequired` as
          // `structuredContent`, the same JSON in `content[0].text`, and a mirror in
          // `_meta["x402/error"]` — the field `withX402Client` detects.
          const body = {
            ...outcome.requirements.body,
            error: 'Payment required. Sign the accepts entry whose network is yours locally and retry with the payment in _meta["x402/payment"] or the payment_signature argument.',
          };
          return {
            content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
            structuredContent: body as unknown as Record<string, unknown>,
            isError: true,
            _meta: { "x402/error": body },
          };
        }

        const data = {
          status: "granted",
          version: outcome.body.version,
          artifact_sha256: outcome.body.artifact_sha256,
          download_url: outcome.body.download_url,
          expires_at: outcome.body.expires_at,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          structuredContent: data,
          isError: false,
          // The spec's settlement confirmation — present only when this call settled
          // (a free grant, a replay or an existing entitlement has no transaction).
          ...(outcome.settlement ? { _meta: { "x402/payment-response": outcome.settlement as unknown as Record<string, unknown> } } : {}),
        };
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "fetch_release",
    {
      title: "Re-fetch a version you already own",
      description:
        "Wraps `GET /api/r/:owner/:slug/v/:version`. A fresh five-minute download URL for a version this wallet already bought. Free, forever, including after the listing is retired. Never sells anything: if the wallet does not hold that version it is `not_entitled`, not a 402. `wallet_signature` is required — without a proved wallet there is nobody to be entitled.",
      inputSchema: { owner, slug, version: z.string().describe("An exact version string, e.g. `1.2.0`."), wallet_signature: walletSignature },
      outputSchema: {
        version: z.string(),
        artifact_sha256: z.string(),
        download_url: z.string(),
        expires_at: z.string(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ owner, slug, version, wallet_signature }) =>
      await run(async () => {
        const buyer = await walletFor(wallet_signature);
        if (!buyer) throw new ApiError("invalid_signature", { message: "fetch_release requires a wallet signature." });
        const body = await refetchVersion({ owner, slug, buyer, version, source: "mcp" });
        return {
          version: body.version,
          artifact_sha256: body.artifact_sha256,
          download_url: body.download_url,
          expires_at: body.expires_at,
        };
      }),
  );

  return server;
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

/**
 * FR-20, through the same code path as the HTTP routes: an absent signature is
 * anonymous, a malformed or replayed one is `invalid_signature`. Wrapping the value in
 * a `Request` is not ceremony — it is the guarantee that the MCP surface cannot drift
 * into a laxer check than `X-Wallet-Signature`.
 */
async function walletFor(signature: string | undefined): Promise<string | null> {
  if (!signature) return null;
  return await walletFrom(new Request("https://mcp.invalid/", { headers: { [WALLET_SIGNATURE_HEADER]: signature } }));
}

/**
 * Run a tool body and shape the result.
 *
 * Success is `structuredContent` plus the same JSON as text, because clients differ in
 * which they show the model. Failure is the §9 catalogue body — `{ code, message,
 * docs_url, details }`, the same one the HTTP routes return (FR-33) — with
 * `isError: true`, as JSON in `content[0].text` only: MCP clients validate any
 * `structuredContent` against a cached `outputSchema` (`additionalProperties: false`),
 * so an error body under `structuredContent` would throw client-side before the agent
 * ever saw the code.
 */
async function run(fn: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
  try {
    const data = await fn();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data, isError: false };
  } catch (e) {
    return errorResult(e);
  }
}

/** The §9 error body as an `isError` result — text only, see `run`. */
function errorResult(e: unknown): CallToolResult {
  const body = toApiError(e).toBody();
  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }], isError: true };
}

/**
 * `_meta["x402/payment"]`, whichever form the client speaks: the transport spec sends
 * the `PaymentPayload` object, the Cloudflare Agents SDK sends its base64 encoding.
 * Both normalise to the `PAYMENT-SIGNATURE` string `purchaseFlow` already takes; a
 * malformed value is `null`, which the flow answers with the 402.
 */
function paymentFromMeta(meta: Record<string, unknown> | undefined): string | null {
  const value = meta?.["x402/payment"];
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (value && typeof value === "object") {
    try {
      return encodePaymentSignatureHeader(value as PaymentPayload);
    } catch {
      return null;
    }
  }
  return null;
}
