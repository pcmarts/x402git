#!/usr/bin/env node
/**
 * scripts/e2e-sweep-pass.mjs — the maintainers' production check (https://x402git.com by default); it needs their credentials.
 *
 * BLOCKERS.md B4: the FR-34 second pass.
 *
 *   node scripts/e2e-sweep-pass.mjs                                # prod
 *   node scripts/e2e-sweep-pass.mjs --base http://localhost:3000   # dev server
 *
 * FR-34's last clause — "sweep pays wallet A on Base Sepolia" — is the one part of the
 * definition of done the overnight run could not exercise: its sales were seconds old
 * and FR-27 holds them for seven days. This script is the pass that runs once the
 * holdback has elapsed. It needs `SWEEP_WALLET_PRIVATE_KEY` in the *target's*
 * environment (Vercel for prod), not here; locally it only reads `CRON_SECRET` and the
 * chain config from `.env`.
 *
 * What it does, in order:
 *
 *   1. snapshot the USDC balance of each wallet A recorded in docs/archive/E2E-REPORT.md;
 *   2. trigger `GET /api/cron/sweep` (Vercel's own bearer convention) — the same code
 *      path the daily 03:00 UTC cron runs, so nothing is special-cased for the test;
 *   3. for every payout the cron reports `confirmed`, verify it independently on chain:
 *      the receipt succeeded, its ERC-20 `Transfer` log pays exactly `amount_micro` of
 *      USDC to exactly `to_address`, and the balance delta at that address agrees;
 *   4. assert both production rail creators were paid at the wallet A addresses the
 *      overnight run bound — the FR-26 claim, now with money attached.
 *
 * No key is read or printed here. Addresses, amounts and transaction hashes are.
 *
 * Timing: run it on 2026-09-06 between ~00:30 and 03:00 UTC. Before ~00:10 the prod
 * sales are still inside the holdback; after 03:00 Vercel's cron has already swept and
 * a second pass finds `nothing_to_sweep` (the tx hashes are then in the cron's own
 * response, in the Vercel logs).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, erc20Abi, http, parseEventLogs } from "viem";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// --- .env, the same minimal loader scripts/e2e-fr34.mjs uses -------------------

const env = (() => {
  try {
    return Object.fromEntries(
      fs
        .readFileSync(path.join(ROOT, ".env"), "utf8")
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
const setting = (name) => process.env[name] ?? env[name] ?? null;

/** B4: the generated sweep credentials. Holds `cron_secret` when `.env` does not. */
const localWallet = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "sweep-wallet.local.json"), "utf8"));
  } catch {
    return null;
  }
})();

// --- what the overnight run bound (docs/archive/E2E-REPORT.md, production) -----

/** Base Sepolia USDC — the report's asset row; `X402_ASSET_ADDRESS` overrides. */
const USDC = setting("X402_ASSET_ADDRESS") ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/**
 * The two production rail creators and the payout addresses (wallet A) their runs
 * bound. These are the FR-34 assertion: the sweep must pay *these* addresses, because
 * nothing in the API can name any other (FR-26). The local-run creators share the same
 * database and are verified generically in step 3; their throwaway addresses were not
 * recorded.
 *
 * They are production identifiers, so they are not in the source. They are read from
 * `e2e-sweep.local.json` at the repo root (gitignored by `*.local.json`), a JSON array
 * with one entry per rail creator:
 *
 *   [
 *     { "rail": "prod A", "creatorId": "<creator uuid>", "walletA": "0x<40 hex: bound payout address>" },
 *     { "rail": "prod B", "creatorId": "<creator uuid>", "walletA": "0x<40 hex: bound payout address>" }
 *   ]
 */
const EXPECTED_FILE = "e2e-sweep.local.json";
const EXPECTED = (() => {
  const shape = `see the comment above EXPECTED in scripts/e2e-sweep-pass.mjs for its shape`;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(ROOT, EXPECTED_FILE), "utf8"));
  } catch (err) {
    const why = err?.code === "ENOENT" ? "is missing" : `could not be read as JSON (${err.message})`;
    console.error(`error: ${EXPECTED_FILE} ${why}. It names the rail creators and the payout addresses the sweep must pay; ${shape}.`);
    process.exit(2);
  }
  const valid =
    Array.isArray(parsed) &&
    parsed.length > 0 &&
    parsed.every(
      (e) =>
        typeof e?.rail === "string" &&
        typeof e?.creatorId === "string" &&
        e.creatorId.length > 0 &&
        typeof e?.walletA === "string" &&
        /^0x[0-9a-fA-F]{40}$/.test(e.walletA),
    );
  if (!valid) {
    console.error(`error: ${EXPECTED_FILE} must be a non-empty array of { rail, creatorId, walletA }; ${shape}.`);
    process.exit(2);
  }
  return parsed;
})();

// --- args ---------------------------------------------------------------------

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = argOf("--base", "https://x402git.com").replace(/\/$/, "");
const RPC = argOf("--rpc", setting("EVM_RPC_URL") ?? "https://sepolia.base.org");

const chain = {
  id: 84532,
  name: "eip155:84532",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};
const client = createPublicClient({ chain, transport: http(RPC) });

const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const usdc = (micro) => `$${(Number(micro) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
const balanceOf = (address) =>
  client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] });

let failures = 0;
const ok = (msg) => console.log(`  ok: ${msg}`);
const bad = (msg) => {
  failures += 1;
  console.error(`  FAIL: ${msg}`);
};

// --- the pass -----------------------------------------------------------------

/**
 * An RPC URL can *be* a credential: CDP embeds the client API key in the path
 * (`…/rpc/v1/base/<key>`), and so do Alchemy and Infura. Printing one to a terminal
 * puts it in scrollback, in whatever gets pasted into an issue, and in CI logs. Print
 * the host and the shape, never the last segment.
 */
function safeRpc(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    return parts.length ? `${u.origin}/${parts.slice(0, -1).concat("…").join("/")}` : u.origin;
  } catch {
    return "(unparseable rpc url)";
  }
}

console.log(`B4 second pass against ${BASE} (rpc ${safeRpc(RPC)})`);

// 1. Balances before, for the wallets the report recorded.
const before = new Map();
for (const e of EXPECTED) before.set(e.walletA, await balanceOf(e.walletA));

// 2. Trigger the sweep through the cron route — the path Vercel itself runs daily.
const cronSecret = setting("CRON_SECRET") ?? localWallet?.cron_secret ?? null;
if (!cronSecret) console.log("note: no CRON_SECRET in the environment or sweep-wallet.local.json; production will refuse this call (W2.3)");
let res;
try {
  res = await fetch(`${BASE}/api/cron/sweep`, {
    headers: cronSecret ? { authorization: `Bearer ${cronSecret}` } : {},
  });
} catch (e) {
  console.error(`FAIL: could not reach ${BASE}: ${e.cause?.message ?? e.message}`);
  process.exit(1);
}
if (!res.ok) {
  console.error(`FAIL: GET /api/cron/sweep answered ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const summary = await res.json();
console.log(`cron ran at ${summary.ran_at}: ${summary.creators} creator(s) with released balance, swept ${usdc(summary.swept_micro)}`);

if (summary.creators === 0) {
  console.error(
    "FAIL: nothing was released. Either the holdback has not elapsed yet (prod sales release ~2026-09-06 00:10 UTC)\n" +
      "or the daily 03:00 UTC cron already swept — check the payouts on https://sepolia.basescan.org/address/" +
      EXPECTED[0].walletA,
  );
  process.exit(1);
}

// 3. Verify every payout the cron reports, independently, on chain.
for (const r of summary.results) {
  const label = `creator ${r.creator_id.slice(0, 8)}…`;
  if (r.error) {
    bad(`${label} errored: ${r.error}`);
    continue;
  }
  if (r.skipped) {
    bad(`${label} skipped: ${r.skipped} (payout ${r.payout_id ?? "—"}) — nothing broadcast`);
    continue;
  }
  if (r.status !== "confirmed" || !r.tx_hash) {
    bad(`${label} finished '${r.status}' with tx ${r.tx_hash ?? "none"} — see the payout row`);
    continue;
  }

  const receipt = await client.getTransactionReceipt({ hash: r.tx_hash });
  if (receipt.status !== "success") {
    bad(`${label} tx ${r.tx_hash} reverted`);
    continue;
  }
  const transfers = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs }).filter(
    (l) => same(l.address, USDC) && same(l.args.to, r.to_address),
  );
  const paid = transfers.reduce((sum, l) => sum + l.args.value, 0n);
  if (paid !== BigInt(r.amount_micro)) {
    bad(`${label} tx ${r.tx_hash} transfers ${usdc(paid)} to ${r.to_address}, ledger says ${usdc(r.amount_micro)}`);
    continue;
  }
  ok(`${label} paid ${usdc(r.amount_micro)} to ${r.to_address} — https://sepolia.basescan.org/tx/${r.tx_hash}`);
}

// 4. The B4 assertion: the recorded wallet A addresses were paid, and the balances moved.
for (const e of EXPECTED) {
  const result = summary.results.find((r) => r.creator_id === e.creatorId);
  if (!result) {
    bad(`${e.rail}: creator ${e.creatorId} not in the sweep at all`);
    continue;
  }
  if (!same(result.to_address, e.walletA)) {
    bad(`${e.rail}: paid ${result.to_address}, but the run bound wallet A ${e.walletA} (FR-26)`);
    continue;
  }
  const delta = (await balanceOf(e.walletA)) - before.get(e.walletA);
  if (result.status === "confirmed" && delta !== BigInt(result.amount_micro)) {
    bad(`${e.rail}: wallet A balance moved ${usdc(delta)}, ledger says ${usdc(result.amount_micro)}`);
    continue;
  }
  if (result.status === "confirmed") ok(`${e.rail}: wallet A ${e.walletA} balance rose by exactly ${usdc(delta)}`);
}

if (failures > 0) {
  console.error(`\n${failures} failure(s). B4 stays open.`);
  process.exit(1);
}
console.log("\nSweep pays wallet A on Base Sepolia — FR-34 is complete. Close B4 and update docs/archive/E2E-REPORT.md step 13.");
