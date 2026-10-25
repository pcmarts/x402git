/**
 * GET /:owner/:slug — the product page. §14.1, FR-47 to FR-53, Quality Signals §9.
 *
 * This is the product's whole hypothesis rendered as HTML: a public manifest over a
 * private repo, in a frame the creator cannot replace.
 *
 * Rebuilt 2026-08-30 on the founder's direction — "formatted for humans, not for
 * agents" — into the shape a person recognises: the repository reference and its facts
 * at the top, the README as the body of the page, and the price in a box on the right
 * that follows you down. GitHub's document, Gumroad's order block.
 *
 * The manifest did not go anywhere. Everything that used to be printed inline is one
 * disclosure away (`Contents` → `Files`, `Dependencies`) or on the
 * unlinked machine reading at `?view=agent`, which still server-renders the whole thing
 * for `curl`. What changed is what leads: a person deciding to spend $9 is not served
 * by three thousand rows of tree, and an agent is not served by a sidebar.
 *
 * Four constraints shape every line of it.
 *
 * 1. **It must be complete in the server HTML.** Agents fetch it with `curl` and read
 *    it once, cold. The client components on the page are the buy button and the
 *    endpoint's copy button, and their pre-hydration rendering — which is what `curl`
 *    receives — is a sentence that says how to pay without one, and the URL itself.
 *    `npm run check:ssr` is the proof.
 * 2. **Computed and self-reported never share a namespace** (FR-52, Quality Signals
 *    §9a.1). Computed values are monospace; the creator's own words are set in the text
 *    face and badged `self_reported`. The stamps that carry the analyser version and
 *    the computed-at time moved into the disclosures rather than being deleted.
 * 3. **Never bill blind.** The version, the licence, the scan verdict and its date and
 *    the artifact class are in the header, above the price, on every viewport. The box
 *    comes immediately after those facts in the document, because on a phone a buyer
 *    should not scroll a README to find out what something costs.
 * 4. **Nothing is invented.** Every number here is computed from the repository, and a
 *    field with no value renders nothing rather than a placeholder.
 *
 * Amended 2026-08-30, on the founder's direction — "the buy box should be way further
 * up; the README should just be an expandable, not the whole page; pull in more stats
 * around the author/creator". Three changes, in one shape:
 *
 * - The box starts at the **top of the right column**, level with the title, rather
 *   than under a full-width header. Above the fold on a desktop and, because the header
 *   lost everything that was not a buyer's check, above the fold on a phone too.
 * - The README is **previewed, not hidden**: the first screenful renders, clipped and
 *   fading into the paper, over one control that opens the rest
 *   (`app/_components/readme-more.tsx`). The whole document is always in the server
 *   HTML — `check:ssr` proves it — but it is no longer the page.
 * - An **About** block and a **Creator** block carry what GitHub knows about the
 *   repository and the person (`lib/web/github-profile.ts`): the project's own website,
 *   its topics, when it was last pushed, and who the creator is. Read live, cached an
 *   hour, and falling back to the copy the analyser persisted into the manifest. It is
 *   context, not a computed signal, so it is set in the text face and nothing on the
 *   page depends on it: every field of it can be absent and the page is unchanged.
 *
 * Amended again 2026-08-30, on the founder's direction to take **Gumroad's product page**
 * as the shape, kept simple. Five changes, none of which moved a computed fact:
 *
 * - **The creator is at the top**, directly under the headline
 *   (`app/_components/creator-strip.tsx`), carrying the avatar, the name, the handle and
 *   three counts — repos on this platform (a link to the author page), public repos, and
 *   stars summed across them. The sidebar Creator block is **gone**, not duplicated: an
 *   avatar in two places is one fact in two places.
 * - ~~A hero image~~ — removed 2026-08-30 on the founder's direction ("don't want that
 *   to be a thing yet"). The README renders as committed, opening image and all.
 * - **A pinned price bar on a phone** (`app/_components/buy-bar.tsx`), showing once the
 *   buy box has scrolled away. It is an anchor to the box, not a second buy button, so
 *   the accent ground still appears exactly once per viewport.
 * - **Installs** (FR-40, amended the same day): the exact count of distinct wallets that
 *   own the listing, in the meta row and in the box, from the first purchase and never
 *   as a zero.
 * - **"Contents" leads with the folders**, each with a mark, a file count, a byte
 *   total and a line saying what is in it in the analyser's own nouns.
 *
 * Amended again 2026-08-30, on the founder's direction — the repository speaks for
 * itself. The **About block is gone**: it interleaved GitHub metadata with the
 * creator's typed-in prose, which is data the repo itself does not carry. What remains
 * in the body is computed ("Contents", first, because it is the buyer's fastest
 * check that the thing is real) and then the README — the creator's whole pitch,
 * exactly as committed. The badged tagline stays in the header (FR-51 requires the
 * inputs and the badge), and the sentence explaining the badge moved to the small
 * print. The trigger hint still reaches agents via `?view=agent` and the API.
 */

import { Fragment } from "react";
import type { Metadata } from "next";
import type { ManifestOutput } from "@/lib/schemas";
import { jsonLdSafe } from "@/lib/web/json-ld";
import { listingJsonLd } from "@/lib/web/listing-json-ld";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { type Reading, StorefrontColophon, StorefrontMark } from "@/app/_components/chrome";
import { BuyBar } from "@/app/_components/buy-bar";
import { BuyWithFreighter } from "@/app/_components/buy-with-freighter";
import { BuyWithWallet } from "@/app/_components/buy-with-wallet";
import { CopyEndpoint } from "@/app/_components/copy-endpoint";
import { CreatorStrip } from "@/app/_components/creator-strip";
import { Icon, iconFor } from "@/app/_components/icons";
import { ClipScript, ClipToggle, ReadmeSection, TRUST_BODY_ID } from "@/app/_components/readme-more";
import { WebMcpTools } from "@/app/_components/webmcp";
import { OpenReleaseBlock } from "./open-release";
import { StellarPay } from "./stellar-pay";
import { chainLabel } from "@/lib/buy-links";
import { type ListingRef, type PaymentOption, paymentOptionsFor, quote, toPaymentRequirements } from "@/lib/core/access";
import { toMicro } from "@/lib/db/types";
import { appUrl, stellarRail } from "@/lib/env";
import type { StellarCheckoutConfig } from "@/lib/web/stellar-checkout";
import { record } from "@/lib/events";
import { isLikelyBot } from "@/lib/web/user-agent";
import { optionalSession } from "@/lib/web/current";
import { type ListingProfile, listingProfile } from "@/lib/web/github-profile";
import { liveListingCount, loadListingByPath, installCount, manifestFor, type ListingBundle } from "@/lib/web/loaders";
import { openReleaseView } from "@/lib/listings/view";
import { refreshPromiseOnRead } from "@/lib/release/promise";
import {
  cadenceSentence,
  capabilityLines,
  checkRows,
  checkTone,
  componentInventory,
  compositionLine,
  computedStamp,
  contradictions,
  countedNoun,
  EMPTY_INVENTORY_SENTENCE,
  findingLabel,
  findingSentence,
  formatBytes,
  formatCount,
  formatDate,
  folderRows,
  hasTrustReport,
  inventoryIsEmpty,
  languageMix,
  languageShares,
  licenceLabel,
  licenceShort,
  publicFindingRows,
  scanLabel,
  severityTone,
  linkVendors,
  scannerVerdict,
  trustChecklist,
  trustStampLines,
  bucketForPath,
  totalBytes,
  treeView,
} from "@/lib/web/manifest-view";
import { formatPrice, updatesLabel } from "@/lib/web/money";
import { renderMarkdown } from "@/lib/analysis/markdown";
import { sanitiseHtml } from "@/lib/web/sanitise-html";
import { chainInfo } from "@/lib/web/wallet-checkout";

export const dynamic = "force-dynamic";

/**
 * The two readings. `?view=agent` server-renders the complete manifest, because agents
 * were promised a page they can `curl`. Linked again on 2026-08-30, on the founder's
 * direction: a Human · Agent switch in the corner of the storefront header
 * (chrome.tsx `Reading`), so a person can see exactly what their agent will read —
 * and what it will be asked to pay — before handing it the endpoint.
 */
type View = "human" | "agent";

/**
 * The 402 this listing answers with right now, as JSON, for the agent reading's Order
 * block. Built from `quote` (the one place that decides money) and never from `grant`;
 * a null buyer is a stranger's first fetch, which is what the sample is meant to show.
 * `null` when there is nothing to sell, or when this deployment holds no receiving
 * address (`x402Config` throws) — the block is omitted, never faked.
 */
async function paymentRequiredSample(ref: ListingRef): Promise<string | null> {
  try {
    const q = await quote(ref, null);
    if (q.kind !== "payment_required") return null;
    return JSON.stringify(toPaymentRequirements(q).body, null, 2);
  } catch {
    return null;
  }
}

type Params = {
  params: Promise<{ owner: string; slug: string }>;
  /** Optional so the page can be awaited directly in a test, as §14.1's unit proof does. */
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function viewOf(value: string | string[] | undefined): View {
  return (Array.isArray(value) ? value[0] : value) === "agent" ? "agent" : "human";
}

/**
 * The request's user-agent, or null when there is no request.
 *
 * `headers()` throws outside a request context, which is exactly how
 * `app/[owner]/[slug]/page.test.ts` renders this component — it awaits the server
 * function directly and asserts on the markup (§14.1's unit proof). The same reasoning
 * as `optionalSession`: a page must not become untestable, or 500 in production, over a
 * value used only to bucket a statistic.
 */
async function requestUserAgent(): Promise<string | null> {
  try {
    return (await headers()).get("user-agent");
  } catch {
    return null;
  }
}

/**
 * A draft is invisible to everyone but its owner. Not 403 — a listing nobody has
 * published should not be discoverable by guessing its URL.
 */
async function load(owner: string, slug: string): Promise<ListingBundle | null> {
  const bundle = await loadListingByPath(owner.toLowerCase(), slug.toLowerCase());
  if (!bundle) return null;
  if (bundle.status !== "draft") return bundle;

  const session = await optionalSession();
  return session?.creatorId === bundle.creator.id ? bundle : null;
}

const FALLBACK_DESCRIPTION = "A private repository for sale over x402. The manifest is public; the contents are private.";

/** The computed one-liner: link unfurls, search results and the structured data all quote it. */
function metaDescription(manifest: ManifestOutput, price: bigint): string {
  return `${manifest.computed.artifact_class} · ${componentInventory(manifest.computed.component_inventory) || countedNoun(manifest.computed.file_count, "file")} · ${licenceLabel(manifest)} · ${formatPrice(price)}`;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { owner, slug } = await params;
  const bundle = await load(owner, slug);
  if (!bundle) return { title: "Not found", robots: { index: false } };

  const version = bundle.latest?.version;
  const title = `${bundle.creator.handle}/${bundle.listing.slug}${version ? ` v${version}` : ""}`;
  const path = `/${bundle.creator.handle}/${bundle.listing.slug}`;
  const manifest = bundle.latest ? manifestFor(bundle, bundle.latest) : null;

  // The description is the computed facts, not the creator's blurb: this string is
  // quoted by link unfurls and search results, which is exactly where an unverified
  // claim does the most damage.
  const description = manifest ? metaDescription(manifest, toMicro(bundle.listing.price_micro)) : FALLBACK_DESCRIPTION;

  return {
    title,
    description,
    // One canonical for both readings: the agent view is the same listing, not a second
    // page, and it must not compete with the product page in an index.
    alternates: { canonical: path },
    openGraph: { title, description, type: "website", url: path },
    twitter: { title, description },
  };
}

/**
 * The rail, reduced to what a browser may know (25 Oct 2026): the one Stellar network this
 * deployment pays on, its passphrase, the public RPC and Horizon, and the token. Null when
 * the rail is off or misconfigured, or pays on a network other than the option's — then
 * the page shows the terminal line alone rather than a button that cannot work.
 */
function stellarCheckoutConfig(option: PaymentOption): StellarCheckoutConfig | null {
  try {
    const rail = stellarRail();
    if (!rail || rail.network !== option.network) return null;
    return {
      network: rail.network,
      passphrase: rail.passphrase,
      rpcUrl: rail.rpcUrl,
      horizonUrl: rail.horizonUrl,
      asset: { code: rail.asset.code, issuer: rail.asset.issuer, contract: rail.asset.contract, symbol: option.asset_symbol },
    };
  } catch {
    return null;
  }
}

export default async function ListingPage({ params, searchParams }: Params) {
  const { owner, slug } = await params;
  const query = searchParams ? await searchParams : {};
  const view = viewOf(query.view);
  const bundle = await load(owner, slug);
  if (!bundle) notFound();

  // PRODUCT.md's hypothesis is "does a public manifest over a private repo convert where
  // a sealed box does not?", and it names the number that answers it: manifest views per
  // purchase. Nothing recorded a view until 2026-09-07, so the ratio could not be
  // computed at all — `settled` had no denominator. This is that denominator.
  //
  // Fire-and-forget: `record` swallows its own errors, and it is awaited only because
  // this page is already `force-dynamic` and does several reads, so one more insert is
  // not the thing that makes it slow. A draft previewed by its own owner is not a view —
  // `load` has already returned it, so the status check happens here.
  if (bundle.status !== "draft") {
    // `bot` keeps crawlers out of the denominator. robots.txt invites indexing on
    // purpose ("search=yes … that is how a buyer finds a listing"), so without this the
    // ratio would be dominated by Googlebot. It is recorded rather than filtered at
    // write time, so the split stays inspectable and the rule can change later without
    // having lost the data.
    await record({ name: "manifest_view", listingId: bundle.listing.id, props: { view, bot: isLikelyBot(await requestUserAgent()) } });
  }

  // Open releases (25 Oct 2026): a promise whose date has passed is checked on this
  // read, so the block below never shows a stale `pending`. Cheap — nothing to do
  // before the date, two GETs once after it — and it never throws (lib/release/promise.ts).
  await refreshPromiseOnRead(bundle);

  const { creator, listing, latest, releases, endpoints, status } = bundle;
  const ref = `${creator.handle}/${listing.slug}`;
  const manifest = latest ? manifestFor(bundle, latest) : null;
  const openRelease = openReleaseView(listing, latest);
  const buyShares = manifest ? languageShares(manifest.computed.languages) : [];
  const folderCount = manifest ? folderRows(manifest).filter((f) => f.name !== "(root)").length : 0;
  const price = toMicro(listing.price_micro);
  const updatePrice = toMicro(listing.update_price_micro);
  const claims = manifest ? contradictions(manifest) : [];
  const readme = sanitiseHtml(manifest?.computed.readme_html ?? null);
  const base = appUrl();
  const path = `/${ref}`;
  const structuredData = listingJsonLd({
    base,
    creator,
    listing,
    status,
    manifest,
    description: manifest ? metaDescription(manifest, price) : FALLBACK_DESCRIPTION,
  });

  const notices = (
    <>
      {status === "retired" ? (
        <p role="status" data-status="warn">
          No longer sold. The manifest and the release log stay up, and every wallet that bought a version keeps it.
        </p>
      ) : null}
      {status === "draft" ? (
        <p role="status" data-status="pending">
          Draft — visible only to you. Nobody else can reach this URL until you publish.
        </p>
      ) : null}
    </>
  );

  /**
   * FR-53, folded to one sentence. A contradicted claim is the single most important
   * thing on the page when it fires, and the least useful thing to say twice.
   */
  const contradiction =
    claims.length > 0 ? (
      <p role="status" className="contradiction">
        The description {claims.map((c) => c.sentence.replace(/^claims /, "claims ")).join("; ")}.
      </p>
    ) : null;

  const reading: Reading = { current: view, path };

  if (view === "agent") {
    return (
      <AgentView
        bundle={bundle}
        base={base}
        path={path}
        readme={readme}
        claims={claims}
        notices={notices}
        reading={reading}
        sample402={status === "live" ? await paymentRequiredSample({ owner: creator.handle, slug: listing.slug }) : null}
      />
    );
  }

  const releasesNewestFirst = releases;
  const newest = releasesNewestFirst[0];

  // Which networks this listing can be paid on, from the creator's bound addresses
  // (JOURNEYS B0 *[today, Must]*, BATTLE-TEST finding 4, 25 Oct 2026). The same function
  // builds the 402's `accepts`, so the box and the paywall cannot disagree. The EVM
  // button renders only when Base is offered: on a Stellar-only creator's listing it
  // used to walk a MetaMask visitor to a 402 it could not pay. Stellar renders as text
  // (stellar-pay.tsx), alone or under the button.
  const options = paymentOptionsFor(creator, listing);
  const evmOption = options.find((o) => o.network.startsWith("eip155:")) ?? null;
  const stellarOption = options.find((o) => o.network.startsWith("stellar:")) ?? null;
  const chain = evmOption ? chainInfo(Number(evmOption.network.split(":")[1])) : null;
  // What the Freighter button needs from the rail: network, passphrase, public endpoints
  // and the token. Picked field by field, so nothing else in the rail's config (the
  // facilitator key) can ever reach a client component.
  const stellarConfig = stellarOption ? stellarCheckoutConfig(stellarOption) : null;

  // GitHub's own reading of the repository and the creator. Never throws, never blocks
  // publishing, never feeds a computed field: if this is `{ repo: null, owner: null }`
  // every block below it renders nothing and the page is exactly what it was.
  const profile: ListingProfile = await listingProfile(listing, manifest);

  // FR-40, amended 30 August 2026: the count is exact from the first purchase and is
  // never a buyer address. Zero is hidden, not printed — a listing published this
  // morning saying "0 installs" tells every reader the same discouraging thing.
  const installs = await installCount(listing.id);
  const siblings = await liveListingCount(creator.id);

  return (
    <>
      {/* No site navigation on a storefront (chrome.tsx, amended 2026-08-30): the
          wordmark alone, so the page is the creator's and the first line is the title. */}
      <StorefrontMark reading={reading} />
      <main className="listing">
        {/* Product + Offer for the search engines the chat products read (16 Sep 2026,
            docs/research/Agent Discovery Channels.md). Computed facts only; a draft
            page is noindex and gets none (lib/web/listing-json-ld.ts). */}
        {structuredData ? <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdSafe(structuredData) }} /> : null}
        {/* The repository's name alone, large — the thing being bought is the title
            (the owner/slug breadcrumb left on 2026-08-30; the creator line below
            carries the person and links to their page).

            Everything in this header is a buyer's check, so that the box below starts
            inside the first viewport on a phone. */}
        <header className="listing-head">
          <h1>{listing.slug}</h1>

          {/* The creator, directly under the title — named as the creator, linking to
              their author page, and nothing more. The counts, bio and links live on
              that page (creator-strip.tsx, amended 2026-08-30): this page is about
              the thing, that one is about the person. */}
          <CreatorStrip owner={profile.owner} stats={profile.stats} handle={creator.handle} listings={siblings} linked compact />

          {listing.description ? (
            <p className="written tagline">
              {listing.description}
            </p>
          ) : null}
          {contradiction}

          {/* The meta row left the header on 2026-08-30, on the founder's direction —
              it repeated what the buy column already carries and read as plumbing next
              to the pitch. Version is on the Download line, installs on the owners
              line, and licence, class, updated and the scan verdict are in the
              specification list under the box. */}

          {notices}
        </header>

        {/* Order in the document: box, then body. On a desktop the grid puts the box in
            the right column beside the README; on a phone it stays where it is, so
            nobody scrolls a README to find a price. */}
        <aside className="buybox" aria-label="Price and what you get">
          {/* The promise this release carries, above the price it changes the meaning
              of (open-release.tsx). Absent on an ordinary listing. */}
          {openRelease ? <OpenReleaseBlock block={openRelease} /> : null}
          {!latest ? (
            <div className="box" id="buy">
              <p role="status" data-status="pending">
                Nothing is for sale here yet. Nothing can be, until a snapshot has been analysed, licence-checked and scanned.
              </p>
            </div>
          ) : (
            <div className="box" id="buy">
              {/* The two costs, itemised the way an invoice is: the thing, then its
                  price. The download row carries the display size — it is the price of
                  the page — and updates sit under it in the same mono, so the box reads
                  as one bill with no number printed twice. */}
              <dl className="cost-lines">
                <div className="cost download">
                  <dt className="written">Download v{latest.version}</dt>
                  <dd>
                    <strong>{price === 0n ? "Free" : formatPrice(price)}</strong>
                  </dd>
                </div>
                <div className="cost">
                  <dt className="written">Future updates</dt>
                  <dd>{updatePrice === 0n ? "Free" : `${formatPrice(updatePrice)} each`}</dd>
                </div>
              </dl>
              <p className="written updates">
                <small className="muted">
                  {updatePrice === 0n
                    ? "Every later release is yours."
                    : "You're only charged when you choose to update."}
                </small>
              </p>

              {evmOption && chain ? (
                <BuyWithWallet
                  owner={creator.handle}
                  slug={listing.slug}
                  version={latest.version}
                  priceMicro={price.toString()}
                  updatePriceMicro={updatePrice.toString()}
                  priceLabel={price === 0n ? "free" : formatPrice(price)}
                  updatePriceLabel={updatePrice === 0n ? "free" : formatPrice(updatePrice)}
                  chainId={chain.id}
                  chainName={chain.name}
                  forSale={status === "live"}
                  sizeLabel={latest.size_bytes ? formatBytes(Number(latest.size_bytes)) : undefined}
                />
              ) : null}
              {/* The Stellar button (buy-with-freighter.tsx), then the terminal line under
                  it, closed. Both render from the same `payment_options` entry as the 402. */}
              {stellarOption && stellarConfig ? (
                <BuyWithFreighter
                  owner={creator.handle}
                  slug={listing.slug}
                  version={latest.version}
                  priceMicro={price.toString()}
                  priceLabel={price === 0n ? "free" : formatPrice(price)}
                  chainName={chainLabel(stellarOption.network)}
                  config={stellarConfig}
                  forSale={status === "live"}
                  sizeLabel={latest.size_bytes ? formatBytes(Number(latest.size_bytes)) : undefined}
                />
              ) : null}
              {stellarOption ? <StellarPay owner={creator.handle} slug={listing.slug} option={stellarOption} forSale={status === "live"} /> : null}
              {!evmOption && !stellarOption ? (
                <p className="written buy-fallback">
                  This listing cannot be bought on this site yet: its creator is paid on a network this deployment does not offer.
                </p>
              ) : null}

              {/* The other way to buy: hand a prompt to an agent — listing, skill and
                  endpoint. The text is in the server HTML; only its copy button
                  hydrates (copy-endpoint.tsx). */}
              {status === "live" ? <CopyEndpoint owner={creator.handle} slug={listing.slug} appUrl={base} /> : null}

            </div>
          )}

          {/* What arrives, with the specification rather than in the offer (moved out
              of the box 2026-08-30): the box holds the deal, this column's tail holds
              the facts about the thing. */}
          {latest ? (
            <>
              <h2>What you get</h2>
              <ul className="written what">
                <li>
                  A <code>.zip</code> of the repository at v{latest.version}
                  {latest.size_bytes ? ` (${formatBytes(Number(latest.size_bytes))})` : ""}
                </li>
              </ul>
            </>
          ) : null}

          {/* The specification, under the offer. Licence, class and updated moved back
              in here on 2026-08-30 when the header meta row was removed — the buy
              column is now the one place the buyer's checks live, so nothing is
              printed twice. */}
          {manifest ? (
            <dl className="details">
              <dt>Size</dt>
              <dd>{formatBytes(totalBytes(manifest))}</dd>
              <dt>Files</dt>
              <dd>{formatCount(manifest.computed.file_count)}</dd>
              {/* The shape counts moved here from the What's inside line on 2026-08-30:
                  they are checks a buyer makes, like the licence, and this list is the
                  one place those live. `(root)` is loose files, not a folder, so it is
                  not counted; a nought is never printed (DESIGN.md), so no folders is no
                  row and no dependencies is the word. Lines of code is not printed
                  anywhere on the page, on the founder's call the same day. */}
              {folderCount > 0 ? (
                <>
                  <dt>Folders</dt>
                  <dd>{formatCount(folderCount)}</dd>
                </>
              ) : null}
              <dt>Dependencies</dt>
              <dd>{manifest.computed.dependencies.length === 0 ? "None" : formatCount(manifest.computed.dependencies.length)}</dd>
              <dt>Licence</dt>
              <dd>{licenceShort(manifest)}</dd>
              <dt>Class</dt>
              <dd>{manifest.computed.artifact_class}</dd>
              {latest ? (
                <>
                  <dt>Updated</dt>
                  <dd>{formatDate(latest.created_at)}</dd>
                </>
              ) : null}
            </dl>
          ) : null}

          {/* The security scan, in this column — the founder's direction, 14 Sep 2026:
              "I want it to actually be part of the right-hand panel … a lot more compact
              … signal these various scans it's had, maybe just a tick next to each scan
              and the name of it, e.g. whether it was scanned with Socket or not."

              It replaced the one-line `Scanned ✓ 2026-09-01 — what was checked.` that
              stood here from 13 Sep. That line was the five-second read and it was one
              word about seven checks: it could say the scan passed and never say what a
              scan is, which is the same "badge with nothing behind it" one rung up. Seven
              rows of mark, name and vendor is the same five seconds and answers the
              question the badge was hiding.

              It is a section beside the box, not a row inside it: the buy box is one of
              the two bordered rectangles in the system and nothing nests inside it
              (DESIGN.md). Same grammar as What you get and Languages above and below —
              the small-caps label, then rows. */}
          {manifest ? <TrustBrief manifest={manifest} /> : null}

          {/* FR-40: a count of wallets, never a wallet. Before the first sale the line is
              absent — a zero is not a statistic, and neither is a sentence standing in
              for one. Out of the box and under the releases (2026-08-30, founder). */}
          {installs > 0 ? (
            <p className="facts owners">
              {installs === 1 ? "1 person owns this" : `${formatCount(installs)} people own this`}
            </p>
          ) : null}

          {/* The language mix, its own block under the releases (2026-08-30, founder)
              rather than a row in the details list. */}
          {buyShares.length > 0 ? (
            <section className="mix" aria-label="Languages">
              <h2>Languages</h2>
              <LanguageBar shares={buyShares} />
            </section>
          ) : null}
        </aside>

        <div className="listing-body">
          {/* The computed contents first: every number here is measured from the
              repository, and it is the buyer's fastest check that the thing is real.
              The prose below it is the creator's — the README is the whole pitch,
              exactly as it exists in the repo, and nothing on this page adds to it. */}
          {manifest ? <Contents manifest={manifest} labelEndpoint={endpoints.label_endpoint} /> : null}

          {/* The returning buyer's way back (2026-09-13, founder): the question they
              arrive with, and the page that answers it as a small control rather than a
              word in a sentence, because it navigates somewhere real. Its own small frame
              under the contents rather than a row in the buy column, so the column holds
              only the deal and a buyer who already owns this is not asked to read past
              the price to find their way back. */}
          <section className="already" aria-label="Already bought this">
            <p>Already bought this?</p>
            <a data-button href="/purchases">
              View your purchases
            </a>
          </section>

          {/* The first screenful, rendered and clipped, with one control for the rest.
              The whole document is in the HTML either way — see readme-more.tsx. */}
          {readme ? <ReadmeSection html={readme} /> : null}

          {/* What the scan checked, what it found, and what the artifact can do.

              It sat above the README until 14 Sep 2026, on the reasoning that it was "the
              last computed thing a buyer reads before they start reading prose". The
              checklist in the buy column is now that thing, and it is above the fold
              beside the price rather than a screen down — so what is left here is the
              long form: seven phrases, the capability inventory and the findings list,
              which is reference a reader comes back to, not pitch. Reference sits with
              the release log, after the creator's own words.

              Still a section and not a `<details>`: `#trust` in the column above links
              here, and a disclosure cannot be opened by its own anchor without script
              (`:target` can style a `<details>`, it cannot open one). A reader with
              scripting off would land on a closed fold and have to ask twice for the one
              thing the link promised. The findings list inside it stays folded, as it
              has been — and `<details>` ships its contents open to `curl` either way. */}
          {manifest ? <Trust manifest={manifest} /> : null}

          {/* Releases, under the README in their own frame (2026-08-30, founder, after a
              morning in the right column): the count on the heading, the newest three
              in full, the rest behind Show more. Set in the text face to match the
              README above it — the founder's call, and the one place a version and a
              date are not in the computed face. */}
          <section className="releases" aria-label="Releases">
            <h2>
              Releases{releasesNewestFirst.length > 0 ? <span className="count"> {formatCount(releasesNewestFirst.length)}</span> : null}
            </h2>
            {!newest ? (
              <p className="written muted">None yet.</p>
            ) : (
              <>
                <ReleaseList releases={releasesNewestFirst.slice(0, SHOWN_RELEASES)} newestId={newest?.id} />
                {releasesNewestFirst.length > SHOWN_RELEASES ? (
                  <details className="more">
                    <ReleaseList releases={releasesNewestFirst.slice(SHOWN_RELEASES)} />
                    {/* The summary is last in the markup so the hidden releases open
                        above the control, where the eye is; both labels are in the
                        HTML and the open state swaps them without script. */}
                    <summary>
                      <span className="when-closed">Show more</span>
                      <span className="when-open">Show less</span>
                    </summary>
                  </details>
                ) : null}
              </>
            )}
          </section>

          {/* No small print here (2026-08-30, founder): the FR-51 disclosure and the
              holdback/terms sentence both left. Terms are in the colophon; the agent
              reading (?view=agent) still badges the description `self_reported`. */}

          {/* Once, after the last clipped section — see readme-more.tsx on why once. */}
          <ClipScript />
        </div>
      </main>

      {/* Gumroad's pinned price line, on a phone only, and only while the box above is
          off screen — so the accent ground is still on the page exactly once. */}
      <BuyBar
        price={price === 0n ? "Free" : formatPrice(price)}
        updates={updatePrice === 0n ? "free updates" : `updates ${formatPrice(updatePrice)}`}
        forSale={status === "live" && Boolean(latest)}
      />

      {/* This listing as WebMCP tools, for an agent driving a browser. Read-only, and
          nothing it returns is absent from the HTML above. */}
      <WebMcpTools owner={creator.handle} slug={listing.slug} />

      <StorefrontColophon />
    </>
  );
}

/**
 * Trust in the buy column — "PRD Trust Report.md" §5, amended 14 Sep 2026 on the
 * founder's direction that it "actually be part of the right-hand panel", "a lot more
 * compact", and that it "signal these various scans it's had … e.g. whether it was
 * scanned with Socket or not".
 *
 * Seven rows, always seven: a mark and the scan's short name. The vendor that ran each
 * one was here for an afternoon and moved into the report the same day, on the founder's
 * second reading — *"on the right side we can just keep the simplified view; we don't
 * need to know what scanned it"*. A tick and a name is what a price needs beside it.
 *
 * The numbers are `trustChecklist`'s, which are `checkRows`' — nothing here re-derives a
 * fact the report already states, so this list and the section below it cannot disagree.
 *
 * Three things carry over unchanged from the section:
 *
 * - **The mark is decorative.** `aria-hidden`, and the row's full phrase sits beside it
 *   in `.sr-only` — so a screen reader and `curl` get "Vulnerabilities: 1 moderate in 545
 *   packages — see below" where the eye gets a dot and two words. DESIGN.md: colour never
 *   carries the meaning alone, and no Unicode glyph does either.
 * - **A gap is a row.** A check that could not run, or that this listing's scanner never
 *   recorded, keeps its name and takes the `–`. Its name drops to the ash, which is as
 *   light as this system's text ever goes (The AA Floor Rule).
 * - **No dead anchor.** *Show report* appears only when there is a section to land on;
 *   a listing cut before 13 Sep 2026 gets the rows and no link.
 */
function TrustBrief({ manifest }: { manifest: ManifestOutput }) {
  const rows = trustChecklist(manifest);

  return (
    // "Security scan", not "Trust", since 14 Sep 2026 on the founder's direction. Trust
    // is the thing a buyer decides; a scan is the thing we ran. Naming the section after
    // the reader's conclusion rather than after our own work is the same move as a shield
    // icon or the word "safe" — it claims the verdict instead of showing it — and this
    // section exists because "docs/research/Battle Test.md" §6.3a says so of Agensi. The
    // class names, the `#trust` anchor and every symbol in this file are untouched: they
    // are addresses, not copy, and the anchor is in links we do not own.
    <section className="trust-brief" aria-label="Security scan">
      <h2>Security scan</h2>
      <dl className="trust-checks">
        {rows.map((row) => (
          // `title` for the mouse, `.sr-only` for everything else: the same sentence, and
          // the tooltip is never the only place a fact lives.
          <div key={row.id} data-status={checkTone(row.status)} data-ran={row.ran ? undefined : "no"} title={`${row.name}: ${row.note}`}>
            <dt>
              <span className="mark" aria-hidden="true">
                {row.mark}
              </span>
              {row.name}
            </dt>
            <dd>
              <span className="sr-only">{row.note}</span>
              {/* The short phrase is the full one abbreviated, so it is hidden from a
                  reader who has already been given the full one a node ago. It is what
                  keeps a row that is not a tick from being a dot with no meaning. */}
              {row.short ? (
                <span className="short" aria-hidden="true">
                  {row.short}
                </span>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
      {/* One event per line, the date first, newest on top — a log, on the founder's
          direction (14 Sep 2026). The page's only scan stamp; see `trustStampLines`. */}
      <dl className="facts trust-brief-stamp">
        {trustStampLines(manifest).map((line) => (
          <div key={line.event}>
            <dt>{line.date}</dt>
            <dd>{line.event}</dd>
          </div>
        ))}
      </dl>
      {/* One link, and it does two things (14 Sep 2026, founder: "when a user clicks Show
          report on the right panel, can this also expand the trust report on the main
          page as well"). `data-readme-open` names the report's clipped body, which the
          inline script opens before the browser jumps to `#trust`. Without script it is a
          plain anchor to a section that was never clipped — which is the whole reason the
          clip is script-side. */}
      {hasTrustReport(manifest) ? (
        <p className="written trust-brief-more">
          <a href="#trust" data-readme-open={TRUST_BODY_ID}>
            Show report
          </a>
        </p>
      ) : null}
    </section>
  );
}

/**
 * The trust report — "PRD Trust Report.md" §5, accepted 13 Sep 2026.
 *
 * The badge used to be one word and a date, which is exactly the criticism
 * `docs/research/Battle Test.md` §6.3a makes of Agensi: *"the badge has nothing behind
 * it."* This is what is behind it, and every line of it is computed.
 *
 * Three blocks, in the order a buyer's question narrows:
 *
 * 1. **The tick column** — one row per check, in `CHECK_ORDER`. The mark is decorative
 *    (`aria-hidden`, DESIGN.md: no Unicode glyph carries meaning on its own); the row's
 *    name and its right-hand phrase are the whole of what it says, and `data-status`
 *    carries the ink. A check that could not run says "not yet checked, retrying" — a gap
 *    is a row, never a missing row (§4.1).
 * 2. **What this can do** — §4.3's inventory. Five lines including the empty ones,
 *    because "At install — nothing runs" is a claim and a blank accordion is not; and
 *    when the whole inventory is empty it collapses to the one sentence that says so.
 * 3. **Findings** — folded, severity word first, disclosed findings only (§4.4). Secrets
 *    and injection matches are not in the manifest at all, so there is nothing here to
 *    filter: `computed.scan.findings` is the public list by construction.
 *
 * "Safe to install" is never printed. No score, no shield, no icon. Everything is in the
 * server HTML — `<details>` is the only fold and its contents ship open to `curl`.
 *
 * *Amended 14 Sep 2026, on the founder's direction.* The five-second read left this
 * section for the buy column (`TrustBrief`, above), so what this is now is the long form
 * a reader arrives at from the link there: the same seven rows with their phrases, the
 * inventory, the findings. Two consequences, both deliberate:
 *
 * - **It sits after the README**, with the release log, because reference belongs with
 *   reference. It led the body when it was the last computed thing before the pitch.
 * - **It stays a `<section>`.** A `<details>` would be the compact thing to make of it,
 *   and `#trust` could not open one: `:target` styles a disclosure, it cannot open it,
 *   and without script a reader following *Full report* would land on a closed fold.
 *
 * The rows are duplicated with the column's list on purpose, and they are the same rows
 * — `trustChecklist` reads `checkRows`. DESIGN.md forbids printing a fact twice in one
 * viewport, and these are a screen apart: one is a list of names, the other is what each
 * of them found.
 */
function Trust({ manifest }: { manifest: ManifestOutput }) {
  const rows = checkRows(manifest);
  const verdict = scannerVerdict(manifest);
  const capabilities = manifest.computed.scan.capabilities;
  const lines = capabilityLines(capabilities);
  const findings = publicFindingRows(manifest);
  const empty = inventoryIsEmpty(capabilities);

  // A manifest cut before the report existed carries none of this. The buy column still
  // names its seven checks and marks every one of them as never recorded; this section is
  // simply absent — a heading over nothing would be the page implying a report it does
  // not have, and the column's *Full report* link is absent with it.
  if (!hasTrustReport(manifest)) return null;

  return (
    // "Security scan report", not "Security scan", since 14 Sep 2026: the column above
    // says Security scan and this is the thing its last line links to. Two headings
    // reading the same words in one page is a reader wondering which of them they are
    // looking at.
    <section className="trust-report" id="trust" aria-label="Security scan report">
      <h2>Security scan report</h2>
      {/* Who scanned this and how each of them came out, in one sentence, at the top
          (14 Sep 2026, founder: "something like a simplified view, just to give that
          level of confidence, like pass/pass"). It is a computed claim rather than prose
          somebody wrote, and it names the findings in the same breath as the pass they
          did not prevent — a page that prints the first half without the second is the
          badge §1 was written against. */}
      {verdict ? (
        <p className="written trust-verdict">
          {/* The two vendors that are not us are linked on first mention (14 Sep 2026,
              founder): "scanned by Socket" is worth nothing to a reader who has never
              heard of Socket and cannot get to it from here. A new window, because this
              page is where they are deciding — the same reason the home page's View
              opens one — and the accessible name says so. The source column on the rows
              below stays text: the same two names seven times as links would read as
              navigation rather than as a column of facts. */}
          {linkVendors(verdict).map((part, i) =>
            part.href ? (
              <a key={part.href} href={part.href} target="_blank" rel="noopener noreferrer">
                {part.text}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            ) : (
              // eslint-disable-next-line react/no-array-index-key -- the parts are a split of one string and never reorder
              <Fragment key={i}>{part.text}</Fragment>
            ),
          )}
        </p>
      ) : null}
      {/* No stamp here: the dates and the scanner version are printed once, in the buy
          column's log (14 Sep 2026, founder: "we only need to show this once"). */}

      {/* Clipped the way the README above it is clipped (14 Sep 2026, founder: "can the
          trust report have a Read more just like the README does"), with the same
          delegated script and the same control — readme-more.tsx. The preview is the
          rows; what folds is the inventory and the findings, which is the order §5 puts
          them in and the order a reader stops caring in. The verdict is outside the clip:
          it is the section's answer, and an answer you have to open
          the section to read is the fold this page keeps refusing.

          Everything is in the server HTML, unclipped, as it always was: the clip is a
          `max-height` the section only wears once script has said so, and the control is
          `display: none` until then. `curl` and a reader with scripting off get the whole
          report, which is also what makes the link in the buy column safe. */}
      <div id={TRUST_BODY_ID} className="trust-body" data-readme-clip>
        {rows.length > 0 ? (
          <dl className="check-rows">
            {rows.map((row) => (
              <div key={row.id} data-status={checkTone(row.status)}>
                <dt>
                  <span className="mark" aria-hidden="true">
                    {row.mark}
                  </span>
                  {row.label}
                </dt>
                <dd>{row.phrase}</dd>
                {/* Which source produced this row (14 Sep 2026, founder: "next to each
                    one it should be who, what was detected, or which source detected
                    this"). `tool` has been on every check since §4.2 and had never been
                    printed, so a reader could see that something found a thing and never
                    what found it. */}
                <dd className="by">{row.by}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        {capabilities ? (
          <>
            <h3>What this can do</h3>
            {empty ? (
              <p className="written measure">{capabilities.summary || EMPTY_INVENTORY_SENTENCE}</p>
            ) : (
              <dl className="capability-rows">
                {lines.map((line) => (
                  <div key={line.label}>
                    <dt>{line.label}</dt>
                    {/* One item per line (14 Sep 2026, founder: "so it's cleaner on the
                        eye"). Nine hostnames joined with dots is a paragraph, and a
                        reader looking for one domain in it has to read all nine. It is a
                        real `<ul>` because it is a real list — `curl` and a screen
                        reader get "list of 9 items", not a run-on sentence — and a line
                        that is one value stays one value rather than a list of one. */}
                    <dd>
                      {line.values.length === 1 ? (
                        line.values[0]
                      ) : (
                        <ul className="capability-values">
                          {line.values.map((value) => (
                            <li key={value}>{value}</li>
                          ))}
                        </ul>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </>
        ) : null}

        {findings.length > 0 ? (
          <details className="findings">
            <summary>Findings ({formatCount(findings.length)})</summary>
            <ul>
              {findings.map((finding, i) => (
                <li key={`${finding.rule_id}:${finding.package?.name ?? finding.path ?? ""}:${i}`}>
                  <span className="sev" data-status={severityTone(finding)}>
                    {findingLabel(finding)}
                  </span>
                  <span className="written">{findingSentence(finding)}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
      <ClipToggle id={TRUST_BODY_ID} />
    </section>
  );
}

/** Releases shown before Show more. Three is a log; one is a badge. */
const SHOWN_RELEASES = 3;

/**
 * How many characters of changelog stay on the page, and above which one it folds.
 *
 * A release note is a GitHub release body, so it is anything from "fix typo" to a
 * structured page with headings and a list per section. Folding all of them would make a
 * reader click to see six words; folding none would bury the release *log* — the thing
 * this section is — under whichever creator writes the most. So the short ones stay
 * open and only the long ones get a control, which is the same rule the README preview
 * above already follows.
 */
const CHANGELOG_FOLD_CHARS = 240;

/**
 * One release: version, date, and the notes rendered as the markdown they are.
 *
 * The notes were printed as plain text until 2026-09-01, which meant a creator's `##
 * Fixed` and their bullet list arrived on the page as literal `##` and `-`. They go
 * through the same two functions the README does — `renderMarkdown` then `sanitiseHtml`,
 * never one without the other — so the allow-list that governs a README governs a
 * changelog, and there is one answer on this page to "what markup may a creator ship".
 *
 * Headings start at `h3`, so a creator's `#` lands directly under the section's `h2` and
 * their `##` — which is what a GitHub release body usually opens with — becomes an `h4`.
 * Starting at `h4` instead would have skipped a level in the document outline for the
 * common case, which is exactly the thing a screen reader's heading list makes obvious.
 *
 * **The row is the control.** A long note folds by making the whole `<li>` a `<details>`
 * whose `<summary>` *is* the version-and-date line, so the marker sits at the end of a
 * line that already exists rather than claiming a row of its own, and the click target is
 * the row rather than a 12px glyph. That is the same bargain the dashboard's checklist
 * makes, and it is why the two read as one system.
 *
 * A short note has no control at all and renders as a plain row. Both shapes therefore
 * have to draw identically, which is why the grid lives on `.release` and not on whichever
 * element happens to be holding it — see `.release-list` in globals.css.
 *
 * No script, and the whole changelog is in the server HTML whether the row is open or
 * shut, so `curl` and the agent reading lose nothing. The newest release is open on
 * arrival, because it is the one a buyer is deciding about.
 */
function Release({ release, open }: { release: ListingBundle["releases"][number]; open: boolean }) {
  const head = (
    <>
      <span className="version">v{release.version}</span>
      <span className="date">{formatDate(release.created_at)}</span>
    </>
  );

  if (!release.changelog) {
    return <li className="release">{head}</li>;
  }

  const html = sanitiseHtml(renderMarkdown(release.changelog, { baseHeadingLevel: 3 }));

  if (release.changelog.length <= CHANGELOG_FOLD_CHARS) {
    return (
      <li className="release">
        {head}
        <div className="note written" dangerouslySetInnerHTML={{ __html: html }} />
      </li>
    );
  }

  return (
    <li className="release is-foldable">
      <details open={open}>
        <summary>{head}</summary>
        <div className="note written" dangerouslySetInnerHTML={{ __html: html }} />
      </details>
    </li>
  );
}

function ReleaseList({ releases, newestId }: { releases: ListingBundle["releases"]; newestId?: string }) {
  return (
    <ol className="written release-list">
      {releases.map((release) => (
        <Release key={release.id} release={release} open={release.id === newestId} />
      ))}
    </ol>
  );
}

/**
 * Contents — "What's inside" until 2026-08-30. What a person actually wants to know before buying source code is
 * its shape — how many files, in what languages, arranged into what folders, pulling
 * in how many dependencies — and a three thousand row table answers none of that on
 * its own. The counts are in the details list beside the price; this section is
 * three views of the same inventory under tabs: the folders, the files, the dependencies. Every view is a
 * table at the listing's 30px pitch, and the computed-at stamp travels with them as
 * FR-52 requires.
 *
 * The tabs are radio inputs and labels, not script: `curl` and a reader with
 * scripting off get all three panels in the HTML (the first is shown, the rest
 * follow it in a browser that cannot switch), and the keyboard gets the radio
 * group's own arrow-key switching for free.
 */
function Contents({ manifest, labelEndpoint }: { manifest: ManifestOutput; labelEndpoint: string }) {
  const tree = treeView(manifest);
  const folders = folderRows(manifest);
  const deps = manifest.computed.dependencies;

  const tabs = [
    { id: "folders", label: "Folders", show: folders.length > 0 },
    { id: "files", label: "Files", show: true },
    { id: "dependencies", label: "Dependencies", show: deps.length > 0 },
  ].filter((t) => t.show);

  return (
    <section className="inside" aria-label="Contents">
      {/* No heading and no line of counts (2026-08-30, founder): the counts are rows
          in the details list beside the price, and a framed box of Folders / Files
          tabs says what it is. The section keeps its name for assistive technology. */}
      <div className="tabs">
        <div className="tab-row" role="group" aria-label="Show">
          {tabs.map((tab, i) => (
            <label key={tab.id}>
              <input type="radio" name="inside-tab" value={tab.id} defaultChecked={i === 0} />
              {tab.label}
            </label>
          ))}
        </div>

        {folders.length > 0 ? (
          <div className="panel" data-tab="folders">
            <table>
              <caption className="sr-only">Top level of the repository</caption>
              <thead>
                <tr>
                  <th scope="col" className="num" data-col="optional">
                    Size
                  </th>
                  <th scope="col">Folder</th>
                  <th scope="col">Inside</th>
                </tr>
              </thead>
              <tbody>
                {folders.map((folder) => (
                  <tr key={folder.name}>
                    <td className="num" data-col="optional">
                      {formatBytes(folder.bytes)}
                    </td>
                    <td className="wrap path">
                      <Icon name={folder.name === "(root)" ? "file" : "folder"} />
                      {folder.name}
                    </td>
                    {/* What is actually in there, in the analyser's own nouns (FR-48),
                        so this cell and the headline inventory can never disagree. */}
                    <td className="wrap note">
                      <Icon name={iconFor(folder.bucket)} />
                      {folder.note}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        <div className="panel" data-tab="files">
          <table>
            <caption className="sr-only">{tree.caption}</caption>
            <thead>
              <tr>
                <th scope="col" className="num" data-col="optional">
                  Size
                </th>
                <th scope="col">Path</th>
              </tr>
            </thead>
            <tbody>
              {tree.rows.map((entry) => (
                <tr key={entry.path}>
                  <td className="num" data-col="optional">
                    {formatBytes(entry.size)}
                  </td>
                  <td className="wrap path">
                    <Icon name={iconFor(bucketForPath(entry.path))} />
                    {entry.path}
                    {entry.binary ? <span className="muted"> · binary</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {tree.omitted > 0 ? (
            <p className="computed muted">
              + {formatCount(tree.omitted)} more files, listed in full at <a href={labelEndpoint}>the manifest endpoint</a>.
            </p>
          ) : null}
        </div>

        {deps.length > 0 ? (
          <div className="panel" data-tab="dependencies">
            <table>
              <caption className="sr-only">{countedNoun(deps.length, "dependency")}</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Version</th>
                  <th scope="col" data-col="optional">
                    Ecosystem
                  </th>
                </tr>
              </thead>
              <tbody>
                {deps.map((d) => (
                  <tr key={`${d.ecosystem}:${d.name}:${d.version ?? ""}`}>
                    <td className="wrap">{d.name}</td>
                    <td>{d.version ?? "—"}</td>
                    <td data-col="optional">{d.ecosystem}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      <small className="stamp">{computedStamp(manifest)}</small>
    </section>
  );
}

/**
 * The language mix as a bar and a legend.
 *
 * GitHub's own bar is the reference and its colours are the part that does not
 * translate: this system has one accent and it belongs to the paid action, so a
 * five-colour language key would spend the whole palette on a decoration. The segments
 * are the ink ramp instead — ink, ash, hairline-strong, hairline — largest first, so the
 * ordering carries the meaning that colour carries on GitHub. The legend names every
 * segment with its percentage, so the bar is never the only place the fact appears and
 * a reader who cannot distinguish two greys loses nothing.
 */
function LanguageBar({ shares }: { shares: ReturnType<typeof languageShares> }) {
  return (
    <div className="languages">
      {/* One language is one segment, and a bar with one segment is a full-width
          black rule that measures nothing. The legend already says "JavaScript 100%". */}
      {shares.length > 1 ? (
        <div className="bar" aria-hidden="true">
          {shares.map((share, i) => (
            <span key={share.name} data-rank={Math.min(i, 3)} style={{ width: `${share.percent}%` }} />
          ))}
        </div>
      ) : null}
      <ul className="legend computed">
        {shares.map((share, i) => (
          <li key={share.name}>
            <span className="swatch" data-rank={Math.min(i, 3)} aria-hidden="true" />
            {share.name} {share.percent}%
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * `?view=agent` — the manifest, unfolded, unchanged, and unlinked.
 *
 * Nothing on the website points here any more. It stays because `/docs` names it, agents
 * were promised a page they can `curl`, and the whole product claim is that the manifest
 * is public: a disclosure that is only reachable by opening three `<details>` is a
 * weaker promise than one that is one URL away and complete in the HTML.
 */
function AgentView({
  bundle,
  base,
  path,
  readme,
  claims,
  notices,
  reading,
  sample402,
}: {
  bundle: ListingBundle;
  base: string;
  path: string;
  readme: string | null;
  claims: ReturnType<typeof contradictions>;
  notices: React.ReactNode;
  reading: Reading;
  /** The live 402 body, pretty-printed, or null when there is nothing to quote. */
  sample402: string | null;
}) {
  const { creator, listing, latest, releases, endpoints, status } = bundle;
  const ref = `${creator.handle}/${listing.slug}`;
  const manifest = latest ? manifestFor(bundle, latest) : null;
  const price = toMicro(listing.price_micro);
  const updatePrice = toMicro(listing.update_price_micro);
  const scan = manifest ? scanLabel(manifest) : null;
  const cadence = cadenceSentence(releases.filter((r) => r.scan === "pass").map((r) => r.created_at));
  const tree = manifest ? treeView(manifest) : null;

  const paySession = `# the 402, with the price and the exact bytes to sign
curl -si ${endpoints.resource_endpoint}

# what your wallet already owns, and what the next fetch would cost it
curl -s ${endpoints.version_endpoint} \\
  -H "X-Wallet-Signature: 0xYOURADDRESS.<nonce>.<signature>"`;

  const updateNote = (
    <p className="written">
      {updatePrice === 0n
        ? "Buy once and every later release is included, forever. That is stamped on the purchase and no later price change can revoke it."
        : `Later releases cost ${formatPrice(updatePrice)}, and never more than the update price in force when you bought. One charge per update, whatever the release cadence.`}
    </p>
  );

  return (
    <>
      <StorefrontMark reading={reading} />
      {/* `agent-reading` (2026-08-30, founder): "a lot smaller — it was made for agents,
          not for humans." The type scale is re-tokened on this element alone. */}
      <main className="agent-reading">
        <h1>
          {ref}
          {latest ? ` · v${latest.version}` : ""}
        </h1>
        <p className="written measure">
          What an agent reads when it fetches this URL: the whole manifest, in order, with the offer on the last line as a{" "}
          <a href="#order">402 it can pay</a>. Nothing here is a button — an agent does not click, it signs. The page a person reads
          is <a href={path}>here</a>.
        </p>

        {notices}

        {manifest ? (
          <>
            <p className="facts computed">
              {manifest.computed.artifact_class}
              {componentInventory(manifest.computed.component_inventory) ? ` · ${componentInventory(manifest.computed.component_inventory)}` : ""}
              {` · ${countedNoun(manifest.computed.file_count, "file")}`}
              {` · ${compositionLine(manifest.computed.bytes_text, manifest.computed.bytes_binary)}`}
              {` · ${languageMix(manifest.computed.languages)}`}
              {` · ${licenceLabel(manifest)}`}
            </p>
            <p className="facts">
              <span data-status={scan?.status}>{scan?.text}</span>
              {cadence ? ` · ${cadence}` : ""}
              {manifest.computed.originality ? ` · ${Math.round(manifest.computed.originality.blob_overlap_ratio * 100)}% of files seen elsewhere` : ""}
            </p>
            <small className="stamp">{computedStamp(manifest)}</small>
            {/* §5: "the agent gets the same thing as JSON" — and, since this reading is
                the manifest rendered, the same thing as HTML. One component, two
                readings, so a check row can never appear on one and not the other. */}
            <Trust manifest={manifest} />
          </>
        ) : (
          <p role="status" data-status="pending">
            No passing release yet. Nothing is for sale until a snapshot has been analysed, licence-checked and scanned.
          </p>
        )}

        {listing.description || listing.trigger_hint ? (
          <section>
            <h2>
              Description <span className="badge">self_reported</span>
            </h2>
            <p className="written">
              <small className="muted">
                Written by the creator. Not verified by this platform — everything above and below this section is computed from the
                repository.
              </small>
            </p>
            {listing.description ? <p className="written">{listing.description}</p> : null}
            {listing.trigger_hint ? (
              <p className="written">
                <strong>When to use it.</strong> {listing.trigger_hint}
              </p>
            ) : null}
            {claims.length > 0 ? (
              <div role="status">
                {claims.map((c) => (
                  <p className="contradiction" key={c.claim}>
                    {c.sentence}
                  </p>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        {readme ? (
          <section>
            <h2>Readme</h2>
            <div className="written" dangerouslySetInnerHTML={{ __html: readme }} />
          </section>
        ) : null}

        {manifest && tree ? (
          <section>
            <h2>Contents</h2>
            <table>
              <caption>{tree.caption}</caption>
              <thead>
                <tr>
                  <th scope="col" className="num" data-col="optional">
                    Size
                  </th>
                  <th scope="col">Path</th>
                </tr>
              </thead>
              <tbody>
                {tree.rows.map((entry) => (
                  <tr key={entry.path}>
                    <td className="num" data-col="optional">
                      {formatBytes(entry.size)}
                    </td>
                    <td className="wrap">
                      {entry.path}
                      {entry.binary ? <span className="muted"> · binary</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {tree.omitted > 0 ? (
              <p className="computed muted">
                + {formatCount(tree.omitted)} more files, listed in full at <a href={endpoints.label_endpoint}>the manifest endpoint</a>.
              </p>
            ) : null}
            <small className="stamp">{computedStamp(manifest)}</small>
          </section>
        ) : null}

        {manifest ? (
          <section>
            <h2>Dependencies</h2>
            {manifest.computed.dependencies.length === 0 ? (
              <p className="computed">None found in the software bill of materials for this release.</p>
            ) : (
              <table>
                <caption>{countedNoun(manifest.computed.dependencies.length, "dependency")}</caption>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Version</th>
                    <th scope="col" data-col="optional">
                      Ecosystem
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {manifest.computed.dependencies.map((d) => (
                    <tr key={`${d.ecosystem}:${d.name}:${d.version ?? ""}`}>
                      <td className="wrap">{d.name}</td>
                      <td>{d.version ?? "—"}</td>
                      <td data-col="optional">{d.ecosystem}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <small className="stamp">{computedStamp(manifest)}</small>
          </section>
        ) : null}

        <section>
          <h2>Releases</h2>
          {releases.length === 0 ? (
            <p className="computed">No releases yet.</p>
          ) : (
            <table>
              {/* `cadence` already opens with the release count; do not print it twice. */}
              <caption>{cadence ?? countedNoun(releases.length, "release")}</caption>
              <thead>
                <tr>
                  <th scope="col">Version</th>
                  <th scope="col" data-col="optional">
                    Date
                  </th>
                  <th scope="col">Scan</th>
                  <th scope="col">Changed</th>
                  <th scope="col">Notes</th>
                </tr>
              </thead>
              <tbody>
                {releases.map((release) => {
                  const diff = release.diff_summary as
                    | { files_added?: number; files_changed?: number; files_removed?: number; additions?: number; deletions?: number }
                    | null;
                  const touched = diff ? (diff.files_added ?? 0) + (diff.files_changed ?? 0) + (diff.files_removed ?? 0) : null;
                  const lines = diff ? (diff.additions ?? 0) + (diff.deletions ?? 0) : null;
                  return (
                    <tr key={release.id}>
                      <td>v{release.version}</td>
                      <td data-col="optional">{formatDate(release.created_at)}</td>
                      <td data-status={release.scan}>{release.scan}</td>
                      <td className="num">{touched === null ? "—" : `${countedNoun(touched, "file")}, ${countedNoun(lines ?? 0, "line")}`}</td>
                      <td className="written">{release.changelog ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <p className="computed muted">
            Machine-readable at <a href={endpoints.releases_endpoint}>{endpoints.releases_endpoint}</a>. Entries cannot be deleted by the
            creator.
          </p>
        </section>

        {/* The Last Line Rule: on this reading the order comes after everything. */}
        <section className="order">
          <h2 id="order">Order</h2>
          {status === "retired" ? (
            <p role="status" data-status="warn">
              This listing is no longer sold. If your wallet already owns a version, it can still fetch it from{" "}
              <code className="wrap">{endpoints.resource_endpoint}</code>.
            </p>
          ) : !latest ? (
            <p role="status" data-status="pending">
              Nothing is for sale here yet.
            </p>
          ) : (
            <>
              <p className="order-line">
                <span>
                  GET v{latest.version} · {price === 0n ? "free" : formatPrice(price)} · {updatesLabel(updatePrice)}
                </span>
              </p>
              <p className="written">
                The resource endpoint answers <code>402</code> with the price and the exact bytes to sign; the same request carrying{" "}
                <code>PAYMENT-SIGNATURE</code> returns a signed download URL. Access is granted only after settlement returns a
                transaction hash. A person can do the same thing with a browser wallet on <a href={path}>the product page</a>.
              </p>
              <pre>
                <code>{paySession}</code>
              </pre>
              {sample402 ? (
                <>
                  {/* The buy button of this reading. Not an accent block — an agent is
                      shown the answer it will get, quoted for this render and valid for
                      the timeout the body names. `quote_id` and `valid_before` change
                      on every load because they are real. */}
                  <p className="written">
                    The first request answers this — a real quote, made for this page load:
                  </p>
                  <pre>
                    <code>{`HTTP/1.1 402 Payment Required\nContent-Type: application/json\n\n${sample402}`}</code>
                  </pre>
                </>
              ) : null}
              <dl>
                <dt>Resource</dt>
                <dd className="wrap">
                  <a href={endpoints.resource_endpoint}>{endpoints.resource_endpoint}</a>
                </dd>
                <dt>Manifest</dt>
                <dd className="wrap">
                  <a href={endpoints.label_endpoint}>{endpoints.label_endpoint}</a>
                </dd>
                <dt>Version</dt>
                <dd className="wrap">
                  <a href={endpoints.version_endpoint}>{endpoints.version_endpoint}</a>
                </dd>
                {latest.artifact_sha256 ? (
                  <>
                    <dt>Artifact sha256</dt>
                    <dd className="wrap">{latest.artifact_sha256}</dd>
                  </>
                ) : null}
              </dl>
              {updateNote}
              <p className="written">
                <small className="muted">
                  Sold by <span className="computed">{creator.handle}</span>. Read the <a href="/api/terms">terms</a> and the{" "}
                  <a href="/docs">route documentation</a> before you script against this. Base URL <code>{base}</code>.
                </small>
              </p>
            </>
          )}
        </section>
      </main>
      {/* The same four tools as the human reading: an agent that landed here through a
          browser should not be the one reader that has to scrape. */}
      <WebMcpTools owner={creator.handle} slug={listing.slug} />
      <StorefrontColophon />
    </>
  );
}
