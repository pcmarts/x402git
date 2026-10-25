# docs/

Everything that is not the live spec. The spec itself — [PRD Final.md](../PRD%20Final.md)
— stays at the repo root with [DECISIONS.md](../DECISIONS.md), [PRODUCT.md](../PRODUCT.md)
and [DESIGN.md](../DESIGN.md). Orientation for agents is in [AGENTS.md](../AGENTS.md), and
[PUBLIC-TREE.md](PUBLIC-TREE.md) lists every document this repository publishes.

Some documents cited in code comments and in DECISIONS.md (for example BLOCKERS, RED-TEAM,
Battle Test, MIGRATION-PRD, ENV-SYNC) are internal and not published.

## Living documents

- [ADMIN-NOTIFICATIONS.md](ADMIN-NOTIFICATIONS.md) — the Telegram channel that makes the
  PRD's "admin alert" real: the five kinds, what is deliberately never sent, the privacy
  and never-fail rules, setting up a bot and rotating its token, and
  `npm run telegram:check`. Optional: unconfigured, every send is a silent no-op.
- [BACKLOG.md](BACKLOG.md) — ideas agreed in principle, not designed yet. An idea goes
  into the PRD before it gets built; once it is there the item is marked accepted where it
  stands, with the answers to its open questions, rather than deleted.
- [PUBLIC-TREE.md](PUBLIC-TREE.md) — which documents live in this repository.
- [SELF-HOST.md](SELF-HOST.md) — run your own instance: local Supabase, your own GitHub
  App, payments on Base Sepolia, the optional services, and which scripts are
  maintainer-only.
- [agent-discovery.md](agent-discovery.md) — every discovery document an agent can find
  without being told (Link headers, the two well-known catalogues, the MCP server card,
  the agent skills, markdown negotiation, WebMCP), what each is generated from, and why
  DNS-AID is not published.
- [x402-upstream.md](x402-upstream.md) — the upstream x402 watch: what we run, what
  we adopted, what we declined and why, and the review log. `npm run x402:check` is the
  tool that feeds it.

## proposals/

PRD amendments, each written as its own document. Accepted ones are merged into PRD Final
and kept here for the argument behind the change.

- [PRD Session Keys.md](proposals/PRD%20Session%20Keys.md) — the dashboard stops
  borrowing the agent's credential (amends D11, FR-4, §9, §12, §14.7). **Accepted
  31 Aug 2026, implemented.**
- [PRD Trust Report.md](proposals/PRD%20Trust%20Report.md) — the scan publishes what it
  checked, discloses what it found, and inventories what the artifact can do; our own
  `lib/scan` rules for the artifact's files, Socket for what its dependencies do, no model
  in the loop (amends G5, FR-35, FR-37, FR-39, FR-41, FR-49, §9, §11, §12, §16).
  **Accepted 13 Sep 2026, building** — the four §10 answers are recorded there and the
  build order is §9. Preflight: `npm run socket:check`.
- [PRD Substance Classifier.md](proposals/PRD%20Substance%20Classifier.md) — a fast
  evaluation model (`typesafe-ai/jev`) reads each file and the description, to answer
  *how much of this is substance* and *does it do what it claims*; disclosed in the
  `review` tier, never a verdict (would amend §8.10, FR-51, FR-53, §11, and two of the
  trust report's non-goals). **Draft, not accepted** — the open questions are §7 and the
  first build step needs no amendment.

## research/

Background material the PRD was built from. Referenced by the spec; not itself spec.

- [Quality Signals.md](research/Quality%20Signals.md) — the manifest/quality-signal
  spec, the product's differentiator (full spec behind PRD Final §8.10).
- [Gumroad Ideas.md](research/Gumroad%20Ideas.md) — mechanics worth borrowing from the
  Gumroad codebase, filtered against the PRD's non-goals.
- [Agent Discovery Channels.md](research/Agent%20Discovery%20Channels.md) — how agents
  find paid services off-domain (Bazaar, skills registries, search, MCP registries),
  where x402git stands in each as of 16 Sep 2026, and the ranked candidates for
  automatic discovery.
