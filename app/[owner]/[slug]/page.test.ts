/**
 * §14.1, as a test rather than as a promise.
 *
 * `npm run check:ssr` proves this against a running server and a real database. This
 * proves the same thing on every `npm test`, against a seeded mock: the page is awaited
 * as a server component and rendered to static markup, so what is asserted here is the
 * bytes a `curl` would receive with scripting off.
 *
 * It is deliberately about *presence*, not layout. The failure this guards against is
 * Agent Bazaar's — a product page whose HTML contains the product's name zero times.
 */

import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import type { ListingProfile } from "@/lib/web/github-profile";
import { makeMockDb } from "@/lib/test/mock-db";
import { type ScanFinding, publishedFindings } from "@/lib/scan";
import ListingPage, { generateMetadata } from "./page";

/**
 * GitHub is not reachable from a unit test and must not be: the About block and the
 * Creator block are context over a manifest, and the page's contract is that they can
 * be entirely absent without changing anything else. So the loader is mocked, it
 * answers two nulls by default, and the two tests that care set it.
 */
const profile: ListingProfile = { repo: null, owner: null, stats: null };

vi.mock("@/lib/web/github-profile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/web/github-profile")>();
  return { ...actual, listingProfile: async () => profile };
});

const CREATOR_ID = "11111111-1111-4111-8111-111111111111";
const LISTING_ID = "22222222-2222-4222-8222-222222222222";

let mock: ReturnType<typeof makeMockDb>;

function computed(overrides: Record<string, unknown> = {}) {
  return {
    artifact_class: "Harness",
    component_inventory: [
      { kind: "skill", count: 1 },
      { kind: "script", count: 9 },
      { kind: "test file", count: 3 },
    ],
    file_count: 18,
    dir_depth: 3,
    bytes_text: 225_280,
    bytes_binary: 67_584,
    languages: { Python: 68_000, Shell: 32_000 },
    tree: [
      { path: "README.md", size: 4_096, binary: false },
      { path: "src/humanize.py", size: 12_288, binary: false },
    ],
    readme_html: "<h2>Install</h2><p>Run it.</p><script>alert(1)</script>",
    dependencies: [{ name: "requests", ecosystem: "pypi", version: "2.31.0" }],
    licence: { spdx: "MIT", verdict: "pass" },
    scan: { verdict: "pass", scanner_version: "2026.08.2", at: "2026-08-21T10:00:00.000Z" },
    computed_at: "2026-08-28T16:20:00.000Z",
    analyzer_version: "0.1.0",
    ...overrides,
  };
}

/**
 * A report v2 as `computed.scan` ("PRD Trust Report.md" §4.2, accepted 13 Sep 2026).
 *
 * Deliberately mixed: a clean row, a row with findings, a row that could not run, and a
 * capability inventory that is not empty — so one seed exercises every branch of the
 * Trust section. The secret is here on purpose and must never reach the markup: the
 * manifest schema has no place for it, and the test below proves the page cannot print
 * one even when a report hands it over.
 */
function scanV2(overrides: Record<string, unknown> = {}) {
  return {
    verdict: "pass",
    scanner_version: "2026.09.1",
    at: "2026-08-21T10:00:00.000Z",
    advisories_refreshed_at: "2026-09-12T04:00:00.000Z",
    checks: [
      { id: "secrets", tool: "x402git/secrets", tool_version: "2026.09.1", status: "pass", at: "2026-08-21T10:00:00.000Z", findings: 0 },
      { id: "limits", tool: "x402git/limits", tool_version: "2026.09.1", status: "pass", at: "2026-08-21T10:00:00.000Z", findings: 0 },
      { id: "known_malware", tool: "osv.dev/MAL", tool_version: "2026-09-13", status: "pass", at: "2026-08-21T10:00:00.000Z", findings: 0, packages: 63 },
      { id: "known_vulns", tool: "osv.dev", tool_version: "2026-09-13", status: "findings", at: "2026-08-21T10:00:00.000Z", findings: 2, packages: 41 },
      {
        id: "dep_behaviour",
        tool: "socket.dev",
        tool_version: "2026-09-13",
        status: "unavailable",
        at: "2026-08-21T10:00:00.000Z",
        findings: 0,
        reason: "socket quota",
        // Ours alone (§4.2). The manifest schema drops it; the assertion below proves so.
        socket_scan_id: "sock_secret_id",
      },
      { id: "injection", tool: "x402git/inject", tool_version: "2026.09.1", status: "pass", at: "2026-08-21T10:00:00.000Z", findings: 0 },
      { id: "capabilities", tool: "x402git/caps", tool_version: "2026.09.1", status: "findings", at: "2026-08-21T10:00:00.000Z", findings: 2 },
    ],
    findings: [
      {
        kind: "vulnerability",
        check: "known_vulns",
        tier: "disclosed",
        rule_id: "GHSA-1234-5678-90ab",
        severity: "MODERATE",
        description: "prototype pollution in zipObjectDeep",
        package: { ecosystem: "npm", name: "lodash", version: "4.17.20" },
        advisory_ids: ["GHSA-1234-5678-90ab"],
      },
      {
        kind: "vulnerability",
        check: "known_vulns",
        tier: "disclosed",
        rule_id: "GHSA-aaaa-bbbb-cccc",
        severity: "LOW",
        description: "regular expression denial of service",
        package: { ecosystem: "npm", name: "semver", version: "5.7.1" },
      },
      {
        kind: "capability",
        check: "capabilities",
        tier: "disclosed",
        rule_id: "hook",
        severity: "UNKNOWN",
        description: "a .claude hook runs on PostToolUse",
        path: ".claude/settings.json",
      },
      // Never public (§4.4), and here to prove it: the producer runs `publicFindings()`
      // before it writes a manifest, so this row should never exist — and if a future
      // producer bug puts one here anyway, the page still must not print it.
      {
        kind: "secret",
        check: "secrets",
        tier: "blocking",
        rule_id: "anthropic-api-key",
        severity: "CRITICAL",
        description: "Anthropic API key",
        path: "src/leaked.py",
        line: 42,
      },
    ],
    capabilities: {
      tools: [{ name: "Bash", from: "SKILL.md" }, { name: "Read", from: "SKILL.md" }],
      runs: [{ path: "scripts/build.sh", kind: "script" }],
      hosts: [
        { host: "api.anthropic.com", local: false, from: "code", paths: ["src/humanize.py"] },
        { host: "shields.io", local: false, from: "docs", paths: ["README.md"] },
      ],
      env: [{ name: "ANTHROPIC_API_KEY", paths: ["src/humanize.py"] }],
      install_runs: false,
      summary: "2 tools, 1 host, 1 environment variable, nothing runs at install.",
    },
    counts: { blocking: 0, disclosed: 3, review: 0 },
    ...overrides,
  };
}

/** A v1 report, as `normalizeReport` lifts it: three rows ran, four say they did not. */
function scanV1Lifted() {
  const at = "2026-08-21T10:00:00.000Z";
  const row = (id: string, tool: string, ran: boolean) => ({
    id,
    tool,
    tool_version: "2026.08.2",
    status: ran ? "pass" : "unavailable",
    at,
    findings: 0,
    ...(ran ? {} : { reason: "predates scanner 2026.09" }),
  });
  return {
    verdict: "pass",
    scanner_version: "2026.08.2",
    at,
    checks: [
      row("secrets", "x402git/secrets", true),
      row("limits", "x402git/limits", true),
      { ...row("known_vulns", "osv.dev", true), packages: 12 },
      row("known_malware", "osv.dev/MAL", false),
      row("dep_behaviour", "socket.dev", false),
      row("capabilities", "x402git/caps", false),
      row("injection", "x402git/inject", false),
    ],
    findings: [],
    counts: { blocking: 0, disclosed: 0, review: 0 },
  };
}

function seed(options: { retired?: boolean; description?: string; updatePrice?: string; releases?: number; computed?: Record<string, unknown> } = {}) {
  mock.seed("creator", [
    { id: CREATOR_ID, handle: "adrian", payout_address: "0x0000000000000000000000000000000000000001", terms_version: "2026-08-29" },
  ]);
  mock.seed("listing", [
    {
      id: LISTING_ID,
      creator_id: CREATOR_ID,
      slug: "humanizer",
      source: "github",
      price_micro: "9000000",
      update_price_micro: options.updatePrice ?? "5000000",
      description: options.description ?? "Rewrites machine prose into something a person would have written.",
      trigger_hint: "When a draft reads like a model wrote it.",
      licence_spdx: "MIT",
      licence_verdict: "pass",
      published_at: "2026-08-21T00:00:00.000Z",
      retired_at: options.retired ? "2026-08-25T00:00:00.000Z" : null,
    },
  ]);
  // Older releases, newest first after the head below. They exist only to give the
  // "N earlier releases" disclosure something to fold.
  const older = Array.from({ length: Math.max(0, (options.releases ?? 1) - 1) }, (_, i) => ({
    id: `4444444${i}-4444-4444-8444-44444444444${i}`,
    listing_id: LISTING_ID,
    version: `1.${1 - i}.0`,
    git_ref: `refs/tags/v1.${1 - i}.0`,
    commit_sha: "c".repeat(40),
    artifact_sha256: "d".repeat(64),
    scan: "pass",
    manifest: { computed: computed(options.computed) },
    changelog: "Earlier work.",
    diff_summary: null,
    price_micro_at_publish: "9000000",
    update_price_micro_at_publish: "5000000",
    created_at: `2026-08-${String(10 - i).padStart(2, "0")}T00:00:00.000Z`,
  }));

  mock.seed("release", [
    {
      id: "33333333-3333-4333-8333-333333333333",
      listing_id: LISTING_ID,
      version: "1.2.0",
      git_ref: "refs/tags/v1.2.0",
      commit_sha: "a".repeat(40),
      artifact_sha256: "b".repeat(64),
      size_bytes: "1024",
      scan: "pass",
      manifest: { computed: computed(options.computed) },
      changelog: "Faster tokeniser.",
      diff_summary: { files_added: 1, files_changed: 5, files_removed: 0, additions: 180, deletions: 30, components_touched: ["scripts"] },
      price_micro_at_publish: "9000000",
      update_price_micro_at_publish: "5000000",
      created_at: "2026-08-21T00:00:00.000Z",
    },
    ...older,
  ]);
}

/**
 * The Overview by default; `?view=agent` for the manifest. Both are awaited as server
 * components and rendered to static markup, so what is asserted is the bytes a `curl`
 * would receive with scripting off.
 */
async function html(options: { owner?: string; slug?: string; view?: "human" | "agent" } = {}): Promise<string> {
  const { owner = "adrian", slug = "humanizer", view } = options;
  const element = await ListingPage({
    params: Promise.resolve({ owner, slug }),
    searchParams: Promise.resolve(view ? { view } : {}),
  });
  return renderToStaticMarkup(element);
}

/** The agent view, which is where every computed block now lives. */
function agentHtml(): Promise<string> {
  return html({ view: "agent" });
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = "https://x402git.com";
  resetEnv();
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  profile.repo = null;
  profile.owner = null;
});

afterEach(() => {
  resetDb();
  delete process.env.NEXT_PUBLIC_APP_URL;
  resetEnv();
});

describe("the manifest page is complete in the server HTML (§14.1)", () => {
  it("names the repository as the title, the creator beneath it, and the version", async () => {
    seed();
    const markup = await html();
    // 2026-08-30: the owner/slug breadcrumb left the h1 — the repository's name alone
    // is the title, and the creator line under it carries the person.
    expect(markup).toContain("<h1>humanizer</h1>");
    expect(markup).toContain("@adrian");
    expect(markup).toContain("v1.2.0");
    // The agent reading still writes it as one string.
    expect(await agentHtml()).toContain("adrian/humanizer");
  });

  it("prints the computed facts as counted nouns, not bytes (FR-47, FR-48)", async () => {
    seed();
    const markup = await agentHtml();
    expect(markup).toContain("Harness");
    expect(markup).toContain("1 skill · 9 scripts · 3 test files");
    expect(markup).toContain("18 files");
    expect(markup).toContain("Python 68%");
  });

  it("prints the scan badge with its date and scanner version (FR-37)", async () => {
    seed();
    expect(await agentHtml()).toContain("scan passed 2026-08-21 · scanner 2026.08.2");
  });

  it("stamps every computed block with computed-at and analyzer version (FR-52)", async () => {
    seed();
    const markup = await agentHtml();
    const stamps = markup.split("computed 2026-08-28 16:20 UTC · analyzer 0.1.0").length - 1;
    // Facts, contents, dependencies.
    expect(stamps).toBeGreaterThanOrEqual(3);
  });

  it("badges the creator's own words as self_reported only in the agent reading (FR-51, amended)", async () => {
    seed();
    const markup = await html();
    expect(markup).toContain("Rewrites machine prose");
    // The human page carries no `self_reported` token and no small print about it
    // (2026-08-30, founder). The agent reading keeps the badge, so a machine can
    // still tell computed from claimed.
    expect(markup).not.toContain("self_reported");
    expect(markup).not.toContain("own words, unverified");
    const agent = await agentHtml();
    expect(agent).toContain('class="badge">self_reported');
    expect(agent).toContain("Not verified by this platform");
  });

  it("contradicts an all-clear claim inline (FR-53)", async () => {
    seed({ description: "A humanizer with no dependencies." });
    expect(await html()).toContain("claims no dependencies — 1 dependency found");
  });

  it("lists the file tree with sizes and paths", async () => {
    seed();
    const markup = await agentHtml();
    expect(markup).toContain("src/humanize.py");
    expect(markup).toContain("12.3 kB");
    expect(markup).toContain("18 files · 293 kB · computed 2026-08-28");
  });

  it("lists the dependencies and the release log", async () => {
    seed();
    const markup = await agentHtml();
    expect(markup).toContain("requests");
    expect(markup).toContain("Faster tokeniser.");
    expect(markup).toContain("6 files, 210 lines");
  });

  it("renders the README but strips the script the analyser let through", async () => {
    seed();
    const markup = await html();
    expect(markup).toContain("<h2>Install</h2>");
    expect(markup).not.toContain("alert(1)");
  });

  it("puts the order line last, with price, version and updates", async () => {
    seed();
    const markup = await agentHtml();
    expect(markup).toContain("GET v1.2.0 · $9 · new releases $5");
    expect(markup).toContain("https://x402git.com/api/r/adrian/humanizer");
    // Never bill blind: the price comes after the contents, not before.
    expect(markup.indexOf("GET v1.2.0")).toBeGreaterThan(markup.indexOf("src/humanize.py"));
  });

  it("says updates are included when the update price is zero (D1)", async () => {
    seed({ updatePrice: "0" });
    const markup = await agentHtml();
    expect(markup).toContain("new releases included");
    expect(markup).toContain("every later release is included, forever");
  });

  it("still renders a retired listing, marked no longer sold (FR-43)", async () => {
    seed({ retired: true });
    const markup = await agentHtml();
    expect(markup).toContain("No longer sold");
    expect(markup).toContain("src/humanize.py");
    expect(markup).not.toContain("GET v1.2.0 · $9");
  });

  it("switches between the two readings from the corner of the header (2026-08-30)", async () => {
    seed();
    // Both readings carry the same two links, server-rendered, with the current one
    // marked `aria-current` — so curl finds the other reading and a person can see
    // what their agent will read before handing it the endpoint.
    const human = await html();
    expect(human).toContain('<nav class="reading" aria-label="Reading">');
    expect(human).toContain('<a href="/adrian/humanizer" aria-current="page">Human</a>');
    // The link to the other reading also carries `data-track` for Vercel Web Analytics
    // (app/_components/analytics.tsx); the current reading's link does not.
    expect(human).toContain('<a href="/adrian/humanizer?view=agent" data-track="agent_reading_opened">Agent</a>');
    const agent = await agentHtml();
    expect(agent).toContain('<a href="/adrian/humanizer">Human</a>');
    expect(agent).toContain('<a href="/adrian/humanizer?view=agent" aria-current="page">Agent</a>');
    // The agent reading says what it is and points back at the product page.
    expect(agent).toContain("What an agent reads when it fetches this URL");
    expect(agent).toContain("Nothing here is a button");
  });

  it("shows the agent reading the real 402 it would be answered with, and never a buy button", async () => {
    seed();
    process.env.PLATFORM_RECEIVING_ADDRESS = "0x000000000000000000000000000000000000dEaD";
    resetEnv();
    try {
      const agent = await agentHtml();
      expect(agent).toContain("HTTP/1.1 402 Payment Required");
      expect(agent).toContain("&quot;x402Version&quot;: 2");
      expect(agent).toContain("&quot;amount&quot;: &quot;9000000&quot;");
      expect(agent).toContain("&quot;quote_id&quot;");
      expect(agent).not.toContain("<button");
    } finally {
      delete process.env.PLATFORM_RECEIVING_ADDRESS;
      resetEnv();
    }
  });

  it("omits the 402 sample rather than faking one when the deployment cannot quote", async () => {
    seed();
    // No PLATFORM_RECEIVING_ADDRESS in this test: `x402Config` throws, the block is gone,
    // and the rest of the Order section is unchanged.
    const agent = await agentHtml();
    expect(agent).not.toContain("HTTP/1.1 402");
    expect(agent).toContain("curl -si https://x402git.com/api/r/adrian/humanizer");
  });

  it("gives the page a title and a computed description, not the creator's blurb", async () => {
    seed();
    const metadata = await generateMetadata({ params: Promise.resolve({ owner: "adrian", slug: "humanizer" }) });
    expect(metadata.title).toBe("adrian/humanizer v1.2.0");
    expect(metadata.alternates?.canonical).toBe("/adrian/humanizer");
    expect(metadata.description).toContain("Harness");
    expect(metadata.description).toContain("MIT, resale permitted");
    expect(metadata.description).not.toContain("Rewrites machine prose");
  });
});

/**
 * The product page and the machine reading, in both directions.
 *
 * The failure this guards against is the one every "two views of one document" invites:
 * a reading that is a panel rather than a page, so that half of it only exists once
 * something has been clicked. Both of these are awaited cold, and every assertion is on
 * the bytes `curl` receives with scripting off.
 *
 * Since 2026-08-30 the product page is the GitHub-meets-Gumroad layout: the reference and
 * its facts, a buy box, the README, and the manifest folded into disclosures. Everything
 * that folded is still in the HTML — a `<details>` is closed, not absent — so the
 * assertions below are about *where* a fact is, not whether it survived.
 */
describe("the product page (default) and the machine reading (?view=agent)", () => {
  it("leads with the price, the updates line and one buy control", async () => {
    seed();
    const markup = await html();

    // The costs are itemised like an invoice: the download and future updates each
    // get a line with its own amount.
    expect(markup).toContain("Download v1.2.0");
    expect(markup).toContain("$9");
    expect(markup).toContain("Future updates");
    expect(markup).toContain("$5 each");
    expect(markup).toContain("only charged when you choose to update");
    expect(markup).toContain('class="buybox"');
    expect(markup).toContain("What you get");
    expect(markup).toContain(".zip");
    expect(markup).toContain("(1 kB)");
    // The check list is the five-second read ("PRD Trust Report.md" §5, amended
    // 14 Sep 2026 — it moved into this column and became seven rows). This seed's
    // manifest predates the report, so the rows say so and there is no report to link to.
    expect(markup).toContain("<dt>2026-08-21</dt><dd>scanned · scanner 2026.08.2</dd>");
    expect(markup).not.toContain("Show report");
    expect(markup).toContain("v1.2.0");
  });

  it("offers an agent prompt under the buy control — listing, skill and endpoint (2026-09-02)", async () => {
    seed();
    const markup = await html();

    // The prompt is a server-HTML fact — curl gets every line. The copy button
    // hydrates later, so no dead control is asserted here.
    expect(markup).toContain("Buy with your agent");
    expect(markup).toContain("Buy adrian/humanizer from X402 Git for me.");
    expect(markup).toContain("Listing: https://x402git.com/adrian/humanizer");
    expect(markup).toContain("How to pay: https://x402git.com/.well-known/agent-skills/buy-a-repo/SKILL.md");
    expect(markup).toContain("x402 endpoint: https://x402git.com/api/r/adrian/humanizer");
    expect(markup.indexOf("Buy with your agent")).toBeGreaterThan(markup.indexOf("buy-fallback"));

    // The agents the prompt is for sit between the heading and the prompt, each mark
    // named in the server HTML (2026-09-13) — the tooltip is CSS, not script.
    for (const name of ["Claude Code", "Cursor", "Codex CLI", "GitHub Copilot", "Gemini CLI", "OpenClaw", "Manus", "Grok"]) {
      expect(markup).toContain(`aria-label="${name}"`);
    }
    expect(markup).toContain('src="/logos/claude.svg"');
    expect(markup.indexOf("Buy with your agent")).toBeLessThan(markup.indexOf('src="/logos/claude.svg"'));
    expect(markup.indexOf('src="/logos/grok.svg"')).toBeLessThan(markup.indexOf("Buy adrian/humanizer from X402 Git for me."));

    // A retired listing sells nothing, so it hands nothing to an agent either.
    seed({ retired: true });
    expect(await html()).not.toContain("Buy with your agent");
  });

  it("keeps the buyer's checks with the price, in the buy column (2026-08-30)", async () => {
    seed();
    const markup = await html();

    // The header meta row is gone; licence, class, updated and the scan's own check
    // list live under the box — same column as the price, before the page body in the
    // document on every viewport.
    expect(markup).toContain("<dt>2026-08-21</dt><dd>scanned · scanner 2026.08.2</dd>");
    expect(markup).toContain("<dt>Licence</dt><dd>MIT</dd>");
    expect(markup).toContain("<dt>Class</dt><dd>Harness</dd>");
    expect(markup).toContain("<dt>Updated</dt><dd>2026-08-21</dd>");
    expect(markup.indexOf('class="trust-brief"')).toBeLessThan(markup.indexOf('class="listing-body"'));
    expect(markup).not.toContain('class="facts meta"');
  });

  it("previews the README below the buy box, with the whole document still in the HTML", async () => {
    seed();
    const markup = await html();

    // Rendered, not hidden: the first screenful is real markup, clipped in CSS, and the
    // rest is one control away. Nothing is behind a click that `curl` cannot read.
    expect(markup).toContain("README</h2>");
    expect(markup).toContain("<h2>Install</h2>");
    expect(markup).toContain("data-readme-clip");
    expect(markup).toContain("Show more");
    expect(markup).not.toContain("alert(1)");

    // Never bill blind, in the other direction: the box is above the README in the
    // document, so it is above it on a phone and beside it on a desktop.
    expect(markup.indexOf('class="buybox"')).toBeLessThan(markup.indexOf("README</h2>"));
  });

  it("leaves the README readable with no script at all", async () => {
    seed();
    const markup = await html();

    // The clip and the control are gated on `<html data-js="on">`, which only the
    // inline script sets. With scripting off the README is simply the README.
    expect(markup).toContain('<div id="readme-body"');
    expect(markup).toContain('aria-controls="readme-body"');
    expect(markup).toContain('aria-expanded="false"');
  });

  it("gives the latest release its own line and folds the older ones away", async () => {
    seed({ releases: 3 });
    const markup = await html();

    // Under the README in its own frame, the count on the heading, three shown in
    // full. Three releases is under the fold, so there is no Show more.
    expect(markup).toContain('<h2>Releases<span class="count"> 3</span></h2>');
    expect(markup).toContain('<span class="version">v1.2.0</span><span class="date">2026-08-21</span>');
    expect(markup).toContain("Faster tokeniser.");
    expect(markup).not.toContain("Show more</span>");
    expect(markup.indexOf('class="releases"')).toBeGreaterThan(markup.indexOf("README</h2>"));
    // The diff column belongs to the machine reading.
    expect(markup).not.toContain("6 files, 210 lines");
  });

  it("shows three releases and folds the rest behind Show more", async () => {
    seed({ releases: 5 });
    const markup = await html();

    expect(markup).toContain('<span class="count"> 5</span>');
    expect(markup).toContain('<span class="when-closed">Show more</span>');
    // The fourth release is in the HTML, inside the fold, after the third.
    const fold = markup.indexOf('<details class="more">');
    expect(fold).toBeGreaterThan(-1);
    const versions = [...markup.matchAll(/<span class="version">/g)].map((m) => m.index ?? 0);
    expect(versions).toHaveLength(5);
    expect(versions[2]).toBeLessThan(fold);
    expect(versions[3]).toBeGreaterThan(fold);
  });

  it("puts the file tree under Contents → Files, a tab after Folders, above the README", async () => {
    seed();
    const markup = await html();

    expect(markup).toContain('class="inside" aria-label="Contents"');
    // Three views of one inventory, as radio tabs: every panel is in the HTML.
    expect(markup).toContain('name="inside-tab" checked="" value="folders"');
    expect(markup).toContain('name="inside-tab" value="files"');
    expect(markup).toContain('data-tab="folders"');
    expect(markup).toContain('data-tab="files"');
    // The files follow the folders, and the computed contents lead the body.
    expect(markup.indexOf("src/humanize.py")).toBeGreaterThan(markup.indexOf('data-tab="files"'));
    expect(markup.indexOf('data-tab="folders"')).toBeLessThan(markup.indexOf('data-tab="files"'));
    expect(markup.indexOf('data-tab="files"')).toBeLessThan(markup.indexOf("README</h2>"));
    // The clip belongs to the README alone now.
    expect(markup).not.toContain("Full file list");
    expect(markup).not.toContain('aria-controls="inside-body"');
  });

  it("summarises the shape of the repository without opening anything", async () => {
    seed();
    const markup = await html();

    // The counts are rows in the details list beside the price, not a line of prose.
    expect(markup).toContain("<dt>Files</dt><dd>18</dd>");
    expect(markup).toContain("<dt>Folders</dt><dd>1</dd>");
    expect(markup).toContain("<dt>Dependencies</dt><dd>1</dd>");
    expect(markup).not.toContain('class="facts inside-caption"');
    expect(markup).toContain("Python 68%");
    expect(markup).toContain("Top level");
    expect(markup).toContain("src/");
  });

  it("keeps stamps and hashes out of the default reading's flow", async () => {
    seed();
    const markup = await html();

    // The analyser stamp travels with the block it stamps (FR-52) — which is now a
    // disclosure, so it is below the summary rather than under the title.
    expect(markup.indexOf("analyzer 0.1.0")).toBeGreaterThan(markup.indexOf('class="inside"'));
    expect(markup).not.toContain("b".repeat(64));
    // The scanner version sits in one place only: the scanned line of the buy column's
    // log, the page's one scan stamp (DESIGN.md, Don'ts, amended 14 Sep 2026).
    expect(markup.split("scanner 2026.08.2").length - 1).toBe(1);
    expect(markup).toContain("<dd>scanned · scanner 2026.08.2</dd>");
  });

  it("says how to pay when there is no JavaScript, without a curl block", async () => {
    seed();
    const markup = await html();

    expect(markup).toContain("Turn on JavaScript");
    expect(markup).toContain('href="/docs"');
    expect(markup).not.toContain("curl -si");
    expect(markup).not.toContain("PAYMENT-SIGNATURE");
  });

  it("links Your purchases from the box, so a buyer knows where it went", async () => {
    seed();
    expect(await html()).toContain('href="/purchases"');
  });

  it("puts the whole manifest on ?view=agent, tree and stamps and curl and all", async () => {
    seed();
    const markup = await agentHtml();

    expect(markup).toContain("src/humanize.py");
    expect(markup).toContain("computed 2026-08-28 16:20 UTC · analyzer 0.1.0");
    expect(markup).toContain("requests");
    expect(markup).toContain("6 files, 210 lines");
    expect(markup).toContain("GET v1.2.0 · $9 · new releases $5");
    expect(markup).toContain("curl -si https://x402git.com/api/r/adrian/humanizer");
    expect(markup).toContain("b".repeat(64));
  });

  it("treats an unknown ?view= as the product page rather than a 404", async () => {
    seed();
    const markup = await html({ view: "nonsense" as "human" });
    expect(markup).toContain('class="buybox"');
    expect(markup).not.toContain("GET v1.2.0 · $9");
  });
});

/**
 * The Creator strip, compact.
 *
 * Amended 2026-08-30, same day it was added: the product page now shows the person
 * only — the word "Creator", the avatar and the name, linking to the author page. The
 * counts, bio, site and socials moved to the author page (see its test file). So this
 * suite asserts the compact rendering and, load-bearingly, the *absence* of the
 * metadata that used to be here.
 */
describe("the person behind the repository", () => {
  it("no longer prints an About block — the README is the repository's own pitch", async () => {
    seed();
    profile.repo = {
      full_name: "adrian/humanizer",
      description: "Rewrites machine prose, offline.",
      homepage: "https://humanizer.dev/",
      topics: ["llm", "writing"],
      stars: 412,
      private: false,
      html_url: "https://github.com/adrian/humanizer",
    };

    const markup = await html();
    expect(markup).not.toContain("<h2>About</h2>");
    expect(markup).not.toContain("Rewrites machine prose, offline.");
  });

  it("renders the creator card from a GitHub profile, under the box", async () => {
    seed();
    profile.owner = {
      login: "adrian",
      name: "Adrian Vance",
      avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
      bio: "Building tools for people who write.",
      blog: "https://adrian.dev/",
      company: "@somewhere",
      location: "Lisbon",
      twitter_username: "adrianvance",
      followers: 1_240,
      public_repos: 42,
      created_at: "2016-02-11T00:00:00Z",
      html_url: "https://github.com/adrian",
    };

    const markup = await html();

    // The person's name, linking to their page here; the handle is on that page.
    expect(markup).toContain("Adrian Vance");
    expect(markup).not.toContain("@adrian");
    expect(markup).toContain('<a href="/adrian"');
    // The avatar is decorative — the name is beside it in text.
    expect(markup).toContain('alt=""');
    // The metadata lives on the author page now, not here.
    expect(markup).not.toContain("Building tools for people who write.");
    expect(markup).not.toContain("adrian.dev");
    expect(markup).not.toContain("@somewhere · Lisbon");
    expect(markup).not.toContain("42 public repos");
    expect(markup).not.toContain("1,240 followers");
    expect(markup).not.toContain("on GitHub since 2016");
    expect(markup).not.toContain('href="https://x.com/adrianvance"');
    expect(markup).not.toContain('href="https://github.com/adrian"');
    // The person still comes before the offer, and there is exactly one of them.
    expect(markup.indexOf('class="creator-strip')).toBeLessThan(markup.indexOf('class="buybox"'));
    expect(markup.split('class="creator-strip').length - 1).toBe(1);
  });

  it("prints the name, not the handle, when GitHub knows the person", async () => {
    seed();
    profile.owner = { login: "adrian", name: "Adrian Vance", avatar_url: "https://avatars.githubusercontent.com/u/1" };

    const markup = await html();

    expect(markup).toContain('<span class="written name">Adrian Vance</span>');
    expect(markup).not.toContain('class="computed login"');
    // No label above the line either: an avatar beside a name under the title is enough.
    expect(markup).not.toContain('class="kicker"');
  });

  it("shows no counts here even when GitHub has them — they belong to the author page", async () => {
    seed();
    profile.owner = { login: "adrian", name: "Adrian Vance", public_repos: 42 };
    profile.stats = { repos: 42, stars: 1_204, truncated: false };

    const markup = await html();

    expect(markup).not.toContain("1,204");
    expect(markup).not.toContain("stars across their public repositories");
    expect(markup).not.toContain("public repos");
    profile.stats = null;
  });

  it("falls back to the handle when there is no GitHub person (Rail B, or a failed call)", async () => {
    seed();
    const markup = await html();

    expect(markup).toContain('<span class="computed login">@adrian</span>');
    // Nothing invented: no avatar, no name, no counts.
    expect(markup).not.toContain("avatars.githubusercontent.com");
    expect(markup).not.toContain("followers");
    expect(markup).not.toContain("on GitHub since");
  });

  it("prints no zeroes and no empty rows when GitHub knows almost nothing", async () => {
    seed();
    profile.repo = { full_name: "adrian/humanizer", topics: [], stars: null, forks: null, open_issues: null, private: true };
    profile.owner = { login: "adrian", followers: null, public_repos: null };

    const markup = await html();

    expect(markup).not.toContain("0 stars");
    expect(markup).not.toContain("0 followers");
    expect(markup).not.toContain("—</p>");
    expect(markup).toContain("@adrian");
  });
});

/**
 * "PRD Trust Report.md" §5, accepted 13 Sep 2026 — the badge became a section.
 *
 * The failure these guard against is the one Battle Test §6.3a names: a green tick with
 * nothing behind it, an empty "Permissions required" accordion, and "Safe to install"
 * printed over a scan that checked two things. Every assertion here is about what is in
 * the server HTML, because that is what an agent reads and what `curl` receives.
 */
describe("the trust report on the listing page (PRD Trust Report §5)", () => {
  it("stamps the scan once, in the buy column, not again in the section", async () => {
    seed({ computed: { scan: scanV2() } });
    const markup = await html();
    // Founder, 14 Sep 2026: "we only need to show this once".
    expect(markup).not.toContain('class="facts trust-stamp"');
    expect(markup.split("scanner 2026.09.1").length - 1).toBe(1);
    // And the check list in the buy column becomes the way in, rather than a dead anchor
    // — one that opens the report as it goes (14 Sep 2026, founder).
    expect(markup).toContain('<a href="#trust" data-readme-open="trust-body">Show report</a>');
  });

  it("reads as reference under the README, not as the last word before the pitch (14 Sep 2026)", async () => {
    seed({ computed: { scan: scanV2() } });
    const markup = await html();
    // It sat above the README until the buy column took over the five-second read.
    expect(markup.indexOf('class="readme"')).toBeLessThan(markup.indexOf('id="trust"'));
    expect(markup.indexOf('id="trust"')).toBeLessThan(markup.indexOf('class="releases"'));
    // Still a section and not a `<details>`: an anchor cannot open a disclosure without
    // script, and the link in the column above is the only way most readers arrive.
    expect(markup).toContain('<section class="trust-report" id="trust" aria-label="Security scan report">');
    expect(markup).toContain("<h2>Security scan report</h2>");
  });

  it("prints one row per check, in order, with a phrase in words beside each", async () => {
    seed({ computed: { scan: scanV2() } });
    const markup = await html();

    for (const label of ["secrets", "size limits", "known malware", "known vulnerabilities", "dependency behaviour", "instruction smuggling", "what it can do"]) {
      expect(markup).toContain(label);
    }
    // The rows read in the order the section declares, not the report's.
    expect(markup.indexOf("size limits")).toBeLessThan(markup.indexOf("known malware"));
    expect(markup.indexOf("known malware")).toBeLessThan(markup.indexOf("dependency behaviour"));

    // A clean check says what it ruled out; a scoped one says how far it looked.
    expect(markup).toContain("none found");
    expect(markup).toContain("within caps");
    expect(markup).toContain("none in 63 packages");
    // Worst first, and a severity with no findings is not printed as a nought.
    expect(markup).toContain("1 moderate, 1 low in 41 packages — see below");
    // A gap is a row that says so, never a missing row and never a tick.
    expect(markup).toContain("not yet checked, retrying (socket quota)");
  });

  it("opens with who scanned it and how each of them came out (14 Sep 2026)", async () => {
    seed({ computed: { scan: scanV2() } });
    const markup = await html();

    // The confidence line the founder asked for, and the clause that keeps it from being
    // a shield: the pass and the findings it did not prevent, in one breath.
    expect(markup).toContain("Scanned by X402 Git and ");
    expect(markup).toContain(" — passed on both.");
    expect(markup).toContain("Findings from both are listed below.");
    // Socket was over quota on this seed, and a vendor that did not answer is never
    // counted into the pass.
    expect(markup).toContain(" has not answered yet.");
  });

  it("links the vendors on first mention, and only there (14 Sep 2026)", async () => {
    seed({ computed: { scan: scanV2() } });
    const markup = await html();

    // A new window, and the accessible name says so — the site's own convention for a
    // link that leaves the page a reader is deciding on.
    expect(markup).toContain(
      '<a href="https://osv.dev" target="_blank" rel="noopener noreferrer">OSV<span class="sr-only"> (opens in a new tab)</span></a>',
    );
    expect(markup).toContain(
      '<a href="https://socket.dev" target="_blank" rel="noopener noreferrer">Socket<span class="sr-only"> (opens in a new tab)</span></a>',
    );
    // Once each. "Socket has not answered yet" two sentences later is a second mention
    // of a name already linked, and the source column on the rows is plain text — seven
    // rows of the same two links would read as navigation, not as a column of facts.
    expect(markup.split('href="https://osv.dev"').length - 1).toBe(1);
    expect(markup.split('href="https://socket.dev"').length - 1).toBe(1);
    expect(markup).toContain('<dd class="by">Socket</dd>');
    expect(markup).toContain('<dd class="by">OSV</dd>');
    // We are not a link to ourselves.
    expect(markup).not.toContain('>X402 Git<span class="sr-only"');
  });

  it("names the source beside every check row, not only in the manifest", async () => {
    seed({ computed: { scan: scanV2() } });
    const markup = await html();

    expect(markup).toContain('<dd class="by">X402 Git</dd>');
    expect(markup).toContain('<dd class="by">OSV</dd>');
    expect(markup).toContain('<dd class="by">Socket</dd>');
    // The row's own phrase still leads; the source is the last cell, not the first.
    expect(markup.indexOf("none in 63 packages")).toBeLessThan(markup.indexOf('<dd class="by">OSV</dd>'));
  });

  /**
   * The report is clipped the way the README is — 14 Sep 2026, founder: *"can the trust
   * report have a Read more just like the README does? When a user clicks Show report on
   * the right panel, can this also expand the trust report on the main page as well?"*
   *
   * The invariant these hold is the one the whole page rests on: the clip is CSS the
   * section only wears once script has said so, so `curl` gets the whole report either
   * way. Everything here is asserted on the server HTML, which is the proof of that.
   */
  it("clips the report behind the same control the README uses, with the whole of it still in the HTML", async () => {
    seed({ computed: { scan: scanV2() } });
    const markup = await html();

    expect(markup).toContain('<div id="trust-body" class="trust-body" data-readme-clip="true">');
    expect(markup).toContain('data-readme-toggle="true" aria-expanded="false" aria-controls="trust-body"');
    // The verdict is the section's answer and is outside the clip; the rows are the
    // preview, and the inventory and the findings are what folds.
    expect(markup.indexOf(" — passed on both.")).toBeLessThan(markup.indexOf('id="trust-body"'));
    expect(markup.indexOf('id="trust-body"')).toBeLessThan(markup.indexOf("known vulnerabilities"));
    // Clipped is not hidden: every phrase, the inventory and the findings are all here.
    expect(markup).toContain("1 moderate, 1 low in 41 packages — see below");
    expect(markup).toContain("What this can do");
    expect(markup).toContain("Findings (3)");
  });

  it("emits the clip script exactly once, after the last thing it clips", async () => {
    seed({ computed: { scan: scanV2() } });
    const markup = await html();

    // Two listeners would toggle twice per press and visibly do nothing (readme-more.tsx).
    // The README's control and the report's, and no third — the count is of rendered
    // buttons, not of the word, which the script itself says three times.
    expect(markup.split('data-readme-toggle="true"').length - 1).toBe(2);
    // `dataset.js="on"` is not the fingerprint — the pinned price bar sets it too. The
    // listener is.
    expect(markup.split("fit();addEventListener").length - 1).toBe(1);
    // The report moved below the README on 14 Sep, so "after the last clipped section"
    // means after the report now.
    expect(markup.indexOf('id="trust-body"')).toBeLessThan(markup.indexOf("fit();addEventListener"));
  });

  /**
   * 14 Sep 2026, on `example-seller/example-listing`, whose README fits its own
   * preview: `fit()` had set `hidden` on the control's wrapper, correctly, and the button
   * was on the page anyway. `[data-js="on"] .readme-more{display:block}` is one attribute
   * and one class; the user agent's `[hidden]{display:none}` is one attribute, so the
   * author rule won and a "Show more" sat under a README with nothing left to show.
   *
   * The fix is one line of base CSS, and this is the test that keeps it: it is about the
   * stylesheet rather than the markup because the markup was right all along, which is
   * exactly why nothing caught it. Every element this product hides with the attribute —
   * the README's control, the trust report's, any future one — goes through that line.
   */
  it("lets the hidden attribute beat the class that shows the control", async () => {
    const css = await readFile(new URL("../../globals.css", import.meta.url), "utf8");
    expect(css).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);

    // And nothing may re-open that door. Source order cannot: `!important` wins from
    // anywhere. The one thing that could is a second `!important` on the rule that shows
    // the control, so that is what is forbidden here.
    const shows = [...css.matchAll(/[^{}]*\.readme-more[^{}]*\{[^}]*\}/g)].filter((m) => /display:/.test(m[0]));
    expect(shows.length).toBeGreaterThan(0);
    for (const rule of shows) expect(rule[0]).not.toMatch(/display:[^;]*!important/);
  });

  it("hands the buy column's link the id of the block it opens", async () => {
    seed({ computed: { scan: scanV2() } });
    const markup = await html();

    // The link is an anchor first — with scripting off it lands on a section that was
    // never clipped — and `data-readme-open` is what the delegated listener reads.
    expect(markup).toContain('<a href="#trust" data-readme-open="trust-body">Show report</a>');
    expect(markup.indexOf("data-readme-open")).toBeLessThan(markup.indexOf('id="trust-body"'));
    // It names the block the toggle controls, and one id is spelled once.
    const id = /data-readme-open="([^"]+)"/.exec(markup)?.[1];
    expect(markup).toContain(`aria-controls="${id}"`);
  });

  it("never prints a score, a shield or the words Safe to install", async () => {
    seed({ computed: { scan: scanV2() } });
    const markup = await html();
    expect(markup).not.toContain("Safe to install");
    expect(markup).not.toContain("Verified clean");
    expect(markup).not.toContain("/ 100");
  });

  it("prints the capability inventory, with documentation links kept apart from hosts", async () => {
    seed({ computed: { scan: scanV2() } });
    const markup = await html();

    expect(markup).toContain("What this can do");
    expect(markup).toContain("scripts/build.sh");
    expect(markup).toContain("ANTHROPIC_API_KEY");
    expect(markup).toContain("nothing runs");
    // A badge host in a README is not a network call the artifact makes (§4.3).
    expect(markup).toContain("Links to");
    expect(markup.indexOf("shields.io")).toBeGreaterThan(markup.indexOf("Links to"));
  });

  it("puts every host, path and variable on its own line (14 Sep 2026)", async () => {
    seed({
      computed: {
        scan: scanV2({
          capabilities: {
            tools: [{ name: "Bash", from: "SKILL.md" }, { name: "Read", from: "SKILL.md" }],
            runs: [{ path: "scripts/build.sh", kind: "script" }],
            hosts: [
              { host: "api.anthropic.com", local: false, from: "code", paths: ["a.py"] },
              { host: "fonts.googleapis.com", local: false, from: "code", paths: ["a.py"] },
              { host: "localhost:3000", local: true, from: "code", paths: ["a.py"] },
            ],
            env: [{ name: "ANTHROPIC_API_KEY", paths: ["a.py"] }],
            install_runs: false,
            summary: "…",
          },
        }),
      },
    });
    const markup = await html();

    // Three hosts, three elements — a real list, so `curl` and a screen reader get
    // "list of 3 items" rather than a run-on sentence with dots in it.
    expect(markup).toContain(
      '<ul class="capability-values"><li>api.anthropic.com</li><li>fonts.googleapis.com</li><li>localhost:3000 (local)</li></ul>',
    );
    expect(markup).toContain('<ul class="capability-values"><li>Bash</li><li>Read</li></ul>');
    expect(markup).not.toContain("api.anthropic.com · fonts.googleapis.com");
    // A line that is one value stays one value rather than becoming a list of one.
    expect(markup).toContain("<dd>scripts/build.sh</dd>");
    expect(markup).toContain("<dd>nothing runs</dd>");
  });

  it("says the empty inventory in words rather than showing five blank rows (§4.3)", async () => {
    seed({
      computed: {
        scan: scanV2({
          capabilities: {
            tools: [],
            runs: [],
            hosts: [],
            env: [],
            install_runs: false,
            summary: "No tools, no hosts, no environment variables, nothing runs at install.",
          },
        }),
      },
    });
    const markup = await html();
    expect(markup).toContain("No tools, no hosts, no environment variables, nothing runs at install.");
    expect(markup).not.toContain("no environment variables</dd>");
  });

  it("folds the findings, severity word first, and never prints a secret that is in the report", async () => {
    seed({ computed: { scan: scanV2() } });
    const markup = await html();

    // `<details>` is a fold, not a fetch: every finding is in the HTML `curl` receives.
    expect(markup).toContain("<details class=\"findings\">");
    expect(markup).toContain("MODERATE");
    expect(markup).toContain("lodash 4.17.20 — prototype pollution in zipObjectDeep GHSA-1234-5678-90ab");
    expect(markup).toContain("semver 5.7.1 — regular expression denial of service");

    // §4.4, the absolute: a secret never reaches a page that is not the creator's, not
    // even when the stored report hands one over. The count in the summary excludes it.
    expect(markup).not.toContain("src/leaked.py");
    expect(markup).not.toContain("anthropic-api-key");
    expect(markup).toContain("Findings (3)");
  });

  /**
   * §4.4, amended 14 Sep 2026 — the fold, on the page that made the case for it.
   *
   * The first Socket backfill put 1,209 `dep_behaviour` findings on
   * `pcmarts/acl-recovery-tracker` and every one of them was published: 844 KB of HTML,
   * 418 of those lines identical. `publishedFindings` folds the transitives before the
   * manifest is written, so what this asserts is the page consuming the manifest as it
   * finds it — one line for the 300, and the direct dependency still named.
   */
  it("prints a folded transitive row once, not three hundred times", async () => {
    const behaviour = (name: string, version: string, direct: boolean): ScanFinding => ({
      kind: "behaviour",
      check: "dep_behaviour",
      tier: "disclosed",
      public: true,
      rule_id: "networkAccess",
      severity: "UNKNOWN",
      description: `${name} ${version} (${direct ? "direct" : "transitive"}) — network access`,
      blocking: false,
      package: { ecosystem: "npm", name, version, direct, dev: false },
      source: "socket.dev",
    });
    // The real 301, as Socket maps them, put through the producer the writers use.
    const findings = [
      behaviour("esbuild", "0.21.5", true),
      ...Array.from({ length: 300 }, (_, i) => behaviour(`transitive-${i}`, `1.0.${i}`, false)),
    ];
    const published = publishedFindings({ findings } as unknown as Parameters<typeof publishedFindings>[0]);

    seed({
      computed: {
        scan: scanV2({
          checks: [{ id: "dep_behaviour", tool: "socket.dev", tool_version: "2026-09-14", status: "findings", at: "2026-08-21T10:00:00.000Z", findings: 301, packages: 545 }],
          findings: published,
          counts: { blocking: 0, disclosed: 301, review: 0 },
        }),
      },
    });
    const markup = await html();

    // One line for the three hundred, with a sample a reader can go and check.
    expect(markup).toContain("networkAccess — 300 transitive packages, e.g. transitive-0@1.0.0, transitive-1@1.0.1, transitive-2@1.0.2");
    expect(markup.split("networkAccess —").length - 1).toBe(1);
    // The direct dependency keeps its own line — that is the one a buyer can act on.
    expect(markup).toContain("esbuild 0.21.5 — esbuild 0.21.5 (direct) — network access");
    expect(markup).toContain("Findings (2)");
    // The check row reads from the counts: the direct half first, the rest as a number.
    expect(markup).toContain("1 direct package declares network access · 300 more in transitive packages");
    // And the other 297 are in neither the markup nor the bytes `curl` is charged for.
    expect(markup).not.toContain("transitive-299");
    expect(markup.length).toBeLessThan(200_000);
  });

  it("never publishes the vendor scan id, whatever the stored report carries (§4.2)", async () => {
    seed({ computed: { scan: scanV2() } });
    expect(await html()).not.toContain("sock_secret_id");
    expect(await agentHtml()).not.toContain("sock_secret_id");
  });

  it("renders a v1-era report as the rows it never ran, rather than as ticks", async () => {
    seed({ computed: { scan: scanV1Lifted() } });
    const markup = await html();

    expect(markup).toContain("<dt>2026-08-21</dt><dd>scanned · scanner 2026.08.2</dd>");
    expect(markup).not.toContain("advisories refreshed");
    // Three checks ran and four did not, and the four say which scanner era they are from.
    expect(markup).toContain("none in 12 packages");
    expect(markup).toContain("not checked by this scanner version");
    // No inventory was computed, so no claim is made about one.
    expect(markup).not.toContain("What this can do");
  });

  it("shows nothing at all for a manifest cut before the report existed", async () => {
    seed();
    const markup = await html();
    // The check list still stands in the buy column, saying what was never recorded;
    // the section itself is absent rather than empty, and so is the link to it.
    expect(markup).toContain("<dt>2026-08-21</dt><dd>scanned · scanner 2026.08.2</dd>");
    expect(markup).not.toContain('id="trust"');
    expect(markup).not.toContain("Show report");
  });

  it("gives the agent reading the same section, from the same component (§5)", async () => {
    seed({ computed: { scan: scanV2() } });
    const markup = await agentHtml();
    expect(markup).toContain("known vulnerabilities");
    expect(markup).toContain("What this can do");
    expect(markup).not.toContain("src/leaked.py");
  });
});

/**
 * Trust in the buy column — §5, amended 14 Sep 2026 on the founder's direction that it
 * "actually be part of the right-hand panel", "a lot more compact", and that it "signal
 * these various scans it's had … e.g. whether it was scanned with Socket or not".
 *
 * The failure these guard against is the one the founder was pointing at: a listing page
 * that says a scan happened and never says what a scan is. A buyer who reads only this
 * column must be able to see all seven checks, which vendor ran each of them, and which
 * of them did not run at all.
 */
describe("the trust checklist in the buy column (§5, amended 14 Sep 2026)", () => {
  /** The buy column, alone: everything before the body, which is where the report is. */
  function aside(markup: string): string {
    return markup.slice(markup.indexOf('class="buybox"'), markup.indexOf('class="listing-body"'));
  }

  /** The Trust block alone — the agent prompt above it says "X402 Git" in a sentence. */
  function brief(markup: string): string {
    const from = markup.indexOf('class="trust-brief"');
    return markup.slice(from, markup.indexOf("</section>", from));
  }

  it("puts seven rows in the column, each with its mark and its name and nothing else", async () => {
    seed({ computed: { scan: scanV2() } });
    const column = aside(await html());

    expect(column).toContain('<section class="trust-brief" aria-label="Security scan"><h2>Security scan</h2>');
    for (const name of ["Secrets", "Size limits", "Malware", "Vulnerabilities", "Dependencies", "Injection", "Capabilities"]) {
      expect(column).toContain(`</span>${name}</dt>`);
    }
    // "Trust" was the heading for a day; the section is named after what we ran rather
    // than after what the reader is meant to conclude from it (14 Sep 2026, founder).
    expect(column).not.toContain("<h2>Trust</h2>");
    // The vendor is not beside the price ("we don't need to know what scanned it"); it is
    // in the report, on the row it produced, and the test below this block proves it.
    for (const vendor of ["Socket", "OSV", "X402 Git"]) {
      expect(brief(column)).not.toContain(vendor);
    }
    // Four marks, three meanings and a gap. The mark is decorative on every one of them.
    expect(column).toContain('<span class="mark" aria-hidden="true">✓</span>');
    expect(column).toContain('<span class="mark" aria-hidden="true">·</span>');
    expect(column).toContain('<span class="mark" aria-hidden="true">–</span>');
    expect(column).toContain('data-status="pass"');
    expect(column).toContain('data-status="warn"');
    expect(column).toContain('data-status="pending"');
  });

  it("says every verdict in words as well as in ink, and carries the short phrase where one fits", async () => {
    seed({ computed: { scan: scanV2() } });
    const column = aside(await html());

    // DESIGN.md: colour never carries the meaning alone, and neither does a glyph. The
    // full phrase is beside every mark for a screen reader and for `curl`.
    expect(column).toContain('<span class="sr-only">none found</span>');
    expect(column).toContain('<span class="sr-only">none in 63 packages</span>');
    expect(column).toContain('<span class="sr-only">not yet checked, retrying (socket quota)</span>');
    // …and the eye gets the abbreviation of it, where the column has room for one.
    expect(column).toContain('<span class="short" aria-hidden="true">1 moderate, 1 low</span>');
    // A clean row says nothing: the tick is the phrase, and seven rows reading "none
    // found" is the wall of reassurance the report exists to replace.
    expect(column).not.toContain('<span class="short" aria-hidden="true">none found</span>');
  });

  it("stamps the column with both dates, newest first, the version on the scan, then links the report", async () => {
    seed({ computed: { scan: scanV2() } });
    const column = aside(await html());

    // A log: one line per event, the date first, the newest on top (founder, 14 Sep 2026).
    const refreshed = "<dt>2026-09-12</dt><dd>advisories refreshed</dd>";
    const scanned = "<dt>2026-08-21</dt><dd>scanned · scanner 2026.09.1</dd>";
    expect(column).toContain(refreshed);
    expect(column).toContain(scanned);
    expect(column.indexOf(refreshed)).toBeLessThan(column.indexOf(scanned));
    expect(column).toContain('<a href="#trust" data-readme-open="trust-body">Show report</a>');
  });

  it("still names every scan on a listing cut before the report existed, and ticks none of them", async () => {
    // A v1-era manifest: a verdict, a date, and no `checks` at all. "Which scans has this
    // had" still has an answer for that buyer, and the answer is none of them.
    seed();
    const column = aside(await html());

    expect(column).toContain('class="trust-brief"');
    for (const name of ["Secrets", "Size limits", "Malware", "Vulnerabilities", "Dependencies", "Injection", "Capabilities"]) {
      expect(column).toContain(`</span>${name}</dt>`);
    }
    // Seven dashes and no ticks: the manifest records nothing, so the page claims nothing.
    expect(column.split('<span class="mark" aria-hidden="true">–</span>').length - 1).toBe(7);
    expect(column).not.toContain('<span class="mark" aria-hidden="true">✓</span>');
    expect(column).toContain('<span class="sr-only">not recorded by this scanner version</span>');
    expect(column).toContain('data-ran="no"');
  });

  it("keeps a dependency check that found no manifests to check as a tick, not a gap", async () => {
    // `example-seller/another-listing`, in the shape the rescan writes it: a
    // `pass` with `packages: 0`. Nothing was skipped, so nothing is dashed.
    const at = "2026-08-21T10:00:00.000Z";
    seed({
      computed: {
        scan: scanV2({
          checks: [
            { id: "known_vulns", tool: "osv.dev", tool_version: "2026-09-13", status: "pass", at, findings: 0, packages: 0 },
            { id: "known_malware", tool: "osv.dev/MAL", tool_version: "2026-09-13", status: "pass", at, findings: 0, packages: 0 },
          ],
          findings: [],
        }),
      },
    });
    const column = aside(await html());

    expect(column).toContain('<span class="sr-only">no dependency manifests to check</span>');
    expect(column.split('<span class="mark" aria-hidden="true">✓</span>').length - 1).toBe(2);
  });
});
