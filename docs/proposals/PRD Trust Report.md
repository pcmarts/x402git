# PRD: The trust report — what the scan checked, what it found, and what the artifact can do

**Status:** Accepted (13 Sep 2026), building · **Amends:** PRD Final v1.1 (G5, FR-35, FR-37, FR-39, FR-41, FR-49, §9 `VersionResponse`, §11 implementation table, §12 `release.scan_report`, §16) and DECISIONS 2026-08-29 "The scan fails on secrets and on HIGH/CRITICAL CVEs, and nothing else" · **Date:** 13 Sep 2026 (rev. same day: Snyk removed, Socket integration specified against its API) · **Closes:** BACKLOG "Socket for malicious-dependency detection" and "A creator can read the scan report that failed their release"

---

## 1. Problem

FR-35 scans every release and FR-37 puts a badge on every listing. The badge is one word and a date: `Scanned ✓ 2026-08-30`. Behind it, `release.scan_report` holds a finding-by-finding report with a `checked[]` list that nobody reads — not the buyer, not the creator, not `GET /api/v/:owner/:slug` (`lib/schemas/releases.ts:57`, the agent's cheapest call, has no scan field at all).

That is exactly the criticism `docs/research/Battle Test.md` §6.3a makes of Agensi: *"The badge has nothing behind it."* Agensi's listing says "Verified clean 5 months ago · Passed all security checks, Safe to install", shows an empty "Permissions required" accordion on most listings, and refuses to publish its rules. We have the report and we are showing the same shield.

Three concrete gaps, in the order they matter to a buyer:

1. **The scan cannot see a malicious dependency unless it has a CVE.** OSV only knows published advisories; the packages hitting registries in 2026 are new and malicious, not old and vulnerable. Worse, OSV *does* ingest `ossf/malicious-packages` as `MAL-…` records, but those carry no CVSS vector and no severity word, so `severityOf` (`lib/scan/osv.ts:165`) returns `UNKNOWN` and DECISIONS 2026-08-29 says `UNKNOWN` never blocks. **A dependency OSV itself lists as malware passes the gate today.**
2. **Nothing says what the artifact can do.** A Claude Code skill with `allowed-tools: Bash` and a `.claude/settings.json` hook that runs on every prompt is a different purchase from a Markdown prompt pack. Both show the same badge. The buyer's question — "will installing this run something on my machine, and will it talk to anyone?" — is answerable from the bytes we already hold, and we do not answer it.
3. **The verdict is binary and the middle is invisible.** MODERATE and LOW CVEs are recorded and never shown. An install script, a deprecated dependency, a package that phones home — none of these should stop a sale, and all of them belong in front of the person paying.

## 2. Goal

Every listing carries a **trust report** the buyer and the buyer's agent can read: which checks ran, when, with what tool version; what was found and what it means; and what the artifact is capable of (shell, network hosts, environment variables, install-time execution). The release verdict stays binary and still gates on the same small set of absolutes plus one addition — a dependency *known* to be malicious. Everything else is disclosed, not blocked.

Two tools and only two: **our own scan scripts in `lib/scan/`, improved**, for the artifact's own files; **Socket**, for what its dependencies do. Nothing else is called, and no model is in the loop.

The lines to hold: **a gate that always fires is a gate people learn to ignore** (DECISIONS 2026-08-29), and **binary ticks, never scores** (Quality Signals §9, "four binary trust ticks").

## 3. Non-goals

- Executing creator code (NG6). Every check here is static: our own parsers and regexes, OSV, and Socket's analysis of *published packages*.
- **An LLM reading each repository.** No Claude-Code-per-repo scan, no "AI review" badge. Every check we run ourselves is a deterministic rule with a version number; a finding is reproducible from the bytes and the rule, which is what lets us publish it. Socket uses models internally for some alert types (`gpt*`, `skill*`); those are treated as *flags for review*, never as verdicts (§6.2).
- Sending the creator's source anywhere. Socket's archive endpoint extracts *manifest files only* from what we upload (§6.2); the artifact's own code never leaves our storage. D3a holds.
- A trust *score*. Socket returns `score.supplyChain` etc.; we do not show it, and we do not build one of our own. Quality Signals §3.6 excludes maintenance from Depth for the same reason.
- A second vendor. Snyk was considered and rejected — §8.
- Manual review. Agensi claims it at 77 uploads/day; we do not claim it.
- Changing the terminal verdict of a cut release (§12). A rescan refreshes disclosures; it does not flip `pass` to `fail`. See §7.

## 4. Decision

### 4.1 Three tiers, not two

| Tier | Effect | What lands here |
|---|---|---|
| **Blocking** — `fail` | Release never sells. Unchanged mechanics: report stored, bytes deleted. | Secrets (unchanged) · HIGH/CRITICAL CVEs from OSV (unchanged) · §6 size caps (unchanged) · **new:** a dependency with an OSV `MAL-` record · **new:** a Socket `malware` alert (the human-confirmed type; not `gptMalware`) · **new:** hidden-Unicode instruction smuggling in a `.md`/tool-description file (tag characters U+E0000–E007F, zero-width runs spelling text) — there is no benign reason for it in a skill |
| **Disclosed** — `pass` with findings | Sells. Shown on the listing, in the manifest, in `VersionResponse`. | MODERATE/LOW/UNKNOWN CVEs (today: hidden) · Socket capability alerts on dependencies · Socket hygiene alerts · Socket model-derived flags (`gpt*`, `skill*`, `potentialVulnerability`) as **"flagged for review"** with an admin alert · own capability inventory (§4.3) · own textual injection heuristics |
| **Not checked** — a gap, recorded | Sells on the checks that did run. | Socket unreachable, over quota, or still processing at cut time. `checks[].status = "unavailable"`, retried by the rescan cron (§7). |

Why Socket's model-derived alerts are disclosed, not blocking: Socket publishes 94.5% precision for its skill classifier — one flag in eighteen is wrong, and the creator it lands on cannot fix it or see why. Blocking on the *confirmed* `malware` type is exactly "fully malicious" and nothing else is.

Why "not checked" sells: OSV's outage today leaves the release `pending` forever, and that was the right call when OSV was the *only* dependency check. Socket is an addition. A Socket outage blocking every release on the platform is the always-firing gate again; a listing that says "dependency behaviour: not yet checked, retrying" is honest. **Founder decision — §10 Q1.**

### 4.2 The report is published per check

`scan_report` becomes a report **v2** with a stable `checks[]` block. Every check that ran, or was supposed to, is a row:

```jsonc
{
  "version": 2,
  "verdict": "pass",
  "scanner_version": "2026.09.1",
  "scanned_at": "2026-09-13T10:12:00Z",
  "checks": [
    { "id": "secrets",       "tool": "x402git/secrets", "tool_version": "2026.09.1",  "status": "pass",     "at": "…", "findings": 0 },
    { "id": "limits",        "tool": "x402git/limits",  "tool_version": "2026.09.1",  "status": "pass",     "at": "…", "findings": 0 },
    { "id": "known_vulns",   "tool": "osv.dev",         "tool_version": "2026-09-13", "status": "findings", "at": "…", "findings": 2, "packages": 41 },
    { "id": "known_malware", "tool": "osv.dev/MAL",     "tool_version": "2026-09-13", "status": "pass",     "at": "…", "findings": 0 },
    { "id": "dep_behaviour", "tool": "socket.dev",      "tool_version": "2026-09-13", "status": "findings", "at": "…", "findings": 3, "packages": 63, "socket_scan_id": "…" },
    { "id": "capabilities",  "tool": "x402git/caps",    "tool_version": "2026.09.1",  "status": "findings", "at": "…", "findings": 4 },
    { "id": "injection",     "tool": "x402git/inject",  "tool_version": "2026.09.1",  "status": "pass",     "at": "…", "findings": 0 }
  ],
  "findings": [ /* v1 shape, unchanged, plus `check`, `public`, `tier` */ ],
  "capabilities": { /* §4.3 */ },
  "counts": { "blocking": 0, "disclosed": 9, "review": 0 },
  "advisories_refreshed_at": "2026-09-13T10:12:00Z"
}
```

`status` is one of `pass | findings | fail | unavailable | partial`. `partial` is Socket's own signal that some packages were still `pendingScan`/`notFound` when we read the result. `findings[]` keeps today's `ScanFinding` shape so v1 reports still parse; three fields are added: `check` (which row), `public` (§4.4), `tier` (`blocking | disclosed | review`). `packages` on the Socket row will exceed the OSV row's count because Socket resolves the transitive tree from the lockfile and `packagesFromFiles` does not.

The v1 → v2 read path: a loader that receives a v1 report synthesises `checks[]` from `checked[]` and `counts`. No migration of old rows; `SCANNER_VERSION` is bumped so the badge says which era a scan is from.

### 4.3 Capability inventory — "Permissions required", computed, never self-reported

The block the founder pointed at on Agensi. Ours is computed from the snapshot at cut time, in-process, by our own parsers, and it is on every listing including ones with no dependencies at all. Sources, in `lib/scan/capabilities.ts`:

| Capability | Where it is read from |
|---|---|
| **Tools** (Claude Code) | `allowed-tools:` in SKILL.md / command frontmatter; `permissions.allow[]` in `.claude/settings.json`; `hooks` in the same file (a hook is arbitrary shell on an event — disclosed as its own line, loudly) |
| **Runs a local process** | `.mcp.json` / `mcp.json` `command` + `args`; any file under `scripts/`, `bin/`; `package.json` `scripts.postinstall`/`preinstall`/`prepare`; `setup.py`/`pyproject` build hooks; `Makefile`; `.github/workflows/*` (runs on the buyer's CI if they fork) |
| **Talks to hosts** | Hostnames from URL literals in code and config files (not README/docs — those are listed separately as "documentation links" so a badge image host does not read as a network call). `localhost`/`127.0.0.1` kept and labelled "local" |
| **Reads environment** | `process.env.X`, `os.environ[...]`/`os.getenv`, `$X`/`${X}` in shell, `env:` blocks in MCP config. Names only — the value is never in the repo, and if it is, the secrets check already failed the release |
| **Writes files** | Only when certain: a hook, an install script, or a Socket `filesystemAccess` alert on a direct dependency. Otherwise omitted rather than guessed |

This is the FR-35 "capability disclosure" the backlog said no vendor sells. It is also the answer to Quality Signals §9a's "verify the all-clear state first": a listing whose inventory is empty says **"No tools, no hosts, no environment variables, nothing runs at install"** in those words, and that sentence is a computed claim we stand behind, not a creator's checkbox.

### 4.4 What is public

| Finding | Public (manifest, page, `VersionResponse`) | Creator (dashboard, `GET /api/listings/:id`) |
|---|---|---|
| Secret | Never — not even on a failed release. The failed release never sells, and a path+line is a map for anyone who cloned before the tag. | `rule_id`, `path`, `line`, secret *length*. Path and line are the creator's own file; withholding them is what the backlog complains about. |
| CVE / MAL on a dependency | Yes: package, version, advisory id, severity, one-line summary. | Same. |
| Socket alert on a dependency | Yes: package, version, alert type, severity, Socket's one-line description, `direct`/`dev` flag. Never Socket's `html_report_url` — the report lives under our org and the badge must not depend on Socket staying up. | Same. |
| Capability inventory | Yes, all of it. | Same. |
| Injection heuristic | Yes: check row + count. Not the matched text (which would tell the next creator what to avoid). | Rule id + path + line. |

The dashboard "Security scan" row (`app/dashboard/[id]/page.tsx:328`) links to the release's report. That closes the second backlog item; the third state (`pending` with `osv_error`) gets its words: "known-vulnerability check could not run; retrying".

**Amendment, 14 Sep 2026 — the report keeps everything, the publication folds transitives.**

The first Socket backfill ran on `pcmarts/acl-recovery-tracker`: 545 packages, **1,209 `dep_behaviour` findings** — 447 `networkAccess` (29 on direct dependencies, 418 transitive), 364 `envVars`, 106 `filesystemAccess`, 66 `urlStrings`, 50 `gptAnomaly` (review, 1 direct), 40 `unmaintained`. Published one row each, that was an **844 KB listing page**, the same in `manifest.computed.scan.findings` and in `GET /api/label`. §4.1 had already warned that "every real Node project has an `installScripts` transitive" and the tiering held; the *publication* did not. Nobody reads 418 identical lines and an agent fetching the manifest pays for them.

So the table above still describes `release.scan_report`, which keeps every finding and is what the creator's dashboard and `GET /api/listings/:id` read. What the public surfaces carry is now `publishedFindings(report)` (`lib/scan/report.ts`), not `publicFindings(report)`:

- every non-`dep_behaviour` public finding, as before;
- a `dep_behaviour` finding that is on a **direct** dependency, is **blocking**, or names **no package**, as itself;
- everything else folded to **one row per `rule_id`**, with `package` omitted and a new optional `aggregate: { packages, examples }` — the count of distinct packages and up to three `name@version` samples. The description is `networkAccess in 418 transitive packages`, or, on the review tier, `flagged for review by Socket's classifier in 49 transitive packages`. A rule that caught one package is not folded; the schema's `packages ≥ 2` says the same.

`counts` is untouched: `disclosed: 1175` is a fact about the scan, not about the page. Both manifest writers — `manifestScan` (`lib/release/index.ts`) and `withRefreshedScan` (`lib/scan/rescan.ts`) — use the fold, so the backfill that produced the 1,209 is the run that takes them back off. `publicFindings` stays for the surfaces that want the unfolded public set.

The `release_scan_review` event stays one event with a `count` and the distinct `rule_ids`, capped at five with `+N more`. Fifty `gptAnomaly` flags are one thing to look at, and no package name is ever in the payload.

## 5. The buyer's reading

On `app/[owner]/[slug]/page.tsx`, the single scan line (`:472`) becomes a section. Server-rendered (§14.1, `npm run check:ssr`), plain `<dl>`/`<ul>`, tokens from DESIGN.md, no shield icon — the word is the verdict.

```
Trust

Scanned 13 Sep 2026 · scanner 2026.09.1 · advisories refreshed 12 Sep 2026
  ✓ secrets                none found
  ✓ size limits            within caps
  ✓ known malware          none in 63 packages
  · known vulnerabilities  2 moderate, 0 high — see below
  · dependency behaviour   3 packages declare install scripts or network access
  ✓ instruction smuggling  none found

What this can do
  Tools        Bash, Read, Write, WebFetch          (from SKILL.md allowed-tools)
  Runs         scripts/build.sh · a .claude hook on PostToolUse
  Talks to     api.anthropic.com · fonts.googleapis.com · localhost:3000 (local)
  Reads        ANTHROPIC_API_KEY · PORT
  At install   nothing runs

Findings (5)
  MODERATE  GHSA-xxxx  lodash 4.17.20 — prototype pollution in zipObjectDeep
  notice    installScripts  esbuild 0.21.5 (direct) — install scripts run when installed
  …
```

**Amendment, 14 Sep 2026 — how the folded rows read.** Following §4.4's amendment above, the dependency-behaviour row and the findings list say the two halves apart: the direct dependencies, which a buyer can act on, and the transitive remainder, which is a number.

```
  · dependency behaviour   29 direct packages declare network access, environment variables
                           or filesystem access · 1,180 more in transitive packages

Findings (34)
  MODERATE  lodash 4.17.20 — prototype pollution in zipObjectDeep GHSA-xxxx
  notice    esbuild 0.21.5 (direct) — install scripts run when installed
  …
  flagged for review  gptAnomaly — 49 transitive packages, e.g. left-pad@1.3.0, …
  notice    networkAccess — 418 transitive packages, e.g. axios@1.7.2, got@14.4.1, undici@6.19.2
  notice    envVars — 364 transitive packages, e.g. …
```

The row's nouns come from the rules the direct dependencies actually tripped (three at most, then "and more"), never from a hard-coded pair, and the transitive count is `check.findings` minus the direct ones — the scan's own tally, so the creator's dashboard and the buyer's page print the same number off the same row. The tallies sort last in the list, review first among them, then severity, then size: everything above a tally names a package a reader can go and look at.

**Amendment, 14 Sep 2026 — Trust is part of the buy column, and the report is the detail behind it.** The founder, on the section as it shipped: *"We need to change the trust section. I want it to actually be part of the right-hand panel. It needs to be a lot more compact, and it needs to be its own little section … We also need to signal these various scans it's had, so maybe just a tick next to each scan and the name of it, e.g. whether it was scanned with Socket or not."*

So the section splits in two, and the half a buyer reads is the half beside the price.

**The buy column carries the check list** (`trustChecklist`, `lib/web/manifest-view.ts`), a block of its own between *What you get* and *Languages*, where the one-line `Scanned ✓ 2026-09-01 — what was checked.` used to sit. Seven rows: a mark, the scan's short name, and a short phrase where the column has room for one.

```
TRUST
  ✓ SECRETS
  ✓ SIZE LIMITS
  ✓ MALWARE
  · VULNERABILITIES                  1 moderate
  · DEPENDENCIES     11 direct · 1,116 transitive
  ✓ INJECTION
  · CAPABILITIES

  2026-09-01  scanned
  2026-09-14  advisories refreshed
  Full report
```

The vendor was in these rows for an afternoon, on the first reading of the direction above, and moved into the report the same day on the second: *"on the right side we can just keep the simplified view — we don't need to know what scanned it … in the report, in the details, exactly what scanner scanned this."* A tick and a name is what a price needs beside it. The stamp is a log — the date first, one event per line — on the same reading.

Five rules, four of them carried over from the section and one new:

- **Seven rows, always seven**, in `CHECK_ORDER` — the report's own order, because these are the report's own rows sixty pixels away and two orders for one list is a reader checking whether they are looking at the same thing. This is the one surface that prints a row the report does not carry: a listing cut before 13 Sep 2026 has no `checks[]` at all, and *which scans has this had* still has an answer for it — `–`, with `not recorded by this scanner version` in the row's title. §4.1's rule that a gap is a row, one rung up.
- **`checkRows`' numbers, never a second derivation.** Where a phrase fits the 22rem column it is an abbreviation of the row's own — `1 moderate`, `11 direct`, `1 transitive` — computed from the same `check.findings` and the same direct/transitive split as §4.4's amendment above. Over budget it is dropped whole rather than wrapped or ellipsised, and the full phrase is one line away.
- **The mark is decorative**, `aria-hidden`, with the full phrase beside it in `.sr-only`: the verdict is a word to a screen reader and to `curl` exactly as it is in the report.
- **No scanner version in the column.** The stamp is the two dates. DESIGN.md's 13 Sep exception is for the section whose subject is the ruleset; this is a summary that points at it.
- **No dead anchor.** *Full report* renders only when `hasTrustReport` is true.

**The report says who found what.** Two additions, on the same second reading:

- **A verdict sentence at the top**, above the stamp (`scannerVerdict`): *"Scanned by X402 Git, OSV and Socket — passed on all three. Findings from all three are listed below."* The founder asked for "something like a simplified view, just to give that level of confidence, like pass/pass"; the second sentence is what stops the first from being §1's shield, and it is computed from the rows rather than written so it cannot drift from them. A vendor that produced nothing is never counted into the pass — *"Socket has not answered yet"* — and a vendor that ran some of its rows and not others says that instead, because OSV answering for vulnerabilities and not for malware is not OSV failing to answer.
- **The source on every check row**, as a third column at the right margin (`CheckRow.by`, from §4.2's `tool`): `X402 Git`, `OSV`, `Socket`. The field has been on every check since this document was accepted and had never been printed, so a reader could see that something found a thing and not what found it.

**Amendment, 14 Sep 2026 (same day, third reading) — the report is clipped like the README, and the column's link opens it.** The founder: *"Can the trust report have a 'Read more' just like the README does? When a user clicks on 'Show report' on the right panel, can this also expand the trust report on the main page as well?"*

The clip is the README's, reused rather than rebuilt (`app/_components/readme-more.tsx`): the same `data-readme-clip` attribute on the block, the same `Show more` / `Show less` control, and the same single delegated inline listener, which the page still emits exactly once after the last thing it clips — which since this amendment is the report, not the README. The preview height is the README's `min(26rem, 55vh)`, and that height happens to be the one that puts **all seven check rows above the fold** on the longest report we hold (390px of rows on `pcmarts/acl-recovery-tracker`); what folds is the capability inventory and the findings. The verdict sentence and the stamp are outside the clipped block.

**Amendment, 14 Sep 2026 (fourth reading) — three tweaks.** The vendors are **links on first mention** in the verdict sentence (`OSV` → osv.dev, `Socket` → socket.dev, new window, "(opens in a new tab)" in the accessible name); X402 Git is never a link, and the source column on the rows stays plain text. **"What this can do" puts one item per line** — a real `<ul>`, because nine hostnames joined by ` · ` is a paragraph a reader has to read all of to find one domain. And the fold moved up: the preview is `min(11rem, 40vh)`, which on the longest report ends two pixels short of the fourth check row's rule, so three rows read crisp and the fourth fades. The report's height is the one deliberate exception to the README's.

The same pass fixed a bug the clip had carried since it shipped: `fit()` sets `hidden` on the control's wrapper when the block already fits, and `[data-js="on"] .readme-more{display:block}` outranked the user agent's `[hidden]{display:none}`, so a **Show more** sat under a README that was entirely visible (`example-seller/example-listing`). One line of base CSS — `[hidden]{display:none!important}` — and the rule holds for the README, the report and anything else the product hides with the attribute.

The column's link is renamed **Show report** and carries `data-readme-open="trust-body"`. The listener finds the toggle whose `aria-controls` matches, opens it, and lets the anchor navigate to `#trust`. It only ever opens, never closes; it does nothing when the report already fits, because `fit()` will have removed the clip and hidden the control by then; and with scripting off it is a plain anchor to a section that was never clipped. **The whole report is still in the server HTML** — the clip is a `max-height` the section only wears once the script has set `<html data-js="on">` — so `curl`, an agent and a reader with scripting off are unaffected by all of this, which is the only reason a fold was allowed here at all.

**Amendment, 14 Sep 2026 (fifth reading) — the word is "Security scan".** On the founder's direction the buy column's heading reads **Security scan** and the section below the README reads **Security scan report**; *Show report* is unchanged, because it still names the thing it opens. Nothing else moved: the class names, the `#trust` anchor (external links and the clip's `data-readme-open` target depend on it), every symbol in `lib/web/manifest-view.ts` and this document's own filename are addresses rather than copy. *Trust* named the reader's conclusion; *security scan* names the thing we ran, which is the only one of the two we are entitled to put in a heading. **A shield icon was proposed in the same breath and declined** — §5 already says "no shield icon — the word is the verdict", the marks (`✓ · ✗ –`) are the section's only symbols, and a shield beside a heading is the exact thing `docs/research/Battle Test.md` §6.3a criticises Agensi for.

**The section is the detail**, unchanged in content, renamed *Trust report*, and moved **after the README** — it is reference, like the release log under it, rather than the last computed thing a reader meets before the pitch, which is the job the column now does above the fold. It stays a `<section id="trust">` and does not become a `<details>`: `:target` can style a disclosure but cannot open one, so a reader following the link with scripting off would land on a closed fold and have to ask twice for the thing the link promised. The findings list inside it stays folded, as it always was.

The five-second read is the tick column; the expert layer is the findings list, folded by default. The wording rules from `lib/web/manifest-view.ts` carry over: the verdict is a word, the date is always there, the scanner version is always there. "Safe to install" is never printed — it is a promise we cannot make and Quality Signals §9a.5 bans the medium of exaggeration.

The agent gets the same thing as JSON: `manifest.computed.scan` widens from `{verdict, scanner_version, at}` to the v2 report minus non-public findings, and `VersionResponse` gains `scan: { verdict, at, blocking: 0, disclosed: 9, review: 0, capabilities_summary }` so a buyer-agent deciding on the cheapest call sees it.

## 6. The tools

### 6.1 Our own scripts, improved (`lib/scan/`)

Everything here is a pure function over `SnapshotResult.files`, unit-tested on fixtures, with a rule version that goes on the check row. No binaries, no network except OSV, no model.

| Change | Where | What it closes |
|---|---|---|
| **`MAL-` is blocking.** Any advisory id beginning `MAL-` becomes a `known_malware` finding at `CRITICAL`, blocking, regardless of the record's severity fields. | `lib/scan/osv.ts` `severityOf` / finding builder | The live hole in §1(1). Ships first, on its own. |
| `known_malware` check row, driven by the same OSV query — no new call. | `lib/scan/index.ts` | A tick the buyer can read. |
| MODERATE/LOW/UNKNOWN CVEs carry `tier: "disclosed"` and are published. | `lib/scan/index.ts` | §1(3). |
| GHSA/CVE ids kept on every vulnerability finding, so the Socket CVE alerts (§6.2) can be de-duplicated against OSV by id. | `lib/scan/osv.ts` | Same CVE shown once. |
| **Capabilities** (§4.3) — new module. | `lib/scan/capabilities.ts` | §1(2). |
| **Injection** — new module. Two rule classes: *hidden Unicode* (tag characters and zero-width runs inside `.md`, YAML frontmatter, tool descriptions in `mcp.json`) → blocking; *textual* ("ignore previous instructions", instructions inside HTML comments, base64 blobs ≥ 200 chars in prose, `<system>`-style tags in a skill body) → disclosed. Deterministic patterns, a versioned ruleset like `secrets.ts`. **Tuned on wiring, 13 Sep 2026** (three false-positive risks the module's author raised; none had shipped, so `INJECTION_RULESET_VERSION` stays `2026.09.1`): *bidi overrides are **disclosed**, not blocking* — §4.1 names tag characters and zero-width runs spelling text and does not name bidi, and an RTL README legitimately carries RLO/FSI/PDI around a Latin code span; *U+200C ZWNJ does not count towards a zero-width run when either neighbour is Arabic (U+0600–06FF, U+0750–077F, U+08A0–08FF, U+FB50–FDFF, U+FE70–FEFC) or Indic (U+0900–0DFF)*, because `می‌روم` and `क्‍ष` are spelling and a page of Persian clears five-in-sixty-four many times over; *a hit under `node_modules/`, `vendor/`, `third_party/` or `.yarn/` drops to disclosed with a `-vendored` rule-id suffix* — a dependency's README must not fail a creator's release, and the suffix keeps the two readings distinguishable rather than silently identical. | `lib/scan/injection.ts` | The mcp-scan finding in Quality Signals §7.1 — the payload class a dependency scanner cannot see. |
| **A cap is a disclosure, never a silent pass** (13 Sep 2026). Both modules skipped a file over 2 MB with a bare `continue` and left the row reading `pass`, so padding a `SKILL.md` past the cap was the whole of the bypass. They now emit a disclosed `injection-unscannable` / `capabilities-unscannable` finding naming the file, and the blocking hidden-Unicode pass reads `secretScanFiles` — the untruncated decode of every byte that ships — rather than `textFiles`, which `snapshot()` cuts off at 4 MB. Neither is blocking: a bundled dataset with a `.txt` extension is not an attack. | `lib/scan/injection.ts`, `lib/scan/capabilities.ts` | A computed claim about bytes nothing read. |
| **The threat-documentation allowlist is anchored** (13 Sep 2026). `isThreatDocumentation` suppresses `override-phrase` where a file declares itself to be about the attack; it matched `security`/`test`/`example`/`docs/` as substrings **anywhere** in the path — so `latest-notes.md` and `contest.md` were exempt — and trusted the bare word "security" in an MCP tool's own attacker-controlled `description`. The path test is now whole segments (`(^|/)(security|tests?|examples?|docs)(/|\.md$)`) and the declared subject must state the topic (`prompt`, `injection`, `jailbreak`, `red team`, `security review/audit/scan`). | `lib/scan/injection.ts` | A rule a creator could switch off by naming the file. |
| Secrets ruleset gets a refresh cadence: the `x402:check` pattern applied to gitleaks' `config/gitleaks.toml` — a script that diffs upstream rule ids against `secrets.ts` and reports what is missing. | `scripts/`, `lib/scan/secrets.ts` | The ruleset was ported once and has no way to notice drift. |

**Division of labour with Socket** — the rule that keeps the two from overlapping: our scripts look at *the artifact's own files*; Socket looks at *the published packages the artifact depends on*. Socket never sees the artifact's code and we never re-implement package behaviour analysis.

### 6.2 Socket — dependency behaviour

**What it adds:** analysis of what each published package actually does (install scripts, network, shell, filesystem, env, native code, `eval`, obfuscation, telemetry), a human-confirmed `malware` flag for packages that have no advisory yet, and resolution of the full transitive tree from the lockfile, which our `packagesFromFiles` does not do.

**Preflight — `npm run socket:check`** (`scripts/socket-check.mjs`). Read-only, 2 quota units. Reads the token from `.env`/`.env.local`, and prints: the org slug and plan the token belongs to (`GET /organizations`), the remaining quota and window (`GET /quota`), the manifest globs an uploaded archive will be scanned for (`GET /orgs/{slug}/supported-files`), whether any of those globs would match a skill file, and whether the token can list full scans.

**Run on 13 Sep 2026 against the real token.** Org `<socket org>` (plan `free`). Quota 500 units/hour, window resets hourly. `full-scans:list` confirmed. 55 globs across 14 ecosystems: `npm` (package.json, package-lock, yarn.lock, `pnpm-lock.y{a,}ml`, bun.lock, npm-shrinkwrap), `pypi` (requirements*, pyproject, poetry.lock, uv.lock, Pipfile, setup.py), `golang`, `cargo`, `gem`, `composer`, `maven`, `nuget`, `swift`, plus **`github` (`.github/workflows/*.y{a,}ml`, `action.y{a,}ml`)** — so the `gha*` alerts are reachable — and **`chrome` (`manifest.json`)**, which means a repo with a root `manifest.json` (a PWA, say) is read as a browser extension; its `browserExtension*`/`chrome*` alerts stay in the ignored set for that reason. **No skill-shaped glob** — no SKILL.md, `.claude/`, `mcp.json` — so Socket's `skill*` alert family is not reachable through the API for our uploads, and §6.1's own capability and injection checks are the whole of skill analysis. That closes what was §10 Q5.

**Configuration.** The token was saved as `SOCKET_TOKEN_VALUE` (the secret; `SOCKET_TOKEN_HASH` beside it is the token's public id, which authenticates nothing and is never sent). The pipeline reads `SOCKET_TOKEN_VALUE` and `SOCKET_ORG_SLUG=<socket org>` — both in `.env.local`, both to be added with `vercel env add` for production and preview before 2b ships. Token scopes required: `full-scans:create`, `full-scans:list`, `full-scans:delete`. `packages:list` only if the PURL fallback is enabled. The token is read in `lib/scan/socket.ts` only, sent as `Authorization: Bearer`, and appears in no report, log or manifest. Base URL `https://api.socket.dev/v0`.

**The call sequence at cut time** (`lib/scan/socket.ts`, invoked from `scanArtifact` after OSV):

1. **Upload the zip we already built.** `POST /orgs/{slug}/full-scans/archive?repo=<listing_id>&branch=v<version>&commit_hash=<commit_sha>&integration_type=api&tmp=true` with the artifact bytes as the multipart file. Socket extracts server-side and ingests *only* files matching its supported-manifest globs — `package.json`, lockfiles, `requirements.txt`, `go.mod`, `Cargo.lock`, and so on — so what it receives is dependency declarations, not source. Uploading the artifact rather than hand-picked files means the Socket result is bound to `artifact_sha256` the same way the OSV result is (D3, §6). Limits: 10,000 extracted files, 268 MB per file. Our snapshot cap is 20,000 files, so a snapshot between 10,001 and 20,000 files falls back to step 1′. Cost: 1 unit. `repo` is the listing id, never the slug (FR-42, DECISIONS 2026-08-29 on immutable ids). `tmp=true` keeps it out of Socket's dashboard as a repository.
   - **1′ (fallback, >10,000 files or no lockfile):** `POST /orgs/{slug}/full-scans?repo=…&tmp=true` with just the manifest files we can name from `packagesFromFiles`'s inputs. Same cost.
2. **Poll the stream, not the metadata.** `GET /orgs/{slug}/full-scans/{id}?include_scores=false&include_license_details=false` answers `202 {status:"processing"}` until the scan is done and `200 application/x-ndjson` when it is. The metadata endpoint's `scan_state` has no terminal value in its enum, so the stream's status code is the only reliable completion signal. Poll at 5 s, 10 s, 15 s — three polls, ≤ 30 s, ≤ 3 units. *(Trimmed from five polls on 13 Sep 2026, with the per-request ceiling cut from 30 s to 10 s: at the old numbers the worst case was eight requests at 30 s plus 60 s of sleeps — 300 s, the whole of `maxDuration`, on Socket alone before OSV had been asked anything. The default worst case is now **90 s**: six requests at 10 s plus 30 s of sleeps.)* `cutRelease` runs inside the GitHub webhook handler at `maxDuration = 300` and passes `scanArtifact` a **deadline** of `now + 200 s`; Socket trims its per-request ceilings and drops polls to fit what is left of it, and OSV stops its per-advisory detail lookups when one would not fit — a truncated lookup leaves the advisory at severity `UNKNOWN`, which does not block, and a `MAL-` record is still promoted from its **id** and never from the detail. Not done → the row is `unavailable` with `reason: "socket processing"` and `socket_scan_id` stored; the rescan cron (§7) reads it later at 1 unit.
3. **Parse.** One JSON object per line. Skip the line with `_type: "scores"`. Each artifact carries `type`, `namespace`, `name`, `version`, `direct`, `dev`, `alerts[]` with `{type, severity, category, props, action}`. `pendingScan` / `notFound` synthetic alerts → row `partial`, retry on the next rescan. `unmatchedFiles` on the create response is recorded so a "we sent 3 manifests, Socket read 2" gap is visible on the creator's report.
4. **Map every alert through one table** (`SOCKET_ALERTS` in `lib/scan/socket.ts`; unknown types are disclosed at `LOW` so a new Socket category is never silently dropped):

   | Tier | Socket alert types |
   |---|---|
   | **blocking** | `malware` |
   | **disclosed · capability** (feeds §4.3's "What this can do" for direct deps, listed per package for transitive) | `installScripts` `networkAccess` `shellAccess` `filesystemAccess` `envVars` `hasNativeCode` `usesEval` `dynamicRequire` `debugAccess` `telemetry` `obfuscatedFile` `highEntropyStrings` `urlStrings` `minifiedFile` |
   | **review** (disclosed as "flagged for review by Socket's classifier", admin alert raised, never blocking) | `gptMalware` `gptSecurity` `gptAnomaly` `potentialVulnerability` `didYouMean` `gptDidYouMean` `troll` `suspiciousStarActivity` and every `skill*` type |
   | **disclosed · hygiene** (low, folded) | `deprecated` `unmaintained` `unstableOwnership` `newAuthor` `missingAuthor` `recentlyPublished` `gitDependency` `gitHubDependency` `httpDependency` `floatingDependency` `badSemverDependency` `missingLockfile` `shrinkwrap` `manifestConfusion` `unpopularPackage` `trivialPackage` `tooManyFiles` `unresolvedYarnDependency` `oversizedManifest` |
   | **disclosed · capability** (repo-level) | `gha*ToSink`, `gha*ToEnv`, `gha*ToOutput` — a workflow the buyer inherits; reachable, since `.github/workflows/*.yml` is an ingested glob |
   | **de-duplicated against OSV** | `criticalCVE` `cve` `mediumCVE` `mildCVE` — matched by `props.ghsaId`/`props.cveId`; OSV stays the single source for the *blocking* decision; a CVE Socket knows and OSV does not is disclosed, never blocking (one gate, one source) |
   | **ignored** | all `license` category (FR-11 reads SPDX from the artifact) · `policy` `generic` `socketUpgradeAvailable` · `pendingScan`/`notFound` (handled as `partial`) · browser/Chrome/VS Code extension types (not an artifact class we sell) |

   `dev: true` packages are disclosed with a "dev only" mark; they still count.
5. **Store, then delete.** Findings are copied into `scan_report` in our shape; the `socket_scan_id` stays on the check row. `DELETE /orgs/{slug}/full-scans/{id}` is issued after a *terminal* read so tmp scans do not pile up under the org. A **`partial` read is never deleted** (13 Sep 2026): `partial` is Socket saying some packages are still `pendingScan`/`notFound`, and §7 finishes exactly that scan from its stored id for one unit — deleting it while keeping the id meant a 404 every night and a seven-unit re-upload for a scan already paid for. If the delete fails the id is kept and the cron sweeps it.

**Quota budget.** Per release: 1 (create) + ≤ 3 (polls) + 1 (delete) = ≤ 5 units. Free plan: 500 units/hour, 1,000 full scans/month. That is ~70 releases an hour by units and ~30 a day by scans — well above V0 traffic, and the monthly cap is the one to watch. `GET /quota` costs nothing and is called before every create: under 10% remaining → cut-time Socket is skipped as `unavailable` (release still cuts), rescans are paused, and an admin event fires. Cut-time scans always take priority over rescans.

**Failure handling — never fail a release on transport.**

| Response | Row | Action |
|---|---|---|
| 401 | `unavailable` · `reason: "socket auth"` | admin alert (`release_scan_socket_auth`); almost certainly a rotated token |
| 403 / 429 | `unavailable` · `reason: "socket quota"` | honour `Retry-After`, which is appended to the reason; admin alert (`release_scan_socket_quota`); cron retries |
| 202 after 60 s | `unavailable` · `reason: "socket processing"` | cron reads the stored id |
| **400 `No supported manifest files were found in the uploaded archive.`** | **`pass`** · `findings: 0` · `packages: 0` · `reason: "no dependency manifests"` | nothing. Socket looked and there was nothing to analyse; the page says "no dependency manifests to check" and the row is a tick |
| 404 on a full-scan id | `unavailable` · `reason: "socket error (404: Full scan not found)"` | the scan is gone (deleted, expired, or never created): cron **re-uploads** rather than re-reading the id |
| other 4xx / 5xx / timeout / bad NDJSON | `unavailable` · `reason: "socket error (<status>: <message>)"` | cron re-uploads |
| 200 with `pendingScan`/`notFound` | `partial` | cron re-reads |
| 200 clean | `pass` or `findings` | — |

*(Amended 14 Sep 2026, from the first backfill.* `pcmarts/crypto-balanced-portolio-builder` is a 256 KB repository that declares no dependencies at all: no `package.json`, no lockfile, no `requirements.txt`, nothing any of the 55 globs matches. Every non-OK create mapped to `unavailable · socket error`, so it read as an outage — the rescan kept the old row, the listing sat at `predates scanner 2026.09` for ever, and the run's notes blamed a vendor that had answered correctly. **A 400 that says there are no manifests is an answer, and an answer replaces a predates row.** Every *other* non-OK response now carries the status, and the vendor's message with it where the body is the uniform error shape below, truncated to 80 characters — `socket error (503)` and `socket error (400: branch is required)` are different problems and were the same four letters. The reason's **prefix** is load-bearing and unchanged: `runSocket` decides whether to re-upload on `socket error`, `scanAlerts` alerts on `socket auth` / `socket quota`, and §7's repair queue looks for `socket processing`, all four by `startsWith`.)*

**What the live API actually did, 13 Sep 2026** (the preflight run, and the shapes the client is written against):

- `GET /quota` answers `nextWindowRefresh: null` on a window nothing has spent yet. The field is nullable and its absence is **not** an error; a client that treats it as one refuses to scan on the quietest hour of the day.
- Every error body is `{"error": {"message": …, "details": …}}`. *(Amended 14 Sep 2026: the message **is** read now, and only in `reasonForResponse`. It decides the one 400 that is an answer rather than a gap, and it is what makes a reason a diagnosis — collapsed to one line, truncated to 80 characters, and never a top-level `message`, which Socket does not send. `details` is not read: it is free-form, and a reason is not a place to paste an object.)*
- A `GET` for a full-scan id Socket does not have is a **404**, not a 200 with an empty stream. That is the row added to the table above: an id we hold that Socket no longer does means re-uploading, not polling harder.
- The multipart field name for the archive route is `file` (`SOCKET_ARCHIVE_FIELD`). This is still an **assumption** — the preflight is read-only and never posted an archive — and is confirmed or corrected on the first real cut against a configured token. The manifest fallback (step 1′) is not affected: there each file is appended under its own repository path, which is documented.

**Terms.** Socket's plans are per developer seat with one token on the free tier. We upload dependency manifests extracted from third parties' repositories under an org we own. The recommendation is to build against the free tier, ship it, and open the conversation with Socket once the preflight and a month of real volume give us numbers to bring — rather than before. **§10 Q4.**

**The `skill*` alerts.** Socket scans AI agent skills for skills.sh — Vercel uploads the skill source to Socket's API and Socket reads "every file a skill references". That path is not the public full-scan API: the preflight shows no skill-shaped glob in `supported-files`, so nothing in a SKILL.md reaches Socket from our archive upload. The `skill*` rows in the alert table stay so that a future glob is handled the day it appears (they map to `review`), and §6.1's own checks are the skill analysis this document ships.

**Not the PURL endpoint.** `POST /v0/purl` is deprecated (2026-01-05); its org-scoped successor `POST /v0/orgs/{slug}/purl` costs **100 units per call** — five calls an hour on the free plan — and takes only the packages we can parse ourselves, missing the transitive tree. It stays as an *optional* fallback behind a flag for the lockfile-less case, and is off by default.

### 6.3 `ossf/malicious-packages`

Already inside OSV as `MAL-` records. No new integration — §6.1 row one is the whole of it.

## 7. Re-scanning — a verdict ages, a disclosure should not

"Verified clean 5 months ago" is the weakest line on Agensi's page: advisories published in those five months are not in it. We hold the passing artifact's bytes in storage, content-addressed, so re-checking costs no GitHub call.

- New cron `GET /api/cron/rescan`, nightly at 04:00 after `reconcile`, behind `requireCron`, `maxDuration = 300`. Two queues, in order:
  1. **Repairs** — every release with a Socket row that is `unavailable` or `partial`: read the stored `socket_scan_id` (1 unit) or re-upload the artifact from storage (≤ 5 units). *(Widened 13 Sep 2026:* also every release whose `capabilities` or `injection` row is `unavailable` with a `check failed: …` reason — the mark `scanArtifact` writes when a module *threw*. Those two are pure functions of bytes that have not changed, so the cron re-runs them over the stored zip and spends no vendor unit doing it. A row that says `predates scanner 2026.09` is not queued: there is nothing to re-run.)*
  2. **Refresh** — the latest passing release of every live listing, OSV nightly (free) and Socket weekly (re-upload from storage, ≤ 5 units; `POST …/rescan?mode=shallow` on a retained scan is cheaper but depends on `tmp` scans persisting, which the preflight does not establish — re-upload is the reliable path until it does).
  For each, rewrite the dependency rows and their findings only, and update `manifest.computed.scan` with `advisories_refreshed_at` and the three public counts `{blocking, disclosed, review}` — never the report's own five-key `counts`, two of which are the creator's. `scan.at` stays the cut-time date; the page shows both.
- **The package set is the one the cut asked about** (13 Sep 2026). The rescan queries OSV with the stored SBOM — `manifest.computed.dependencies`, the resolved graph the cut got from GitHub — and falls back to `packagesFromFiles` over the zip only when a manifest predates it. Re-deriving the set from the zip was a silent regression, not an outage: our own parser reads `package-lock.json` and four other basenames and has never read a `yarn.lock`, a `pnpm-lock.yaml` or a `poetry.lock`, so a pnpm repo cut at 300 packages was re-read at ten versionless ranges, answered `pass, packages: 10`, and its two disclosed moderates disappeared from a published manifest. The backstop, for when the SBOM is missing too: **a rescan that asks about fewer than 80% of the packages the stored report asked about does not rewrite the OSV rows at all.** The old rows and their findings stay and the run records `skipped: weaker package set` in its summary.
- **The wall clock is budgeted per release, not only per run.** The route is `maxDuration = 300` and the run stops at 250 s, but the loop used to read that only *between* releases — so at 249 s it would happily start one that takes another ninety. Each release now gets a deadline of 45 s (threaded into Socket and into OSV's detail lookups, exactly as `cutRelease` threads its own), and the run starts nothing it cannot finish inside the remaining budget. A release cut off mid-Socket leaves the row `socket processing` with its id, which the next night finishes for one unit.
- **The release verdict is terminal (§12) and the rescan never changes it.** If a rescan finds something that *would* have been blocking at cut time — a dependency now `MAL-` or Socket-`malware` — that is a takedown question, not a scan question: raise `release.compromised` on the FR-41 abuse webhook, put it on the admin listing page (`app/admin/listings/[id]`), and the founder uses the existing takedown control (`lib/admin/controls.ts`, FR-39). The listing keeps selling until a human acts — **§10 Q2.** The notice fires on a *transition*, and a transition is a **new identity** rather than a new boolean (13 Sep 2026): the set of `rule_id | ecosystem/name@version` pairs that would have blocked is compared member by member against the previous report's, the notice fires when the new set has a member the old one lacked, and the payload names only the new members. A boolean meant the first `MAL-` record a release ever carried silenced every one after it. The FR-41 delivery result is not discarded either — a webhook that did not deliver goes into the cron summary's `notes`, which the route records as an event.
- **Backfill — the run a person types** (14 Sep 2026). The nightly is a *refresh*, and a refresh is right to leave a `predates scanner 2026.09` row alone: there is no bug to retry and re-reading every archive on the platform every night on the off-chance is not what a cron is for. But that rule is what leaves `capabilities` and `injection` blank on every listing cut before scanner 2026.09 — live, selling, and nobody has ever looked at what their files can do. `GET /api/cron/rescan?mode=backfill`, behind the same `requireCron` gate and never on a schedule, is the operator's answer: over every live listing's latest passing release (or one, with `&listing=<owner>/<slug>`, resolved by creator handle and slug the way the listing page resolves it), re-run `capabilities` and `injection` whenever their row is `unavailable` for *any* reason, refresh OSV exactly as the nightly does, and call Socket regardless of the weekly cadence. Everything else is the nightly's: the quota floor, the 45 s per-release deadline, the 250 s run budget, the weaker-package-set guard, and the rule that the verdict is never written. With one listing named the summary carries the refreshed `publicChecks` rows, so the terminal that asked shows the answer:
  ```
  curl -H "authorization: Bearer $CRON_SECRET" "https://x402git.com/api/cron/rescan?mode=backfill&listing=owner/slug"
  ```
- **The artifact is read by its magic bytes, not by its extension** (14 Sep 2026). §7 reads the bytes we sold, and on three listings it could not: the `examples/*` releases were cut on 30 Aug 2026, hours before DECISIONS 2026-08-30 chose zip, and are stored as `<listing>/<version>/<sha>.tar.gz`. The reader knew only about zips, so the backfill met all three as `artifact unreadable: zip: end of central directory not found` and skipped them — the storage format of an old release deciding whether a live listing ever gets scanned. `readArtifactEntries` (`lib/scan/archive.ts`) sniffs the first bytes — `1f 8b` gzip, `50 4b 03 04` zip — and fronts both readers under the same §6 caps: `gunzipCapped` counting chunk by chunk and then `readTar`, or `readZip` off the central directory. The wrapper directory comes off the same way for both (`commonRoot`, so `<slug>-<version>/` and GitHub's `<owner>-<repo>-<sha>/` are both handled), and the manifests-only predicate holds for both — the tar path cannot skip the inflate, but it skips the decode. The same sniff picks what Socket's archive endpoint is told it is being sent: a `.tar.gz` filename and `application/gzip`, since that endpoint accepts `.tar`, `.tar.gz` and `.zip` and reads the name. Nothing is migrated and no artifact is rewritten: `artifact_sha256` covers the bytes that were sold, and the fix is to read them.
- **The compromise set includes a blocking injection finding** (14 Sep 2026), for the same reason the backfill exists. Hidden Unicode tag characters and a non-orthographic zero-width run are `tier: "blocking"` at cut time (§4.1, §6.1) — a release carrying one does not ship — so finding one on a release that *did* ship is the same sentence as finding a dependency gone `MAL-`, and it takes the same path: `release_compromised`, the FR-41 webhook, the transition-only rule, and §10 Q2's answer that a human decides. The event names the rule id and the path, because it is our audit trail and a smuggling notice with no path is one nobody can act on; the webhook body names the rule ids in its `code` and never the path (§4.4), because it goes to a creator-supplied URL over the open internet.
- Budget: at 1,000 full scans a month, weekly Socket refresh covers ~200 live listings with room for cut-time scans and repairs. When live listings exceed that, refresh cadence stretches before cut-time coverage does. A backfill spends Socket on every live listing at once, so it is run deliberately and it stops at the same 20% quota floor the nightly does.

## 8. Alternatives rejected

- **Snyk.** Considered for SAST on the creator's own code. Rejected: its REST API is Enterprise-plan only; the free/Team route is the CLI, which is a Go binary via an npm wrapper; `snyk code test` uploads the creator's source to Snyk, which D3a forbids without opt-in; and its dependency half overlaps OSV + Socket. One vendor, whose input is manifests, is the right shape.
- **An LLM pass over each repository.** Rejected by the founder (13 Sep 2026) and by the design: non-deterministic findings cannot be published with a rule version, cannot be reproduced by the creator, and would put a model's opinion on a badge we promise is computed. Socket's model-derived alerts are the one exception and are labelled as review flags, never verdicts.
- **Block on every Socket alert.** Every real Node project has an `installScripts` transitive. The gate fires on everyone and means nothing.
- **Show Socket's scores.** A `supplyChain: 0.71` is a number nobody can act on and Socket's, not ours. Binary ticks and a findings list.
- **A trust score of our own.** Rejected in Quality Signals §9 and here for the same reason: a score invites gaming and hides the one finding that matters.
- **Creator-declared permissions (Agensi's model).** Self-reported and, on Agensi, empty. The inventory is computed or it is not shown.
- **Hand-picking manifest files for Socket instead of uploading the artifact.** Loses the `artifact_sha256` binding and re-implements Socket's file matching. Kept only as the >10,000-file fallback.

## 9. Build order

Each phase is shippable on its own; 0–2a need no vendor.

| Phase | What | Touches | Done when |
|---|---|---|---|
| **0 — close the hole** (hours) | `MAL-` → blocking CRITICAL. `SCANNER_VERSION` bump. | `lib/scan/osv.ts`, `lib/scan/index.ts`, fixture with a `MAL-` record | A lockfile pinning a package with a `MAL-` record fails the scan in vitest |
| **1 — publish the report** (days) | Report v2 with `checks[]`; v1 read-shim; `ScanInfo` widened; `VersionResponse.scan`; the Trust section on the listing page; dashboard row links to the creator's full report; creator-authenticated report on `GET /api/listings/:id`; the `pending`/`osv_error` copy. MODERATE/LOW CVEs shown. | `lib/scan/index.ts`, `lib/schemas/manifest.ts`, `lib/schemas/releases.ts`, `lib/schemas/listings.ts`, `lib/web/manifest-view.ts`, `app/[owner]/[slug]/page.tsx`, `app/dashboard/[id]/page.tsx`, `lib/admin/detail.ts`, OpenAPI regen | `check:ssr` green; a listing with a MODERATE CVE shows it; a creator can read the path+line of the secret that failed their release |
| **2a — own checks** (days) | `lib/scan/capabilities.ts`, `lib/scan/injection.ts`; two check rows; the "What this can do" block; hidden-Unicode → blocking; secrets-ruleset drift script. | `lib/scan/*`, `lib/release/index.ts` (pass `files` through), listing page, `scripts/` | The examples-creator listings show a correct inventory; a SKILL.md with U+E0041… fails the scan |
| **2b — Socket** (days) | `SOCKET_TOKEN_VALUE` + `SOCKET_ORG_SLUG` via `vercel env add` (preflight already green locally); `lib/scan/socket.ts` (archive upload, poll, NDJSON parse, `SOCKET_ALERTS` table, quota guard, failure table, delete); `unavailable`/`partial` rows. | `lib/scan/*`, `lib/release/index.ts`, env, `docs/BLOCKERS.md` if the preflight fails | A lockfile with a package Socket flags `installScripts` shows the disclosure; a fixture with a Socket `malware` alert (recorded NDJSON, no live call in tests) fails the scan; a 429 leaves the release cut with an `unavailable` row |
| **2c — rescan cron** (day) | `/api/cron/rescan` with the repair and refresh queues, `advisories_refreshed_at`, `release.compromised` webhook event, admin alert, quota-aware pausing. | `app/api/cron/rescan/route.ts`, `vercel.json`, `lib/events.ts`, `lib/webhooks` | A release scanned before an advisory shows the advisory the morning after; a release cut during a Socket outage has its row filled the morning after |

Phase 0 goes first regardless of whether the rest of this document is accepted. `scripts/socket-check.mjs` exists now and can be run before anything else is built.

## 10. Decisions needed — answered by the founder, 13 Sep 2026

All four as proposed. The document is accepted on these answers and §11 is applied.

1. **Does a Socket outage block a release?** Proposed: no — the row reads `unavailable`, the release sells on the other checks, the cron retries. The alternative (consistent with OSV today) is `pending` until Socket answers, which makes every release on the platform depend on a vendor's uptime.
   **Answered: no.** `unavailable` row, the release sells on the checks that did run, the cron retries. §4.1's third tier is the shipping behaviour and FR-35 says so.
2. **When a rescan finds confirmed malware in a selling release, does anything happen automatically?** Proposed: no — webhook + admin alert, human takedown. The alternative is an automatic `revoked_at` on purchases + listing pause, which FR-39 currently reserves for upheld notices.
   **Answered: nothing automatic.** `release.compromised` on the FR-41 webhook plus the admin alert; the takedown is the existing FR-39 control and a human uses it. Revocation stays where FR-39 put it.
3. **Hidden-Unicode smuggling: block or disclose?** Proposed: block. It has no benign use in a skill file. If it false-positives on legitimate emoji flag sequences (which also use tag characters), fall back to disclose and revisit.
   **Answered: block.** The emoji-flag fallback stands as written — if it fires on one, the rule drops to `disclosed` rather than being tuned in place.
4. **Socket terms.** Build on the free tier and open the conversation with numbers, or ask first? Proposed: build first; we upload dependency manifests, not source, and `tmp=true` scans are deleted after read.
   **Answered: build on the free tier**, and move up when volume needs it — the monthly full-scan cap (§6.2) is the number that says when.

*(Resolved 13 Sep 2026 by the preflight: Socket's `skill*` alerts are not reachable through the full-scan API, so whether they should block does not arise. If Socket adds a SKILL.md glob, the answer is `review`, never block, until real flags show the false-positive rate on our catalogue.)*

## 11. PRD text to change on acceptance

*Applied to PRD Final and DECISIONS.md on 13 Sep 2026.*

- **G5** — "…passing an automated security scan" → "…an automated security scan whose per-check results are published. The scan blocks on secrets, HIGH/CRITICAL CVEs, known-malicious dependencies, instruction smuggling and size caps; everything else it finds is disclosed."
- **FR-35** — add: known-malicious dependencies (OSV `MAL-`, Socket `malware`) block; capability inventory, injection heuristics and dependency behaviour (Socket) are disclosed; the report is v2 with `checks[]`; the creator can read the full report; `unavailable`/`partial` rows are retried. "Malware signatures" moves from V1 to V0; "behavioural analysis" is defined as Socket on dependencies — execution of creator code stays NG6.
- **FR-37** — the badge becomes the trust section: verdict + date + scanner version + per-check rows + capability inventory + `advisories_refreshed_at`.
- **FR-41** — add `release.compromised`.
- **FR-49** — the manifest's "scan badge" item becomes "trust report".
- **§9 `VersionResponse`** — gains `scan`.
- **§11 implementation table** — Scanning row gains "Socket full scans from the artifact zip (`tmp=true`), manifests only; own capability/injection rulesets in TypeScript".
- **§12** — `release.scan_report` documented as v2; `scan_report.advisories_refreshed_at`; `checks[].socket_scan_id`.
- **§16** — V0 gains capability disclosure and Socket; V1's "malware/behavioural scanning" line is removed; "MinHash originality" and the rest stay.
- **DECISIONS.md** — new entry superseding 2026-08-29's "and nothing else": the blocking set gains known-malicious dependencies and instruction smuggling; a third tier, disclosed, is introduced; no model-derived finding is ever a verdict.
