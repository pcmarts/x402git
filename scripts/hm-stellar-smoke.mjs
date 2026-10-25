#!/usr/bin/env node
/**
 * scripts/hm-stellar-smoke.mjs — can a stock x402 Stellar client pay this deployment's
 * receiving address, through this deployment's facilitator, in this deployment's asset?
 *
 *   node scripts/hm-stellar-smoke.mjs --supported-only        # /supported lists our network?
 *   node scripts/hm-stellar-smoke.mjs --dry-run               # build + sign, call nothing
 *   node scripts/hm-stellar-smoke.mjs --verify-only           # /verify, never /settle
 *   node scripts/hm-stellar-smoke.mjs                         # /verify then /settle: MOVES MONEY
 *   node scripts/hm-stellar-smoke.mjs --amount-micro 100000   # $0.10, the default
 *
 * The HackMeridian T+1:30 check (docs/HACKMERIDIAN-USDT0.md §4). It runs before any app
 * code exists, so it is deliberately standalone: it hand-writes the one `accepts` entry
 * the app will later build, signs it with the agent's key the way `@x402/stellar`'s
 * client does, and talks to the facilitator with the same `HTTPFacilitatorClient` the
 * app uses. If this passes, U1 (the facilitator serves `stellar:pubnet`), V1 (it settles
 * our asset) and V2 (it settles an asset with clawback enabled) are all answered.
 *
 * Reads `.env` then `.env.local`, shell wins:
 *   STELLAR_NETWORK              stellar:testnet (default) | stellar:pubnet
 *   STELLAR_RPC_URL              Soroban RPC; required on pubnet (SDF runs none)
 *   STELLAR_FACILITATOR_URL      default: x402.org on testnet, OZ Channels on pubnet
 *   STELLAR_FACILITATOR_API_KEY  Bearer token; OZ needs one on both networks
 *   STELLAR_RECEIVING_ADDRESS    the G… that is paid (the platform account)
 *   STELLAR_ASSET_ADDRESS        SAC; default testnet USDC / pubnet USDT0
 *   HM_AGENT_SECRET              S… of the paying account. Never passed as an argument.
 *
 * Nothing secret is printed. Whether a secret was found is.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { createEd25519Signer, USDC_TESTNET_ADDRESS, validateStellarAssetAddress, validateStellarDestinationAddress } from "@x402/stellar";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flag = (name) => process.argv.includes(`--${name}`);
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
};

const env = (() => {
  const out = {};
  for (const file of [".env", ".env.local"]) {
    let text;
    try {
      text = fs.readFileSync(path.join(ROOT, file), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      out[m[1]] = v;
    }
  }
  return { ...out, ...process.env };
})();

/** USDT0 on pubnet (docs/HACKMERIDIAN-USDT0.md §1). Testnet has no USDT0; USDC stands in. */
const USDT0_PUBNET_ADDRESS = "CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF";
const DEFAULTS = {
  "stellar:testnet": { facilitator: "https://x402.org/facilitator", asset: USDC_TESTNET_ADDRESS, symbol: "USDC", explorer: "https://stellar.expert/explorer/testnet/tx/" },
  "stellar:pubnet": { facilitator: "https://channels.openzeppelin.com/x402", asset: USDT0_PUBNET_ADDRESS, symbol: "USDT0", explorer: "https://stellar.expert/explorer/public/tx/" },
};

const network = env.STELLAR_NETWORK || "stellar:testnet";
const defaults = DEFAULTS[network];
if (!defaults) {
  console.error(`FAIL: STELLAR_NETWORK must be stellar:testnet or stellar:pubnet, got ${network}`);
  process.exit(2);
}
const facilitatorUrl = env.STELLAR_FACILITATOR_URL || defaults.facilitator;
const apiKey = env.STELLAR_FACILITATOR_API_KEY || null;
const rpcUrl = env.STELLAR_RPC_URL || null;
const asset = env.STELLAR_ASSET_ADDRESS || defaults.asset;
const payTo = env.STELLAR_RECEIVING_ADDRESS || null;
const secret = env.HM_AGENT_SECRET || null;
/** What to call the asset in output. A custom SAC is named by STELLAR_ASSET_CODE, never by the network default. */
const symbol = asset === defaults.asset ? defaults.symbol : env.STELLAR_ASSET_CODE ? `${env.STELLAR_ASSET_CODE} (custom asset)` : "the configured asset";
const amountMicro = BigInt(arg("amount-micro") ?? "100000");
/** Ledger money is 6-dp micro-dollars; Stellar SACs are 7 dp. Wire = micro × 10, exact. */
const amountStroops = (amountMicro * 10n).toString();

console.log(`network       ${network}`);
console.log(`facilitator   ${facilitatorUrl}${apiKey ? "  (Bearer key attached)" : "  (no key)"}`);
console.log(`rpc           ${rpcUrl ?? (network === "stellar:pubnet" ? "MISSING (required on pubnet)" : "(package default)")}`);
console.log(`asset         ${asset} (${symbol})`);
console.log(`payTo         ${payTo ?? "MISSING"}`);
console.log(`payer secret  ${secret ? "found" : "MISSING (HM_AGENT_SECRET)"}`);
console.log(`amount        ${amountStroops} stroops = $${(Number(amountMicro) / 1e6).toFixed(2)}\n`);

const auth = apiKey
  ? async () => {
      const headers = { Authorization: `Bearer ${apiKey}` };
      return { verify: headers, settle: headers, supported: headers };
    }
  : undefined;
const facilitator = new HTTPFacilitatorClient({ url: facilitatorUrl, createAuthHeaders: auth });

// 1. Does this facilitator serve our network with `exact`? Cheap, and it exercises the key.
let supported;
try {
  supported = await facilitator.getSupported();
} catch (e) {
  console.error(`FAIL: /supported did not answer — ${e?.message ?? e}`);
  if (apiKey) console.error("If this is a 401/403, the facilitator key is wrong.");
  else if (facilitatorUrl.includes("openzeppelin")) console.error("OZ Channels needs STELLAR_FACILITATOR_API_KEY, even for /supported.");
  process.exit(1);
}
const kinds = supported?.kinds ?? [];
const ours = kinds.filter((k) => k.network === network && k.scheme === "exact");
console.log(`/supported: ${kinds.length} kind(s); ${ours.length} match 'exact' on ${network}`);
for (const k of ours) console.log(`  x402 v${k.x402Version} extra=${JSON.stringify(k.extra ?? {})}`);
if (!ours.length) {
  console.error(`FAIL: this facilitator does not settle 'exact' on ${network}. Do not point money at it.`);
  process.exit(1);
}
if (flag("supported-only")) {
  console.log("\nok: supported-only. Stopping before any signing.");
  process.exit(0);
}

// 2. The one accepts entry the app will build (docs/HACKMERIDIAN-BUILD.md §3.4).
const problems = [];
if (!payTo || !validateStellarDestinationAddress(payTo)) problems.push("STELLAR_RECEIVING_ADDRESS is missing or not a Stellar address");
if (!validateStellarAssetAddress(asset)) problems.push("STELLAR_ASSET_ADDRESS is not a C… contract address");
if (!secret) problems.push("HM_AGENT_SECRET is missing");
if (network === "stellar:pubnet" && !rpcUrl) problems.push("STELLAR_RPC_URL is required on pubnet");
if (problems.length) {
  for (const p of problems) console.error(`FAIL: ${p}`);
  process.exit(2);
}

const requirements = {
  scheme: "exact",
  network,
  asset,
  amount: amountStroops,
  payTo,
  maxTimeoutSeconds: 300,
  extra: { areFeesSponsored: true },
};
const resource = {
  url: "https://x402git.com/api/r/examples/hm-smoke",
  description: `HackMeridian smoke: $${(Number(amountMicro) / 1e6).toFixed(2)} in ${symbol} on Stellar`,
  mimeType: "application/zip",
};

// 3. Sign the way an agent does: auth entries only, no XLM needed, fees sponsored.
const signer = createEd25519Signer(secret, network);
console.log(`\npayer         ${signer.address}`);
const client = new ExactStellarScheme(signer, rpcUrl ? { url: rpcUrl } : undefined);
let signed;
try {
  signed = await client.createPaymentPayload(2, requirements);
} catch (e) {
  console.error(`FAIL: could not build the payment — ${e?.message ?? e}`);
  console.error("Usual causes: the payer has no trustline for the asset, no balance, or the RPC is wrong.");
  process.exit(1);
}
const paymentPayload = { x402Version: 2, resource, accepted: requirements, payload: signed.payload };
console.log(`payload       transaction XDR, ${String(signed.payload?.transaction ?? "").length} chars`);
if (flag("dry-run")) {
  console.log("\nok: dry-run. Built and signed; nothing was sent to the facilitator.");
  process.exit(0);
}

// 4. /verify: no money moves. The facilitator re-simulates and checks the auth entries.
let verify;
try {
  verify = await facilitator.verify(paymentPayload, requirements);
} catch (e) {
  console.error(`FAIL: /verify did not answer — ${e?.message ?? e}`);
  process.exit(1);
}
console.log(`\n/verify       isValid=${verify.isValid}${verify.payer ? ` payer=${verify.payer}` : ""}`);
if (!verify.isValid) {
  console.error(`FAIL: ${verify.invalidReason ?? "?"}${verify.invalidMessage ? ` — ${verify.invalidMessage}` : ""}`);
  process.exit(1);
}
if (verify.payer && verify.payer !== signer.address) {
  console.error(`FAIL: facilitator reports payer ${verify.payer}, but we signed as ${signer.address}. Do not settle.`);
  process.exit(1);
}
if (flag("verify-only")) {
  console.log("\nok: verify-only. Nothing settled.");
  process.exit(0);
}

// 5. /settle: this moves real money on pubnet.
let settle;
try {
  settle = await facilitator.settle(paymentPayload, requirements);
} catch (e) {
  console.error(`INDETERMINATE: /settle did not answer — ${e?.message ?? e}`);
  console.error("The transfer may still have happened. Check the payer's account on stellar.expert before retrying.");
  process.exit(1);
}
console.log(`/settle       success=${settle.success} network=${settle.network}${settle.payer ? ` payer=${settle.payer}` : ""}`);
if (!settle.success) {
  console.error(`FAIL: ${settle.errorReason ?? "?"}${settle.errorMessage ? ` — ${settle.errorMessage}` : ""}`);
  process.exit(1);
}
if (settle.network !== network) {
  console.error(`WARN: facilitator says network ${settle.network}; we asked for ${network}. The app must never trust this field.`);
}
console.log(`tx            ${settle.transaction}`);
console.log(`              ${defaults.explorer}${settle.transaction}`);
console.log(`\nok: ${amountStroops} stroops of ${symbol} moved ${signer.address} → ${payTo} on ${network}.`);
