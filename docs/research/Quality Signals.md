# Quality Signals Spec

**Purpose:** make the substance of a repo legible at a glance, computed automatically, resistant to a creator gaming it.
**Status:** Draft v0.1, measured
**Related:** the v0.2 PRD and the Battle Test (both internal, not published); the live spec is [PRD Final.md](../../PRD%20Final.md)

This is the differentiator. Everything else in the product is plumbing that competitors can copy in a weekend.

---

## 1. The finding that justifies the whole product

```
multica-ai/andrej-karpathy-skills
  GitHub says:   208,335 stars · 21,225 forks
  Repo contains:      9 files · 37.7 KB · 0 lines of executable code
                 1 SKILL.md · 0 releases · bus factor 1
                 last push 2026-04-20
```

For comparison, `anthropics/claude-code` has **143,275 stars**.

**A 37 KB folder of markdown outranks Claude Code itself on the only signal a buyer can currently see.** The classifier in §3 grades it T1 in about 200ms.

Stars are not merely noisy in this category. They are close to uncorrelated with substance, and in the head of the distribution they are anti-correlated with it.

They are also **bought at scale**. An ICSE 2026 study from CMU identified roughly **6 million fake stars across 18,617 repositories** and 300,000+ fraudulent accounts, with fake-star campaigns rising two orders of magnitude during 2024 and AI projects carrying the highest absolute volume (~177k fake stars). And stars do not exist at all for private repos, which is half the intended supply.

Every existing marketplace either shows stars or shows nothing. Anything computed from the repo beats what buyers can see today.

| Repo | Stars | Substance tier | Files | Executable files |
|---|---|---|---|---|
| andrej-karpathy-skills | 208,335 | **T1** | 9 | 0 |
| ui-ux-pro-max-skill | 122,431 | T3 | 661 | 157 |
| caveman | 101,570 | T3 | 1,367 | 890 |
| taste-skill | 81,793 | T2 | 64 | 5 |
| awesome-claude-skills | 73,790 | T3 | 1,142 | 65 |

---

## 2. Feasibility: this is cheap

One batched GraphQL query returning repo metadata, language mix, 100 commits with signature state and per-commit churn, 20 releases with bodies, tag/issue/PR counts and vulnerability alert count costs **1 point** of a 5,000/hour budget.

| Bucket | Limit | Repos/hour |
|---|---|---|
| GraphQL | 5,000 pts/hr | **~1,600** |
| REST core | 5,000/hr | ~2,500 |
| **`dependency_sbom`** | **100/hr** | **100 — the binding constraint** |
| search | 30/min | — |
| code search | 10/min | — |

A full scan is ~3 GraphQL points + 1 SBOM call + 1 blobless clone, about **8 seconds wall clock**. Everything except dependency analysis is effectively free. Run SBOM weekly or on-release; run everything else hourly. A GitHub App installation token is worth it purely to escape the 100/hr SBOM ceiling.

### 2.1 Clone strategy — one hard rule

| Strategy | Time | Size | History |
|---|---|---|---|
| `--depth=1` | 2.52s | 24 MB | **destroyed** |
| `--filter=blob:none` | 2.47s | 25 MB | **complete** |

**Never use `--depth=1`.** Pick the filter by what you are computing:

| Task | Clone | Why |
|---|---|---|
| Blob SHAs, file tree, content analysis | `--filter=blob:none` | `git ls-tree -r HEAD` yields every blob SHA with no blob download |
| Commit history, authors, cadence only | `--filter=tree:0 --bare` | Smaller and faster still: django 32 MB / 8.5s vs blobless 84 MB / 11.4s |
| `--numstat`, `log -p`, blame | **full clone** | See the trap below |

**The blobless trap, measured:** `git log --numstat -n 500` on django took **0.40s on a full clone** and **69.7s on a blobless clone before failing with exit 128**, with `.git` growing 84→86 MB from on-demand refetches. A ~175x slowdown, then an error. Never run a content-touching command against a blobless clone. If you need churn, use a full clone or `/stats/code_frequency`, which is free and needs no clone at all.

`--depth=1` reports 1 commit and 0 authors for *every repo on earth*. The research pass nearly shipped a false "these repos are all single-dump imports" finding from exactly this artifact. Blobless clones cost the same, keep full history, all tags and all authors, and `git ls-tree -r HEAD` still yields every blob SHA without downloading a single blob.

This needs a test in CI. The failure is silent and the numbers look plausible.

Cross-validation: GraphQL `history.totalCount` = 742 = `git rev-list --count HEAD`; tags 206 = 206. The cheap path is exact.

---

## 3. The classifier: class first, score second

### 3.1 A single number does not answer the question

"Is this a 5-line prompt or a 5MB harness" is a **categorical** question. Lead with a class badge; use the score as a tiebreaker within a class. An opaque 0–100 as the primary UI recreates the exact problem we are solving, one level up.

| Class | Threshold — all on **deduplicated** volume, all gated on `unique_5gram >= 0.6` |
|---|---|
| **Prompt** | ≤2 files, no executable code, <2,500 effective words |
| **Pack** | ≥3 files or ≥2,500 effective words, documentation only |
| **Toolkit** | ≥1 code file and ≥50 effective LOC |
| **Harness** | ≥800 effective LOC, **or** ≥5 code files with tests |
| **System** | ≥3,000 effective LOC **and** tests **and** ≥30 files |

**The `unique_5gram >= 0.6` guard is load-bearing.** Without it, a 30-second slop generator classified as `Harness`. With it, `Pack`.

### 3.2 Why raw volume cannot be the metric

A prototype scorer was built and run against `anthropics/skills` (19 real artifacts), `modelcontextprotocol/servers`, and a deliberately padded fake — 4,000 random dictionary words in SKILL.md, six reference files of 1,500 random words, ten near-identical Python scripts, three trivial tests. Build time: about 30 seconds.

| | Volume-only score | Dedup-hardened score |
|---|---|---|
| **Fake slop artifact** | **75** (classified `Harness`) | **34** (`Pack`) |
| `skill-creator` (real, substantial) | 77 | 63 (`Harness`) |
| `brand-guidelines` (real, minimal) | 34 | 17 (`Prompt`) |

**A volume-only score essentially tied a 30-second slop generator with Anthropic's most substantial skill.** Any spec that counts files, words or lines without deduplication is not a quality signal, it is a padding incentive.

### 3.3 The two dedup signals, and why you need both

**Code padding → unique 5-gram ratio.** The separation is total:

| Artifact | LOC | unique 5-gram ratio | Effective LOC |
|---|---|---|---|
| gamed (padded) | 1,440 | **0.142** | 204 |
| skill-creator | 1,890 | 0.990 | 1,871 |
| pptx | 3,146 | 0.983 | 3,092 |
| mcp-builder | 409 | 0.976 | 399 |
| docx | 3,014 | 0.981 | 2,957 |

Padded code sits at 0.14. Every real artifact sits at 0.97–0.99. There is no overlap.

**Prose padding → type-token ratio, which inverts.** N-gram dedup does *not* catch random-word prose — the fake scored `unique_8gram = 1.000`, the most "novel" text in the corpus. TTR catches it because real technical writing reuses vocabulary heavily:

| Artifact | Words | Type-token ratio |
|---|---|---|
| gamed | 13,013 | **0.972** |
| claude-api | 122,304 | 0.071 |
| skill-creator | 11,684 | 0.182 |
| brand-guidelines | 1,913 | 0.296 |

An abnormally *high* TTR at scale is a slop flag. Caveat in §5.

### 3.4 Raw size is worse than useless

| Skill | Total | Text | Binary | Composition |
|---|---|---|---|---|
| `canvas-design` | 5.65 MB | 142 KB | **5.41 MB (96%)** | 54 `.ttf` fonts, 28 `.txt`, 1 `.md` |

The largest skill in Anthropic's own repo is 96% fonts. **"5MB" tells a buyer nothing.** Always split text from binary, and never let binary count toward depth.

### 3.5 Component inventory: the concrete-nouns layer

Measured across 247 real `SKILL.md` files, the complete set of frontmatter fields in use: `name` (247), `description` (247), `version` (211), `argument-hint` (145), `user-invocable` (133), `allowed-tools` (13), `license` (12), `tools`, `disable-model-invocation` (1). Supporting subdirectories: `reference` 24, `scripts` 18, `references` 14, `examples` 6, `templates` 1. Plugin top-level dirs: `skills` 15, `commands` 13, `agents` 8, `hooks` 6, `workflows` 2.

Component base rates across 39 plugins in Anthropic's official marketplace: license 100%, readme 95%, `plugin.json` 64%, commands 33%, agents 23%, scripts/references/hooks 15% each, MCP 3%, **tests 0%, CI 0%, changelog 0%**.

That last row matters. Tests and CI dominate OpenSSF Scorecard and have **zero discriminating power** at artifact level here. Do not use them as classification inputs at artifact scope; they work fine at repo scope.

Render the inventory as counted nouns — `1 skill · 9 scripts · 3 test files` — following Unity's "technical details" pattern. Concrete nouns beat bytes for a non-expert.

### 3.6 The Depth Score

Base, 0–100, using saturating rather than linear curves so a 10x bigger artifact is not a 10x better one:

| Component | Weight | Computation |
|---|---:|---|
| Effective volume | **35** | `0.55·sat(eff_words, 4000) + 0.45·sat(eff_loc, 1500)` where `sat(x,k) = 1 − e^(−x/k)` |
| Executable substance | **20** | `0.6·min(1, code_files/8) + 0.4·min(1, languages/3)` |
| Structure | **15** | `0.5·min(1, files/25) + 0.3·min(1, depth/3) + 0.2·min(1, doc_files/4)` |
| Documentation | **15** | `0.5·sat(eff_words, 2500) + 0.5·agent_facing_doc_coverage` |
| Verification | **15** | `min(1, test_files / (0.2 × code_files))` |

Integrity multiplier, 0.50–1.00, applied last:

| Trigger | Penalty |
|---|---|
| `unique_5gram_ratio < 0.5` | −0.25 |
| >3,000 words and `type_token_ratio > 0.6` | −0.25 |
| `binary_bytes / total_bytes > 0.8` | −0.10 |
| `max_corpus_jaccard > 0.8` (reskinned fork) | −0.30 |
| `unmodified_scaffold_ratio > 0.7` | −0.20 |
| Floor | 0.50 |

**Hard gates — not scored, the listing does not go live:** security scan fail, licence absent or resale-incompatible, spec-invalid manifest, artifact does not load in the sandbox.

**Maintenance and adoption are deliberately excluded from the Depth Score.** Depth is a property of the artifact; cadence and subscribers are properties of the channel. Mixing them makes a great new artifact look shallow and lets an old popular one coast. Show them as separate top-line facts. (Snyk blends maintenance in at 35% — right for a package registry's ranking, wrong for a "what am I buying" score.)

### 3.7 Validated spread

| Artifact | Class | Depth | Integrity |
|---|---|---|---|
| `modelcontextprotocol/servers` | **System** | 91 | 1.00 |
| `skill-creator` | Harness | 63 | 1.00 |
| `pptx` | Harness | 52 | 0.90 |
| `mcp-builder` | Toolkit | 43 | 1.00 |
| **gamed (slop)** | **Pack** | **34** | **0.50** |
| `internal-comms` | Pack | 25 | 1.00 |
| `brand-guidelines` | **Prompt** | 17 | 1.00 |
| `doc-coauthoring` | **Prompt** | 17 | 1.00 |

Prompt 17 → Pack 25 → Toolkit 43 → Harness 52–63 → System 91, with 30-second slop landing at 34. The ordering matches human judgement on a corpus the rubric was not designed around.

### 3.8 The signal nobody else has: context cost

| Skill | Always-loaded tokens | On-demand tokens | Disclosure ratio |
|---|---|---|---|
| internal-comms | 377 | 5,598 | 0.07 |
| brand-guidelines | 558 | 3,395 | 0.16 |
| skill-creator | 8,292 | 20,821 | 0.40 |
| **claude-api** | **18,926** | 243,334 | 0.08 |
| doc-coauthoring | 3,953 | 3,953 | **1.00** |

A buyer paying $1/release deserves to know that one artifact eats **19k tokens of context on every single run** and another eats 377. **No marketplace shows this.** It is the AI-native equivalent of npm's unpacked size, it is trivially computable, and it is the single most differentiated field available.

Put it in the 402 response payload too: an agent deciding whether to spend $1 should know the thing will cost it 8.3k tokens on every subsequent invocation.

### 3.9 What the classifier cannot do

`awesome-claude-skills` scores as a large System on 864 `SKILL.md` files. It is an aggregation of other people's work.

**Substance and originality are orthogonal, and no amount of counting collapses them.** Originality ships as a separate signal (§5.3), never folded into the class.

## 4. Release Cadence Score

Recency answers "did they ship?" A subscriber needs "will they keep shipping?" — a variance question, not a recency one.

OpenSSF Scorecard's `Maintained` check is the closest prior art: repos must be >90 days old, and the top score requires at least one commit per week over the previous 90 days. Its weakness is instructive — **"one commit per week" measures activity, not reliability.** A creator who ships 20 commits in a single day each quarter passes it. That gap is the opening.

```
gaps     = days between consecutive releases (last <= 60)
med      = median(gaps)
eff      = max(med, 7)            # floor: don't punish burst publishers
on_time  = |{g : g <= 2 * med}| / |gaps|
grace    = eff + 14
overdue  = clamp((days_since_last - grace) / (2 * eff), 0, 1)

RCS = round(100 * on_time * (1 - overdue))
```

Two factors, each explicable to a buyer in one clause: how often they hit their own rhythm, and whether they are currently late by their own standard. The median floor stops a repo that ships twice a day from being flagged overdue after 48 hours.

Calibration against six live repos:

| Repo | Median gap | On-time | Days since | **RCS** |
|---|---|---|---|---|
| microsoft/vscode | 6.5d | 93% | 1.9 | **93** |
| anthropics/claude-code | 1.0d | 86% | 0.6 | **86** |
| mcp/python-sdk | 6.9d | 85% | 2.2 | **85** |
| pbakaus/impeccable | 0.4d | 62% | 2.4 | **62** |
| mcp/servers | 4.6d | 54% | 10.0 | **54** |
| sindresorhus/got | 19.2d | 69% | 57.1 | **26** |

The ordering is right for the right reasons: `got` is historically regular but three cadences overdue; `impeccable` is current but bursty; `vscode` is metronomic.

**Publish the sentence, not the integer:** "Ships every ~7 days, hits that 93% of the time."

### 4.1 The escape hatch: do not punish finished software

Two registries independently arrived at the same conclusion — **"no recent release" must not be scored as a pure negative** — and both gate the exemption on stability plus documentation plus a low issue backlog rather than on age alone.

**npms.io** (`isPackageFinished`):
```js
isFinished = version >= 1.0.0 && !deprecated && openIssues < 15 && hasREADME && hasTestScript
if (isFinished) evaluation = mapValues(evaluation, e => Math.max(e, 0.9))
```
A stable, documented, tested package with under 15 open issues gets a **floor of 0.9 on every maintenance sub-score regardless of commit recency.**

**Ruby Toolbox** (`rubygem_long_running`): an explicit green flag when `first_release_on < 5.years.ago AND latest_release_on > 1.year.ago`.

Scorecard's own docs make the same point: *"a library that determines if an integer is even would not normally need maintenance."* Coelho & Valente (FSE 2017) found **11% of surveyed maintainers considered their project completed rather than abandoned** — that is the false-positive class any cadence score has to survive.

**Recommendation:** apply an RCS floor of 0.9 when an artifact is at a stable version, not deprecated, documented, tested, and has a low open-issue count. Publish the exemption openly so creators understand it.

### 4.2 Coefficient of variation does not work

Tried and rejected. CV of release gaps ranged 0.79–1.94 across the six repos with no discrimination. Release gaps are heavy-tailed; CV is the wrong statistic. Use on-time fraction.

---

## 5. Anti-gaming

The whole scoring system is worthless if a creator can inflate it in an afternoon.

### 5.1 Bot commits — the biggest distortion

`anthropics/claude-code`: **742 commits, 420 of them (57%) from bots.** Raw author count 83, human author count 64, bus factor 6.

Any metric touching commits or contributors must filter `[bot]`, `actions@github.com`, `dependabot`, `renovate` and `noreply@github.com` **before** computing. Unfiltered commit count is the most inflatable metric available — a scheduled workflow committing a timestamp yields unlimited commits for free.

### 5.2 Duplication and vendoring

`pbakaus/impeccable`: **3,323 tracked files → 986 unique blob SHAs = 3.37x duplication.** Legitimate in that case (the same skills shipped into twelve harness directories: `.claude/`, `.cursor/`, `.codex/`, `.gemini/`, `.kiro/`, …), but a naive file count overstates the work by 3.4x.

Deduplicate by blob SHA before counting anything.

**The trap in the obvious fix:** linguist's `linguist-vendored` and `linguist-generated` markers live in `.gitattributes`, which the creator controls. Never trust them as the sole filter. Use path and extension heuristics you own; treat creator-supplied overrides as a hint.

### 5.3 Originality is nearly free

Identical files have identical git blob SHAs, and `git ls-tree -r HEAD` on a blobless clone yields every blob SHA **without downloading content**. Set-intersect against a corpus of known upstreams:

```
repoA blobs: 986   repoB blobs: 139   shared: 0
```

One tree walk. Catches verbatim reuse instantly.

It does **not** catch reformatted or lightly edited copies. For that, **MinHash over 8-gram shingles, and it works cleanly** — 128 permutations, ~50ms per artifact:

| Pair | Jaccard |
|---|---|
| skill-creator vs a renamed copy of itself | **0.992** |
| skill-creator vs mcp-builder | 0.000 |
| any unrelated pair | 0.000 |

Perfect separation. **This directly mitigates Battle Test KS-3:** under MIT a buyer may lawfully rebrand and resell a free artifact, and MinHash against a corpus of public repos catches exactly that at listing time. It is the cheapest available answer to the licensing problem, and it should ship in the first fortnight rather than being deferred.

There is no public GitHub API for "which repos contain this blob SHA," so the upstream corpus is yours to build. Seed it with `anthropics/skills`, `claude-plugins-official`, the MCP registry and the top free skill repos.

**One trap in blob-SHA matching:** the empty-file blob `e69de29bb2d1d6434b8b29ae775ad8c2e48c5391` appears in essentially every Python repo. Blacklist it and weight matches by blob size, or copy-detection fires on every `__init__.py` and `.gitkeep` in existence.

### 5.4 Attack table

| Attack | Defeats | Countered by |
|---|---|---|
| Scheduled bot commits | commit count, cadence, `pushedAt` | bot filter (§5.1) |
| Tag every commit | release count, "recent release" | substantive-release rate (§5.5) |
| Boilerplate release notes | "has release notes" | template-hash dedup |
| Generated/padded markdown | file count, prose bytes | body-lines-per-heading; real-repo baseline **8.4**, under 3 is skeletal |
| Vendor deps as own code | SLOC, file count | path exclusion + blob dedup |
| Duplicate across harness dirs | file count | blob-SHA dedup (3.37x observed) |
| Copy an upstream repo | everything size-based | blob-SHA intersect (§5.3) |
| Buy stars | social proof | **do not ship stars** (§1) |
| Squash/force-push history | history depth | fingerprint diffing, below |

**Force-push detection is not solvable from outside.** Reflog is local only. What works: store HEAD SHA plus the commit-SHA set at each scan and diff across scans — a rewrite shows as previously-seen commits disappearing. This only works from your first scan forward, so **start recording at listing time.** Secondary hint: author-date vs commit-date skew (`anthropics/claude-code`: 1/742 = 0.1%; a rewritten history runs far higher).

### 5.5 The keystone: substantive-release rate

Gate a release as substantive when the release-note body is **≥120 informative characters** after stripping boilerplate **AND** tag-commit churn is **≥10 lines**.

```
anthropics/claude-code, 60 releases:
  substantive       53/60 = 88%
  identical bodies  6 releases sharing 1 template
  tag-commit churn  median 82.5 lines, zero-churn releases: 0
```

A well-run repo scores ~88%. A tag-spammer scores near zero. This single metric neutralises the entire fake-release attack class, which is why it ships **alongside** cadence rather than after it.

Boilerplate is real and detectable — the reused 60-character body was literally `## What's changed\n\n- Bug fixes and reliability improvements`.

### 5.6 What survives an adversarial creator

**Survives** (faking costs about as much as doing the work): bus factor, substantive-release rate, blob-SHA originality, dependency vulnerabilities and licence tree, signed commits and attestations, hardcoded-retired-model scan, archived flag.

**Does not survive:** raw commit count, tag count, `pushedAt` recency, repo size, directory depth, stars and forks, prose byte volume, "has a README/CI/tests" booleans.

**The structural point worth stating out loud:** the metrics that survive are mostly about dependencies, history shape and third-party corpora — things outside the creator's unilateral control. That asymmetry is the moat.

---

## 6. Model-epoch freshness

This is the deterministic expression of PRD D8 (fast-decay artifacts).

> **Evidence status.** An earlier draft of this section carried direct quotations from Anthropic's and OpenAI's prompting guides and precise statistics from arXiv:2311.11123. **Those were not verified and have been removed.** The research pass that produced them retracted them. What remains below is only what was measured or inspected directly. Before this section informs a build decision, someone should rebuild the vendor-guidance evidence from primary sources.

### 6.1 What is actually verified

**No artifact schema in the corpus carries a model-compatibility field.** Inspected across 247 real `SKILL.md` files, the complete set of frontmatter fields in use is: `name`, `description`, `version`, `argument-hint`, `user-invocable`, `allowed-tools`, `license`, `tools`, `disable-model-invocation`. Nothing else. There is no way for a creator to declare "this works on Opus 5 but not Sonnet 4.5," and no way for a buyer to filter on it.

**Retired and ageing model IDs are sitting in live repos.** Scanner output, measured:

```
anthropics/claude-code
  → claude-sonnet-4-20250514
  → claude-sonnet-4-5-20250929

modelcontextprotocol/servers
  → references MCP specs 2024-11-05, 2025-03-26, 2025-11-25
```

The MCP spec references are the cleaner signal of the two: a repo pinned to three superseded revisions is measurably behind, and that is computable without any vendor-policy assumption.

### 6.2 What needs verifying before it ships

Each of these is plausible and was asserted without a source. Treat as open:

- Specific model retirement dates and whether Anthropic operates a fixed notice period.
- Whether `temperature`/`top_p`/`top_k`, `thinking.budget_tokens` and assistant prefill return errors on particular model versions.
- The current MCP spec revision, its contents, and the claim that JSON-RPC batching was added and removed inside 84 days.
- The `SKILL.md` `compatibility` and `metadata` field semantics, the MCPB `manifest.json` compatibility precedent, and the agentskills.io specification.
- Vendor guidance instructing developers to remove legacy scaffolding when migrating models. This is the load-bearing claim for the whole subscription thesis and it is currently unsourced.
- Quantified prompt decay across model updates. The literature exists but the figures previously quoted here should not be trusted.

**Nobody has published a benchmark of agent-artifact performance across model epochs.** No one has measured "this skill scored X on Sonnet 4.5 and Y on Opus 5." That gap is real and is a V2 opportunity — running that benchmark would be a genuinely novel contribution and a strong marketing asset.

### 6.3 Build it on the deterministic layer regardless

Model IDs, spec revisions and SDK floors are strings in files. Whatever the vendor policy turns out to be, a scanner that flags "this artifact references a model ID that is no longer current" is computable, ungameable without actually fixing the problem, and useful to a buyer.

Ship the scanner. Source the narrative separately.

## 7. Prior art worth stealing from

Verified from implementation source, not documentation.

| System | The mechanism | Take or leave |
|---|---|---|
| **OpenSSF Scorecard** | Risk-weighted mean, inconclusive checks dropped from *both* numerator and denominator. Weights Critical 10 / High 7.5 / Medium 5 / Low 2.5. Two-part scoring within a check: License = 9 for presence + 1 for OSI-approved; Security-Policy = 6 links + 3 prose + 1 disclosure wording | **Take** the weighted-mean-with-skip pattern and "presence + substance" scoring. **Leave** the checks themselves — only 11 of 20 run offline, and a 2023 peer-reviewed npm/PyPI study found no clean correlation between Scorecard score and actual vulnerabilities. It measures process, not the thing you are selling |
| **Libraries.io SourceRank** | `max(0, Σ)` of ~1-point boolean hygiene checks plus `log10`-scaled popularity terms; −5 for deprecated/unmaintained/removed | **Take** cheap boolean hygiene and log-scaling so nothing dominates. **Leave** the ecosystem-position terms — dependents and stars, which you have none of at cold start |
| **Snyk Advisor** | Undocumented weights, recovered empirically to 8 decimal places across 49 packages: `0.15·popularity/6 + 0.35·maintenance/5 + 0.20·community/7 + 0.30·security/5`. Thresholds: Healthy = release within 90 days, Inactive = none within 365 | **Take** the implicit claim that *is this alive* (35%) beats *is this popular* (15%), and the qualitative label per sub-score. **Note** it took 49 samples to recover their weights — assume yours are recoverable too |
| **JSR** | The only registry scoring documentation: 5 of 18 points for **≥80% of exported symbols documented**, 1 point for a code-block example in the readme, 1 for build provenance | Right idea, wrong target here — see §8 |
| **pkg.go.dev** | `ts_rank × pow(ln(e + imported_by), 1.0) × (redistributable ? 1 : 0.5) × (has_go_mod ? 1 : 0.8)`. An unclear licence **halves search rank and suppresses rendered docs entirely** | **Take** the licence penalty. It is the only registry that puts real weight on licence clarity, and licence clarity is load-bearing for resale |
| **crates.io RFC 1824** | Formally *refused* to build a composite score: *"no consensus around a way to order crates that would be useful, understandable, resistant to being gamed, and not require work of curators."* | A warning worth reading before shipping a single blended number |
| **PromptBase** | Buyers cannot inspect a prompt before purchase, so every listing carries **example outputs** | **Take this.** It is the direct answer to unverifiable goods, and it maps onto the co-founder's demo-video instinct |
| **Envato** | Documentation mandatory with every item; live demo required; item description must list and link every third-party asset used | **Take** mandatory docs + demo as a listing gate |
| **CMU IoT Security Label** | Two layers: a primary layer all 15 test users understood, and an expert layer of 47 factors behind a link. Some found the expert layer opaque but **all wanted it present** | **Take** the layering. It is the structure of §9 |
| **Apple Privacy Nutrition Labels** | Standardised mandatory self-disclosure, 14 categories | **Cautionary tale.** Multiple studies found them materially inaccurate because nothing audits them. Copy the structure, verify every field you can, segregate the ones you cannot |

### 7.1 This category already has scorers

Worth knowing, because they are the real baseline rather than the empty field the calls assumed:

- **Glama** (MCP servers): LLM judge. Tool Definition Quality 70% (Purpose Clarity 25, Usage Guidelines 20, Behavioral Transparency 20, Parameter Semantics 15, Conciseness 10, Contextual Completeness 10), Server Coherence 30%. Server score = `0.6 × mean + 0.4 × minimum`, so one bad tool drags the whole server down. Tiers A–F.
- **MCP Queen**: behavioural, 100 points. Reachability 25, protocol compliance 15, tooling quality 35, latency 10, provenance 15. Across 9,326 remote servers: **17.2% are dead** and 29.2% grade D/F. Also: 99.7% ship a typed input schema, so schema presence is a floor, not a discriminator.
- **PluginEval** (Claude plugins): 10 dimensions, three layers (static <2s free, LLM judge ~30s, Monte Carlo 2–5min). Triggering Accuracy 25%, Orchestration Fitness 20%, Output Quality 15%. Anti-pattern flags with `max(0.5, 1 − 0.05n)`.
- **skill-validator**: the most liftable static rubric. Token budgets (SKILL.md warns at 5,000 tokens or 500 lines), **information density = 0.5·code_block_ratio + 0.5·imperative_ratio**, **instruction specificity** = strong markers (*must, always, never, required*) over strong+weak (*may, consider, could, optional*), keyword-stuffing detection, orphan detection with Python import-chain resolution, unclosed code fences as a hard error.
- **Smithery**: runs Invariant's mcp-scan on every listing. A scan of the top 100 servers found **1 in 5 with security findings, most commonly tool-description injection** — a payload class unique to agent artifacts and one a generic malware scanner will miss.

## 8. What not to do

| Don't | Why |
|---|---|
| **GitHub stars** | §1. Also ~6M fake stars across 18,617 repos, and unavailable for private repos |
| **Raw repo size in MB** | §3.4. The biggest skill in Anthropic's repo is 96% fonts |
| **Raw LOC, file count or word count** | §3.2. Got a 30-second slop generator to 75/100 |
| **Comment density** | The easiest metric on earth to inflate. Treat **high** density (>40%) as a *negative* — a strong marker of generated or copy-pasted code |
| **Maintainability Index** | `+50·sin(√(2.4·C))` peaks around C≈0.65 rad, so you raise MI by adding comments, including empty ones. Coefficients were regression-fitted to a handful of 1980s HP C/Pascal systems |
| **COCOMO "cost to develop"** | A pure monotone function of SLOC. Seductive because it renders as a dollar figure. scc's own README calls it "a conversation starter" |
| **Cyclomatic complexity** | Undefined for Markdown, which is most of this domain. scc's "Complexity" column is not cyclomatic — it is a per-language keyword substring counter, so identical logic scores differently by language |
| **File-presence checklists** | Six empty files scores 86% on GitHub's community profile. A one-line workflow running `echo ok` satisfies every CI check |
| **Static coverage badges** | `img.shields.io/badge/coverage-87%25-green` is a string the author typed |
| **JSR-style docstring coverage as a gate** | §8.1. Every skill in Anthropic's own repo fails the 80% bar |
| **Star ratings and review counts at launch** | Cold-start dead. Under ~10 ratings is noise |
| **Any AI-content detector as a verdict** | ~1–4% false positive for native English speakers versus **~61% for non-native speakers**; paraphrasing cuts detection 15–25%. Report a structural "low-effort score", never an AI verdict |
| **Self-reported quality tags** | See the Apple label cautionary tale above |
| **Download counts** | Cold-start dead and inflatable. Paid active subscribers is strictly better and only you can compute it |
| **A single blended score as the primary UI** | The diagnosis is that listings are indistinguishable. Another opaque 0–100 recreates it one level up. The **class badge** is the answer |
| **Orphan-file ratio without import resolution** | 83–98% false positives on legitimate skills (test fixtures, fonts, Python-imported modules) |
| **Publishing your exact weights** | Snyk's undocumented weights were recovered to 8 decimal places from 49 public samples |

### 8.1 Two domain-specific corrections

**JSR's 80% docstring bar fails this entire domain:**

| Skill | Documented / exported symbols |
|---|---|
| docx | 0 / 59 (0%) |
| xlsx | 0 / 58 (0%) |
| pptx | 1 / 76 (1%) |
| skill-creator | 17 / 36 (47%) |
| slack-gif-creator | 23 / 34 (67%) |

Every skill in Anthropic's own repo fails it. For agent artifacts the documentation lives in SKILL.md and `references/`, not docstrings. The correct analogue is **agent-facing coverage**: every bundled script referenced from SKILL.md with a stated purpose, every MCP tool with a description and typed schema.

**Tag-ordered diffs break on parallel branches.** Diffing `modelcontextprotocol/python-sdk` tags by creation date produced garbage — v1.29.1 → v2.1.0 showed 227k insertions — because v1.x and v2.x interleave. Diff along the release channel's ancestry, never `--sort=creatordate`.

## 9. The listing label

Three layers, per the CMU finding: a primary layer a non-expert reads in five seconds, an expert layer, and a JSON layer for agents.

### 9.1 Primary — the five-second read

```
┌──────────────────────────────────────────────────────────────────────┐
│  humanizer                                        adrian · verified  │
│                                                                      │
│  ┌────────────┐   Depth 63 / 100  ·  top 19% of Harnesses            │
│  │  HARNESS   │   ████████████████████████░░░░░░░░░░░░               │
│  └────────────┘                                                      │
│                                                                      │
│  WHAT YOU GET            1 skill · 9 scripts · 3 test files          │
│                          7,000 words of instructions · 1,900 LOC     │
│  CONTEXT COST            8.3k tokens loaded every run                │
│                          20.8k more read only when needed            │
│  SHIPS                   every 12 days · last release 7 days ago     │
│                          latest change: 6 files, 210 lines           │
│  IN USE                  141 agents · 78% already on this release    │
│                                                                      │
│  ✓ Security scan passed 21 Aug   ✓ MIT, resale permitted             │
│  ✓ Original (no match in public corpus)   ✓ Build attested           │
│                                                                      │
│  $1.00 / release                          [ full breakdown ▾ ]       │
└──────────────────────────────────────────────────────────────────────┘
```

Field priority and why each earns its slot:

| # | Field | Justification |
|---|---|---|
| 1 | **Class badge** | Literally the question. Categorical beats numeric for a non-expert |
| 2 | **Depth + percentile *within class*** | Percentile-within-class stops a good Prompt looking like a bad Harness |
| 3 | **"What you get" inventory** | The Unity/Envato pattern. Concrete nouns, not bytes |
| 4 | **Context cost** | AI-native, buyer-relevant, unique to us |
| 5 | **Cadence + last substantive change** | The fast-decay thesis, made visible |
| 6 | **Adoption** | The one number no directory can fabricate |
| 7 | **Four binary trust ticks** | Scan, licence, originality, provenance. Binary, never scored |

**Not in the top layer:** stars, download totals, star ratings, size in MB, raw LOC, complexity, or any self-reported claim.

### 9.2 Expert layer

```
COMPOSITION            text 220 KB · binary 66 KB (23%)
                       python, bash · 18 files · max depth 3
                       effective words 7,019 (98% unique)
                       effective LOC 1,869 (99% unique)
DEPTH BREAKDOWN        volume        ██████████████████░░  78
                       executable    █████████████████░░░  73
                       structure     ███████████████░░░░░  66
                       documentation █████████████████░░░  73
                       verification  ████████████░░░░░░░░  55
                       integrity multiplier  ×1.00
ENGINEERING            duplication 1.5% · circular deps 0
                       9 direct deps · 41 transitive · max depth 4
                       tests 3 files · assertion density 4.2/test
HISTORY                34 releases · 2 authors · first listed 2026-01-14
                       median 12 days between releases
PROVENANCE             built and signed on GitHub Actions
                       adrian/humanizer @ a1b2c3d · public ledger entry
ORIGINALITY            max similarity to any public repo: 0.04
SAFETY                 scanner 2026.08.2 · 0 findings
                       checked: secrets, network egress, filesystem writes,
                       dependency CVEs, prompt injection in descriptions
COMPUTED               2026-08-28 16:20 UTC · analyzer depth-1.0.0
```

Two disclosure rules: every number carries **when it was computed and by which analyzer version**, and computed facts are visually separated from creator-supplied ones.

### 9.3 Agent layer — `GET /v/{channel}/label`

Free, cacheable, unauthenticated, alongside `/latest` (PRD FR-16).

```json
{
  "channel": "adrian/humanizer",
  "artifact_class": "Harness",
  "depth_score": 63,
  "depth_percentile_in_class": 0.81,
  "computed_at": "2026-08-28T16:20:00Z",
  "analyzer_version": "depth-1.0.0",
  "release": { "version": "2.4.1", "published_at": "2026-08-21", "artifact_sha256": "9f2c…" },
  "composition": {
    "effective_doc_words": 7019, "effective_code_lines": 1869, "files": 18,
    "text_bytes": 225280, "binary_bytes": 67584, "languages": ["python","bash"],
    "components": { "skills": 1, "mcp_servers": 0, "agents": 0, "hooks": 0, "scripts": 9 }
  },
  "context_cost": { "always_loaded_tokens": 8292, "on_demand_tokens": 20821,
                    "progressive_disclosure_ratio": 0.40 },
  "engineering": { "test_files": 3, "duplication_pct": 1.5,
                   "unique_5gram_ratio": 0.99, "circular_deps": 0 },
  "provenance": { "build_attested": true, "source_commit": "a1b2c3d" },
  "originality": { "max_corpus_jaccard": 0.04, "nearest_match": null },
  "maintenance": { "releases": 34, "median_days_between_releases": 12,
                   "substantive_change_last_release": { "files": 6, "lines": 210 } },
  "safety": { "verdict": "pass", "scanner_version": "2026.08.2", "findings": [] },
  "licence": { "spdx": "MIT", "attribution_included": true, "resale_permitted": true },
  "adoption": { "active_subscribers": 141, "on_latest_release_pct": 0.78 },
  "integrity_multiplier": 1.0,
  "self_reported": { "description": "…", "demo_video_url": "…" }
}
```

**`self_reported` is a namespaced sub-object** so a consuming agent can discard every unverified claim in one line.

### 9.4 What the creator must supply

Following Envato and PromptBase, both mandatory:

1. A description stating **what it does and when to trigger it**, third person, not keyword-stuffed. skillscore weights description quality 25/100, the highest single category.
2. **Example inputs and outputs — real, reproducible, and generated by the listed release.** If a buyer cannot read the prompt before paying, let them read what it produces. This is the cheapest version of the co-founder's demo-video instinct.

   **This requirement has teeth because a competitor already broke it.** Agensi's listings show an "Example session with this skill installed" and "an example file from a real run" — both are **staged demo artifacts**, not the skill's actual output. Fabricating a preview is worse than showing nothing: it is the one competitor failure you can be publicly attacked for imitating. Generate examples by executing the artifact in the sandbox, stamp them with the release version and run timestamp, and regenerate on every release.

## 9a. Disclosure design: making the label trustworthy

Computed signals are worth nothing if the surrounding design lets a creator fake, delete or bypass them. Five marketplaces were audited for how they structure and enforce disclosure. The organising finding:

**Every field splits into one of three provenance classes, and they must never share a namespace.**

| Class | Examples elsewhere | Trustworthiness |
|---|---|---|
| **Computed from the artifact** | Apple `Size` and `Compatibility`, Play `Requires Android X.X`, Unity `Original Unity version`, Gumroad `Length: 904 pages` | High. Cannot be faked without changing the artifact |
| **Computed from behaviour** | sales counts, install buckets, ratings histograms, Envato author badges | High but lagging. Zero on day one |
| **Self-reported into a form** | privacy labels, Play Data safety, Unity Technical details, Envato attribute panel | Attestation only. Measured non-compliance runs **16–80%** |

Apple's product page states the rule out loud: everything derived from the binary is trustworthy, everything derived from a form is an attestation — and it prints *"This information has not been verified by Apple"* directly beneath the label.

### 9a.1 Four design bugs to avoid, each observed live

**Do not let computed and self-reported fields share a namespace.** Gumroad's worst bug: custom attributes and computed attributes live in one free-text-keyed list, so `Size: A4` (typed by the seller) renders identically to `Size: 28.3 MB` (computed from the file). Observed live: `Pages: "240+ page guide • 90+ pages of printables • Lifetime access"` — a marketing sentence in a field named `Pages`. **And the seller can delete the computed rows.** Namespace them, badge them visually, make them undeletable.

**Do not gate computed metadata on a simplicity condition.** Gumroad renders `Size`, `Duration`, `Length` and `Resolution` **only when a product has exactly one file** — so its four good fields vanish precisely when a product becomes substantial enough to need them. Aggregate instead of gating.

**Do not let sellers replace the disclosure chrome.** Gumroad's custom landing pages replace the entire product page *"including the price and the native button"* — ratings, refund policy, sales count and every computed row disappear unless manually re-added. **If disclosure is a marketplace guarantee rather than a template default, the platform must render it in a frame the seller cannot replace.**

**A mandatory field with a zero-effort default collects the default.** 41.8% of labelled iOS apps declare "Data Not Collected", which the longitudinal researchers read as an artifact of being forced to pick something. **Compulsory disclosure without cheap-to-do-correctly converts non-disclosure into misdisclosure — which is worse, because it looks like information.** This is the argument for computing rather than asking wherever a computation exists.

### 9a.2 Verify the "all clear" state first

The highest-signal claim is always the least reliable, because it has the biggest payoff and the lowest apparent cost:

| Claim | Measured reality |
|---|---|
| iOS "Data Not Collected" | **80.2% contain at least one tracker library** (Kollnig, FAccT 2022, n=1,759) |
| iOS "Data Not Collected" | **97% have a privacy policy indicating otherwise** (Balash, n=474,669) |
| iOS labels generally | **67.1% non-compliant** (Lalaine, USENIX Security 2023, n=5,102) |
| German iOS apps | **≥16% violated their own label** under traffic testing (Koch, PoPETs 2022) |

**The git analogues to check first are obvious: "no dependencies", "100% test coverage", "no telemetry", "MIT licensed", "original work".** Those are the cheapest claims to falsify and the most damaging to leave unchecked.

### 9a.3 Enforcement patterns that work

Ranked by leverage. These are what separate a trust badge from trust theatre.

**1. Behavioural demotion beats gatekeeping.** Google Play publishes hard thresholds — **1.09% user-perceived crash rate, 0.47% ANR**, 28-day rolling — and the consequence is that the app becomes *"less discoverable"* **and a warning renders on its own store listing**. No human adjudication, no removal, no appeal queue.

**2. The ratchet is the most elegant mechanism in the survey.** Play's target-API-level rule does not remove abandoned apps; it makes them **invisible to new devices**. Self-cleaning and automatic. The direct analogue here is model-epoch freshness (§6): an artifact pinned to a superseded model or spec revision quietly loses ranking rather than getting deleted.

**3. Economic and effort proof-of-work filters junk better than review.** Gumroad's Discover gate requires **$100 in genuine sales** — explicitly excluding self-purchases and purchases from your partner or housemate — plus manual risk review. Play requires **12 testers opted in continuously for 14 days** for new personal accounts. Both are unfakeable at scale in a way a submission form never is. This is the strongest argument for the refundable listing stake (PRD D2c).

**4. Couple every optional disclosure to a distribution surface.** Gumroad's sharpest incentive: turning off ratings display also **delists the product from Discover.** You cannot hide bad reviews and keep distribution.

**5. Enum the headline claim, free-text only the elaboration, and check for contradiction.** Gumroad's refund policy title is a closed enum; the fine print is free text; **an AI classifier rejects the save if the fine print contradicts the enum**, failing closed on timeout. Cheap, high-signal, and directly transferable to "support commitment", "test coverage claim" and "licence".

**6. Sellers should earn behavioural signals and never type them.** Envato's entire author ladder — Elite Author at $75k lifetime sales, Power Elite at $1M — is derived from platform-recorded earnings and cannot be self-reported.

**7. Frictionless updating does not produce updating.** Apple removed every barrier to editing a privacy label — no app update required — and labels remain functionally write-once. **Removing friction does not create a trigger.** Attach re-confirmation to a recurring event: here, the release. Every release re-runs the analysis and re-stamps the label.

### 9a.4 Envato's live preview, and the git version of it

The single strongest substance mechanism found anywhere in the survey is Envato's mandatory live preview for web themes — reviewer-clicked, and *"must be fully functional and work as expected."* A running instance of the thing, before purchase.

**A git repo is a better case than anything these platforms handle.** The artifact is fully introspectable at listing time, cheaply. The equivalents are stronger and cost less: a green CI run **you executed**, a container that boots, `install && test` output, an ephemeral sandbox. **Run the repo at listing time and publish the transcript.** That is §10's week-4 sandbox item, and this is the argument for pulling it earlier if anything slips.

Envato also mandates documentation with a *specification* rather than an adjective: PDF or HTML, English, **online and publicly accessible — not behind a purchase gate**, covering installation, customisation, use and credited assets. It is a named, enumerated rejection reason. Most of that is automatable against a repo: does a README exist, does it have an install section, does it contain a usage example that parses, does it state a licence.

### 9a.5 Ban the medium of exaggeration

Apple's Guideline 2.3.4 is the one place a platform prohibits the *form* of a lie rather than the lie itself:

> "Previews may only use video screen captures of the app itself."

Combined with 2.3.3 — *"Screenshots should show the app in use, and not merely the title art, login page, or splash screen"* — it makes a whole category of misrepresentation structurally impossible rather than merely against the rules.

**Adopt it verbatim for demos:** any example output must be terminal or editor capture of the shipped artifact, executed by us, stamped with the release version and run time. This is the rule Agensi breaks (Battle Test §6.3a), and having it written down is what lets you say so.

### 9a.6 Two more worth copying

**Order tiers by buyer harm, worst first.** Apple's label runs *Used to Track You → Linked to You → Not Linked → Not Collected* — bad news at the top rather than buried in a flat list. Here: licence risk and vendored-code provenance above subscriber counts.

**Default definitions against the discloser.** Apple: *"Data collected from an app is often linked to the user's identity, **unless** specific privacy protections are put in place."* Anonymity is an affirmative claim. The analogue: **assume an artifact is unmaintained, untested, undocumented and licence-contaminated until the artifact proves otherwise.** Most self-disclosure regimes default to the flattering answer, which is exactly why they carry so little information.

## 10. What to ship, in order

Constraints applied: computable at cold start from the repo alone with no subscriber traffic, legible to a buyer in one sentence, and durable against an adversarial creator.

| # | Signal | Renders as | Why it earns the slot |
|---|---|---|---|
| **1** | **Artifact class** | `HARNESS · 1 skill · 9 scripts · 3 tests` | Literally the question in the brief. Categorical, cold-start-proof, validated against an adversarial fake |
| **2** | **Context cost** | `8.3k tokens loaded every run` | Nobody has it. Trivially computable. The most differentiated field available, and directly relevant to a buyer paying per release |
| **3** | **Integrity / originality** | `Original · no match in public corpus` | MinHash, ~50ms, perfect separation. Mitigates Battle Test KS-3, which is otherwise the hardest unsolved problem in the model |
| **4** | **Substantive-release rate** | `88% of releases shipped real changes` | The keystone. Without it, cadence is trivially forgeable, and charging for a release that changed nothing is the fastest way to lose the trust the whole thesis rests on |
| **5** | **Release Cadence Score** | `Ships every ~12 days · hits it 93% of the time` | Measures reliability, which Scorecard's `Maintained` check does not. Carries the "updates" differentiator |
| **6** | **Maintainer reality** | `3 humans · bus factor 2 · 57% of commits are bots` | Bot filtering is mandatory anyway; surfacing it is nearly free, and it is the risk a subscriber most needs to see |

**Deliberately excluded from V0:** stars and forks (§1), tests and CI presence (0% base rate at artifact level), repo size (§3.4), prose:code ratio (non-monotonic across tiers), coefficient of variation (no discrimination). Dependency vulnerabilities and licence conflicts are covered by the security-scan gate — do not duplicate them into the trust panel.

### 10.1 Build order

| Week | Ship | Rationale |
|---|---|---|
| **1** | Class badge: effective-volume classifier with the `unique_5gram >= 0.6` guard, component inventory, context cost | Prototype runs in 0.24s across 19 artifacts and already separates a Prompt from a System. **This alone solves the stated problem** |
| **2** | Integrity: MinHash corpus, scaffold-hash detection, TTR ceiling | Directly mitigates KS-3. Do not defer this — it is the licensing answer |
| **3** | The label: three-layer UI plus `GET /v/{channel}/label`, and `context_cost` in the 402 payload | Makes the work visible where the decision happens |
| **4** | Behaviour: sandbox load test and a Glama-style LLM judge, cached per artifact hash | MCP Queen found 17.2% of listed remote servers are dead. This is the only component that survives an LLM-equipped adversary |
| **Ongoing** | Substantive-change-per-release, wired to the charge decision | Never charge for a release that changed nothing |

Total pipeline cost measured: `git clone --filter=blob:none` 1.08s, full analysis of 19 artifacts 0.24s, MinHash ~50ms. Adding `scc` (18ms), `lizard` (345ms) and `jscpd` (14ms) keeps the whole thing **under five seconds per artifact**.

### 10.2 The one attack that stays open

| Attack | Cost | Defence | Residual |
|---|---|---|---|
| Pad with repeated code | minutes | unique 5-gram dedup | **Closed** — 0.14 vs 0.99, no overlap |
| Pad with random-word prose | minutes | TTR ceiling | **Closed** for naive attacks |
| **Pad with LLM-generated plausible prose** | **minutes** | Statistical signals fail here. Needs the LLM judge and semantic dedup against the artifact's own stated scope | **OPEN. This is the real threat** |
| Ship a 5 MB font pack | seconds | binary excluded from volume | Closed |
| Rebrand an MIT repo and relist | minutes | MinHash vs corpus | Mostly closed; a determined rewriter defeats it |
| Version-bump farming | seconds | substantive-change-per-release | Closed if the diff is ancestry-correct |
| Split one artifact into 10 channels | minutes | cross-channel MinHash, creator-level cadence | Closed |
| Squashed one-shot history | seconds | single initial commit >5k LOC, all commits inside one hour, zero reverts/merges | Mostly closed |

**Statistical text signals buy you a year, not a moat.** An LLM-equipped adversary produces natural type-token ratios and novel n-grams. The durable defences are the behavioural ones — does it load, does it do what it claims, do subscribers stay — and those need either a sandbox or traffic.

### 10.3 Planned supersession

PRD FR-27's adoption curve — what fraction of subscribers pulled the latest release, and how fast — is a **strictly better signal than 4, 5 and 6 combined**, and is genuinely uncopyable without operating the payment rail. It only needs subscribers.

Ship the six for cold start. Plan for adoption to take over the top of the card once a channel has traffic, and design the label now so that swap is not a redesign.

## 11. Tooling: what to actually install

Verified live 2026-08-28. Versions, maintenance status, and the traps.

### 11.1 Counting

**`scc` v4.0.0** (2026-08-24, Go, actively maintained) is the answer. Measured ~120 MB/s; published benchmarks put it at 907ms on the Linux kernel versus tokei's 1.42s and cloc's minutes. It respects `.gitignore` by default, emits `-f json`, and **v4 added in-process git-history analytics** — `--hotspots`, `--coupling`, `--authors`, `--timeline`, `--buckets N` — computed without shelling out to git or requiring the git binary.

Flags that matter here: `--no-min-gen` (exclude minified and generated), `-d/--no-duplicates`, `-u/--uloc` and `-a/--dryness` (unique lines — a cheap in-repo duplication signal), `--exclude-dir node_modules,vendor,third_party,dist`.

`GOGC=-1 scc .` speeds it up materially. `-c` (skip complexity) gains 8–20%.

**Do not use scc's Complexity column as a quality signal.** It is not cyclomatic complexity — it is a per-language keyword substring counter, and scc's own docs say results are *"only comparable to files in the same language."* Same for its COCOMO and LOCOMO cost estimates: monotone functions of SLOC, seductive because they render as dollars.

`cloc` is Perl, single-process by default, roughly 50–100x slower. `tokei` is fine but slower than scc and has not shipped since December 2025.

### 11.2 Language classification

**`go-enry` v2.9.6** is the practical choice — but know what you are getting:

- It is on autopilot: maintenance is largely a daily GitHub Action that opens a PR per Linguist release. Its pinned Linguist commit is **v9.5.0 while Linguist is at v9.7.0** — about two releases and five months behind.
- **It does not support `.gitattributes` overrides at all.** For most users that is a parity bug. **For us it is arguably correct:** `.gitattributes` is creator-controlled, so `linguist-vendored` and `linguist-generated` are things a creator can assert about their own repo. Never trust them as your sole vendored-code filter regardless — use path and extension heuristics you own.
- Several `heuristics.yml` rules fail to compile under Go's RE2 (no lookbehind), so `.txt`, `.sol`, `.inc` and a few others misclassify. Building with the `oniguruma` tag fixes those and gives a 1.5–2x speedup.
- The `enry` CLI is dead (last release 2023). Use the library.

Linguist's own exclusion rules are worth copying directly: only `programming` and `markup` types count toward stats; vendored, documentation, generated, LFS pointers, binaries, symlinks and submodules are excluded. And note the cliff — **a tree with ≥100,000 entries gets no language stats at all** (`MAX_TREE_SIZE`).

### 11.3 Security and dependencies

| Tool | Version | Use |
|---|---|---|
| `syft` | v1.51.1 | SBOM generation. `syft . -o spdx-json` |
| `grype` | v0.118.0 | Vulns. **`grype sbom:./sbom.json`** — generate the SBOM once, scan many times |
| `trivy` | v0.74.0 | Repo scanning. Auto-extracts git metadata into JSON output — free provenance |
| `osv-scanner` | v2.5.1 | Lockfile scanning, respects `.gitignore`, has an offline mode |

All four actively maintained.

**OSV.dev has no documented rate limits and needs no auth** — *"Currently there are no limits on the API."* But it has two hard operational limits that will bite a naive client:

- **32 MiB response ceiling on HTTP/1.1, unlimited on HTTP/2.** Use HTTP/2.
- **A response may contain only a `next_page_token` and zero results**, meaning more data exists but was not found inside the time budget. A client that stops on an empty result set **silently under-reports**. Keep paging until the token disappears.

At scale, batch via `/v1/querybatch` and consider osv-scanner's offline mode rather than hammering the API.

### 11.4 Scorecard, if you use it at all

18 checks run by default; `Webhooks` and `SBOM` are experimental and gated behind `SCORECARD_EXPERIMENTAL`. Accepts comma-separated tokens for round-robin (`GITHUB_AUTH_TOKEN=tok1,tok2,tok3`) — the main scaling lever.

Three operational traps:

1. **Branch-Protection returns `-1`, not `0`, for repos you do not own.** Verified live against `psf/requests`, `kubernetes/kubernetes` and `expressjs/express`, all `-1`. `-1` means inconclusive and is excluded from the aggregate. **Scoring it as 0 would systematically penalise every repo you do not administer.**
2. **The rate-limit handler blocks rather than failing.** On a 429 it sleeps until reset and recursively retries, with no retry cap and no jitter. A rate-limited run can silently block for up to an hour per request.
3. **The public API returns only 14 checks for cron-scanned repos**, not 18. The documented blacklist explains three of the four omissions; **`Vulnerabilities` is also missing from every sampled result despite not being blacklisted.** Do not assume it is available.

For bulk work read BigQuery (`openssf:scorecardcron.scorecard-v2_latest`) rather than making 1.3M HTTP requests. Refresh is weekly; budget up to ~10 days of staleness.

### 11.5 Licence detection — and a correction to the PRD

GitHub's licence API runs **licensee** (v10.1.0, active) with a **98% Sørensen–Dice confidence threshold**, against the *choosealicense.com shortlist* rather than full SPDX, on a single top-level licence file. It does not read per-file SPDX headers, does not parse licence expressions, and **returns no result at all when a project has multiple ambiguous matches**.

Measured today:

```
torvalds/linux    → key: other, spdx: NOASSERTION
ffmpeg/FFmpeg     → key: other, spdx: NOASSERTION
nodejs/node       → key: other, spdx: NOASSERTION
golang/go         → key: bsd-3-clause
facebook/react    → key: mit
```

**`NOASSERTION` means "GitHub could not tell," not "unlicensed."** Linux, FFmpeg and Node all hit it.

**This breaks PRD FR-4 as written** — blocking channel creation whenever the licence is absent or unrecognised would reject legitimate, well-licensed projects. Three-way handling instead:

| Result | Action |
|---|---|
| Recognised SPDX id, resale-compatible | Pass |
| `null` — no licence file at all | **Block.** All rights reserved; resale is infringement |
| `other` / `NOASSERTION` | **Do not block.** Route to a manual or deeper check — run scancode, or ask the creator to confirm and attest |

`askalono` is **archived** (last release Oct 2024) — do not build on it. `scancode-toolkit` v32.5.0 is active and is the right per-file fallback for the `NOASSERTION` bucket; it is slow, so run it only on that subset.

### 11.6 Git history analytics: three of four are dead

| Tool | Status |
|---|---|
| `hercules` (src-d) | **Dead.** Last release Jan 2020, last commit Nov 2022, src-d folded, 50 open issues, no maintained fork. The most capable engine of the four and a genuine loss |
| `gitinspector` | **Dead.** Default branch last touched Oct 2020, last release 2016, PyPI 2015, Python 2 era. Note `pushed_at` reads 2024 — that is a non-default branch, do not be fooled |
| `git-of-theseus` | **Dormant.** Last commit Nov 2023, PyPI Mar 2023. Still runs; uniquely good at Kaplan–Meier code-survival curves. Vendor it and accept you own it |
| **GrimoireLab / Perceval** | **Active.** v1.21.0 / v1.5.0, June 2026. The only maintained option, but a heavyweight platform. `perceval git` standalone is fine if you just want normalised commit JSON |

**Use `scc --hotspots --coupling --authors --timeline` instead.** It covers a meaningful slice of what hercules did, is maintained, is fast, and needs no git binary.

## 12. Two things worth escalating

**8.1 The incumbent's provenance gap is bigger than the PRD assumed.** Across 290 plugins in Anthropic's official marketplace: **237 of 237 remote sources are SHA-pinned (100%)** — immutability is solved — but only **1 of 237 uses a semver tag as its ref**. 80 track a bare branch and 153 specify no ref at all. Only **14 of 290** declare a `version` field.

The incumbent has provenance and **no release discipline whatsoever**. That is exactly the gap the "updates" differentiator targets, and it is now measured evidence rather than an assumption.

**8.2 `--depth=1` would have silently corrupted every metric.** See §2.1. It needs a hard rule and a test, because the failure is silent and the numbers look plausible.

---

## Sources

**Verified in this pass** — measured directly, or fetched and read:

- [OpenSSF Scorecard checks](https://github.com/ossf/scorecard/blob/main/docs/checks.md) and [aggregate score source](https://github.com/ossf/scorecard/blob/main/pkg/scorecard/scorecard_result.go)
- [OpenSSF Criticality Score](https://github.com/ossf/criticality_score)
- [Libraries.io SourceRank source](https://github.com/librariesio/libraries.io/blob/main/app/models/concerns/source_rank.rb)
- [npms-analyzer scoring source](https://github.com/npms-io/npms-analyzer/blob/master/lib/scoring/score.js)
- [Avelino et al., Truck Factor, ICPC 2016](https://arxiv.org/abs/1604.06766)
- [Valiev, Vasilescu & Herbsleb, ESEC/FSE 2018](https://cmustrudel.github.io/papers/fse18sustainability.pdf)
- [CHAOSS Contributor Absence Factor](https://chaoss.community/?p=3944)
- [linguist generated.rb](https://github.com/github-linguist/linguist/blob/master/lib/linguist/generated.rb) and [vendor.yml](https://github.com/github-linguist/linguist/blob/master/lib/linguist/vendor.yml)
- [GitHub REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) and [GraphQL rate/node limits](https://docs.github.com/en/graphql/overview/rate-limits-and-node-limits-for-the-graphql-api)
- Measurements against `anthropics/claude-code`, `modelcontextprotocol/servers`, `microsoft/vscode`, `pallets/flask`, `django/django`, `pbakaus/impeccable`, the 290-plugin official marketplace, and a 247-file `SKILL.md` corpus

**Removed as unverified:** vendor prompting and migration guides, arXiv:2311.11123 statistics, arXiv:2307.09009, MCP versioning specifics, MCPB manifest spec, agentskills.io specification, and the `oh-my-openagent` issue. See §6.
