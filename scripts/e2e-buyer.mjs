#!/usr/bin/env node
/**
 * scripts/e2e-buyer.mjs — the buyer half of FR-34, against a real deployment.
 *
 *   BASE_URL=http://localhost:3000 node scripts/e2e-buyer.mjs <owner>/<slug>
 *
 * The hosted service at https://x402git.com is the maintainers' target only.
 *
 * What it proves, in order:
 *
 *   1. GET /api/v          — the listing exists and names a version and a price.
 *   2. GET /api/r          — 402, with a `PAYMENT-REQUIRED` header a real x402 client parses.
 *   3+4. pay              — `@x402/fetch` wraps `fetch`; it signs the EIP-3009
 *                            authorization and retries by itself, ending in a 200 with
 *                            a transaction hash in `PAYMENT-RESPONSE`.
 *   5. download            — the zip's sha256 equals the `artifact_sha256` that was scanned.
 *   6. GET /api/v (signed) — the wallet now reads as `owned`.
 *   7. GET /api/r (signed) — a second fetch is free (owned) or an update 402 at the stamped price.
 *   8. GET /api/r/v/:ver   — the version is re-fetchable (FR-19).
 *
 * It needs `TEST_BUYER_PRIVATE_KEY` in `.env` (a Base Sepolia wallet holding testnet
 * USDC and a little ETH). It never prints a key, and never prints a wallet signature.
 */

import fs from "node:fs";
import crypto from "node:crypto";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

// --- .env, the same minimal loader scripts/github-app-check.mjs uses -----------

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

const BASE_URL = (conf("BASE_URL", "http://localhost:3000")).replace(/\/+$/, "");
const PRIVATE_KEY = conf("TEST_BUYER_PRIVATE_KEY");

const target = process.argv[2] ?? conf("E2E_LISTING", "");
const [owner, slug] = target.split("/");
if (!owner || !slug) fail("usage: node scripts/e2e-buyer.mjs <owner>/<slug>   (or set E2E_LISTING)");
if (!PRIVATE_KEY) fail("TEST_BUYER_PRIVATE_KEY is missing from .env — this script needs a funded Base Sepolia wallet");

const account = privateKeyToAccount(PRIVATE_KEY);

// --- output -------------------------------------------------------------------

const bold = (s) => (process.stdout.isTTY ? `\u001b[1m${s}\u001b[0m` : s);
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
const usd = (micro) => `$${(Number(micro) / 1e6).toFixed(2)}`;

console.log(bold(`FR-34 buyer run — ${owner}/${slug} at ${BASE_URL}`));
say("buyer", account.address);

// --- the x402 client, exactly as an agent would build it ----------------------

const paymentClient = x402Client.fromConfig({
  schemes: [{ network: "eip155:*", client: new ExactEvmScheme(account) }],
  // The price is the server's; this script is asserting the server, not policing it.
  spendControls: false,
});
/** Header parsing (`PAYMENT-REQUIRED`, `PAYMENT-RESPONSE`) still goes through the HTTP client. */
const httpClient = new x402HTTPClient(paymentClient);
/** FR-30's promised client: `fetch`, wrapped, pays 402s from this wallet by itself. */
const fetchWithPay = wrapFetchWithPayment(fetch, paymentClient);

// --- FR-20 wallet signature ---------------------------------------------------

/** `<address>.<nonce>.<eip191_sig>` over a fresh single-use challenge. */
async function walletSignature() {
  const res = await fetch(`${BASE_URL}/api/auth/challenge?address=${account.address}&purpose=wallet_ownership`);
  if (!res.ok) fail(`GET /api/auth/challenge → ${res.status} ${await res.text()}`);
  const { nonce, message } = await res.json();
  const signature = await account.signMessage({ message });
  return `${account.address}.${nonce}.${signature}`;
}

const json = async (res) => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text.slice(0, 400) };
  }
};

// --- 1. the version endpoint ---------------------------------------------------

heading("GET /api/v — what is the latest, and what does it cost");
const versionRes = await fetch(`${BASE_URL}/api/v/${owner}/${slug}`);
const version = await json(versionRes);
check(versionRes.ok, `200 from /api/v (${versionRes.status})`);
say("latest", version.latest ?? "(none)");
say("price", `${usd(version.price_micro)} · updates ${usd(version.update_price_micro)}`);
say("status", version.status);
check(version.latest, "the listing has a release that passed its scan");

// --- 2. the 402 ----------------------------------------------------------------

heading("GET /api/r — the 402");
const unpaid = await fetch(`${BASE_URL}/api/r/${owner}/${slug}`);

if (unpaid.status === 200) {
  const free = await json(unpaid);
  say("free listing", `served ${free.version} with no payment (FR-24)`);
  await verifyDownload(free);
  console.log(`\n${bold("Done.")} Free listing: nothing to settle.`);
  process.exit(0);
}

check(unpaid.status === 402, `402 from /api/r (${unpaid.status})`);
const required = httpClient.getPaymentRequiredResponse((name) => unpaid.headers.get(name), await json(unpaid.clone()));
const body402 = await json(unpaid);
check(unpaid.headers.get("PAYMENT-REQUIRED") !== null, "the PAYMENT-REQUIRED header is present (FR-21)");
say("kind", body402.extra?.kind);
say("price", usd(required.accepts[0].amount));
say("network / asset", `${required.accepts[0].network} · ${required.accepts[0].asset}`);
say("payTo", required.accepts[0].payTo);
say("quote_id", body402.extra?.quote_id);
say("description", required.accepts[0].description ?? required.resource?.description ?? "");

// --- 3 & 4. sign and pay --------------------------------------------------------

heading("Paying the 402 with @x402/fetch — the wrapped fetch signs and retries itself");
const paidRes = await fetchWithPay(`${BASE_URL}/api/r/${owner}/${slug}`, {
  headers: { "x-quote-id": body402.extra?.quote_id ?? "" },
});
const grant = await json(paidRes);
if (!paidRes.ok) fail(`paid request → ${paidRes.status} ${JSON.stringify(grant)}`);
check(paidRes.status === 200, "200 after settlement (FR-22)");

const settlement = httpClient.getPaymentSettleResponse((name) => paidRes.headers.get(name));
check(Boolean(settlement.transaction), "PAYMENT-RESPONSE carries a transaction hash");
say("tx", settlement.transaction);
say("version", grant.version);
say("artifact_sha256", grant.artifact_sha256);
say("expires_at", grant.expires_at);

// --- 5. the bytes ----------------------------------------------------------------

await verifyDownload(grant);

// --- 6. the wallet now owns it ---------------------------------------------------

heading("GET /api/v with X-Wallet-Signature — the wallet reads as a holder (FR-20)");
const ownedRes = await fetch(`${BASE_URL}/api/v/${owner}/${slug}`, { headers: { "x-wallet-signature": await walletSignature() } });
const owned = await json(ownedRes);
check(ownedRes.ok, `200 from the signed /api/v (${ownedRes.status})`);
say("owned", owned.owned ?? "(none)");
say("entitled", String(owned.entitled));
say("price_kind", owned.price_kind ?? "");
check(owned.owned === grant.version, `the wallet owns ${grant.version}`);

// --- 7. the second fetch ----------------------------------------------------------

heading("GET /api/r with X-Wallet-Signature — free while entitled, or an update 402");
const secondRes = await fetch(`${BASE_URL}/api/r/${owner}/${slug}`, { headers: { "x-wallet-signature": await walletSignature() } });
if (secondRes.status === 200) {
  const again = await json(secondRes);
  check(again.version === grant.version, "the holder re-fetches without paying again");
} else if (secondRes.status === 402) {
  const update = await json(secondRes);
  check(update.extra?.kind === "update", `a newer release is an update 402 at ${usd(update.accepts[0].maxAmountRequired)} (FR-16, FR-17)`);
  say("from → to", `${update.extra.from} → ${update.extra.to}`);
  say("releases since", String((update.extra.releases ?? []).length));
} else {
  fail(`second fetch → ${secondRes.status} ${JSON.stringify(await json(secondRes))}`);
}

// --- 8. the version endpoint -------------------------------------------------------

heading(`GET /api/r/.../v/${grant.version} — owned versions stay fetchable (FR-19)`);
const refetchRes = await fetch(`${BASE_URL}/api/r/${owner}/${slug}/v/${grant.version}`, {
  headers: { "x-wallet-signature": await walletSignature() },
});
const refetch = await json(refetchRes);
check(refetchRes.ok, `200 from the version endpoint (${refetchRes.status})`);
check(refetch.artifact_sha256 === grant.artifact_sha256, "the re-fetch serves the identical artifact hash");

console.log(`\n${bold("Done.")} Bought ${owner}/${slug} v${grant.version} — tx ${settlement.transaction}`);

// --- helpers -------------------------------------------------------------------------

/** FR-51 / §6: the bytes served must hash to the value that was scanned. */
async function verifyDownload(g) {
  heading("Downloading the artifact and checking its sha256");
  const res = await fetch(g.download_url);
  if (!res.ok) fail(`download → ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  say("bytes", `${bytes.length}`);
  say("sha256", digest);
  check(digest === g.artifact_sha256, "the download hashes to artifact_sha256 — the bytes that were scanned are the bytes sold");
}
