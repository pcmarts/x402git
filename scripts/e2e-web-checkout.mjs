#!/usr/bin/env node
/**
 * scripts/e2e-web-checkout.mjs — the *browser* buy button, verified without a browser.
 *
 *   BASE_URL=http://localhost:3000 node scripts/e2e-web-checkout.mjs <owner>/<slug>
 *
 * The hosted service at https://x402git.com is the maintainers' target only.
 *
 * `scripts/e2e-buyer.mjs` proves the headless rail: an agent driving `@x402/core`
 * directly. This proves the thing a person actually presses. It imports the very module
 * the `"use client"` component imports — `lib/web/wallet-checkout.ts`, loaded by Node's
 * own type stripping, no build step — and hands it an EIP-1193 provider backed by
 * `privateKeyToAccount` instead of `window.ethereum`.
 *
 * That is the whole substitution. Everything downstream of `provider.request` is the
 * production path: viem's `createWalletClient`/`custom` transport, `ExactEvmScheme`
 * signing the EIP-3009 authorization, `x402HTTPClient` encoding `PAYMENT-SIGNATURE`,
 * the real `/api/r` on the other end, and a real settlement on Base Sepolia.
 *
 * It needs `TEST_BUYER_PRIVATE_KEY` in `.env` (a Base Sepolia wallet holding testnet
 * USDC and a little ETH). It never prints a key and never prints a signature.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { hexToString } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buyWithWallet,
  chainInfo,
  detectProvider,
  ensureChain,
  explorerTxUrl,
  fetchEntitlements,
  fetchOwnership,
  refetchOwnedVersion,
} from "../lib/web/wallet-checkout.ts";

// --- .env, the same minimal loader scripts/e2e-buyer.mjs uses -----------------

const env = (() => {
  try {
    return Object.fromEntries(
      fs
        .readFileSync(".env", "utf8")
        .split("\n")
        .filter((l) => /^[A-Z0-9_]+=/.test(l))
        .map((l) => {
          const i = l.indexOf("=");
          let v = l.slice(i + 1).trim();
          if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\n/g, "\n");
          return [l.slice(0, i), v];
        }),
    );
  } catch {
    return {};
  }
})();
const conf = (key, fallback) => process.env[key] ?? env[key] ?? fallback;

const BASE_URL = conf("BASE_URL", "http://localhost:3000").replace(/\/+$/, "");
const PRIVATE_KEY = conf("TEST_BUYER_PRIVATE_KEY");
const CHAIN_ID = Number(conf("X402_CHAIN_ID", "")) || (conf("X402_NETWORK", "base-sepolia") === "base" ? 8453 : 84532);

const target = process.argv[2] ?? conf("E2E_LISTING", "");
const [owner, slug] = target.split("/");
if (!owner || !slug) fail("usage: node scripts/e2e-web-checkout.mjs <owner>/<slug>   (or set E2E_LISTING)");
if (!PRIVATE_KEY) fail("TEST_BUYER_PRIVATE_KEY is missing from .env — this script needs a funded Base Sepolia wallet");

const account = privateKeyToAccount(PRIVATE_KEY);

// --- output -------------------------------------------------------------------

const bold = (s) => (process.stdout.isTTY ? `[1m${s}[0m` : s);
let step = 0;
const heading = (title) => console.log(`\n${bold(`${++step}. ${title}`)}`);
const say = (label, value) => console.log(`   ${label.padEnd(22)} ${value}`);
function fail(message) {
  console.error(`\nFAILED: ${message}`);
  process.exit(1);
}
function check(condition, message) {
  if (!condition) fail(message);
  console.log(`   ✓ ${message}`);
}

// --- the wallet a browser would have -------------------------------------------
//
// An EIP-1193 provider is six methods, and `window.ethereum` implements them by talking
// to an extension. This one implements them with a local key. Nothing above it — not
// viem, not @x402/evm, not wallet-checkout.ts — can tell the difference, which is the
// point: the code path under test is the shipped one.

let currentChain = CHAIN_ID;
let prompts = { accounts: 0, personalSign: 0, typedData: 0, switches: 0 };

const provider = {
  isCoinbaseWallet: false,
  isMetaMask: true,
  async request({ method, params }) {
    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        prompts.accounts += 1;
        return [account.address];

      case "eth_chainId":
        return `0x${currentChain.toString(16)}`;

      case "wallet_switchEthereumChain":
        prompts.switches += 1;
        currentChain = Number.parseInt(params[0].chainId, 16);
        return null;

      case "wallet_addEthereumChain":
        return null;

      // FR-20's challenge. The header carries the signature; this script never prints it.
      case "personal_sign": {
        prompts.personalSign += 1;
        const [message] = params;
        return await account.signMessage({ message: hexToString(message) });
      }

      // The EIP-3009 authorization. `@x402/evm` built the struct; viem serialised it.
      case "eth_signTypedData_v4": {
        prompts.typedData += 1;
        const [, typed] = params;
        return await account.signTypedData(JSON.parse(typed));
      }

      default:
        throw new Error(`this shim does not implement ${method}`);
    }
  },
};

const transport = { fetch: globalThis.fetch, baseUrl: BASE_URL };
const chain = chainInfo(CHAIN_ID);

console.log(bold(`Browser checkout — ${owner}/${slug} at ${BASE_URL}`));
say("buyer", account.address);
say("chain", `${chain.name} (${CHAIN_ID})`);

// --- 1. the wallet the page would have found ------------------------------------

heading("detectProvider — the page finds an injected wallet");
const found = detectProvider({ ethereum: provider });
check(found === provider, "window.ethereum resolves to one provider");

heading("ensureChain — the wallet is put on the settlement chain");
currentChain = 1; // pretend the wallet was left on mainnet, as most are
await ensureChain(provider, CHAIN_ID);
check(currentChain === CHAIN_ID, `the wallet switched to ${chain.name}`);

// --- 2. what this wallet already owns --------------------------------------------

heading("fetchOwnership — one signature, and the box knows what to say");
const before = await fetchOwnership(provider, account.address, { owner, slug }, transport);
say("latest", before.latest ?? "(none)");
say("owned", before.owned ?? "(nothing)");
say("price for this wallet", `$${(Number(before.priceMicro) / 1e6).toFixed(2)} (${before.priceKind ?? "n/a"})`);
check(before.latest !== null, "the listing has a release that passed its scan");

// --- 3. the purchase ---------------------------------------------------------------

heading("buyWithWallet — 402, sign, pay, download");
const result = await buyWithWallet({
  provider,
  owner,
  slug,
  chainId: CHAIN_ID,
  transport,
  proveWallet: Boolean(before.owned),
});

if (!result.ok) fail(`checkout returned ${result.code}: ${result.message}`);
check(result.ok, `the checkout returned a grant (${result.kind})`);
say("version", result.version);
say("artifact_sha256", result.artifactSha256);
say("expires_at", result.expiresAt);
say("tx", result.txHash ?? "(nothing settled — free or already owned)");
if (result.txHash) say("explorer", explorerTxUrl(CHAIN_ID, result.txHash) ?? "(no explorer for this chain)");

if (before.owned === null && before.priceMicro > 0n) {
  check(Boolean(result.txHash), "money moved and the settlement carried a transaction hash (FR-22)");
}

// --- 4. the bytes -------------------------------------------------------------------

heading("the download — the bytes sold are the bytes that were scanned");
const downloaded = await fetch(result.downloadUrl);
if (!downloaded.ok) fail(`download → ${downloaded.status}`);
const bytes = Buffer.from(await downloaded.arrayBuffer());
const digest = crypto.createHash("sha256").update(bytes).digest("hex");
say("bytes", String(bytes.length));
say("sha256", digest);
check(digest === result.artifactSha256, "the archive hashes to artifact_sha256");
check(bytes[0] === 0x50 && bytes[1] === 0x4b, "the bytes are a zip archive (.zip)");

// --- 5. Your purchases ----------------------------------------------------------------

heading("fetchEntitlements — the purchase shows up under Your purchases");
const owned = await fetchEntitlements(provider, account.address, transport);
say("entitlements", String(owned.length));
const mine = owned.find((e) => e.owner === owner && e.slug === slug && e.version === result.version);
check(Boolean(mine), `${owner}/${slug} v${result.version} is in the wallet's own list (FR-32)`);

heading("refetchOwnedVersion — the Download button on that page works");
const again = await refetchOwnedVersion(provider, account.address, { owner, slug, version: result.version }, transport);
if (!again.ok) fail(`re-fetch returned ${again.code}: ${again.message}`);
check(again.artifactSha256 === result.artifactSha256, "the re-fetch serves the identical artifact hash (FR-19)");

// --- what the person was asked to do --------------------------------------------------

heading("wallet prompts a person would have seen");
say("account", String(prompts.accounts));
say("network switch", String(prompts.switches));
say("personal_sign", String(prompts.personalSign));
say("typed data (the payment)", String(prompts.typedData));

console.log(
  `\n${bold("Done.")} Bought ${owner}/${slug} v${result.version} from the browser module${result.txHash ? ` — tx ${result.txHash}` : ""}`,
);
