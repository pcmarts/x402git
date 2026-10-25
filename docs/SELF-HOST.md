# Running x402git yourself

Last verified on 25 October 2026 up to step 2. Docker was not running on the test machine, so steps 3 onward come from reading the code and scripts and have not been run end to end. Step 5 records what the dev server did without a database.

This guide takes you from a clean machine to a local instance on **Base Sepolia**, with your own database, your own GitHub App and your own testnet wallets. Nothing here uses the x402git.com operators' accounts. The hosted service runs on Base mainnet; develop and test on Base Sepolia only.

## 1. Prerequisites

- **Node.js 22.** `.nvmrc` pins `v22.23.2` and `package.json` requires `>=22`. With nvm: `nvm install && nvm use`.
- **Docker**, running. The Supabase CLI starts the local database in containers. See https://docs.docker.com/get-started/get-docker/.
- **The Supabase CLI.** See https://supabase.com/docs/guides/local-development/cli/getting-started.
- **The GitHub CLI**, signed in (`gh auth login`). `npm run app:github` uses it to finish creating your App. See https://cli.github.com/.
- **A GitHub account** to own the App, and a private repo to list.
- **`openssl`**, to generate secrets.
- **Testnet wallets on Base Sepolia.** Step 7 explains which ones and how to make throwaway keys. Faucets:
  - Testnet USDC: https://faucet.circle.com/ (pick Base Sepolia).
  - Base Sepolia ETH: https://portal.cdp.coinbase.com/products/faucet, or the list at https://docs.base.org/base-chain/tools/network-faucets.

## 2. Get the code

```sh
git clone https://github.com/pcmarts/x402git.git
cd x402git
npm ci
npm run typecheck
npm test
```

The unit tests are hermetic: they mock the database and the facilitator, and need no `.env`. On a clean clone on 25 October 2026, `npm test` ran 135 test files (1,833 tests) and all passed in about 5 seconds. That run used Node 26.8.1 rather than the pinned 22.23.2.

npm 11 may warn that `@coinbase/x402` has a postinstall script not covered by `allowScripts`. That script only prints a notice about the x402 Bazaar terms. Nothing depends on it.

## 3. Start the database

```sh
supabase start
supabase db reset
supabase status
```

- `supabase start` runs Postgres 17 and the Supabase API locally, on the ports in `supabase/config.toml`: API on `http://127.0.0.1:54321`, Postgres on `54322`, Studio on `http://127.0.0.1:54323`. The first run downloads the images.
- `supabase db reset` drops the local database and applies every migration in `supabase/migrations/` in order. Run it again whenever you pull new migrations. `config.toml` names a `supabase/seed.sql` that does not exist, so the database starts empty: no creators, no listings.
- **Storage buckets: nothing to do.** No migration creates them. The app creates both on first use (`lib/storage.ts`): `artifacts` (private, holds the snapshots that are sold) and `readme-assets` (public, README images only, 2 MB per file, image types only).
- The app does not use Supabase Auth. Creators sign in with GitHub OAuth and the app keeps its own session cookie.

`supabase status` prints the values you need next. `supabase status -o env` prints the same values as `KEY=value` lines.

| `supabase status` shows | Goes into | Notes |
|---|---|---|
| API URL (`API_URL`) | `SUPABASE_URL` | `http://127.0.0.1:54321` |
| Secret key (`SECRET_KEY`) | `SUPABASE_SECRET_KEY` | Server only. It bypasses row-level security. The legacy service role key also works. |
| Publishable key (`PUBLISHABLE_KEY`) | `SUPABASE_PUBLISHABLE_KEY` | Declared in `lib/env.ts` but not read by the app. Optional. |
| DB password | `SUPABASE_DB_PASSWORD` | Used by the `supabase` CLI against a hosted project, never by the app. Not needed locally. |

## 4. Create your `.env`

```sh
cp .env.example .env
```

Use `.env`, not `.env.local`. `next dev` reads both, but `npm run app:github` writes to `.env` by default, and `npm run app:check` and the `e2e:*` scripts read only `.env`. Both files are gitignored.

Fill in at least these lines:

```sh
NEXT_PUBLIC_APP_URL=http://localhost:3000
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SECRET_KEY=<Secret key from supabase status>
SESSION_SECRET=<generate>
CRON_SECRET=<generate>
ABUSE_WEBHOOK_SECRET=<generate>
X402_NETWORK=base-sepolia
X402_FACILITATOR_URL=https://x402.org/facilitator
```

Write `NEXT_PUBLIC_APP_URL` without quotes. `npm run app:github` reads it with a plain pattern match.

### Secrets you generate yourself

Generate a separate value for each of the three:

```sh
openssl rand -hex 32
```

| Variable | What it does | If unset |
|---|---|---|
| `SESSION_SECRET` | Signs and encrypts the creator session cookie (`lib/web/session.ts`) and seals stored idempotent replies (`lib/idempotency.ts`). | Derived from a hash of `SUPABASE_SECRET_KEY`. That works, but rotating the Supabase key would then sign everyone out. Set it. |
| `CRON_SECRET` | The bearer token Vercel Cron sends to `/api/cron/*` (`lib/auth/cron.ts`). | Locally the cron routes are open, so you can call them by hand. In production (`VERCEL=1` or `NODE_ENV=production`) they refuse every call. |
| `ABUSE_WEBHOOK_SECRET` | Signs the abuse notices sent to a creator's `abuse_contact_url` (`lib/abuse-webhook.ts`). | No notice is sent. |

## 5. Run the app

```sh
npm run dev
```

You should see:

```
▲ Next.js 16.3.3 (Turbopack)
- Local:         http://localhost:3000
- Environments: .env
✓ Ready in …
```

With only the database and the secrets configured:

- These render: `/`, `/how-it-works`, `/docs`, `/docs/errors`, `/terms`, `/buyer-terms`, `/abuse`, `/signin`, `/api/terms`, `/api/openapi.json` and `/api/health`.
- The database is empty, so there are no listings yet.
- `/dashboard` and `/admin` redirect to `/api/auth/github`. That answers 500 `internal` and logs `missing required environment variable: GITHUB_OAUTH_CLIENT_ID` until you finish step 6.
- Paid routes also need `PLATFORM_RECEIVING_ADDRESS` (step 7).

What happened on 25 October 2026 with no database running: the pages listed above still returned 200, but each request first waited about 7 seconds for the database connection to fail. `/api/health` answered `{"status":"degraded","checks":{"database":"unreachable"},…}`. `/api/label/…`, `/api/r/…`, `/api/auth/challenge` and listing pages answered 500 `internal`, with `ECONNREFUSED 127.0.0.1:54321` in the server log.

With the dev server running, check that pages are server-rendered (PRD §14.1):

```sh
npm run check:ssr
# ok: 'X402 Git' appears 3 time(s) in server HTML at http://localhost:3000/
```

To check a listing page once you have one: `sh scripts/check-ssr.sh http://localhost:3000/<owner>/<slug> <slug>`.

## 6. Create your own GitHub App

The app needs a GitHub App to read creators' repos, receive push and release webhooks, and sign creators in with OAuth. `npm run app:github` (`scripts/github-app-create.mjs`) creates **a new App owned by you** through GitHub's manifest flow. It does not use, or need access to, the x402git App.

### Decide your public URL first

The manifest builds the App's URLs from `NEXT_PUBLIC_APP_URL`, so set it before you run the script:

- Webhook URL: `<NEXT_PUBLIC_APP_URL>/api/webhooks/github`, for the `push` and `release` events.
- OAuth callback URL: `<NEXT_PUBLIC_APP_URL>/api/auth/github/callback`.
- Setup URL: `<NEXT_PUBLIC_APP_URL>/dashboard/new`, where GitHub sends a creator after they install the App.

GitHub cannot deliver webhooks to `localhost`. To receive them on your machine, run a tunnel: any tool that gives you a public HTTPS URL forwarding to port 3000. Put that URL in `NEXT_PUBLIC_APP_URL` and browse the app through it. Sign-in starts and ends on `NEXT_PUBLIC_APP_URL`, and the callback refuses a sign-in that started on a different host.

Without a tunnel, keep `NEXT_PUBLIC_APP_URL=http://localhost:3000`. Webhooks will not arrive, so a tag push will not cut a release. Cut releases with `POST /api/listings/{id}/sync` instead. That is the documented recovery path (FR-8.2), and `e2e:fr34` uses it too.

If a page renders through the tunnel but its buttons do nothing, Next.js may be blocking dev-only requests from a host other than `localhost`. Add the tunnel host to `allowedDevOrigins` in your local `next.config.ts`, and do not commit that change.

### Create it

```sh
npm run app:github
```

Options, passed after `--`:

- `--name <name>`: the App's name. Default `x402git-dev-<your GitHub login>`.
- `--org <org>`: create the App under an organisation you administer instead of your account.
- `--env <file>`: the file to read `NEXT_PUBLIC_APP_URL` from and write to. Default `.env`.

The script serves a page on `http://127.0.0.1:3979` and opens it. The `open` command is macOS only; elsewhere, open the URL it prints. The page posts the manifest to GitHub. Click **Create GitHub App**. GitHub redirects back with a one-time code, the script exchanges it through `gh api`, and it writes these to your env file:

- `GITHUB_APP_ID`
- `GITHUB_APP_SLUG`
- `GITHUB_APP_PRIVATE_KEY` (one line, quoted, newlines written as `\n`)
- `GITHUB_APP_WEBHOOK_SECRET`
- `GITHUB_OAUTH_CLIENT_ID`
- `GITHUB_OAUTH_CLIENT_SECRET`

It prints only the App's URL and id. The App is public, so other accounts can install it. It asks for Contents read, Metadata read and Administration write; Administration write lets it create hosted repos and add per-repo deploy keys.

`GITHUB_APP_SLUG` matters: when it is unset the app falls back to `x402git`, and the "install the App" link would point at the hosted service's App.

### Then

1. **Add one permission by hand.** On the App's settings page, under Permissions and events, set Organization permissions, Members, to Read-only. The create script does not request it, but `app:check` expects it, and the ownership check for repos owned by an organisation fails closed without it.
2. **Install the App** on a private repo you want to list: `https://github.com/apps/<GITHUB_APP_SLUG>/installations/new`. The new-listing page links there too.
3. **Check the wiring:**

   ```sh
   npm run app:check
   ```

   It prints the App, its permissions and events, and each installation, then `All good.` or a list of issues.
4. Set `ADMIN_GITHUB_LOGINS=<your GitHub login>` if you want `/admin`. Unset, `/admin` admits nobody.
5. Restart `npm run dev` so it reads the new values.

If your tunnel URL changes, update `NEXT_PUBLIC_APP_URL` and the App's Homepage, Callback, Setup and Webhook URLs on GitHub.

### Hosted repos (Rail B, optional)

Rail B is the headless path: the platform creates the private repo and the creator pushes to it with a deploy key. To try it:

1. Create a GitHub organisation you own and install your App on it with access to all repositories.
2. Set `GITHUB_HOSTED_ORGS=<org>`. It takes a comma-separated list; the first entry is where new repos go.
3. `RAIL_B_INVITE_CODES` is a comma-separated list of invite codes. Unset means registration is open, which is fine locally.

## 7. Payments on Base Sepolia

| Variable | Value | Notes |
|---|---|---|
| `X402_NETWORK` | `base-sepolia` | The default. The code translates it to CAIP-2 `eip155:84532`, chain id 84532. |
| `X402_FACILITATOR_URL` | `https://x402.org/facilitator` | The public testnet facilitator. It needs no key. If unset, `@x402/core` falls back to the same URL. |
| `X402_ASSET_ADDRESS` | leave unset | Defaults to Circle's Base Sepolia USDC, `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (`usdcAddress()` in `lib/env.ts`, matching `@x402/evm`'s table). |
| `PLATFORM_RECEIVING_ADDRESS` | a Base Sepolia address you control | The `payTo` of every 402. Required for any paid route. |
| `SWEEP_WALLET_PRIVATE_KEY` | throwaway testnet key, optional | Signs payouts: a USDC transfer from the sweep wallet to the creator's bound address, with gas paid in ETH. Unset, the sweep skips with `no_sweep_signer`. |
| `EVM_RPC_URL` | leave unset | Read-only RPC for the sweep and the daily reconcile. Defaults to `https://sepolia.base.org`. |
| `TEST_BUYER_PRIVATE_KEY` | throwaway testnet key | Used only by the `e2e:*` scripts, as the paying buyer. The app never reads it. |
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | leave unset | Only for Base mainnet settlement through Coinbase's facilitator. `lib/x402/server.ts` sends them to `api.cdp.coinbase.com` and nowhere else. Not needed on Base Sepolia. |

Check that the facilitator will settle on your network:

```sh
npm run check:facilitator
# facilitator   https://x402.org/facilitator
# credentials   none
# …
# ok: 'exact' on eip155:84532 is supported. Settlement is reachable.
```

**Make throwaway keys.** `scripts/new-wallet.mjs` writes a fresh key to a gitignored `<name>.local.json` (mode 600) and prints only the address:

```sh
node scripts/new-wallet.mjs test-buyer --purpose "Base Sepolia test buyer"
node scripts/new-wallet.mjs test-sweep --purpose "Base Sepolia sweep signer"
```

Copy `private_key` from each file into `.env` (`TEST_BUYER_PRIVATE_KEY`, `SWEEP_WALLET_PRIVATE_KEY`), then delete the files.

**Fund them from the faucets.** A buyer pays in testnet USDC and the facilitator pays the gas for the transfer; `e2e:web` also asks for a little ETH in the buyer wallet. The sweep wallet needs Base Sepolia ETH for gas, plus the USDC it pays out. Locally, the simplest setup is to use the sweep wallet's address as `PLATFORM_RECEIVING_ADDRESS`, so the USDC buyers pay is the USDC the sweep sends. The hosted service keeps the two apart.

> **Never put a mainnet key in `.env`.** Use keys made for this and fund them only from faucets. These keys sit in a plain-text file, and the `e2e:*` scripts sign with them unattended. If a key has ever held real funds, do not use it here.

Creators need no funded wallet. A payout address only signs messages.

## 8. Optional services

| Service | Variables | Without it |
|---|---|---|
| Telegram admin notifications (`lib/notify`) | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_ID` | Silent no-op. Set both only on a production deployment. `npm run telegram:check` tests a bot and chat. |
| Socket dependency-behaviour check (`lib/scan/socket.ts`) | `SOCKET_TOKEN_VALUE`, `SOCKET_ORG_SLUG` | Releases still cut. The scan report carries a `socket unconfigured` row instead of Socket's findings. `npm run socket:check` tests a token. |
| OSV dependency CVEs (`lib/scan/osv.ts`) | none (public `api.osv.dev`); `OSV_TIMEOUT_MS` sets the timeout, default 20000 | Always on, so cutting a release needs outbound network. A timeout on the batch query leaves the scan incomplete, not passed; an advisory whose detail lookup times out or is cut off by the deadline is shown as a non-blocking `UNKNOWN`. |
| Sanctions screening (`lib/screening.ts`) | none; fetches a public OFAC address list from GitHub | Always on. If the list cannot be fetched it fails open and records that it did. |
| IndexNow pings (`lib/indexnow.ts`) | `INDEXNOW_KEY` | No search-engine ping on publish. Leave it unset on a dev instance. |
| Vercel Analytics | none (`VERCEL=1` is set by Vercel) | Not loaded outside Vercel. |
| An LLM | none | The app calls no LLM. `ANTHROPIC_API_KEY` appears only in test fixtures, as an example of an environment variable the scanner reports. |

Tunables with defaults from the PRD. Leave them unset unless you mean to change the product: `PLATFORM_FEE_BPS` (1000, which is 10%), `HOLDBACK_DAYS` (7), `REPLAY_GRANT_WINDOW_SEC` (600), `ANALYZER_VERSION` and `TERMS_VERSION`. `TERMS_VERSION` is the version creators accept; change it only together with the terms text in `lib/terms.ts` and `public/terms.md`.

`TEST_BUYER_ADDRESS` is declared in `lib/env.ts` but nothing reads it.

## 9. Tests and end-to-end runs

```sh
npm run typecheck
npm test
npm run build
```

`npm run detect` runs the impeccable design detector over `app/` through `npx`. It matters only for UI changes.

The end-to-end scripts settle **real Base Sepolia USDC** from `TEST_BUYER_PRIVATE_KEY` against a running instance. Read the header of each script before you run it.

- `npm run e2e:fr34 -- --rail b --base http://localhost:3000` runs FR-34, the definition of done for the headless rail: register, get a hosted repo, cut a release, price, publish, buy, update, re-fetch, sweep. It needs `GITHUB_HOSTED_ORGS`. `--rail a` fails by design, because a creator registered headlessly has no linked GitHub identity to verify an App installation against.
- `BASE_URL=http://localhost:3000 npm run e2e:buyer -- <owner>/<slug>` buys one existing listing the way an agent would.
- `BASE_URL=http://localhost:3000 npm run e2e:web -- <owner>/<slug>` buys one through the browser checkout's own module, without a browser.

Keep these out of CI. The workflow in `.github/workflows/ci.yml` uses no secrets.

## 10. Maintainer-only

These assume the x402git operators' 1Password vault, Vercel project, hosted GitHub org or key files. Contributors and self-hosters do not need them.

- `npm run env:status`, `env:pull`, `env:push` (`scripts/env-sync.mjs`): sync `.env` and `.env.local` with the operators' 1Password vault. They need the `op` CLI and access to that vault.
- `scripts/with-env.mjs` and `scripts/migrate-storage.mjs`: tools for moving between two hosted Supabase projects.
- `npm run skills:publish`: pushes `lib/skills` to `github.com/pcmarts/x402git-skills`. Needs write access to that repo.
- `npm run bazaar:check`: reports whether x402git.com's listings are indexed by the x402 Bazaar. It defaults to `https://x402git.com`.
- `npm run e2e:sweep`: defaults to `https://x402git.com` and needs the target's sweep key. If you run it at all, pass `--base http://localhost:3000`.
- `scripts/b4-fund-sweep-wallet.mjs` and `scripts/ops-clear-stuck-payout.mjs`: expect the operators' key files (`sweep-wallet.local.json`, `sweep-mainnet.local.json`).
- `scripts/github-webhook-redeliver.mjs`: redelivers a webhook for the operators' App.

Operator tools that act on whatever database `.env` names, and so also work on your own instance: `npm run ops:status`, `scripts/ops-switch.mjs` (the four global pauses) and `scripts/ops-takedown.mjs`. `npm run x402:check` compares upstream x402 releases with `docs/x402-upstream.md`; anyone can run it, and `GITHUB_TOKEN` or `GH_TOKEN` raises its GitHub API rate limit.

## 11. Deploy your own instance

The hosted service runs on Vercel. The short version for your own:

1. **Database.** Create a Supabase project, then apply the schema:

   ```sh
   supabase link --project-ref <your-project-ref>
   supabase db push
   ```

   Take `SUPABASE_URL` and `SUPABASE_SECRET_KEY` from the project's API settings.
2. **GitHub App.** Create a separate App for production, because its URLs differ from your dev App's. Put `NEXT_PUBLIC_APP_URL=https://<your-domain>` in a file of its own, then:

   ```sh
   npm run app:github -- --env .env.deploy --name <your-app-name>
   ```

   `.env.deploy` is gitignored by the `.env.*` rule, and Next.js does not load it. Add Members read and install the App as in step 6.
3. **Vercel.** Link the project, add each variable to the Production environment, and deploy:

   ```sh
   vercel link
   vercel env add SUPABASE_URL production
   vercel deploy --prod
   ```

   Paste `GITHUB_APP_PRIVATE_KEY` as the script wrote it, with `\n` escapes. `lib/env.ts` restores the newlines.

Variables for production:

- Required: `NEXT_PUBLIC_APP_URL`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SESSION_SECRET`, `CRON_SECRET`, `ABUSE_WEBHOOK_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET`, `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `ADMIN_GITHUB_LOGINS`, `X402_NETWORK`, `X402_FACILITATOR_URL`, `PLATFORM_RECEIVING_ADDRESS`.
- For payouts: `SWEEP_WALLET_PRIVATE_KEY`, and `EVM_RPC_URL` if you want your own RPC.
- Optional: `GITHUB_HOSTED_ORGS`, `RAIL_B_INVITE_CODES`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_ID`, `SOCKET_TOKEN_VALUE`, `SOCKET_ORG_SLUG`, `INDEXNOW_KEY`.

`vercel.json` schedules three daily jobs. Vercel calls each with `Authorization: Bearer $CRON_SECRET`, and in production they refuse every call if `CRON_SECRET` is unset.

| Path | Schedule (UTC) | Job |
|---|---|---|
| `/api/cron/sweep` | `0 3 * * *` | Pays creators whose holdback has passed |
| `/api/cron/reconcile` | `30 3 * * *` | Compares the ledger with the receiving and sweep wallet balances |
| `/api/cron/rescan` | `0 4 * * *` | Re-runs the dependency checks on stored releases |

`vercel.json` also pins functions to `lhr1` (London). Change `regions` to the region nearest your database.

Stay on Base Sepolia unless you have read `lib/x402/server.ts` and `scripts/check-facilitator.mjs`. Mainnet means `X402_NETWORK=base`, CDP keys, a receiving address held in a hardware wallet, and `npm run check:facilitator -- --network eip155:8453` before any real payment. The x402git name, logo and legal documents are not licensed for your instance: read `NOTICE` and `TRADEMARKS.md`, and replace the terms in `lib/terms.ts`, `lib/buyer-terms.ts` and `public/` before you open an instance to the public.
