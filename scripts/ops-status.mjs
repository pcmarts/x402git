#!/usr/bin/env node
/**
 * scripts/ops-status.mjs — is the money side healthy right now?
 *
 *   node scripts/ops-status.mjs
 *
 * PRD §19's launch checklist asks for monitoring of settlement timeouts, sweep failures
 * and reconciliation variance. V0 has no paging system, and DECISIONS.md is explicit
 * that inventing one nobody is subscribed to would be worse than the honest gap. This is
 * the honest version: one command that answers the questions a pager would have asked,
 * so checking is cheap enough to actually do.
 *
 * It exists because of 2026-09-06. The first real sweep ran the wallet out of USDC
 * halfway through, paid five creators, reverted on a sixth and left three blocked — and
 * nothing said so. The `can it cover what it owes?` section below is that morning,
 * turned into a question that gets asked before the cron runs rather than after.
 *
 * Read-only. Exits non-zero if anything needs a human, so it can be a cron or a CI step
 * later without changing.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { createPublicClient, erc20Abi, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const die = (m) => {
  console.error(`error: ${m}`);
  process.exit(2);
};

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
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      out[m[1]] = v;
    }
  }
  return { ...out, ...process.env };
}

const env = loadEnv();
const ALIASES = { base: 8453, "base-sepolia": 84532 };
const chainId = ALIASES[env.X402_NETWORK] ?? Number(String(env.X402_NETWORK ?? "base-sepolia").split(":")[1] ?? 84532);
const USDC = env.X402_ASSET_ADDRESS ?? (chainId === 8453 ? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" : "0x036CbD53842c5426634e7929541eC2318f3dCF7e");
const RPC = env.EVM_RPC_URL || (chainId === 8453 ? "https://mainnet.base.org" : "https://sepolia.base.org");

const db = createClient(env.SUPABASE_URL || die("SUPABASE_URL missing"), env.SUPABASE_SECRET_KEY || die("SUPABASE_SECRET_KEY missing (.env.local)"), {
  auth: { persistSession: false },
});
const chain = createPublicClient({ transport: http(RPC) });

const usd = (micro) => `$${(Number(micro) / 1e6).toFixed(2)}`;
const problems = [];
const say = (label, value) => console.log(`  ${label.padEnd(26)} ${value}`);

// --- where are we -------------------------------------------------------------
let rpcChain = null;
try {
  rpcChain = await chain.getChainId();
} catch (e) {
  problems.push(`RPC unreachable: ${e.message}`);
}
console.log("\nchain");
say("configured", `${chainId}${chainId === 8453 ? " (Base mainnet)" : chainId === 84532 ? " (Base Sepolia)" : ""}`);
say("rpc serves", rpcChain ?? "unknown");
say("rpc host", (() => {
  try {
    return new URL(RPC).host;
  } catch {
    return "(unparseable)";
  }
})());
if (rpcChain && rpcChain !== chainId) problems.push(`RPC serves chain ${rpcChain} but X402_NETWORK is chain ${chainId}`);

// --- kill switches ------------------------------------------------------------
const { data: switches } = await db.from("ops_switch").select("*").order("name");
const paused = (switches ?? []).filter((s) => s.paused);
console.log("\nkill switches");
say("paused", paused.length ? paused.map((s) => s.name).join(", ") : "none");
for (const s of paused) problems.push(`${s.name} is PAUSED${s.reason ? ` — ${s.reason}` : ""}`);

// --- payouts (every rail: 25 Oct 2026, the ledger is partitioned by `network`) -----------
const { data: payouts } = await db.from("payout").select("*");
const byRail = {};
for (const p of payouts ?? []) {
  const rail = p.network ?? `eip155:${p.chain_id}`;
  byRail[rail] ??= {};
  byRail[rail][p.status] = (byRail[rail][p.status] ?? 0) + 1;
}
const stuck = (payouts ?? []).filter((p) => p.status === "pending" || p.status === "broadcast");
console.log("\npayouts (every rail)");
if (!Object.keys(byRail).length) say("by status", "none");
for (const [rail, counts] of Object.entries(byRail)) say(rail, Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" "));
if (stuck.length) {
  problems.push(`${stuck.length} payout(s) stuck at pending/broadcast — they block their creator. See scripts/ops-clear-stuck-payout.mjs`);
  for (const p of stuck) say("  stuck", `${usd(p.amount_micro)} → ${p.to_address} on ${p.network ?? `eip155:${p.chain_id}`}`);
}

// --- can the sweep wallet cover what it owes? ---------------------------------
// The 2026-09-06 question. Owed is every released, unswept, unrevoked purchase.
const { data: listings } = await db.from("listing").select("id");
const listingIds = (listings ?? []).map((l) => l.id);
const { data: owedRows } = listingIds.length
  ? await db
      .from("purchase")
      .select("net_micro")
      .in("listing_id", listingIds)
      .eq("chain_id", chainId)
      .is("payout_id", null)
      .is("revoked_at", null)
      .lt("holdback_until", new Date().toISOString())
  : { data: [] };
const owed = (owedRows ?? []).reduce((s, p) => s + BigInt(p.net_micro ?? 0), 0n);

const sweepAddr = (() => {
  // The key may only exist in Vercel (§14.8); the local wallet file is the fallback.
  // Never printed — only the address it derives.
  let key = env.SWEEP_WALLET_PRIVATE_KEY;
  if (!key) {
    try {
      key = JSON.parse(fs.readFileSync(path.join(ROOT, "sweep-wallet.local.json"), "utf8")).private_key;
    } catch {
      return null;
    }
  }
  try {
    return privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`).address;
  } catch {
    return null;
  }
})();

console.log("\nsweep wallet");
if (!sweepAddr) {
  say("address", "unknown (no SWEEP_WALLET_PRIVATE_KEY here — fine if it only lives in Vercel)");
  say("released & unswept", usd(owed));
} else {
  const [bal, gas] = await Promise.all([
    chain.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [sweepAddr] }).catch(() => null),
    chain.getBalance({ address: sweepAddr }).catch(() => null),
  ]);
  say("address", sweepAddr);
  say("USDC", bal === null ? "unreadable" : `${usd(bal)}`);
  say("ETH (gas)", gas === null ? "unreadable" : `${Number(gas) / 1e18}`);
  say("released & unswept", usd(owed));
  if (bal !== null && owed > bal) problems.push(`sweep wallet holds ${usd(bal)} but owes ${usd(owed)} — the next sweep will run dry mid-run`);
  if (gas !== null && gas === 0n && owed > 0n) problems.push("sweep wallet has no ETH for gas and has payouts due");
}

// --- last reconcile, per rail (one event per rail per run since 25 Oct 2026) -------------
const { data: recon } = await db.from("event").select("*").eq("name", "reconcile").order("at", { ascending: false }).limit(40);
console.log("\nreconcile");
if (!recon?.length) {
  say("last run", "never");
  problems.push("the reconcile job has never recorded a result");
} else {
  const latest = new Map();
  for (const r of recon) {
    const rail = r.network ?? r.props?.network ?? "primary";
    if (!latest.has(rail)) latest.set(rail, r);
  }
  for (const [rail, r] of latest) {
    const age = (Date.now() - new Date(r.at).getTime()) / 3_600_000;
    const variance = r.props?.variance_micro !== undefined ? usd(r.props.variance_micro) : JSON.stringify(r.props ?? {});
    say(rail, `${new Date(r.at).toISOString()} (${age.toFixed(1)}h ago) · variance ${variance}`);
    if (age > 36) problems.push(`the reconcile for ${rail} has not run in ${age.toFixed(0)}h — the daily cron may be failing`);
  }
}

// --- recent trouble in the event log ------------------------------------------
const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
const { data: recent } = await db.from("event").select("name").gte("at", since);
const counts = {};
for (const e of recent ?? []) counts[e.name] = (counts[e.name] ?? 0) + 1;
const notable = ["sweep_skipped", "paused_block", "settlement_timeout", "settled", "402_issued"].filter((n) => counts[n]);
console.log("\nlast 24h");
say("events", notable.length ? notable.map((n) => `${n}=${counts[n]}`).join(" ") : "nothing notable");

// --- verdict ------------------------------------------------------------------
if (problems.length) {
  console.log(`\n${problems.length} thing(s) need a human:`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log("\nAll good.");
