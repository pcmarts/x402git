# X402 Git — project instructions

## What this is
Paid access to private git repos over x402/USDC, for humans and agents. **The spec is [PRD Final.md](PRD%20Final.md) (v1.1)** — decisions (D1–D13), requirements (FR-1–53), routes (§9), data model (§12), build order (§15). Do not relitigate settled decisions; if the code needs to deviate, change the PRD first and say why.

The full document map is in [AGENTS.md](AGENTS.md) (the published list is [docs/PUBLIC-TREE.md](docs/PUBLIC-TREE.md)); keep the two files in agreement. Spec-adjacent living docs stay at root (DECISIONS.md, PRODUCT.md, DESIGN.md, plus `server.json` for the MCP Registry); everything else is under `docs/` — the backlog, `ADMIN-NOTIFICATIONS.md`, `SELF-HOST.md`, `agent-discovery.md` and `x402-upstream.md` in `docs/`, background research (`Quality Signals.md`, `Gumroad Ideas.md`, `Agent Discovery Channels.md`) in `docs/research/`, and PRD amendments in `docs/proposals/`. Some documents cited in code comments and in DECISIONS.md (for example BLOCKERS, RED-TEAM, Battle Test, MIGRATION-PRD, ENV-SYNC) are internal and not published. Code comments cite these files by bare name, so never rename one without sweeping the comments.

## Stack
Next.js 16 App Router on Vercel · TypeScript · plain CSS (tokens from DESIGN.md, no Tailwind) · Supabase Postgres + Storage · `@x402/core` + `@x402/evm` called directly (not the static-price middleware; never `x402-next`) · GitHub App via `@octokit/app` · viem · zod (OpenAPI is generated from the zod schemas).

## Commands
```
npm run dev          # http://localhost:3000
npm run typecheck
npm test             # vitest
npm run check:ssr    # PRD §14.1 — page text must be in server HTML (dev server must be running)
npm run detect       # impeccable design detector over app/
npm run build
npm run x402:check   # what upstream x402 changed since docs/x402-upstream.md was last reviewed
npm run bazaar:check -- --all   # is each live listing declared to, and indexed by, the x402 Bazaar (indexed on its first sale)
npm run skills:publish          # maintainer-only: mirror lib/skills/*.md (+ MIT LICENSE) to github.com/pcmarts/x402git-skills (skills.sh, `npx skills add`); --check reports drift; --tag vX.Y.Z tags it and cuts a GitHub release
npm run socket:check # Socket preflight with your own token: org slug, plan, quota, supported manifest globs (read-only)
npm run telegram:check # optional admin-notification preflight, if you configure your own bot (docs/ADMIN-NOTIFICATIONS.md); --send posts samples
```
`npm run env:status` / `env:pull` / `env:push` (syncing the maintainers' `.env` files through a shared password manager) are maintainer-only, documented internally, and not needed to run or develop the app.

## Design
UI/UX guidance comes from **impeccable**. It is installed per machine, not committed: run `npx impeccable install --providers=claude --scope=project --yes` once after cloning (writes `.claude/skills/impeccable/` and the detector hook into `.claude/settings.local.json`, both gitignored). `.impeccable/config.json` and `PRODUCT.md` are committed and shared. Product truth is in `PRODUCT.md`; the visual system will live in `DESIGN.md` once decided via `/impeccable shape`. Before writing any UI, the skill runs; follow its directives. The design hook runs the detector after UI edits — fix findings, don't suppress them. Direction: **clean and simple**. No Tailwind defaults, no Inter, no cards-in-cards, no gradients.

## Architecture rules that will bite
- `lib/core/access.ts` is the only module that knows about entitlements or money. Every surface calls `quote`; only paid paths call `grant`. Never fork it.
- Money is `bigint` micro-USDC everywhere. Never a float.
- Grant only after facilitator `settle` returns a tx hash. Nonce is `UNIQUE`.
- Payouts go only to the bound payout address. No `to` parameter exists.
- The server never sees a creator's private key (NG10).
- Server-render the manifest page; `npm run check:ssr` is the proof.
- Snapshot before you sell; serve the exact `artifact_sha256` that was scanned.

## Layout
```
app/                Next.js routes (pages + /api)
lib/core/           access.ts (entitlement + payment core)
supabase/migrations PRD §12 schema, timestamped; Maintainers: check `supabase migration list --linked` before assuming remote parity
scripts/            check-ssr.sh, GitHub App setup/check, e2e harnesses, diagrams-to-tsx
docs/               everything that is not the live spec — see docs/README.md
```

## Working agreement
- Maintainers: for Supabase, use the `supabase` CLI only (migrations, SQL, inspection). Never the Supabase MCP tools.
- Maintainers: for Vercel, use the `vercel` CLI only (deploys, env vars, logs, project config). Never the Vercel MCP tools or dashboard-only workflows an agent can't reproduce.
- Build order is PRD §15: API in week 1, money in week 2, HTML in week 3.
- Tests: vitest for lib; the FR-34 end-to-end on Base Sepolia is the definition of done for the headless rail.
- Maintainers: commit small, on `main`; no force pushes.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
