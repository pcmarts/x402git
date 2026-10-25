#!/usr/bin/env node
/**
 * scripts/telegram-check.mjs — preflight for the admin notification channel.
 *
 *   npm run telegram:check          read-only: who the bot is, which chat, is it an admin
 *   npm run telegram:check -- --send  also posts one sample of each event kind
 *
 * Reads `.env` then `.env.local` (later wins, shell wins over both — same rule as
 * scripts/socket-check.mjs), then answers the three questions that decide whether
 * `lib/notify` can work at all:
 *
 *   1. `getMe`         — is the token live, and which bot is it?
 *   2. `getChat`       — does TELEGRAM_ADMIN_CHAT_ID name a chat this bot can see?
 *   3. `getChatMember` — is the bot an **administrator** there? A channel silently drops
 *                        posts from a non-admin, which looks exactly like a working
 *                        integration that nobody reads.
 *
 * The token travels in the URL path, which is how the Bot API works, and is therefore
 * never printed: this script reports the variable it came from and its length, and the
 * failure paths print `sendMessage`-style method names, never a URL.
 *
 * The `--send` samples are **hand-written approximations of `formatAdminEvent`**, not the
 * formatter itself. This repo has no TypeScript loader for `.mjs` scripts (no tsx, no
 * ts-node — see package.json), and `lib/notify/index.ts` imports through the `@/` alias,
 * so importing the real one here is not possible without adding a build step for a
 * preflight. Keep them roughly in step by eye; the authoritative rendering is asserted
 * character for character in lib/notify/index.test.ts.
 *
 * The posting itself is not duplicated: `--send` goes through `scripts/lib/telegram.mjs`,
 * which is also what `scripts/ops-takedown.mjs` uses to announce a takedown (14 Sep 2026).
 * The three read-only checks below stay on `api()` — they need a *parsed result*, and a
 * preflight is the one caller that should shout and exit rather than shrug.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendTelegram } from "./lib/telegram.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEND = process.argv.includes("--send");

function loadFiles() {
  const out = {};
  for (const file of [".env", ".env.local"]) {
    let text;
    try {
      text = fs.readFileSync(path.join(ROOT, file), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      else v = v.replace(/\s+#.*$/, "").trim();
      out[m[1]] = v;
    }
  }
  return { ...out, ...process.env };
}

function die(reason) {
  console.error(`Telegram preflight failed: ${reason}`);
  process.exit(1);
}

const env = loadFiles();
const token = env.TELEGRAM_BOT_TOKEN;
const chatId = env.TELEGRAM_ADMIN_CHAT_ID;
const appUrl = (env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/+$/, "");

if (!token) die("TELEGRAM_BOT_TOKEN is not set in .env, .env.local or the shell");
if (!chatId) die("TELEGRAM_ADMIN_CHAT_ID is not set in .env, .env.local or the shell");
console.log(`Token: TELEGRAM_BOT_TOKEN (${token.length} chars, id ${token.split(":")[0]})`);
console.log(`Chat:  TELEGRAM_ADMIN_CHAT_ID=${chatId}`);

/** One Bot API call. The token is in the path, so only the method name is ever printed. */
async function api(method, params) {
  let r;
  try {
    r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params ?? {}),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    die(`${method} could not be reached (${e instanceof Error ? e.message.split(token).join("<token>") : String(e)})`);
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.ok !== true) die(`${method} → ${r.status} ${body.description ?? "no description"}`);
  return body.result;
}

// 1. Who is this token?
const me = await api("getMe");
console.log(`Bot:   @${me.username} (${me.first_name}, id ${me.id})`);

// 2. Which chat is that id?
const chat = await api("getChat", { chat_id: chatId });
console.log(`Title: "${chat.title ?? chat.username ?? chat.id}" type=${chat.type}`);

// 3. Can it actually post there? A channel accepts an admin's messages and drops the rest.
const member = await api("getChatMember", { chat_id: chatId, user_id: me.id });
const isAdmin = member.status === "administrator" || member.status === "creator";
console.log(`Member: status=${member.status}${isAdmin ? " — administrator" : ""}${member.can_post_messages === false ? " (can_post_messages=false)" : ""}`);
if (!isAdmin) die(`the bot is "${member.status}" in that chat, not an administrator — add @${me.username} as an admin with "post messages"`);

// 4. Optional: one sample per kind, so the channel can be seen working end to end.
if (SEND) {
  const samples = [
    ["👤 <b>New creator @acme</b>", "via: web", "wallet: self_custody", `${appUrl}/admin/creators/acme`].join("\n"),
    ["📦 <b>New listing acme/widgets</b>", "price: $9.00 USDC", "rail: hosted", "visibility: public", `${appUrl}/admin/listings/sample`].join("\n"),
    [
      "💸 <b>$1.50 USDC — acme/widgets</b>",
      "version: 1.2.0",
      "kind: initial",
      "source: agent",
      "chain: Base Sepolia",
      'tx: <a href="https://sepolia.basescan.org/tx/0x1234567890abcdefabcd">0x1234…abcd</a>',
      `${appUrl}/admin/listings/sample`,
    ].join("\n"),
    ["🚨 <b>Error in POST /api/r</b>", "code: settlement_timeout", "message: facilitator did not confirm", `${appUrl}/admin/activity`].join("\n"),
    ["🔒 <b>Switch paused by pcmarts</b>", "subject: payments", "via: admin", "reason: facilitator returning 5xx", `${appUrl}/admin/audit`].join("\n"),
  ];
  for (const text of samples) {
    const { delivered, reason } = await sendTelegram(text, { token, chatId });
    if (!delivered) die(`sendMessage → ${reason}`);
  }
  console.log(`Sent ${samples.length} sample messages (samples, not the formatter — see the header).`);
}

console.log("");
console.log(`Telegram preflight: ok${SEND ? "" : " (read-only; pass --send to post samples)"}`);
