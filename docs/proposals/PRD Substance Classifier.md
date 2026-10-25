# PRD: The substance classifier — a second opinion on what is actually in a listing

**Status:** Draft, not accepted · **Amends (if accepted):** PRD Final v1.1 (§8.10, FR-51, FR-53, §11 implementation table, §16) and "PRD Trust Report.md" §3 non-goals · **Date:** 21 Sep 2026

---

## 1. Problem

A creator uploads nine files of markdown that restate Anthropic's own skill-authoring
docs, writes a description claiming a complete automation framework, and lists it at $9.
Nothing we compute today objects.

FR-47's class badge answers *how big*. It does not answer *is it any good*, and it was
never meant to — Quality Signals §3.1 is explicit that class is categorical and that a
good Prompt must not look like a bad Harness. But that leaves the gap that prompted this
document: **a good nine-file prompt and a bad one classify identically.**

The dedup guards do not close it. Quality Signals §10.2 tabulates every padding attack
and marks them all *Closed* except one:

> **Pad with LLM-generated plausible prose** — *Statistical signals fail here... Needs the
> LLM judge and semantic dedup against the artifact's own stated scope.* **OPEN. This is
> the real threat.**

The measurement behind that is in §3.3: the deliberately padded fake scored
`unique_8gram = 1.000` — *the most novel text in the corpus*. N-gram dedup and type-token
ratio catch random-word slop. They are blind to competent generated prose, which is what
a creator with a frontier model produces in an afternoon.

Second gap, smaller and cheaper to close: the description and trigger hint are **required**
(FR-51) and **self-reported**, and the only thing that checks them against the artifact is
FR-53, which verifies three hardcoded claims — "no dependencies", "no telemetry",
"MIT licensed". Every other claim a creator makes about their own product goes unread.

## 2. Goal

Two questions, answered per release, cheap enough to run on every one, **disclosed and
never a verdict**:

1. **How much of this artifact is substance** — as against scaffold, vendored code,
   generated filler, or prose restating its own documentation?
2. **Does the artifact substantiate its own description?**

Both are semantic. Neither has a statistical proxy. That is the whole argument for putting
a model near them.

## 3. What is proposed

`typesafe-ai/jev`, an **evaluation** model on the Vercel AI Gateway. It takes typed
questions and returns choices, scores and boolean probabilities. It does not generate
text. Verified against the gateway's model list on 21 Sep 2026:

| | |
|---|---|
| id | `typesafe-ai/jev` · type `evaluation` |
| pricing | **$0.042 / M input tokens**, output free |
| `max_tokens` | `0` — it emits no text, only the typed answer |
| `context_window` | **32,000** |
| `zdr` / `no_training` | `all` / `all` |
| parallelism | multiple questions per request, per its own model card |

**Cost, for us.** A listing's text is on the order of 50k tokens. A full per-file pass is
therefore about **$0.002 per release**. Every release we have ever cut, re-run from
scratch, is small change. Cost stops being a design constraint.

**Latency, for us.** ~200ms per call. PRD §7 promises push webhook → analysis → snapshot
→ scan → release row *"within seconds"*. A reasoning model breaks that promise and would
have to become an async job with its own state. This does not.

**The property that matters most.** The 32k window means we cannot hand it an artifact;
we must ask per file. That looks like a limitation and is the opposite. **The input is the
citation.** We feed one file and get back a verdict keyed to that file, so there is no
citation for the model to invent and nothing for us to verify after the fact. A generative
judge asserting "line 41 of `run.py` is filler" has to be checked. This does not.

## 4. Shape of the decision

Four stages. Only stage two is new machinery.

1. **Decompose the description.** One generative call, on the creator's own words only —
   no source code leaves anywhere at this stage. Out: a list of discrete claims.
2. **Ask Jev, per file, all questions in one request.** Routed by the FR-47 class, so a
   Prompt is graded as a Prompt:
   - `supports_claim[i]` — boolean probability, one per claim from stage 1
   - `content_kind` — choice: `substantive · scaffold · vendored · generated-filler · restates-docs`
   - `dead_weight` — would removing this file change what the artifact does?
   - `reachable` — is this referenced from the entry point?
3. **Aggregate deterministically**, in TypeScript, in `lib/analysis/`. Out: a filler share,
   a dead-weight share, and a claim ledger — *claim 3 of 5 is unsupported anywhere in the
   artifact*, with the file list as evidence.
4. **Explain, only above threshold.** A generative call on the small subset of files that
   tripped, to produce the sentence a creator can act on. Slow is fine; the subset is small.

**Where the output lands: the `review` tier.** "PRD Trust Report.md" §4.1 already invented
the disposition for model-derived signals — *flagged for review, with an admin alert, never
a verdict*. This is the same class of thing and needs no new policy.

## 5. What this costs us, stated plainly

It crosses two non-goals accepted eight days ago, in "PRD Trust Report.md" §3:

> - **An LLM reading each repository.** No Claude-Code-per-repo scan, no "AI review" badge.
> - Sending the creator's source anywhere. [...] the artifact's own code never leaves our
>   storage. D3a holds.

On the first: **the reasoning behind it holds and is not touched here.** That non-goal
exists because *"a finding is reproducible from the bytes and the rule, which is what lets
us publish it"* — a property the **scan** must have, because the scan produces a verdict
that blocks a sale. The scan stays deterministic, stays in `lib/scan/`, stays model-free.
This proposal is the **quality label** (§8.10), a different surface that produces no
verdict and blocks nothing.

On the second: **this is a real amendment and should be argued, not finessed.** The
artifact's text would go to a third-party model under `zdr: all` and `no_training: all`.
That is materially weaker than "never leaves our storage", and if accepted it has to be
said out loud on the trust report and in the creator agreement rather than buried. The
alternative — a local model in a serverless function — is not available to us at this
size.

## 6. Non-goals

- **A score.** Quality Signals §8 and the crates.io RFC 1824 warning both stand: the
  diagnosis is that listings are indistinguishable, and another opaque 0–100 recreates
  that one level up. Output is a ledger and a sentence.
- **A gate.** Quality Signals §9a.3: behavioural demotion beats gatekeeping. Nothing here
  blocks a publish or a sale.
- **Anything inside the scan.** FR-35's six blocking classes (five until 25 Oct 2026) are untouched.
- **Executing creator code.** NG6 holds; every question is asked of static text.
- **Ranking.** NG1 holds. `search_listings` still orders by text match, then name.

## 7. Open questions — the reason this is a draft

1. **Ground truth.** Nothing can be thresholded without it. Will we label 60–100 real
   listings by hand, good / thin / slop? Without that, this ships vibes with a version
   number on them.
2. **Calibration.** A confidence of 0.8 is worth having only if it is right 80% of the
   time. Unmeasured on this domain.
3. **Cheap cuts both ways.** At $0.042/M a creator can iterate thousands of attempts
   against our classifier for under a dollar — strictly worse than an expensive judge on
   the adversarial axis. Argues for publishing aggregates, never per-file verdicts, and
   for never making this the sole input to anything.
4. **How much is public?** Creator-facing only, buyer-facing, or in `/api/label`? FR-52's
   contract — every computed number carries computed-at and analyzer version — requires a
   caching rule: key on `artifact_sha256` + question-set version + model id, and treat a
   model change as an analyzer-version bump.
5. **Does it touch price or discovery at all**, or is it disclosure only? Disclosure only
   is the safe answer and the one this draft assumes.

## 8. Build order

| # | Ship | Why first |
|---|---|---|
| **1** | **Classify the description alone**, creator-facing in the dashboard, pre-publish | Short, self-reported, no source code involved, so §5's amendment is not yet needed. Validates the model on our domain for nothing |
| **2** | Label the corpus; measure agreement and run-to-run variance | Q1 and Q2. Gate on this before anything faces a buyer |
| **3** | Per-file substance pass, admin-visible only | The §10.2 attack, closed or not closed — measurable either way |
| **4** | Claim ledger, creator-facing | Turns FR-53's three claims into all of them |
| **5** | Publish into the `review` tier | Only if 2 and 3 came back well |

Stage 1 needs no PRD amendment. Stage 3 is where §5 has to be argued and settled.

## 9. What it amends, if accepted

- **§8.10** — a new FR for the substance and claim signals, disclosed, `review` tier, no verdict.
- **FR-51** — the description is checked against the artifact, not merely required.
- **FR-53** — generalised from three hardcoded claims to every claim the description makes.
- **§11 implementation table** — the row that reads *"no model is in the loop"* becomes
  true of the scan specifically, not of the platform.
- **§16** — deferred items unchanged; this is additive to V0 §8.10, not a promotion of
  the Depth Score.
- **"PRD Trust Report.md" §3** — the two non-goals in §5 above, narrowed to the scan.
- **lib/terms.ts** — the analysis clause names third-party model processing under ZDR.

---

**Related:** [Quality Signals.md](../research/Quality%20Signals.md) §3.3, §10.2, §9a.3 ·
[PRD Trust Report.md](PRD%20Trust%20Report.md) §3, §4.1 · PRD Final §8.10, §7, §11, §16
