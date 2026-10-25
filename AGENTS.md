# Agent guide — X402 Git

Read this first if you are an AI agent (or a new human) editing this repository.
Claude Code also loads [CLAUDE.md](CLAUDE.md); the two files agree — this one carries
the orientation and the document map, that one carries Claude-specific tooling notes.

## What this is

Paid access to private git repos over x402/USDC, for humans and agents. A creator
points a listing at a repo and sets a price; every release is snapshotted, scanned and
licence-checked before it can be sold; the public manifest is the store page; a buyer
pays a 402 and gets a five-minute signed URL over the exact bytes that were scanned.

## Document map

**The spec is [PRD Final.md](PRD%20Final.md) (v1.1)** — decisions D1–D13, requirements
FR-1–53, routes (§9), data model (§12), build order (§15). Do not relitigate settled
decisions; if the code needs to deviate, change the PRD first and say why.

At the root, alongside it:

| File | What it is |
| --- | --- |
| [README.md](README.md) | Public-facing: what the product is, the API, the MCP server |
| [CLAUDE.md](CLAUDE.md) | Claude Code project instructions (mirrors this file's rules) |
| [DECISIONS.md](DECISIONS.md) | Dated log of implementation decisions *not* in the PRD. Code comments cite it by name — append, never rewrite history |
| [PRODUCT.md](PRODUCT.md) | Product truth for the UI (used by the impeccable design tooling — stays at root) |
| [DESIGN.md](DESIGN.md) | The visual system: tokens, type, layout rules (also impeccable-owned — stays at root) |
| [server.json](server.json) | The buy-side MCP server's entry in the official MCP Registry (`com.x402git/git-x402`); see docs/agent-discovery.md |

Everything else lives under [docs/](docs/):

| Location | Contents |
| --- | --- |
| [docs/README.md](docs/README.md) | The index of `docs/`, a paragraph per document |
| [docs/PUBLIC-TREE.md](docs/PUBLIC-TREE.md) | Which documents this repository publishes |
| [docs/ADMIN-NOTIFICATIONS.md](docs/ADMIN-NOTIFICATIONS.md) | The admin notification channel (`lib/notify/`): the five kinds it sends, what it deliberately does not, the privacy and never-fail rules, and how to point it at your own Telegram bot. Optional: with `TELEGRAM_*` unset every send is a silent no-op |
| [docs/BACKLOG.md](docs/BACKLOG.md) | Ideas agreed in principle, not yet designed. Goes through the PRD before build |
| [docs/SELF-HOST.md](docs/SELF-HOST.md) | Run your own instance: local Supabase, your own GitHub App, payments on Base Sepolia, the optional services, and which scripts are maintainer-only |
| [docs/agent-discovery.md](docs/agent-discovery.md) | The discovery layer: Link headers, `/.well-known/*`, the MCP server card, agent skills, `Accept: text/markdown`, WebMCP, Content Signals — and why DNS-AID is not published |
| [docs/x402-upstream.md](docs/x402-upstream.md) | The upstream x402 watch: versions we run, extensions and schemes adopted or declined with reasons, and the review log. Fed by `npm run x402:check` |
| [docs/proposals/](docs/proposals/) | PRD amendments written as their own document (session keys, trust report, substance classifier). Accepted ones are merged into PRD Final and kept here for the argument |
| [docs/research/](docs/research/) | Background: the Quality Signals spec, the Gumroad study, agent discovery channels |

Some documents cited in code comments and in DECISIONS.md (for example BLOCKERS, RED-TEAM,
Battle Test, MIGRATION-PRD, ENV-SYNC) are internal and not published.

Code comments reference documents by bare filename ("see DECISIONS.md", "PRD Final.md
§11"). Filenames are therefore load-bearing: move a document if you must, but never
rename one without sweeping the comments.

## Stack

Next.js 16 App Router on Vercel · TypeScript · plain CSS (tokens from DESIGN.md, no
Tailwind) · Supabase Postgres + Storage · `@x402/core` + `@x402/evm` called directly
(never the static-price middleware, never `x402-next`) · GitHub App via `@octokit/app` ·
viem · zod (the OpenAPI document is generated from the zod schemas).

This repo's Next.js version may be newer than your training data — read the guides in
`node_modules/next/dist/docs/` before writing framework code.

## Commands

```
npm run dev          # http://localhost:3000
npm run typecheck
npm test             # vitest
npm run check:ssr    # PRD §14.1 — page text must be in server HTML (dev server must be running)
npm run detect       # impeccable design detector over app/
npm run build
npm run app:check    # verify the GitHub App wiring
npm run x402:check   # what upstream x402 changed since docs/x402-upstream.md was last reviewed
npm run bazaar:check -- --all   # is each live listing declared to, and indexed by, the x402 Bazaar (indexed on its first sale)
npm run skills:publish          # maintainer-only: mirror lib/skills/*.md (+ MIT LICENSE) to github.com/pcmarts/x402git-skills (skills.sh, `npx skills add`); --check reports drift; --tag vX.Y.Z tags it and cuts a GitHub release
npm run e2e:fr34     # FR-34 end-to-end on Base Sepolia against a running deployment (--base http://localhost:3000); settles real testnet USDC; registration is rate-limited to 5/hour/IP, so about two runs an hour
```

`npm run env:status` / `env:pull` / `env:push` sync the maintainers' own `.env` files
through a shared password manager. They are maintainer-only, documented internally, and
not needed to run or develop the app.

## Layout

```
app/                Next.js routes (pages + /api)
lib/core/           access.ts — the entitlement + payment core
lib/x402/           flow.ts — the one 402 → verify → settle → grant sequence, shared by /api/r and MCP purchase
lib/                everything else: scan, zip, schemas, web loaders, openapi
supabase/migrations Schema (PRD §12), timestamped migrations
scripts/            check-ssr.sh, GitHub App setup/check, e2e harnesses, diagrams-to-tsx
docs/               everything that is not the live spec (see map above)
diagrams/           archify diagram specs; scripts/diagrams-to-tsx.mjs bakes them into app/how-it-works
```

## Rules that will bite you

- `lib/core/access.ts` is the only module that knows about entitlements or money.
  Every surface calls `quote`; only paid paths call `grant`. Never fork it.
- Money is `bigint` micro-USDC everywhere. Never a float. `9000000` is $9.00.
- Grant only after the facilitator's `settle` returns a tx hash. Nonce is `UNIQUE`.
- Payouts go only to the bound payout address. No `to` parameter exists anywhere.
- The server never sees a creator's private key (NG10).
- Server-render the manifest page; `npm run check:ssr` is the proof.
- Snapshot before you sell; serve the exact `artifact_sha256` that was scanned.
- UI work goes through the impeccable skill and detector; direction is **clean and
  simple** — no Tailwind defaults, no Inter, no cards-in-cards, no gradients.

## Working agreement

- Maintainers: for Supabase, use the `supabase` CLI only (migrations, SQL, inspection) —
  never the Supabase MCP tools.
- Maintainers: for Vercel, use the `vercel` CLI only (deploys, env vars, logs, project
  config) — never the Vercel MCP tools or dashboard-only workflows an agent can't reproduce.
- Tests: vitest for lib; the FR-34 end-to-end on Base Sepolia is the definition of
  done for the headless rail.
- Maintainers: commit small, on `main`; no force pushes. Nothing deploys or pushes automatically:
  production (x402git.com) and the linked database can lag `main` — check
  `supabase migration list --linked` and the Vercel deployment before assuming a
  change is live.
- New decisions that deviate from or extend the PRD get a dated entry in DECISIONS.md.
- New ideas go to docs/BACKLOG.md. Anything that needs a maintainer's hands (credentials,
  accounts, production) is tracked internally; open an issue for it.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
