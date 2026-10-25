#!/usr/bin/env node
/**
 * scripts/ops-takedown.mjs — §19's fifth kill switch: per-listing takedown (FR-39).
 *
 *   node scripts/ops-takedown.mjs inspect  owner/slug
 *   node scripts/ops-takedown.mjs retire   owner/slug --reason "upheld DMCA notice #12"
 *   node scripts/ops-takedown.mjs revoke   owner/slug --reason "…" --i-have-refunded
 *
 * The other four switches are global states an operator flips. This one is an action
 * against one listing, taken because a notice was upheld (see /abuse), so it is a script
 * rather than a row.
 *
 * **`retire` is the takedown.** It sets `retired_at`, which stops new purchases at once
 * (FR-43): `/api/r` answers `410 retired` to non-holders, the manifest and release log
 * stay up marked "no longer sold", and — this is the part that matters — **every wallet
 * that already bought keeps every version it owns.** That is FR-46, and it holds even
 * here. Retire is terminal and slugs are not reused.
 *
 * **`revoke` is the rare, heavier half**, and it is the *only* thing in this product that
 * takes access away from a buyer who paid (FR-39, and the buyer terms say so in as many
 * words). Reach for it when the artifact itself is the infringement and leaving it in
 * buyers' hands continues it — not because a listing was bad.
 *
 * ## The refund is not automated, and this script will not pretend otherwise
 *
 * FR-39 says a takedown "may revoke purchases and refund from the holdback". The revoke
 * half is a column; the refund half is money leaving an address, and V0 has no path that
 * sends USDC to a buyer — payouts go only to a creator's bound payout address, and no
 * `to` parameter exists anywhere by design (FR-26). So `revoke` prints exactly what is
 * owed, to whom, and refuses to run without `--i-have-refunded`, which is you asserting
 * you have paid those buyers by hand.
 *
 * Refusing to revoke silently is the point. Revoking without refunding is taking
 * someone's money and their goods, and the tool should make that impossible to do by
 * accident and awkward to do on purpose.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { escapeHtml, sendTelegram } from "./lib/telegram.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i > -1 ? (argv[i + 1]?.startsWith("--") ? true : (argv[i + 1] ?? true)) : null;
};
const has = (n) => argv.includes(`--${n}`);
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
const db = createClient(env.SUPABASE_URL || die("SUPABASE_URL missing"), env.SUPABASE_SECRET_KEY || die("SUPABASE_SECRET_KEY missing (.env.local)"), {
  auth: { persistSession: false },
});

const APP_URL = (env.NEXT_PUBLIC_APP_URL || "https://x402git.com").replace(/\/+$/, "");
const BY = os.userInfo().username;

/**
 * Announce one takedown on the admin channel (ADMIN-NOTIFICATIONS.md, 14 Sep 2026).
 *
 * The web path gets this for free inside `recordAdminAction`; a script cannot, because it
 * writes the audit row by direct insert and has no TypeScript loader to reach
 * `formatAdminEvent` with. So the 🔒 shape is **duplicated here by hand** — keep it in
 * step with the `admin_action` case in lib/notify/index.ts by eye. `via: script` is what
 * tells the reader which of the two it was, exactly as it does on /admin/audit.
 *
 * Never fatal: the takedown has already happened and Telegram being down does not undo
 * it. One line either way, so a silent channel is never mistaken for a sent message.
 */
async function announce(action, label, subject, reason, listingId) {
  const text = [
    `🔒 <b>${escapeHtml(label)} by ${escapeHtml(BY)}</b>`,
    `subject: ${escapeHtml(subject)}`,
    "via: script",
    `reason: ${escapeHtml(reason)}`,
    `${APP_URL}/admin/listings/${encodeURIComponent(listingId)}`,
  ].join("\n");
  const { delivered, reason: why } = await sendTelegram(text, { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_ADMIN_CHAT_ID });
  console.log(delivered ? `telegram: posted ${action} to the admin channel.` : `telegram: not posted (${why}).`);
}

const [command, ref] = argv;
if (!command || !["inspect", "retire", "revoke"].includes(command)) {
  console.log('usage: ops-takedown.mjs inspect|retire|revoke owner/slug --reason "…"');
  process.exit(command ? 1 : 0);
}
if (!ref || !ref.includes("/")) die("which listing? owner/slug");

const [owner, slug] = ref.split("/");

const { data: creator } = await db.from("creator").select("id, handle").ilike("handle", owner).maybeSingle();
if (!creator) die(`no creator with handle "${owner}"`);

const { data: listing } = await db.from("listing").select("*").eq("creator_id", creator.id).eq("slug", slug.toLowerCase()).maybeSingle();
if (!listing) die(`no listing ${ref}`);

const { data: purchases } = await db.from("purchase").select("*").eq("listing_id", listing.id).is("revoked_at", null);
const live = purchases ?? [];
const buyers = [...new Set(live.map((p) => p.buyer_address))];
const grossMicro = live.reduce((s, p) => s + BigInt(p.gross_micro ?? 0), 0n);
const usd = (micro) => `$${(Number(micro) / 1e6).toFixed(2)}`;

console.log(`listing     ${ref}  (${listing.id})`);
console.log(`status      ${listing.retired_at ? `retired ${new Date(listing.retired_at).toISOString()}` : listing.published_at ? "live" : "draft"}`);
console.log(`purchases   ${live.length} live, ${buyers.length} distinct wallet(s), ${usd(grossMicro)} gross\n`);

if (command === "inspect") {
  for (const p of live) console.log(`  ${p.buyer_address}  ${usd(p.gross_micro)}  ${p.kind}  ${new Date(p.granted_at).toISOString()}`);
  if (!live.length) console.log("  (no live purchases)");
  process.exit(0);
}

const reason = flag("reason");
if (typeof reason !== "string" || reason.length < 3) die('--reason "…" is required: this is written to the event log and it is the record of why');

if (command === "retire") {
  if (listing.retired_at) die("already retired; retire is terminal");
  const retiredAt = new Date().toISOString();
  const { error } = await db.from("listing").update({ retired_at: retiredAt }).eq("id", listing.id);
  if (error) die(error.message);
  await db.from("event").insert({ name: "takedown_retired", listing_id: listing.id, props: { reason, by: BY, ref } });
  await announce("takedown_retired", "Listing retired (takedown)", ref, reason, listing.id);

  console.log(`retired ${ref} at ${retiredAt}.`);
  console.log("New purchases stop now. Every wallet that already bought keeps every version it owns (FR-46).");
  console.log(`If the artifact itself is the infringement, ${live.length} purchase(s) may also need revoking — see \`revoke\`.`);
  process.exit(0);
}

// --- revoke -------------------------------------------------------------------
if (!live.length) die("nothing to revoke: no live purchases on this listing");

console.log("Revoking takes access away from wallets that paid. What is owed:\n");
for (const p of live) console.log(`  refund ${usd(p.gross_micro)} to ${p.buyer_address}`);
console.log(`\n  total ${usd(grossMicro)} across ${buyers.length} wallet(s)\n`);

if (!has("i-have-refunded")) {
  console.error("refusing: V0 has no automated buyer refund — payouts go only to a creator's bound address (FR-26).");
  console.error("Pay the buyers above by hand, then re-run with --i-have-refunded to assert you have.");
  process.exit(1);
}

const revokedAt = new Date().toISOString();
const { error } = await db.from("purchase").update({ revoked_at: revokedAt }).eq("listing_id", listing.id).is("revoked_at", null);
if (error) die(error.message);
await db.from("event").insert({
  name: "takedown_revoked",
  listing_id: listing.id,
  props: { reason, by: BY, ref, purchases: live.length, gross_micro: grossMicro.toString(), refunds_asserted: true },
});
await announce("takedown_revoked", "Purchases revoked (takedown)", ref, reason, listing.id);

console.log(`revoked ${live.length} purchase(s) at ${revokedAt}. Those wallets can no longer fetch any version.`);
if (!listing.retired_at) console.log("The listing is still selling — run `retire` as well, or it will simply be bought again.");
