/**
 * GET /dashboard/:id — one listing: what it is waiting on, what it costs, and the
 * snippet that makes it propagate.
 *
 * Every control here is a plain `<form method="post">` to a route handler that calls the
 * matching creator endpoint with the session's bearer key. No control on this page does
 * anything an agent could not do with `curl`, which is D9 stated as a build constraint
 * rather than as an aspiration.
 *
 * The pricing block is FR-12: presets from D2a, a field that is pre-filled and cannot be
 * blank, and an earnings preview. Two things left it on 2026-09-01, on the founder's
 * direction. The $0 preset's gloss — "buy once, every release free" — is now just `$0`,
 * read off the same `formatPrice` as every other preset. And the floor is printed under
 * each custom field: D2b's rule is that $0.01 is never a *suggestion*, and a note on an
 * already-open box is a constraint, not a suggestion — but it is a deviation from FR-12's
 * "$0.01 nowhere on the page" as written, and the PRD has to catch up with it.
 *
 * Two columns, and the split is the point (2026-08-31, on the founder's direction). The
 * left column is what a creator edits; the right column is what it means and what to do
 * about it — the gates that stand between this listing and being sold, the two controls
 * that act on them, and the box that itemises what a sale pays. Nothing is in both.
 *
 * The left column runs in the order the work happens: say what it is, price it, cut a
 * release, make sure it may be resold, then the two things you hand to something else —
 * the addresses and the README preamble — and retiring at the very end. The checklist in
 * the right column runs in the same order and every row links to the block that answers
 * it, so scanning the column and scanning the sheet are one motion.
 *
 * **One Save on the page,** and since 2026-09-01 that is literal: the Price section's own
 * Save went, leaving the single `PATCH` that price and both self-reported fields always
 * shared. Two Save buttons were two chances to half-save a listing and no answer to "did
 * that take?". Publish is a separate verb and stays a separate control: saving a price is
 * not the same act as putting a listing on sale, and there is no unpublish in this
 * product — retiring is permanent (FR-39), so it stays at the bottom of the left column,
 * away from the everyday controls, wearing the secondary rectangle rather than the
 * accent. Both buttons are pinned to the foot of the window once they scroll away
 * (`save-bar.tsx`).
 *
 * **Prose is down to what the controls cannot say** (2026-09-01, founder). The Releases
 * explainer, the README-snippet preamble and the price caveat all went: each described
 * something the form, the log or the checklist already shows, and a page a creator visits
 * on every release is read once and then scanned forever. The two field hints became
 * `placeholder`s — the guidance is inside the box it is about, gone the moment there is
 * real text to read instead, and it is the browser's own affordance rather than a
 * prefilled value that could be saved as if the creator had written it.
 *
 * The earnings preview left the form the same day. Setting a price and reading what a
 * sale pays you are two different questions, and answering the second inside the radio
 * list answered it four times over while still burying the one number that matters. It
 * is the box now, live against the form, and it says so when what it shows is not yet
 * saved. PRODUCT.md's rule that earnings are what the creator keeps survives the
 * itemisation: the fee is a line, "You receive" is the line it ends on and the only
 * number set large.
 *
 * **Where you get paid** (25 Oct 2026, HackMeridian; founder: "we should have the option
 * to switch between" payout addresses, not only a link to the wallet page). A creator may
 * hold an EVM and a Stellar payout address, and each rail lands at one of them. The block
 * sits in the form right after the price, because it is the other half of the same
 * question — what a sale costs, and where its money goes — and the one Save carries it as
 * `offered_networks`. One row per rail, its address, an Offer box; binding an address is
 * still the wallet page's (where-you-get-paid.tsx).
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { CharCount } from "@/app/_components/char-count";
import { CheckForReleases } from "@/app/_components/check-for-releases";
import { AgentPrompt } from "@/app/_components/agent-prompt";
import { CopyButton } from "@/app/_components/copy-button";
import { GitHubMark } from "@/app/_components/github-mark";
import { BLOCKING_COPY, Notice } from "@/app/_components/notice";
import { PayoutSummary } from "@/app/_components/payout-summary";
import { SaveBar } from "@/app/_components/save-bar";
import { PLATFORM_FEE_BPS, payoutRailsFor } from "@/lib/core/access";
import { RESALE_COMPATIBLE_SPDX } from "@/lib/licence";
import { type ListingRow, toMicro } from "@/lib/db/types";
import { appUrl } from "@/lib/env";
import { MIN_PRICE_MICRO, OPEN_AFTER_DAYS_PRESETS, OPEN_RELEASE_MAX_DAYS, PRICE_PRESETS_MICRO, UPDATE_PRICE_PRESETS_MICRO } from "@/lib/schemas";
import { openReleaseChecks } from "@/lib/listings/view";
import { DESCRIPTION_LIMIT, requireDashboard, TRIGGER_HINT_LIMIT } from "@/lib/web/dashboard";
import { normalizeReport, type ScanReport } from "@/lib/scan/report";
import { blockingReasons, loadListingById, manifestFor, repoUrlFor } from "@/lib/web/loaders";
import { checkRowsFrom, checkTone, formatDate, formatDateTime } from "@/lib/web/manifest-view";
import { formatPrice, PRICE_FLOOR_PATTERN } from "@/lib/web/money";
import { readmeSnippet } from "@/lib/web/readme-snippet";
import { shortAddress, WhereYouGetPaid } from "./where-you-get-paid";

export const metadata: Metadata = { title: "Listing" };
export const dynamic = "force-dynamic";

/** `9000000n` → `"9"`, `9500000n` → `"9.50"`. What goes in the custom price field. */
function dollarsInput(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const fraction = micro % 1_000_000n;
  if (fraction === 0n) return whole.toString();
  return `${whole}.${String(fraction).padStart(6, "0").replace(/0+$/, "")}`;
}

/**
 * What each custom field will actually take (2026-09-01, founder: a creator typing into
 * an open box cannot tell whether a micro-amount is allowed). D2b's rule is that the
 * minimum is never a *suggestion* — these are the constraint on a field that is already
 * open, printed where a rejected save would otherwise be the first place anybody learned
 * it, and the release floor is read from MIN_PRICE_MICRO rather than typed so the two
 * cannot drift.
 *
 * **One floor, both fields** (2026-09-01, founder). D2b's $0.01 is the release price's
 * floor because under it the facilitator's fee costs us more than our commission, and
 * that arithmetic does not care which of the two prices is being charged — so a *typed*
 * update price is held to it too. What is untouched is the $0 preset: zero is lifetime
 * access and is celebrated (D1, FR-16), and it is a preset, not something anybody types.
 * The floor binds the open box; the radio above it still offers free.
 */
const FLOOR_NOTE = `${formatPrice(MIN_PRICE_MICRO)} or more.`;

/**
 * The message the browser says when `PRICE_FLOOR_PATTERN` blocks a submit. The pattern
 * itself is in `money.ts`, next to the `validatePrice` that enforces the same floor on
 * the server, so the two cannot drift.
 */
const FLOOR_MESSAGE = `Enter ${formatPrice(MIN_PRICE_MICRO)} or more.`;

/**
 * GitHub's own instructions for the one thing this page still explains in prose: what a
 * licence file is. Linked from the one word that names it and opened in a new tab, so a
 * creator halfway through pricing a listing does not lose the form to go and read it.
 * Checked live on 2026-08-31. The releases link went with the Releases explainer on
 * 2026-09-01 — the log, the table and Check for releases are the section now.
 */
const GITHUB_HELP = {
  licence:
    "https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository",
} as const;

/**
 * The two repository jobs this page can ask for but cannot do, written as instructions
 * for a coding agent (2026-08-31, founder: "many won't know how to do this").
 *
 * Both are one imperative sentence, both name the exact artefact, and both end by
 * forbidding anything else — an agent handed "add a licence" with no fence will
 * cheerfully reformat the repository on its way past. They are a starting point, not a
 * policy: MIT because it is the most common permissive licence and the first on our own
 * allow-list, `v1.0.0` because these only appear when there is no release at all.
 */
const AGENT_PROMPTS = {
  licence:
    "Add an MIT LICENSE file at the root of this repository, filled in with the correct copyright holder and year, then commit it and push to the default branch. Change nothing else.",
  release:
    "Create the git tag v1.0.0 on the latest commit of this repository's default branch and push it to GitHub with `git push origin v1.0.0`. Do not modify any files.",
} as const;

/** The line over each prompt row. The row itself is app/_components/agent-prompt.tsx. */
const AGENT_LEDE = "Or paste this into your coding agent:";

/**
 * The repository link at the end of the state line, streamed. It is the one thing on this
 * page that asks GitHub (`repoById`, through the App), and until 25 Oct 2026 it held the
 * whole sheet back for the round trip (founder: a slow fetch with nothing on screen reads
 * as broken). Everything else here is read from our own database, so the page renders at
 * once and the link fills in behind it; GitHub not answering costs the link, not the page.
 */
async function RepoLink({ listing }: { listing: ListingRow }) {
  const repoUrl = await repoUrlFor(listing);
  if (!repoUrl) return null;
  return (
    <>
      {" · "}
      <a className="repo-link" href={repoUrl} target="_blank" rel="noopener">
        <GitHubMark />
        View on GitHub
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    </>
  );
}

/**
 * A help link inside a sentence. One word, underlined like every other link on the site,
 * and nothing else.
 *
 * No `sr-only` "(opens in a new tab)" suffix, deliberately, though the site's standalone
 * links carry one. Appended hidden text works on a control that *is* the whole link —
 * the card's View button — and breaks inside prose: a screen reader reads "A tag —
 * GitHub's documentation (opens in a new tab) matching vX.Y.Z", which severs the
 * sentence at its verb. It also rides along in a text selection, and this site's pages
 * are read by `curl` and copied by hand more than most.
 */
function Help({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener">
      {children}
    </a>
  );
}

/**
 * `release.scan_report` as a v2 report, or null.
 *
 * The column is jsonb written by three scanner generations and read defensively for the
 * same reason `lib/admin/detail.ts` reads it defensively: a malformed blob must render
 * nothing, never throw a creator's own dashboard.
 */
function readReport(stored: unknown): ScanReport | null {
  if (!stored) return null;
  try {
    return normalizeReport(stored as Parameters<typeof normalizeReport>[0]);
  } catch {
    return null;
  }
}

/**
 * The creator's own copy of the trust report ("PRD Trust Report.md" §4.4, 13 Sep 2026).
 *
 * The same seven check rows the buyer reads on the listing page, from the same
 * `checkRowsFrom` — a creator and their buyer looking at the same release must not be
 * shown two different scans of it. What is different is the list underneath: **every**
 * finding, secrets included, with the path and the line. That is the point of the
 * section. A secret is in the creator's own file and withholding its location is what
 * docs/BACKLOG.md complained about; the *value* was never stored — `lib/scan/secrets.ts`
 * keeps the rule, the path, the line and the length of the match and discards the
 * credential at the point of the match, so there is nothing here to leak.
 *
 * The three states get three sentences, in the page's voice: what passed, what to fix,
 * and what is still running. Nothing here says "no findings" over a check that could not
 * run — an `unavailable` row says so in its own words.
 */
function ScanReportSection({ report, version, verdict }: { report: ScanReport; version: string; verdict: "pass" | "fail" | "pending" }) {
  const rows = checkRowsFrom(report.checks, report.findings);
  // Blocking first, then by severity: the reason a release failed is the top row.
  const rank: Record<string, number> = { CRITICAL: 0, HIGH: 1, MODERATE: 2, LOW: 3, UNKNOWN: 4 };
  const findings = [...report.findings].sort(
    (a, b) => Number(b.blocking) - Number(a.blocking) || (rank[a.severity] ?? 5) - (rank[b.severity] ?? 5),
  );
  const blocking = findings.filter((f) => f.blocking);

  return (
    <section id="scan-report">
      <h2>Security scan</h2>
      <p className="computed">
        v{version} · <span data-status={verdict}>{verdict}</span> · scanned {formatDateTime(report.scanned_at)} · scanner{" "}
        {report.scanner_version}
        {report.advisories_refreshed_at ? ` · advisories refreshed ${formatDate(report.advisories_refreshed_at)}` : ""}
      </p>

      {verdict === "fail" ? (
        <p className="written measure">
          {blocking.length === 1
            ? "One finding blocks this release, and it is the first row below."
            : `${blocking.length} findings block this release, and they are the first rows below.`}{" "}
          Fix each in the repository and push a new tag — a scan verdict is final, so this version cannot be re-scanned.
        </p>
      ) : null}
      {verdict === "pending" ? (
        <p className="written measure" data-status="pending">
          {report.osv_error
            ? "The known-vulnerability check could not run; retrying. Nothing to fix — this release goes on sale when it answers."
            : "The scan has not finished. Nothing is sold until it passes."}
        </p>
      ) : null}

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
          </div>
        ))}
      </dl>

      {findings.length === 0 ? (
        <p className="written measure">Nothing was found by the checks that ran.</p>
      ) : (
        <table>
          <caption>{`${findings.length} finding${findings.length === 1 ? "" : "s"} · blocking first · yours only, never shown to a buyer`}</caption>
          <thead>
            <tr>
              <th scope="col">Rule</th>
              <th scope="col">Severity</th>
              <th scope="col" data-col="optional">
                Where
              </th>
              <th scope="col" data-col="optional">
                What
              </th>
            </tr>
          </thead>
          <tbody>
            {findings.map((f, i) => (
              <tr key={`${f.rule_id}:${f.path ?? f.package?.name ?? ""}:${f.line ?? ""}:${i}`}>
                <td className="wrap">
                  {f.rule_id}
                  <span className="muted"> · {f.kind}</span>
                </td>
                <td data-status={f.blocking ? "fail" : f.tier === "review" ? "pending" : "warn"}>
                  {f.tier === "review" ? "flagged for review" : f.severity}
                  {f.blocking ? " · blocks" : ""}
                </td>
                {/* The path and the line — the whole reason this section exists. A
                    dependency finding has a package instead; it has no file of yours. */}
                <td className="wrap" data-col="optional">
                  {f.path ? `${f.path}${f.line ? `:${f.line}` : ""}` : f.package ? `${f.package.name}${f.package.version ? ` ${f.package.version}` : ""}` : <span className="muted">—</span>}
                </td>
                <td className="wrap" data-col="optional">
                  {f.description}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** One line of the standing checklist: the gate, where it stands, and what fixes it. */
type Check = {
  key: string;
  label: string;
  /** Where the thing that fixes it lives. Absent when nothing on this page fixes it. */
  href?: string;
  /**
   * `warn` joined the three on 2026-09-01, for one case: the newest release failed its
   * scan but an older one still passes, so the listing sells and nothing is blocked. Red
   * would say "your listing is broken" about a listing that is not; ash would hide a
   * failed scan. Amber is the system's existing ink for "true, and not an emergency".
   */
  state: "pass" | "fail" | "pending" | "warn";
  value: string;
  fix?: string;
};

export default async function ListingDashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string; blocking?: string; check?: string }>;
}) {
  const { id } = await params;
  const { ok, error, blocking, check } = await searchParams;
  const { creator } = await requireDashboard(`/dashboard/${id}`);

  const bundle = await loadListingById(id);
  // Not 403: a listing id that is not yours is a listing that does not exist to you.
  if (!bundle || bundle.creator.id !== creator.id) notFound();

  const { listing, latest, releases, endpoints, status } = bundle;
  const price = toMicro(listing.price_micro);
  const updatePrice = toMicro(listing.update_price_micro);
  const blockers = blockingReasons({ listing, latest, releases });

  const snippet = readmeSnippet({
    owner: creator.handle,
    slug: listing.slug,
    appUrl: appUrl(),
    priceMicro: price,
    updatePriceMicro: updatePrice,
    version: latest?.version ?? null,
  });

  const blocked = (reason: string) => blockers.includes(reason);

  /**
   * Whether the newest sellable release shipped a README (2026-09-01, founder).
   *
   * Read off the manifest the release already stores rather than asked of GitHub: the
   * analyser fetches the README on every cut and `readme_html` is null when the
   * repository has none, so this costs nothing and — more to the point — describes the
   * *snapshot that is for sale*, not the repository as it stands this second. A README
   * committed after the newest tag is not in the release a buyer downloads, and a row
   * that said "found" on the strength of it would be lying about the artifact.
   *
   * Null until there is a release to read, which is the same shape the licence row wears
   * for the same reason — and also when the stored manifest cannot be parsed, because
   * "we could not read it" is not evidence of either answer. Written as an explicit
   * comparison rather than `manifest?.computed.readme_html !== null`, which resolves to
   * `undefined !== null` and would have claimed "found" for a manifest we failed to read.
   */
  const latestManifest = latest ? manifestFor(bundle, latest) : null;
  const readmeFound = latestManifest ? latestManifest.computed.readme_html !== null : null;
  const newest = releases[0] ?? null;
  /**
   * The newest release's trust report, as the creator is allowed to see it
   * ("PRD Trust Report.md" §4.4, 13 Sep 2026 — closing docs/BACKLOG.md's "A creator can
   * read the scan report that failed their release").
   *
   * Always through `normalizeReport`: rows written before today are v1, and the shim
   * gives them the same seven check rows with the four they never ran marked as such, so
   * this page has one shape to render rather than two. It reads the *newest* release, not
   * the newest passing one — the report worth reading is the one attached to the release
   * that did not pass.
   */
  const scanReport = readReport(newest?.scan_report);
  const osvStalled = Boolean(scanReport?.osv_error) && newest?.scan === "pending";
  // Open releases: the checks the newest cut ran, else the listing's last copy of them.
  const openChecks = openReleaseChecks(newest?.open_eligibility ?? listing.open_eligibility);
  const isOpen = listing.open_release === true;
  const openAfterDays = typeof listing.open_after_days === "number" ? listing.open_after_days : null;
  // The form shows the path after a drawn `github.com/`; the row holds the URL.
  const publicRepoPath = (listing.public_repo_url ?? "").replace(/^https:\/\/github\.com\//, "");
  // The placeholder is a real-looking path, not `owner/name` (founder: that reads as a
  // request for the owner's name). A private mirror is usually the public project's name
  // plus a suffix, so the guess strips one; `pcmarts/open-release-demo-next` suggests
  // `pcmarts/open-release-demo`.
  const publicSlugGuess = listing.slug.replace(/-(next|private|mirror|early|pro|paid)$/i, "") || listing.slug;
  // Where you get paid: every rail this deployment runs with this creator's address on it,
  // and the listing's choice among them (null, or a row from before the migration: all).
  const payoutRails = payoutRailsFor(creator);
  const offeredNetworks = Array.isArray(listing.offered_networks) ? listing.offered_networks : null;

  /**
   * The gates FR-42 enforces, printed whether or not they are failing. A checklist that
   * only lists what is wrong makes a creator guess at what is right, and on a live
   * listing these lines are the record of what a buyer is trusting.
   *
   * **Every standing row is a fact about the repository** (2026-09-01, founder): the
   * release, the README in it, the licence in it. Description left the list that day — it
   * is the one row that asked about the form on the same screen, two hand-spans from the
   * box that answers it, and a checklist reads as a list of things you go and look at.
   * It is still a hard publish gate under FR-51; it is now spoken for by the loop below,
   * which means it appears as a row exactly when it is actually blocking and is silent
   * when it is not.
   *
   * In the order the page below is in, so scanning the column and scanning the sheet are
   * the same motion, and every row carries the anchor of the thing that fixes it — a
   * checklist that names a problem and then makes you go find it is half a checklist.
   */
  const checks: Check[] = [
    {
      key: "release",
      label: "Release",
      href: "#releases",
      // Whether a release exists, and nothing else. The scan is its own row below
      // (2026-09-01, founder): this one used to end in "· scan pass", which put two
      // verdicts on one line and made a cut release with a failing scan read as a
      // half-pass. A release either exists or it does not.
      state: newest ? "pass" : "pending",
      value: newest ? `v${newest.version} · ${formatDate(newest.created_at)}` : "none yet",
      // No fix line: "none yet" already says it, and the row links to the Releases
      // section, which explains how to cut one and hands over a prompt for an agent.
    },
    {
      key: "scan",
      // "Security scan", not "Scan" (2026-09-01, founder). The bare verb does not say
      // what is being looked for, and a creator can reasonably read it as a virus check,
      // a linter or an indexing step. All three things it gates are security: leaked
      // secrets, dependency CVEs, and size limits. It is also what the manifest already
      // calls it to agents ("security-scan result", webmcp.tsx), so the two now agree.
      label: "Security scan",
      // The gate that decides whether the release above can be sold, said on its own
      // line and in its own words. A scan verdict is final, so a failed release is never
      // re-scanned; the way past it is a new tag, which is what BLOCKING_COPY says.
      //
      // It reports the newest release's verdict, but only *fails* when that leaves
      // nothing sellable. A repo whose v1.1.0 failed while v1.0.0 still passes is a
      // listing that is selling perfectly well, and `blockingReasons` agrees — it blocks
      // only when there is no passing release at all. A bare red "fail" there would be
      // the page telling a creator their listing is broken when it is not, so the row
      // names the version still being sold instead.
      //
      // Since 13 Sep 2026 the row is a way in, not a dead end: it points at the report
      // itself when there is one to read ("PRD Trust Report.md" §4.4). A creator whose
      // release failed used to be told there was a finding and given nowhere to go.
      href: scanReport ? "#scan-report" : "#releases",
      state: !newest ? "pending" : newest.scan === "pass" ? "pass" : blocked("scan_failed") ? "fail" : newest.scan === "fail" ? "warn" : "pending",
      value: !newest
        ? "waiting for a release"
        : newest.scan === "pass" || !latest || latest.id === newest.id
          ? newest.scan
          : `v${newest.version} ${newest.scan} · selling v${latest.version}`,
      // The third state, and it is not a stall the creator caused: the scan ran and the
      // known-vulnerability check could not. OSV is the single source for the blocking
      // CVE decision (§4.1), so the release waits — but there is nothing to fix, and the
      // generic "the scan has not finished" reads like a queue nobody is working.
      fix: blocked("scan_failed")
        ? BLOCKING_COPY.scan_failed
        : blocked("scan_pending")
          ? osvStalled
            ? BLOCKING_COPY.scan_pending_osv
            : BLOCKING_COPY.scan_pending
          : undefined,
    },
    {
      key: "readme",
      label: "Readme",
      // Advisory, never blocking (2026-09-01, founder): a listing with no README is a
      // worse listing, not an unsellable one, and FR-42's three gates are correctness and
      // law. So "pass" or "pending" and never "fail" — the ink the checklist keeps for a
      // thing that has to be fixed stays meaning exactly that.
      href: "#readme",
      state: readmeFound ? "pass" : "pending",
      value: readmeFound === null ? "waiting for a release" : readmeFound ? "found" : "none in this release",
      // The one case worth a sentence: there is a release, and it shipped without one.
      // The listing page renders the README as the whole of what a buyer reads, so its
      // absence is a blank space where the pitch goes.
      fix:
        readmeFound === false
          ? "Your listing page shows the README as its description, so it is blank without one. Add a README, push a tag, and it fills in."
          : undefined,
    },
    {
      key: "licence",
      label: "Licence",
      // A licence that passed has no section on the page to send anybody to.
      href: listing.licence_verdict === "pass" ? undefined : "#licence",
      // Never `fail`: since 2026-09-02 the licence blocks nothing, so a red row here
      // would be the page inventing a stop that neither publish nor the buy path
      // enforces. `pending` reads as "worth your attention", which is what it now is.
      state: listing.licence_verdict === "pass" ? "pass" : "pending",
      value: listing.licence_spdx
        ? `${listing.licence_spdx}${listing.licence_verdict ? ` · ${listing.licence_verdict}` : ""}`
        : "not detected",
    },
  ];

  // Gates the three standing rows do not speak for — `derivative_of`, `public_repo` —
  // get a row of their own rather than disappearing off a checklist that claims to be
  // complete. New reasons in blockingReasons() land here without a code change. Nothing
  // on this page fixes them, so they point at the reference that explains them.
  const spoken = new Set(["no_release", "scan_pending", "scan_failed"]);
  for (const reason of blockers) {
    if (spoken.has(reason)) continue;
    // `description_missing` is the one unspoken blocker this page can fix, so it gets the
    // label a person would write and the anchor of the field that answers it, rather than
    // the generic token and a link off to the error reference.
    const onPage = reason === "description_missing";
    checks.push({
      key: reason,
      label: onPage ? "Description" : reason.replace(/_/g, " "),
      href: onPage ? "#description" : `/docs/errors#${reason}`,
      state: "fail",
      value: onPage ? "not written yet" : "blocking",
      fix: BLOCKING_COPY[reason] ?? "This has to be resolved before publishing.",
    });
  }

  const publishable = status !== "live" && status !== "retired";

  /**
   * Which of the two controls wears the accent (2026-09-01, founder).
   *
   * The page has exactly one grounded action at a time, per DESIGN.md, and which one it
   * is depends on what is left to do. On a draft that is Publish — the act the whole
   * checklist above is counting down to. Once the listing is live there is no Publish
   * left, and the only thing a creator comes back here to do is change something and
   * commit it, so Save changes inherits the ground.
   *
   * Retired is deliberately neither. The listing's fields still save, but nothing on a
   * page that ends in "the slug is never reused" should be wearing the ink that means
   * *do this next*.
   */
  const saveIsPrimary = status === "live";
  const reference = `${creator.handle}/${listing.slug}`;


  return (
    <main className="record">
      <header className="record-head">
        <div className="record-title">
          <h1>
            {creator.handle}/{listing.slug}
          </h1>
          {/* Top right of the sheet, opposite the name (2026-09-01, founder). It moved up
              from the right column's controls: it answers "what am I about to ship?",
              which is a question a creator asks on arrival and again on the way out, not
              one that belongs in the run of Save and Publish — and up here it is the only
              thing on the page pointing away from the form, which is what it is.

              Still an `<a>` under the rectangle. It is a real navigation to another page
              in a new tab, so the middle click, the context menu and the status bar all
              have to survive; that is the same trade the Retire control makes.

              It goes to the real listing page. A draft renders there in full for its own
              creator and for nobody else, badged "Draft — visible only to you", so there
              is no second page to keep in step with the first — which is why the word
              changes with the state: you preview a draft, you view what is live. */}
          <p className="preview-link">
            <a data-button href={endpoints.url} target="_blank" rel="noopener">
              {publishable ? "Preview listing" : "View listing"}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </p>
        </div>
        {/* Money left this line when the box took it, and the repository's provenance left
            on 2026-08-31: a creator on their own dashboard knows where their code lives,
            and "your GitHub repository" was the longest run of characters on the page
            saying the least. What is left is state — what this listing is right now.

            The repository came back on 2026-09-01, on the founder's direction, but as a
            link at the end of the state line rather than as the sentence that left: half
            of what this page asks for (a tag, a LICENSE) is done over there, and the row
            that says what this listing is now is where a creator is already looking. The
            Octocat is a citation, not an ink — it sits beside its word like every other
            mark in the set, and the link is a link, not a second grounded control. */}
        <p className="facts">
          <span data-status={status === "live" ? "pass" : status === "retired" ? "warn" : "pending"}>{status}</span>
          {` · ${releases.length} release${releases.length === 1 ? "" : "s"}`}
          {latest ? ` · latest v${latest.version}` : ""}
          {/* The repository this listing sells, as somewhere a creator can go (2026-09-01,
              founder). Null when GitHub cannot be asked, and then there is no link — the
              same rule the avatar follows: a placeholder for a fact is worse than the
              fact's absence. Streamed, so the GitHub round trip never holds the sheet. */}
          <Suspense fallback={null}>
            <RepoLink listing={listing} />
          </Suspense>
        </p>
      </header>

      {/* The outcome of the last POST belongs to the whole sheet, not to a column. Always
          rendered, empty or not: the grid places three blocks by name, and a wrapper that
          appears only sometimes would shift the two columns by a row when it did. */}
      <div className="record-notices">
        <Notice ok={ok} error={error} blocking={blocking} />
      </div>

      {/* The right column: where this listing stands, the two acts available on it, and
          what a sale pays. On a phone it comes after the head and before the work, which
          is the same order — read the verdict, then act, then edit. */}
      <div className="record-side">
        <section className="checks-block">
          {/* The heading and the one act that changes what the rows below say. Not inside
              the Release row, though that is the row it answers: `.what a::after` covers
              each `li` edge to edge so the whole row is the link, and a button under that
              overlay could not be clicked at all. */}
          <div className="checks-head">
            {/* One word in every state (2026-09-01, founder). It was "Before this goes
                live" on a draft and "Checks" once published — two headings for one block
                whose rows never changed, and the heading moved under a creator on the one
                day they publish. */}
            <h2>Checks</h2>
            <CheckForReleases id={id} auto={check === "1"} />
          </div>
          <ul className="checks">
            {checks.map((check) => (
              <li key={check.key}>
                {/* The link names the row and covers it: `.what a::after` stretches over
                    the whole `li`, so the click target is the row while the accessible
                    name stays the one word that says which row it is. */}
                <span className="what">{check.href ? <a href={check.href}>{check.label}</a> : check.label}</span>
                <span className="verdict" data-status={check.state}>
                  {check.value}
                </span>
                {check.fix ? <p className="written fix">{check.fix}</p> : null}
              </li>
            ))}
          </ul>
        </section>

        {/* The page's controls, and the anchor the pinned bar watches. Neither button is
            inside the form it submits: `form=` is how HTML associates a control with a
            form elsewhere on the page, which is what lets the same two forms have a
            second trigger in the bar without a second copy of their state. */}
        <div className="record-actions" id="listing-actions">
          <p className="actions">
            <button type="submit" form="listing-form" data-variant={saveIsPrimary ? "primary" : undefined}>
              Save changes
            </button>
            {publishable ? (
              <button type="submit" form="publish-form" data-variant="primary" disabled={blockers.length > 0}>
                Publish
              </button>
            ) : null}
          </p>
        </div>

        <aside className="payout-box" aria-label="What you receive">
          <PayoutSummary
            priceMicro={price.toString()}
            updatePriceMicro={updatePrice.toString()}
            feeBps={PLATFORM_FEE_BPS.toString()}
            payoutAddress={shortAddress(creator.payout_address)}
            pendingAddress={creator.pending_payout_address ? shortAddress(creator.pending_payout_address) : null}
            pendingAt={creator.pending_payout_address ? formatDateTime(creator.rebind_effective_at) : null}
            formId="listing-form"
          />
        </aside>
      </div>

      <div className="record-body">
        {/* One form over both sections, one Save, one PATCH. The button that submits it
            is in the right column and in the pinned bar, associated by `form=`. */}
        <form id="listing-form" method="post" action={`/dashboard/${id}/actions/save`}>
          <section>
            <h2>Description</h2>
            {/* Short boxes for short limits, and a live count of what is left of each.
                The ceiling is soft here and hard in `actions/save`: `maxLength` would
                swallow the tail of a paste without saying so, and a sentence that stops
                mid-word with no explanation is worse than a refusal that names the
                overage. See char-count.tsx. */}
            <div className="field">
              <div className="field-head">
                <label htmlFor="description">What it does</label>
              </div>
              {/* The count sits inside the box, bottom right (2026-09-01, founder), which
                  is where every editor that has one puts it. `.counted` is the
                  positioning context; the textarea's own bottom padding keeps the last
                  line of a long value clear of the number. */}
              <div className="counted">
                <textarea
                  id="description"
                  name="description"
                  rows={3}
                  defaultValue={listing.description ?? ""}
                  placeholder="One sentence. Say what it is and what it does."
                />
                <CharCount htmlFor="description" limit={DESCRIPTION_LIMIT} />
              </div>
            </div>
            <div className="field">
              <div className="field-head">
                <label htmlFor="trigger_hint">When to reach for it</label>
              </div>
              <div className="counted">
                <textarea
                  id="trigger_hint"
                  name="trigger_hint"
                  rows={2}
                  defaultValue={listing.trigger_hint ?? ""}
                  placeholder={"Finish the sentence \u201Cload this when\u2026\u201D."}
                />
                <CharCount htmlFor="trigger_hint" limit={TRIGGER_HINT_LIMIT} />
              </div>
            </div>

          </section>

          <section>
            <h2>Price</h2>
            <fieldset>
              <legend>What one release costs</legend>
              <div className="presets">
                {PRICE_PRESETS_MICRO.map((preset) => (
                  <label key={String(preset)} htmlFor={`price-${preset}`}>
                    <input
                      type="radio"
                      id={`price-${preset}`}
                      name="price_choice"
                      value={String(preset)}
                      defaultChecked={price === preset}
                    />
                    {formatPrice(preset)}
                  </label>
                ))}
                <label htmlFor="price-custom-choice">
                  <input
                    type="radio"
                    id="price-custom-choice"
                    name="price_choice"
                    value="custom"
                    defaultChecked={!(PRICE_PRESETS_MICRO as readonly bigint[]).includes(price)}
                  />
                  Something else
                </label>
              </div>
              {/* Only on screen while its own radio is checked, which is the whole of its
                contract — `choose()` in the pricing route reads this field only when
                `price_choice` is `custom`. Hidden, not disabled: a disabled field posts
                nothing, and the value has to survive the round trip when somebody
                switches back to it. */}
              <div className="field money when-custom">
                <label className="sr-only" htmlFor="price_custom">
                  Custom price, in dollars
                </label>
                {/* Never empty (FR-12): pre-filled with what is set now. */}
                <span className="affix">
                  <span aria-hidden="true">$</span>
                  <input
                    id="price_custom"
                    name="price_custom"
                    defaultValue={dollarsInput(price)}
                    inputMode="decimal"
                    pattern={PRICE_FLOOR_PATTERN}
                    title={FLOOR_MESSAGE}
                    aria-describedby="price-floor"
                  />
                </span>
                <p className="floor" id="price-floor">
                  {FLOOR_NOTE}
                </p>
              </div>
            </fieldset>

            <fieldset>
              <legend>What a later release costs a holder</legend>
              <div className="presets">
                {UPDATE_PRICE_PRESETS_MICRO.map((preset) => (
                  <label key={String(preset)} htmlFor={`update-${preset}`}>
                    <input
                      type="radio"
                      id={`update-${preset}`}
                      name="update_choice"
                      value={String(preset)}
                      defaultChecked={updatePrice === preset}
                    />
                    {formatPrice(preset)}
                  </label>
                ))}
                <label htmlFor="update-custom-choice">
                  <input
                    type="radio"
                    id="update-custom-choice"
                    name="update_choice"
                    value="custom"
                    defaultChecked={!(UPDATE_PRICE_PRESETS_MICRO as readonly bigint[]).includes(updatePrice)}
                  />
                  Something else
                </label>
              </div>
              <div className="field money when-custom">
                <label className="sr-only" htmlFor="update_custom">
                  Custom later-release price, in dollars
                </label>
                <span className="affix">
                  <span aria-hidden="true">$</span>
                  <input
                    id="update_custom"
                    name="update_custom"
                    defaultValue={dollarsInput(updatePrice)}
                    inputMode="decimal"
                    pattern={PRICE_FLOOR_PATTERN}
                    title={FLOOR_MESSAGE}
                    aria-describedby="update-floor"
                  />
                </span>
                <p className="floor" id="update-floor">
                  {FLOOR_NOTE}
                </p>
              </div>
            </fieldset>

            {/* No Save of its own, and no sentence under it (2026-09-01, founder). Price
                is inside `#listing-form` like the two fields above it, so the page's one
                Save changes it; a second button here was a second answer to "did that
                take?" and the reason this file's header says there is one Save. */}
          </section>

          {/* Where you get paid (25 Oct 2026): which rails this listing is sold on, each
              beside the address it pays out to. In the form, so Save carries it. */}
          <WhereYouGetPaid rails={payoutRails} offered={offeredNetworks} />

          {/* Open releases (25 Oct 2026, HackMeridian; docs/HACKMERIDIAN-STRATEGY.md §6a;
              reshaped that evening on the founder's direction). Inside the one form, so the
              one Save carries it in the same PATCH as the price. Three controls and as few
              words as will hold them: a Yes/No switch, the public repo typed after a drawn
              `github.com/`, and how many days after each cut it goes public — a preset row
              like the price, because a maintainer means "a week" or "a month", not a date
              to be re-promised after every release. The two dependent controls are on
              screen only while the switch says Yes. The checks under them are read off the
              newest cut — computed, never declared — so a maintainer sees what a buyer will. */}
          <section id="open-release">
            <h2>Open source</h2>
            <fieldset className="open-release">
              <legend>Early access</legend>
              <div className="field">
                <span className="field-label" id="open-release-question">
                  Is this an open-source project?
                </span>
                <div className="switch" role="radiogroup" aria-labelledby="open-release-question">
                  <label>
                    <input type="radio" name="open_release" value="0" defaultChecked={!isOpen} />
                    <span>No</span>
                  </label>
                  <label>
                    <input type="radio" name="open_release" value="1" defaultChecked={isOpen} />
                    <span>Yes</span>
                  </label>
                </div>
                <small>Yes: buyers get each release first. It goes public a set number of days later, in the project&rsquo;s own repo.</small>
              </div>
              <div className="field open-only">
                <div className="field-head">
                  <label htmlFor="public_repo">Public repo</label>
                </div>
                <span className="affix">
                  <span aria-hidden="true">github.com/</span>
                  <input
                    id="public_repo"
                    name="public_repo"
                    defaultValue={publicRepoPath}
                    placeholder={`${creator.handle}/${publicSlugGuess}`}
                    pattern="(https://(www\\.)?github\\.com/)?[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}/?"
                    title={`The repository path, like ${creator.handle}/${publicSlugGuess}`}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </span>
                <small>Where the code goes public. Not the private repo you are selling.</small>
              </div>
              <div className="field open-only">
                <span className="field-label">Goes public after</span>
                <div className="presets">
                  {OPEN_AFTER_DAYS_PRESETS.map((preset) => (
                    <label key={preset} htmlFor={`open-after-${preset}`}>
                      <input type="radio" id={`open-after-${preset}`} name="open_after_choice" value={String(preset)} defaultChecked={openAfterDays === preset} />
                      {preset} days
                    </label>
                  ))}
                  <label htmlFor="open-after-custom-choice">
                    <input
                      type="radio"
                      id="open-after-custom-choice"
                      name="open_after_choice"
                      value="custom"
                      defaultChecked={openAfterDays !== null && !(OPEN_AFTER_DAYS_PRESETS as readonly number[]).includes(openAfterDays)}
                    />
                    Other
                  </label>
                </div>
                {/* Like the custom price: on screen only while Other is checked, hidden
                    rather than disabled so the value survives switching back. */}
                <div className="field unit when-custom">
                  <label className="sr-only" htmlFor="open_after_custom">
                    Days until it goes public, 1 to {OPEN_RELEASE_MAX_DAYS}
                  </label>
                  <span className="affix">
                    <input
                      id="open_after_custom"
                      name="open_after_custom"
                      defaultValue={openAfterDays ?? ""}
                      inputMode="numeric"
                      pattern="([1-9]|[1-8][0-9]|90)"
                      title={`A whole number of days, 1 to ${OPEN_RELEASE_MAX_DAYS}`}
                      aria-describedby="open-after-floor"
                    />
                    <span aria-hidden="true">days</span>
                  </span>
                  <p className="floor" id="open-after-floor">
                    1 to {OPEN_RELEASE_MAX_DAYS} days.
                  </p>
                </div>
                <small>Counted from the day each release is cut. Releases already cut keep their date.</small>
              </div>
              {openChecks.length > 0 ? (
                <div className="field">
                  <span className="field-label">
                    Checked at the last cut{newest?.promise_status ? ` (v${newest.version} · ${newest.promise_status.replace(/_/g, " ")})` : ""}
                  </span>
                  <ul className="facts">
                    {openChecks.map((check) => (
                      <li key={check.id} data-status={check.ok ? "pass" : "fail"}>
                        {check.detail}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </fieldset>
          </section>
        </form>

        <section id="releases">
          <h2>Releases</h2>
          {releases.length === 0 ? (
            <>
              <p className="computed">No releases yet.</p>
              <AgentPrompt prompt={AGENT_PROMPTS.release} what="The release prompt" lede={AGENT_LEDE} />
            </>
          ) : (
            <table>
              <caption>{`${releases.length} release${releases.length === 1 ? "" : "s"}`}</caption>
              <thead>
                <tr>
                  <th scope="col">Version</th>
                  <th scope="col" data-col="optional">
                    Date
                  </th>
                  <th scope="col">Scan</th>
                  <th scope="col" data-col="optional">
                    Commit
                  </th>
                </tr>
              </thead>
              <tbody>
                {releases.map((release) => (
                  <tr key={release.id}>
                    <td>
                      v{release.version}
                      {/* Which one is being sold, said on the row rather than only in the
                        head — a creator scanning the log should not have to compare a
                        version number against a line four screens up. */}
                      {latest && release.id === latest.id ? <span className="muted"> · latest</span> : null}
                    </td>
                    <td data-col="optional">{formatDate(release.created_at)}</td>
                    <td data-status={release.scan}>{release.scan}</td>
                    <td className="wrap" data-col="optional">
                      {release.commit_sha.slice(0, 12)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* The scan, opened up. Under the release log because it is about one release in
            it, and above the licence because it is the gate that decides whether that
            release can be sold at all. */}
        {scanReport && newest ? <ScanReportSection report={scanReport} version={newest.version} verdict={newest.scan} /> : null}

        {/* Only while there is something to say about it. A licence that passed is a line
            in the checks column and nothing more. Since 2026-09-02 an unlicensed listing
            still publishes and still sells, so this section stopped being a blocker's fix
            and became advice: it says what the missing licence costs the creator, and how
            to add one, without claiming the listing is stuck. FR-11's three outcomes are
            three different situations and they get three different answers. */}
        {listing.licence_verdict !== "pass" ? (
          <section id="licence">
            <h2>Licence</h2>
            {listing.licence_verdict === "block" ? (
              <>
                <p className="written measure">
                  There is no <Help href={GITHUB_HELP.licence}>licence</Help> file in the repository. You can publish and sell without
                  one, but your buyers get no written permission to use what they paid for, and you are the one warranting to us that
                  you may sell it. Adding a licence takes a minute and settles both.
                </p>
                <ol className="written measure">
                  <li>
                    On GitHub, open the repository and choose <strong>Add file → Create new file</strong>.
                  </li>
                  <li>
                    Name it <code>LICENSE</code>, with no extension. A <strong>Choose a license template</strong> button appears beside
                    the filename — it writes the text for you.
                  </li>
                  <li>Pick one from the list below, commit it, and press Check for releases.</li>
                </ol>
                {/* The sentence that stops Check for releases from being a button that quietly does
                    nothing here: a licence is read from the snapshot of one release, so a
                    LICENSE committed after the newest tag is not in the release we hold. */}
                <p className="written measure">
                  A licence is read from the release it ships in, so if your newest tag is older than that commit, push a new tag too
                  — otherwise the copy your buyers download still has no LICENSE in it.
                </p>
                <AgentPrompt prompt={AGENT_PROMPTS.licence} what="The licence prompt" lede={AGENT_LEDE} />
              </>
            ) : listing.licence_verdict === "manual" ? (
              <>
                <p className="written measure">
                  {listing.licence_spdx ? (
                    `${listing.licence_spdx} was recognised, but it is not on the resale-compatible list.`
                  ) : (
                    <>
                      A <Help href={GITHUB_HELP.licence}>licence</Help> file is there, but GitHub could not identify which licence it
                      is.
                    </>
                  )}{" "}
                  Nothing is required from you and nothing is blocked — this is here so you know what ships with the artifact.
                  Swapping in one of the licences below is the clearest answer for your buyers.
                </p>
                <AgentPrompt prompt={AGENT_PROMPTS.licence} what="The licence prompt" lede={AGENT_LEDE} />
              </>
            ) : (
              <p className="written measure">
                The <Help href={GITHUB_HELP.licence}>licence</Help> is read from the repository when the first release is cut. Push a
                tag, or press Check for releases, and this fills in.
              </p>
            )}

            {/* The ten, as one ruled block rather than three loose paragraphs: a label, a
                real list, and the caveat that belongs to it. Space separates the ids —
                middots between ten monospace tokens is a hedge row, and a screen reader
                reads every one of them aloud. */}
            <div className="licence-set">
              <p className="field-label">Resale-compatible</p>
              <ul className="spdx-list">
                {RESALE_COMPATIBLE_SPDX.map((spdx) => (
                  <li key={spdx}>{spdx}</li>
                ))}
              </ul>
              <p className="written note">
                Short on purpose: the set we are willing to defend, not the set that exists. It governs only whether a copy may be sold
                on — your own terms are untouched.
              </p>
            </div>
          </section>
        ) : null}

        <section>
          <h2>Addresses</h2>
          <div className="addresses">
            <div className="addr">
              <span className="field-label">Public page</span>
              {/* Copyable in every state, draft included: the address is settled the
                  moment the slug is, and a creator writing the announcement before they
                  publish should not have to retype it out of the address bar. Only the
                  link waits for the page to exist. */}
              <p className="copyline">
                <code>
                  {status === "draft" ? (
                    <span className="url">{endpoints.url}</span>
                  ) : (
                    /* A new tab, deliberately: the public page wears no site chrome, so it
                       opens the way a buyer will see it — and the dashboard stays here. */
                    <a className="url" href={endpoints.url} target="_blank" rel="noopener">
                      {endpoints.url}
                    </a>
                  )}
                </code>
                <CopyButton value={endpoints.url} what="The public page address" />
              </p>
              {/* The draft's "not reachable until you publish" went on 2026-09-01
                  (founder): the checklist in the right column is already the record of
                  what is outstanding, and `status` is printed in the head. What is left
                  is the caption that tells the two addresses apart. */}
              {status === "draft" ? null : <p className="note">What a person opens. Opens in a new tab.</p>}
            </div>

            <div className="addr">
              {/* `resource_endpoint` on the wire and in the manifest; "Agent endpoint"
                  here, because the label is for the person reading it and the sentence
                  under it is what makes the word mean anything. */}
              <span className="field-label">Agent endpoint</span>
              <p className="copyline">
                <code>
                  <span className="url">{endpoints.resource_endpoint}</span>
                </code>
                <CopyButton value={endpoints.resource_endpoint} what="The agent endpoint" />
              </p>
            </div>
          </div>
        </section>

        <section>
          {/* "Add to your README", not "Readme snippet" (2026-09-01, founder). The old
              heading read as *an excerpt of* the README and pointed the wrong way: this
              block is generated by us and goes *into* the creator's file, which is the
              opposite direction from the README we read out of the repository and render
              on the listing page. The heading is the only thing carrying that meaning
              since the explanatory paragraph went, so it has to name the act.

              One line under it, because the heading says where it goes but not why: this
              preamble is the whole of FR-30's pull channel — there is no push — and a
              creator who does not paste it has a listing whose buyers never learn that a
              new release exists. */}
          <h2 id="readme">Add to your README</h2>
          <p className="written measure">
            So when agents use your code, they check for a newer release each time they run.
          </p>
          {/* Copy in the block's own top-right corner, not on the section rule: the value
              is several lines tall, so the control belongs to the block rather than to the
              heading, and at that size it is a mark and a word rather than a rectangle
              competing with Save. */}
          <div className="snippet">
            <pre>
              <code>{snippet}</code>
            </pre>
            <CopyButton value={snippet} what="The README snippet" />
          </div>

          {/* Added 2026-08-30 with FR-49's images; the cover-image guidance left the same
          day (founder: no featured image yet — the page reads the README as committed).
          Folded into a disclosure on 2026-08-31: it is reference a creator reads once,
          and as a section of its own it sat between two tasks claiming their weight.
          Moved here from the Description section the same day (founder): it is about
          the README, so it lives under the section that is. */}
          <details className="reference">
            <summary>
              <span className="label">How your README renders</span>
            </summary>
            <p className="written measure">
              The listing page renders your README — images, tables and task lists included. Images referenced by a relative path,
              like <code>docs/screenshot.png</code>, are taken from the release snapshot and served from here; absolute{" "}
              <code>https://</code> images are left alone.
            </p>
            <ul className="written measure">
              <li>
                <strong>Up to 20 images, 2&nbsp;MB each</strong> — png, jpg, gif, svg, webp and avif. Nothing is cropped or resized,
                so a picture with words in it stays readable.
              </li>
              <li>
                A relative link to another file — <code>[the guide](docs/guide.md)</code> — points at your repository on GitHub when
                the repository is public, and renders as plain words when it is private.
              </li>
            </ul>
          </details>
        </section>

        {status !== "retired" ? (
          <section className="terminal">
            <h2>Stop selling</h2>
            <p className="written measure">
              Retiring is permanent and the slug is never reused. The manifest and the release log stay up, marked no longer sold, and
              every wallet that bought a version keeps it.
            </p>
            {/* A button (2026-09-01, founder), and still an `<a>` underneath: it opens the
                confirm page, so the middle click and the context menu have to survive —
                the same trade the download link makes. `data-button` is how an anchor
                wears the secondary rectangle in this system. It never wears the accent:
                one grounded action per page, and on this page that is Publish.

                Small, like the page's other two asides (founder, same day). Retiring is
                the most consequential thing on this page and the least frequent, and a
                full-size rectangle at the foot of the sheet reads as an invitation. The
                weight it needs comes from the heavy rule and the paragraph above it, not
                from the size of the control — and the real confirmation is the page it
                opens, where the act is spelled out and typed to confirm. */}
            <p className="actions retire-action">
              <a data-button href={`/dashboard/${id}/retire`}>
                Retire this listing
              </a>
            </p>
          </section>
        ) : null}

      </div>

      {/* Empty on purpose: Publish takes no input, and both of its triggers reach it by
          `form=`. It lives outside `#listing-form` because forms do not nest. */}
      {publishable ? <form id="publish-form" method="post" action={`/dashboard/${id}/actions/publish`} /> : null}

      <SaveBar
        reference={reference}
        formId="listing-form"
        publishFormId={publishable ? "publish-form" : null}
        blocked={blockers.length > 0}
        saveIsPrimary={saveIsPrimary}
      />
    </main>
  );
}
