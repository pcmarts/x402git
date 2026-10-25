/**
 * lib/env.ts — typed, lazy, zod-validated environment access.
 *
 * Rules:
 * - Nothing here ever logs, returns or embeds a secret *value* in an error message.
 *   Errors name the missing key only.
 * - Validation is lazy (first call) and memoised, so importing this module at module
 *   scope in a route handler never blows up a build that has no `.env`.
 * - Secrets are declared `optional()` in the schema and pulled out through the
 *   `require*` helpers below, so a route that only needs Supabase does not fail
 *   because the GitHub App key is absent.
 * - Next.js loads `.env` automatically for `next dev` / `next build`. Vitest does not,
 *   so call `loadEnv()` from a test that genuinely needs a real value. Unit tests
 *   should not need one — mock the DB instead (see lib/test/mock-db.ts).
 *
 * PRD Final.md §11, §13; D6 (PLATFORM_FEE_BPS), FR-27 (HOLDBACK_DAYS), FR-6 (TERMS_VERSION),
 * FR-52 (ANALYZER_VERSION), D2c (RAIL_B_INVITE_CODES).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

/** Money and counts arrive as strings; coerce explicitly, never with a float. */
const intString = (fallback: number) =>
  z
    .string()
    .regex(/^\d+$/, "must be a non-negative integer")
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : Number(v)));

export const envSchema = z.object({
  // --- public ---------------------------------------------------------------
  NEXT_PUBLIC_APP_URL: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v.replace(/\/+$/, "") : "http://localhost:3000")),

  // --- supabase -------------------------------------------------------------
  SUPABASE_URL: z.string().optional(),
  SUPABASE_PUBLISHABLE_KEY: z.string().optional(),
  SUPABASE_SECRET_KEY: z.string().optional(),
  /** Used by the `supabase` CLI only. No application code should read this. */
  SUPABASE_DB_PASSWORD: z.string().optional(),

  // --- github app (§14.3, §14.8) -------------------------------------------
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_APP_WEBHOOK_SECRET: z.string().optional(),
  GITHUB_OAUTH_CLIENT_ID: z.string().optional(),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().optional(),
  GITHUB_HOSTED_ORGS: z.string().optional(),
  /** The App's URL slug, for the "install on a repo" link. */
  GITHUB_APP_SLUG: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : "x402git")),

  // --- web session (FR-1) ---------------------------------------------------
  /**
   * Signs and encrypts the creator session cookie (lib/web/session.ts). Optional so a
   * headless deployment that serves only the API never needs it; when absent it is
   * derived from a hash of SUPABASE_SECRET_KEY so `next dev` works out of the box.
   * Set it explicitly in production: rotating the Supabase key would otherwise log
   * every creator out.
   */
  SESSION_SECRET: z.string().optional(),

  /**
   * The **root** administrators of `/admin` — comma-separated GitHub logins, matched
   * case-insensitively against the identity OAuth proved (`lib/admin/guard.ts`).
   *
   * This is not the whole list. Administrators are also granted from `/admin/people`
   * into the `admin` table (migration 20260907000000); the two are unioned. What makes
   * *this* half worth having is that the app cannot edit it: no sequence of clicks,
   * including revoking every other administrator, can lock everybody out of the surface
   * that would be needed to undo it. Editing this variable and redeploying is always
   * the way back in.
   *
   * Optional, and unset means this half admits nobody. Every other gate in this file
   * fails open on purpose; the admin gate is the exception, because the thing behind it
   * is every creator's listings and every listing's takings, and a surface that defaults
   * to open on a preview build is a surface that leaks on the first preview build
   * somebody shares.
   */
  ADMIN_GITHUB_LOGINS: z.string().optional(),

  // --- telegram admin notifications -----------------------------------------
  /** The BotFather token for the admin bot. See `telegramConfig()` for the policy. */
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  /** The channel/supergroup the bot posts into — a `-100…` id, not a @name. */
  TELEGRAM_ADMIN_CHAT_ID: z.string().optional(),

  // --- x402 / payments (§13) -----------------------------------------------
  CDP_API_KEY_ID: z.string().optional(),
  CDP_API_KEY_SECRET: z.string().optional(),
  X402_NETWORK: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : "base-sepolia")),
  X402_FACILITATOR_URL: z.string().optional(),
  // --- search indexing (16 Sep 2026; docs/research/Agent Discovery Channels.md) ------
  /**
   * IndexNow key: pushes a listing URL to Bing (and every engine sharing the protocol)
   * the moment it is published, retired or gets a new release, instead of waiting for
   * a crawl. Optional: absent, the ping is skipped and nothing else changes. The key is
   * served back at /<key>.txt so the engine can verify it (lib/indexnow.ts).
   */
  INDEXNOW_KEY: z.string().optional(),
  /**
   * §14.8: a crown jewel. Belongs in the signing service, and the web deployment
   * should never hold it. Declared here only so a local FR-34 run can find it.
   */
  SWEEP_WALLET_PRIVATE_KEY: z.string().optional(),
  PLATFORM_RECEIVING_ADDRESS: z.string().optional(),
  /** The USDC contract on `X402_NETWORK`. Defaults per network in `usdcAddress()`. */
  X402_ASSET_ADDRESS: z.string().optional(),
  /** Read-only JSON-RPC for the sweep and the FR-28 reconcile. Public endpoint by default. */
  EVM_RPC_URL: z.string().optional(),

  // --- vercel cron (§9, FR-26/FR-28) ---------------------------------------
  /**
   * Vercel's convention: cron invocations carry `Authorization: Bearer $CRON_SECRET`.
   * Optional so a local `next dev` can hit the route; when it is set the check is
   * mandatory and constant-time.
   */
  CRON_SECRET: z.string().optional(),

  // --- FR-34 end-to-end test wallet ----------------------------------------
  TEST_BUYER_PRIVATE_KEY: z.string().optional(),
  TEST_BUYER_ADDRESS: z.string().optional(),

  // --- tunables with PRD defaults ------------------------------------------
  /** D6: flat 10%, basis points. */
  PLATFORM_FEE_BPS: intString(1000),
  /** FR-27: fixed 7-day holdback. */
  HOLDBACK_DAYS: intString(7),
  /** FR-6. */
  TERMS_VERSION: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : "2026-09-16")),
  /** FR-52. */
  ANALYZER_VERSION: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : "0.1.0")),
  /** D2c: Rail B registration requires an invite code in V0. Comma-separated. */
  RAIL_B_INVITE_CODES: z.string().optional(),
  /**
   * DA (remediation): how long after a purchase a resent PAYMENT-SIGNATURE is still
   * answered from the ledger as an idempotent crash-retry. Past it, re-download of an
   * owned version requires a fresh X-Wallet-Signature. Default 600s (the signed-URL life).
   */
  REPLAY_GRANT_WINDOW_SEC: intString(600),
  /**
   * DC (remediation): abort an OSV dependency-scan request after this many ms. A timeout
   * is an incomplete scan (fail-closed), never a silent pass. Default 20s.
   */
  OSV_TIMEOUT_MS: intString(20000),
});

export type Env = z.infer<typeof envSchema>;
export type EnvKey = keyof Env;

let cached: Env | null = null;

/** Validated, memoised environment. Throws only if a *declared shape* is wrong. */
export function env(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // Never include values — only key names and the reason.
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid environment: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Drop the memo. Tests that mutate process.env must call this. */
export function resetEnv(): void {
  cached = null;
}

/** A key that must be present. Throws naming the key, never the value. */
export function requireEnv<K extends EnvKey>(key: K): NonNullable<Env[K]> {
  const v = env()[key];
  if (v === undefined || v === null || v === "") {
    throw new Error(`missing required environment variable: ${key}`);
  }
  return v as NonNullable<Env[K]>;
}

// --- grouped accessors other modules should prefer ---------------------------

export function appUrl(): string {
  return env().NEXT_PUBLIC_APP_URL;
}

export function supabaseConfig(): { url: string; secretKey: string } {
  return { url: requireEnv("SUPABASE_URL"), secretKey: requireEnv("SUPABASE_SECRET_KEY") };
}

export function githubAppConfig(): { appId: string; privateKey: string; webhookSecret?: string; oauth?: { clientId: string; clientSecret: string } } {
  const e = env();
  const oauth =
    e.GITHUB_OAUTH_CLIENT_ID && e.GITHUB_OAUTH_CLIENT_SECRET
      ? { clientId: e.GITHUB_OAUTH_CLIENT_ID, clientSecret: e.GITHUB_OAUTH_CLIENT_SECRET }
      : undefined;
  return {
    appId: requireEnv("GITHUB_APP_ID"),
    privateKey: unescapePem(requireEnv("GITHUB_APP_PRIVATE_KEY")),
    webhookSecret: e.GITHUB_APP_WEBHOOK_SECRET,
    oauth,
  };
}

/** FR-1: the OAuth half of the App, which is a separate credential pair from the JWT. */
export function githubOAuthConfig(): { clientId: string; clientSecret: string } {
  return { clientId: requireEnv("GITHUB_OAUTH_CLIENT_ID"), clientSecret: requireEnv("GITHUB_OAUTH_CLIENT_SECRET") };
}

/** The `https://github.com/apps/<slug>/installations/new` link on the new-listing page. */
export function githubAppSlug(): string {
  return env().GITHUB_APP_SLUG;
}

/**
 * The key material behind the web session cookie. Falls back to a hash of the
 * Supabase secret so a local `next dev` has a stable key without extra setup; never
 * returns the raw secret, and never logs either value.
 */
export function sessionSecret(): string {
  const e = env();
  if (e.SESSION_SECRET && e.SESSION_SECRET.length > 0) return e.SESSION_SECRET;
  const fallback = e.SUPABASE_SECRET_KEY;
  if (!fallback) throw new Error("missing required environment variable: SESSION_SECRET");
  return createHash("sha256").update(`x402git:session-secret:${fallback}`, "utf8").digest("hex");
}

/**
 * The Telegram admin channel, or `null` when this deployment has none.
 *
 * **Unset is a silent no-op, never a failure.** A signup, a listing and a settlement all
 * happen on request paths that must not care whether an operator's phone buzzes, so
 * `lib/notify` treats a missing pair exactly like a delivery that failed: it returns a
 * result and moves on. Both halves are required — a token without a chat id has nowhere
 * to post — so either being empty means "not configured".
 *
 * **Production only.** Set it on the Production environment and nowhere else. Every
 * preview deployment shares this code, and a preview that carries the pair posts its test
 * signups and its test payments into the same channel the real ones arrive in, which is
 * how an operator learns to ignore the channel.
 */
export function telegramConfig(): { botToken: string; chatId: string } | null {
  const e = env();
  const botToken = e.TELEGRAM_BOT_TOKEN;
  const chatId = e.TELEGRAM_ADMIN_CHAT_ID;
  if (!botToken || !chatId) return null;
  return { botToken, chatId };
}

/** Hosted orgs for Rail B (D10), in cohort order. */
export function hostedOrgs(): string[] {
  return splitList(env().GITHUB_HOSTED_ORGS);
}

/**
 * The **root** administrator logins, lowercased. Empty means this half admits nobody —
 * see the schema note above. `lib/admin/people.ts` unions it with the `admin` table.
 */
export function adminGithubLogins(): string[] {
  return splitList(env().ADMIN_GITHUB_LOGINS).map((s) => s.toLowerCase());
}

/**
 * §13. `network` is CAIP-2 — that is what x402 v2 puts on the wire and what
 * `@x402/core` validates (`eip155:84532`). `X402_NETWORK` may still be written in the
 * v1 shorthand (`base-sepolia`); `caip2Network` translates, so nothing else has to know
 * both spellings.
 */
export function x402Config(): { network: string; chainId: number; facilitatorUrl?: string; payTo: string; asset: string } {
  const e = env();
  const { network, chainId, asset } = paymentChain();
  return { network, chainId, facilitatorUrl: e.X402_FACILITATOR_URL, payTo: requireEnv("PLATFORM_RECEIVING_ADDRESS"), asset };
}

/**
 * The chain and asset half of `x402Config`, without the platform's receiving address.
 *
 * A listing page has to tell a browser wallet which chain to be on, and it renders on
 * deployments that hold no payout key at all (a preview, a docs-only build). Reaching
 * for `x402Config()` there would 500 the page over a value the page does not use, so
 * the two facts a *buyer* needs are separated from the one the *server* needs.
 */
export function paymentChain(): { network: string; chainId: number; asset: string } {
  const e = env();
  const network = caip2Network(e.X402_NETWORK);
  return { network, chainId: Number(network.split(":")[1]), asset: e.X402_ASSET_ADDRESS ?? usdcAddress(network) };
}

const NETWORK_ALIASES: Record<string, string> = {
  base: "eip155:8453",
  "base-sepolia": "eip155:84532",
};

/** v1 shorthand or CAIP-2 in, CAIP-2 out. Throws on anything it cannot name. */
export function caip2Network(value: string): string {
  const alias = NETWORK_ALIASES[value];
  if (alias) return alias;
  if (/^eip155:\d+$/.test(value)) return value;
  throw new Error(`unsupported X402_NETWORK: expected base, base-sepolia or eip155:<chainId>`);
}

/** Canonical USDC per network. Circle's addresses; override with X402_ASSET_ADDRESS. */
export function usdcAddress(network: string): string {
  switch (caip2Network(network)) {
    case "eip155:8453":
      return "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    case "eip155:84532":
      return "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    default:
      throw new Error("no default USDC address for that network; set X402_ASSET_ADDRESS");
  }
}

/** Read-only RPC for the sweep broadcast and the reconcile balance read. */
export function rpcUrl(): string {
  const e = env();
  if (e.EVM_RPC_URL) return e.EVM_RPC_URL;
  return caip2Network(e.X402_NETWORK) === "eip155:8453" ? "https://mainnet.base.org" : "https://sepolia.base.org";
}

/** The sweep signer, or `null` when this deployment does not hold one (§14.8). */
export function sweepPrivateKey(): string | null {
  const v = env().SWEEP_WALLET_PRIVATE_KEY;
  return v && v.length > 0 ? v : null;
}

/** Vercel cron shared secret, or `null` when the routes are left open (local dev). */
export function cronSecret(): string | null {
  const v = env().CRON_SECRET;
  return v && v.length > 0 ? v : null;
}

/** D6. bigint because it multiplies micro-USDC. */
export function platformFeeBps(): bigint {
  return BigInt(env().PLATFORM_FEE_BPS);
}

/** FR-27. */
export function replayGrantWindowSec(): number {
  return env().REPLAY_GRANT_WINDOW_SEC;
}

export function osvTimeoutMs(): number {
  return env().OSV_TIMEOUT_MS;
}

export function holdbackDays(): number {
  return env().HOLDBACK_DAYS;
}

export function termsVersion(): string {
  return env().TERMS_VERSION;
}

export function analyzerVersion(): string {
  return env().ANALYZER_VERSION;
}

/** D2c. Empty array means "no invite gate configured" — callers decide the policy. */
export function inviteCodes(): string[] {
  return splitList(env().RAIL_B_INVITE_CODES);
}

// --- helpers -----------------------------------------------------------------

function splitList(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * A PEM stored in a single-line env var carries literal `\n`. Restore them.
 * Idempotent: a real multi-line PEM passes through untouched.
 */
export function unescapePem(pem: string): string {
  let v = pem.trim();
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  return v.includes("\\n") ? v.replace(/\\n/g, "\n") : v;
}

/**
 * Minimal dotenv-style loader for vitest / scripts. Next.js does this itself.
 * Existing `process.env` values always win, so CI secrets are never clobbered.
 * Never logs the file's contents.
 */
export function loadEnv(file = ".env"): void {
  let text: string;
  try {
    text = readFileSync(resolve(/*turbopackIgnore: true*/ process.cwd(), file), "utf8");
  } catch {
    return; // absent .env is not an error — unit tests must not need one
  }
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\n/g, "\n");
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  resetEnv();
}
