# Public tree

The documents that live in this repository, and what each one is for. Code, tests,
migrations and scripts are not listed here; this is the prose a contributor reads.

Some documents cited in code comments and in DECISIONS.md (for example BLOCKERS, RED-TEAM,
Battle Test, MIGRATION-PRD, ENV-SYNC) are internal and not published.

When a document is added to the repository or taken out of it, update this file,
[AGENTS.md](../AGENTS.md) and [CLAUDE.md](../CLAUDE.md) in the same change.

## At the root

| Document | What it is |
| --- | --- |
| [README.md](../README.md) | What the product is, the API, the MCP server, and how to run it |
| [AGENTS.md](../AGENTS.md) | Orientation for AI agents and new contributors: the document map, the stack, the rules that bite |
| [CLAUDE.md](../CLAUDE.md) | Claude Code project instructions; agrees with AGENTS.md |
| [PRD Final.md](../PRD%20Final.md) | **The spec** (v1.1): decisions D1–D13, requirements FR-1–53, routes, data model, build order |
| [DECISIONS.md](../DECISIONS.md) | Dated log of implementation decisions not in the PRD. Append-only |
| [PRODUCT.md](../PRODUCT.md) | Product truth for the UI: users, purpose, positioning, voice |
| [DESIGN.md](../DESIGN.md) | The visual system: tokens, type, layout rules |
| [server.json](../server.json) | The buy-side MCP server's entry in the official MCP Registry |
| [diagrams/](../diagrams/) | Archify specs and their rendered HTML (the payment split, the x402 exchange); `scripts/diagrams-to-tsx.mjs` bakes them into `/how-it-works` |

The licence, the security policy and the contribution guide are the standard root files
(`LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`).

## docs/

| Document | What it is |
| --- | --- |
| [README.md](README.md) | The index of `docs/` |
| [PUBLIC-TREE.md](PUBLIC-TREE.md) | This file |
| [SELF-HOST.md](SELF-HOST.md) | Run your own instance: local Supabase, your own GitHub App, payments on Base Sepolia, optional services, maintainer-only scripts |
| [ADMIN-NOTIFICATIONS.md](ADMIN-NOTIFICATIONS.md) | The admin notification channel (`lib/notify/`): what it sends, what it never sends, privacy and failure rules, bot setup |
| [BACKLOG.md](BACKLOG.md) | Ideas agreed in principle, not yet designed |
| [agent-discovery.md](agent-discovery.md) | How agents find listings: well-known documents, the MCP server card, skills, markdown negotiation, off-domain registries |
| [x402-upstream.md](x402-upstream.md) | The upstream x402 watch: versions, extensions adopted or declined, review log |
| [proposals/PRD Session Keys.md](proposals/PRD%20Session%20Keys.md) | Accepted amendment: dashboard session keys |
| [proposals/PRD Trust Report.md](proposals/PRD%20Trust%20Report.md) | Accepted amendment: the security scan report |
| [proposals/PRD Substance Classifier.md](proposals/PRD%20Substance%20Classifier.md) | Draft amendment: a substance classifier, disclosed and never a verdict |
| [research/Quality Signals.md](research/Quality%20Signals.md) | The quality-signal spec behind PRD §8.10 |
| [research/Gumroad Ideas.md](research/Gumroad%20Ideas.md) | Mechanics worth borrowing from the Gumroad codebase |
| [research/Agent Discovery Channels.md](research/Agent%20Discovery%20Channels.md) | How agents find paid services off-domain, and where x402git stands in each |

## Shipped with the product

| Document | What it is |
| --- | --- |
| `lib/skills/buy-a-repo.md`, `lib/skills/sell-a-repo.md` | The agent skills served under `/.well-known/agent-skills/` and mirrored to `pcmarts/x402git-skills` |
| `public/terms.md`, `public/buyer-terms.md`, `public/abuse.md` | The site's creator terms, buyer terms and notice-and-takedown policy, served as pages |
| `lib/licences/*.txt` | The canonical SPDX texts of the FR-11 allow-list, committed into a Rail B repository when its creator picks a licence |
| `.impeccable/` | Shared configuration for the impeccable design tooling, the listing-page design decision, and one recorded critique |
