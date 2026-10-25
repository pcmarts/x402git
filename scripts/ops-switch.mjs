#!/usr/bin/env node
/**
 * scripts/ops-switch.mjs — the §19 kill switches, from a terminal.
 *
 *   node scripts/ops-switch.mjs list
 *   node scripts/ops-switch.mjs pause payments --reason "facilitator returning 5xx"
 *   node scripts/ops-switch.mjs resume payments
 *
 * Four global pauses: registrations, publishing, payments, sweeps. Flipping one takes
 * effect within ten seconds everywhere (lib/ops/switches.ts caches for that long) and
 * needs no deploy — which is the whole point of a switch you reach for during an
 * incident.
 *
 * What each one stops, precisely, because "pause payments" is ambiguous until you say:
 *
 *   registrations  a new creator, on either rail. An idempotent replay of a
 *                  registration that already succeeded still replays.
 *   publishing     a genuine draft → live. Re-publishing a live listing is still a
 *                  no-op 200, because it changes nothing.
 *   payments       issuing a 402 and accepting an authorization, with **503, never
 *                  402**. A wallet that already owns a version can still fetch it
 *                  (FR-19), and a $0 listing is not a payment.
 *   sweeps         every payout, cron and forced alike. Nothing is written; the
 *                  purchases stay unswept for the next unpaused run.
 *
 * `--reason` is for whoever reads this table at 3am, including you. It is never shown
 * to a caller: a paused endpoint answers everyone identically.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SWITCHES = ["registrations", "publishing", "payments", "sweeps"];

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : null;
};
const die = (m) => {
  console.error(`error: ${m}`);
  process.exit(1);
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
const db = createClient(
  env.SUPABASE_URL || die("SUPABASE_URL missing"),
  env.SUPABASE_SECRET_KEY || die("SUPABASE_SECRET_KEY missing (it lives in .env.local)"),
  { auth: { persistSession: false } },
);

const [command, name] = argv;

async function list() {
  const { data, error } = await db.from("ops_switch").select("*").order("name");
  if (error) die(error.message);
  const rows = data ?? [];
  const seen = new Set(rows.map((r) => r.name));
  const all = [...rows, ...SWITCHES.filter((n) => !seen.has(n)).map((n) => ({ name: n, paused: false, reason: null, updated_at: null, updated_by: null }))];
  all.sort((a, b) => a.name.localeCompare(b.name));

  for (const r of all) {
    const state = r.paused ? "PAUSED " : "running";
    const when = r.updated_at ? ` · ${new Date(r.updated_at).toISOString()}${r.updated_by ? ` by ${r.updated_by}` : ""}` : "";
    console.log(`${state}  ${r.name.padEnd(14)}${r.paused && r.reason ? ` — ${r.reason}` : ""}${when}`);
  }
  if (all.some((r) => r.paused)) console.log("\nSomething is paused. `resume <name>` when the incident is over.");
}

async function set(paused) {
  if (!name) die(`which switch? one of: ${SWITCHES.join(", ")}`);
  if (!SWITCHES.includes(name)) die(`unknown switch "${name}". One of: ${SWITCHES.join(", ")}`);
  const reason = flag("reason");
  if (paused && !reason) die('a pause needs --reason "…" — the next person to read this table will want it, and it is usually you');

  const { data, error } = await db
    .from("ops_switch")
    .upsert(
      { name, paused, reason: paused ? reason : null, updated_by: flag("by") ?? os.userInfo().username, updated_at: new Date().toISOString() },
      { onConflict: "name" },
    )
    .select("*")
    .single();
  if (error) die(error.message);

  console.log(`${name} is now ${data.paused ? "PAUSED" : "running"}${data.reason ? ` — ${data.reason}` : ""}`);
  console.log("Takes effect everywhere within ten seconds. No deploy needed.");
}

switch (command) {
  case "list":
    await list();
    break;
  case "pause":
    await set(true);
    break;
  case "resume":
    await set(false);
    break;
  default:
    console.log("usage: ops-switch.mjs list | pause <name> --reason \"…\" | resume <name>");
    console.log(`       switches: ${SWITCHES.join(", ")}`);
    process.exit(command ? 1 : 0);
}
