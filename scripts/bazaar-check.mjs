#!/usr/bin/env node
/**
 * scripts/bazaar-check.mjs — the maintainers' production check (https://x402git.com by default; `--pay` needs their credentials).
 *
 * Is each listing declared to, and indexed by, the x402 Bazaar?
 *
 *   npm run bazaar:check -- --all
 *   npm run bazaar:check -- examples/humanizer pcmarts/acl-recovery-tracker
 *
 * Why it exists (docs/research/Agent Discovery Channels.md): the facilitator catalogues
 * a resource only when it settles a payment whose payload echoes the `bazaar` extension
 * the 402 declared (lib/x402/bazaar.ts). So a listing enters the Bazaar on its first
 * sale, and not before. This script reports both halves — declared? indexed? — for each
 * listing, and never pays.
 *
 * Decision, 16 Sep 2026 (founder; DECISIONS.md): the platform does not buy listings to
 * seed the index. The first sale is the creator's to make. `--pay` exists for a creator
 * who wants to be that buyer of their own listing: it needs `BAZAAR_SEED_PRIVATE_KEY`
 * (a Base mainnet wallet holding USDC), spends the listed price for real, records a real
 * purchase (the wallet becomes a holder and an install, FR-40), and then polls the
 * Bazaar for the entry. It never prints a key.
 */

import fs from "node:fs";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

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
          if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
          return [l.slice(0, i), v];
        }),
    );
  } catch {
    return {};
  }
})();
const conf = (key, fallback) => process.env[key] ?? env[key] ?? fallback;

const BASE_URL = conf("BASE_URL", "https://x402git.com").replace(/\/+$/, "");
const BAZAAR = "https://api.cdp.coinbase.com/platform/v2/x402/discovery";

const args = process.argv.slice(2);
const check = !args.includes("--pay");
const all = args.includes("--all");
const refs = args.filter((a) => !a.startsWith("--"));

const say = (label, value) => console.log(`   ${label.padEnd(18)} ${value}`);
const usd = (micro) => `$${(Number(micro) / 1e6).toFixed(2)}`;
function fail(message) {
  console.error(`\nFAILED: ${message}`);
  process.exit(1);
}

const json = async (res) => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text.slice(0, 300) };
  }
};

// --- which listings -------------------------------------------------------------

let targets = refs;
if (all) {
  const wk = await json(await fetch(`${BASE_URL}/.well-known/x402`));
  if (!Array.isArray(wk.resources)) fail(`${BASE_URL}/.well-known/x402 did not list resources: ${JSON.stringify(wk)}`);
  targets = wk.resources.map((u) => u.replace(`${BASE_URL}/api/r/`, ""));
}
if (targets.length === 0) fail("name at least one <owner>/<slug>, or pass --all");

// --- the Bazaar's view ----------------------------------------------------------

async function indexed(resourceUrl, payTo) {
  const res = await fetch(`${BAZAAR}/merchant?payTo=${payTo}&limit=100`);
  if (!res.ok) return { known: false, error: `merchant lookup -> ${res.status}` };
  const body = await json(res);
  const hit = (body.resources ?? []).find((r) => r.resource === resourceUrl);
  return { known: Boolean(hit), entry: hit ?? null };
}

// --- the buyer, only when paying --------------------------------------------------

let fetchWithPay = null;
let httpClient = null;
let buyer = null;
if (!check) {
  const key = conf("BAZAAR_SEED_PRIVATE_KEY");
  if (!key) fail("--pay needs BAZAAR_SEED_PRIVATE_KEY — a Base mainnet wallet holding USDC.");
  const account = privateKeyToAccount(key);
  buyer = account.address;
  const client = x402Client.fromConfig({ schemes: [{ network: "eip155:*", client: new ExactEvmScheme(account) }], spendControls: false });
  httpClient = new x402HTTPClient(client);
  fetchWithPay = wrapFetchWithPayment(fetch, client);
}

console.log(`Bazaar ${check ? "check" : "seed"} — ${targets.length} listing(s) at ${BASE_URL}`);
if (buyer) say("buyer", buyer);

let problems = 0;
for (const ref of targets) {
  const [owner, slug] = ref.split("/");
  if (!owner || !slug) {
    console.log(`\n${ref}: not an <owner>/<slug>`);
    problems++;
    continue;
  }
  const resourceUrl = `${BASE_URL}/api/r/${owner}/${slug}`;
  console.log(`\n${ref}`);

  const unpaid = await fetch(resourceUrl);
  if (unpaid.status !== 402) {
    say("402", `no — ${unpaid.status} (free, retired, or not a listing)`);
    problems++;
    continue;
  }
  const body = await json(unpaid);
  const declared = Boolean(body.extensions?.bazaar?.info?.input);
  const payTo = body.accepts?.[0]?.payTo;
  say("price", usd(body.accepts?.[0]?.amount ?? "0"));
  say("serviceName", body.resource?.serviceName ?? "(none)");
  say("tags", (body.resource?.tags ?? []).join(", ") || "(none)");
  say("declaration", declared ? "present" : "MISSING — the 402 carries no extensions.bazaar");
  if (!declared) {
    problems++;
    continue;
  }

  const before = await indexed(resourceUrl, payTo);
  say("in Bazaar", before.known ? `yes — ${JSON.stringify(before.entry.quality ?? {})}` : before.error ? `unknown (${before.error})` : "no");
  if (check || before.known) continue;

  // Pay. The x402 client copies `extensions` and `resource` from the 402 into the
  // payload by itself; the quote id is ours (FR-23) and goes in the header.
  const paid = await fetchWithPay(resourceUrl, { headers: { "x-quote-id": body.extra?.quote_id ?? "" } });
  const grant = await json(paid);
  if (!paid.ok) {
    say("payment", `FAILED ${paid.status} ${JSON.stringify(grant).slice(0, 200)}`);
    problems++;
    continue;
  }
  const settlement = httpClient.getPaymentSettleResponse((name) => paid.headers.get(name));
  say("settled", settlement.transaction ?? "(no tx hash)");
  say("version", grant.version);

  // The facilitator catalogues asynchronously; give it a minute.
  let after = { known: false };
  for (let i = 0; i < 12 && !after.known; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    after = await indexed(resourceUrl, payTo);
  }
  say("in Bazaar", after.known ? "yes" : "not yet — check again later; the facilitator has been slow to index (x402-foundation/x402#2112)");
  if (!after.known) problems++;
}

console.log(`\n${problems === 0 ? "Done." : `Done, with ${problems} listing(s) needing attention.`}`);
process.exit(problems === 0 ? 0 : 2);
