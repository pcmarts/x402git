#!/usr/bin/env node
/**
 * scripts/ops-clear-stuck-payout.mjs — BLOCKERS.md B8: the missing payout escape hatch.
 *
 *   node scripts/ops-clear-stuck-payout.mjs --chain base            # dry run, prints its reasoning
 *   node scripts/ops-clear-stuck-payout.mjs --chain base --apply    # write
 *   node scripts/ops-clear-stuck-payout.mjs --chain base-sepolia    # the testnet ledger
 *
 *   --rpc <url>        the RPC to read (else EVM_RPC_URL, else the chain's public endpoint)
 *   --payer <address>  the sweep wallet's address (else read from the chain's key file)
 *
 * A payout row at `pending` or `broadcast` blocks every future sweep for that creator
 * (FR-28, `inFlightPayout`), and `lib/payouts/sweep.ts` will not clear one itself:
 *
 *     "pending/broadcast are indeterminate and only ops may clear them"
 *
 * That is the right default — a row can be `pending` because the process died *after*
 * `sendTransaction` returned and *before* the hash was written, in which case money
 * moved and clearing the row would double-pay. B8 recorded that no tooling existed to
 * make the determination. This is that tooling.
 *
 * **It never trusts the database.** For each stuck row it goes to chain and asks whether
 * the sweep wallet ever transferred that exact amount to that exact address, scanning
 * ERC-20 `Transfer` logs from before the oldest stuck row was opened. Only a row that is
 * provably unpaid is cleared, and it is set to `failed` rather than deleted: `failed` is
 * the one non-confirmed state the sweep treats as retryable, so the next cron tick
 * reopens it under a `:r2` idempotency key through the path that already exists. Nothing
 * here broadcasts a transfer or touches a purchase row.
 *
 * A row with a `tx_hash`, or one whose payment is found on chain, is reported and left
 * alone: that is a reconciliation question for a human, not a retry.
 *
 * **"Provably unpaid" is a claim about one chain** (RED-TEAM-2026-09-21.md PAY-1). One
 * database serves both networks, so the chain is named on the command line and never
 * defaulted, and the script refuses to run unless four things agree: the `--chain` asked
 * for, the chain id the RPC reports, the USDC contract scanned, and the `chain_id` on
 * every row read. The payer comes from that chain's own key file, and is checked against
 * the sender of the last confirmed payout on the same chain. Looking for a mainnet
 * transfer on Sepolia finds nothing, and "nothing" is what this script clears on — the
 * sweep would then pay the creator a second time.
 *
 * First used 2026-09-06, after the first live sweep ran the wallet out of USDC mid-run
 * and left three creators blocked. See BLOCKERS.md B4.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { createPublicClient, getAddress, http, isAddress, parseAbiItem } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APPLY = process.argv.includes("--apply");

/** The two ledgers this database holds. The asset is the canonical USDC `lib/env.ts` prices in. */
const CHAINS = {
  base: {
    chainId: 8453,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    rpc: "https://mainnet.base.org",
    keyFile: "sweep-mainnet.local.json",
  },
  "base-sepolia": {
    chainId: 84532,
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    rpc: "https://sepolia.base.org",
    keyFile: "sweep-wallet.local.json",
  },
};

/** ~2s blocks on Base. Only used to guess where to start; the block's own timestamp decides. */
const BLOCK_SECONDS = 2;
/** How far before the oldest stuck row the scan starts. A sweep broadcasts seconds after it opens the row. */
const MARGIN_SECONDS = 6 * 3600;

const die = (m) => {
  console.error(`error: ${m}`);
  process.exit(1);
};

function flag(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return null;
  const value = process.argv[i + 1];
  if (!value || value.startsWith("--")) die(`${name} needs a value`);
  return value;
}

/** `.env` then `.env.local`, then the shell — the real Supabase secret lives in `.env.local`. */
function loadEnv() {
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
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\n/g, "\n");
      out[m[1]] = v;
    }
  }
  return { ...out, ...process.env };
}

const chainName = flag("--chain");
if (!chainName) die(`--chain is required: ${Object.keys(CHAINS).join(" or ")}. There is no default — the wrong chain reads every paid row as unpaid.`);
const CHAIN = Object.hasOwn(CHAINS, chainName) ? CHAINS[chainName] : die(`unknown --chain "${chainName}": ${Object.keys(CHAINS).join(" or ")}`);

// A mistyped flag fails now, not on the night there is a stuck row to clear.
const givenPayer = flag("--payer");
if (givenPayer && !isAddress(givenPayer)) die(`--payer is not an address: ${givenPayer}`);

const env = loadEnv();
const SUPABASE_URL = env.SUPABASE_URL || die("SUPABASE_URL missing");
const SUPABASE_SECRET_KEY = env.SUPABASE_SECRET_KEY || die("SUPABASE_SECRET_KEY missing (it lives in .env.local)");
// An RPC for the other chain is caught below by its chain id, whichever of these named it.
const RPC = flag("--rpc") || env.EVM_RPC_URL || CHAIN.rpc;
const USDC = CHAIN.usdc;

/** The signer whose outbound transfers are the evidence. Never printed, only its address is. */
function sweepAddress() {
  if (givenPayer) return getAddress(givenPayer);
  let key;
  try {
    key = JSON.parse(fs.readFileSync(path.join(ROOT, CHAIN.keyFile), "utf8")).private_key;
  } catch {
    key = null;
  }
  if (!key) die(`no --payer and no ${CHAIN.keyFile} — cannot identify the ${chainName} sweep wallet`);
  return privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`).address;
}

const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const chain = createPublicClient({ transport: http(RPC) });
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

// The host only: an RPC URL is often a credential (lib/chain.ts).
const rpcHost = (() => {
  try {
    return new URL(RPC).host;
  } catch {
    return die("the RPC URL does not parse");
  }
})();
const served = await chain.getChainId().catch(() => die(`could not read the chain id from ${rpcHost}`));
if (served !== CHAIN.chainId) {
  die(`${rpcHost} serves chain ${served}, not ${chainName} (${CHAIN.chainId}). Pass --rpc for the right chain. Nothing was read or written.`);
}

/** Every outbound USDC transfer the sweep wallet has made in the window, as a list. */
async function outboundTransfers(from, fromBlock, toBlock) {
  const out = [];
  let cursor = fromBlock;
  while (cursor <= toBlock) {
    const end = cursor + 9000n > toBlock ? toBlock : cursor + 9000n;
    out.push(...(await chain.getLogs({ address: USDC, event: TRANSFER, args: { from: getAddress(from) }, fromBlock: cursor, toBlock: end })));
    cursor = end + 1n;
  }
  return out;
}

/** A block at or before `seconds` (unix). Estimated from the block time, then walked back until its timestamp agrees. */
async function blockAtOrBefore(seconds, latest) {
  let guess = latest.number - BigInt(Math.ceil((Number(latest.timestamp) - seconds) / BLOCK_SECONDS));
  for (let i = 0; i < 12; i++) {
    if (guess <= 0n) return 0n;
    const block = await chain.getBlock({ blockNumber: guess });
    const late = Number(block.timestamp) - seconds;
    if (late <= 0) return guess;
    guess -= BigInt(Math.ceil(late / BLOCK_SECONDS) + 1000);
  }
  return die("could not find a block older than the oldest stuck row; nothing was written");
}

const { data: stuck, error } = await db
  .from("payout")
  .select("*")
  .eq("chain_id", CHAIN.chainId)
  .in("status", ["pending", "broadcast"])
  .order("created_at");
if (error) die(`could not read payouts: ${error.message}`);

if (!stuck?.length) {
  console.log(`no ${chainName} payouts are stuck at pending or broadcast. Nothing to do.`);
  process.exit(0);
}

const payer = sweepAddress();

// The payer is the one input that cannot be read off the chain id, so it is checked
// against the ledger: the last payout this chain confirmed names, on chain, who paid it.
const { data: lastPaid, error: lastPaidError } = await db
  .from("payout")
  .select("tx_hash")
  .eq("chain_id", CHAIN.chainId)
  .eq("status", "confirmed")
  .not("tx_hash", "is", null)
  .order("created_at", { ascending: false })
  .limit(1);
if (lastPaidError) die(`could not read confirmed payouts: ${lastPaidError.message}`);
if (lastPaid?.length) {
  const tx = await chain.getTransaction({ hash: lastPaid[0].tx_hash }).catch(() => null);
  if (!tx) die(`the last confirmed ${chainName} payout (${lastPaid[0].tx_hash}) is not on this chain; refusing to reason about it`);
  if (tx.from.toLowerCase() !== payer.toLowerCase()) {
    die(`the last confirmed ${chainName} payout was sent by ${tx.from}, not ${payer}. Wrong key file or --payer; a scan of the wrong wallet finds nothing and clears everything.`);
  }
} else {
  console.log(`note: no confirmed ${chainName} payout exists to check the payer against; ${payer} is taken on trust.`);
}

// Transfers a confirmed payout already accounts for are not evidence about a stuck one.
const { data: settled, error: settledError } = await db.from("payout").select("tx_hash").eq("chain_id", CHAIN.chainId).eq("status", "confirmed").not("tx_hash", "is", null);
if (settledError) die(`could not read confirmed payouts: ${settledError.message}`);
const accountedFor = new Set((settled ?? []).map((p) => String(p.tx_hash).toLowerCase()));

const latest = await chain.getBlock();
const oldest = Math.floor(new Date(stuck[0].created_at).getTime() / 1000);
const fromBlock = await blockAtOrBefore(oldest - MARGIN_SECONDS, latest);
const transfers = (await outboundTransfers(payer, fromBlock, latest.number)).filter((t) => !accountedFor.has(String(t.transactionHash).toLowerCase()));

console.log(`chain            ${chainName} (${CHAIN.chainId}) via ${rpcHost}`);
console.log(`payer            ${payer}`);
console.log(`asset            ${USDC}`);
console.log(`scanned          ${transfers.length} unaccounted outbound transfers since block ${fromBlock} (oldest stuck row: ${stuck[0].created_at})`);
console.log(`stuck payouts    ${stuck.length}`);
console.log(APPLY ? "\nmode: APPLY — provably-unpaid rows will be set to failed\n" : "\nmode: dry run — nothing will be written (pass --apply to write)\n");

const clearable = [];
for (const p of stuck) {
  const to = String(p.to_address).toLowerCase();
  const amount = BigInt(p.amount_micro);
  const match = transfers.find((t) => String(t.args.to).toLowerCase() === to && t.args.value === amount);

  if (p.tx_hash) {
    console.log(`HOLD  ${p.id}  ${to}  ${amount} — row carries tx_hash ${p.tx_hash}; reconcile by hand, not with this script`);
    continue;
  }
  if (match) {
    console.log(`HOLD  ${p.id}  ${to}  ${amount} — PAID ON CHAIN in ${match.transactionHash}; this row should be confirmed, not retried`);
    continue;
  }
  console.log(`CLEAR ${p.id}  ${to}  ${amount} — no tx_hash and no matching transfer on ${chainName}; provably unpaid`);
  clearable.push(p);
}

if (!clearable.length) {
  console.log("\nnothing is provably unpaid. No row cleared.");
  process.exit(0);
}

if (!APPLY) {
  console.log(`\n${clearable.length} row(s) would be set to failed, unblocking the next sweep for those creators.`);
  console.log("Re-run with --apply to write.");
  process.exit(0);
}

for (const p of clearable) {
  const { error: e } = await db.from("payout").update({ status: "failed" }).eq("id", p.id).eq("chain_id", CHAIN.chainId).eq("status", p.status);
  if (e) die(`could not clear ${p.id}: ${e.message}`);
  console.log(`cleared ${p.id} → failed`);
}
console.log(`\n${clearable.length} row(s) cleared. The next sweep reopens each under a :r2 key (MAX_FAILED_RETRIES = 3).`);
