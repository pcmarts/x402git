#!/usr/bin/env node
/**
 * scripts/check-facilitator.mjs — can this deployment settle on the network it claims?
 *
 *   node scripts/check-facilitator.mjs                    # the configured facilitator
 *   node scripts/check-facilitator.mjs --network eip155:8453
 *   node scripts/check-facilitator.mjs --network eip155:42161   # an X402_EXTRA_EVM_RAILS rail
 *
 * The cutover check. `GET /supported` is the one question worth asking a facilitator
 * before pointing real money at it: it names the (scheme, network) pairs it will
 * actually settle, and it exercises the credentials on the way — an unauthenticated or
 * misconfigured client fails here rather than at the first buyer's `settle`.
 *
 * Base mainnet settles through Coinbase's facilitator, which signs a JWT per request;
 * the public testnet facilitator takes no key. This mirrors `facilitatorConfig()` in
 * lib/x402/server.ts: CDP credentials go to a CDP host and nowhere else.
 *
 * Per rail since 25 Oct 2026 (docs/HACKMERIDIAN-EVM-USDT0-RAIL.md): when `--network` names
 * a rail in `X402_EXTRA_EVM_RAILS` that has its own `facilitatorUrl`, that facilitator is
 * the one asked, exactly as `resourceServerFor` would settle there; otherwise the primary's.
 * `--url` still overrides both. The script says which URL it asked and where it came from.
 *
 * No key is printed. Whether one was found is.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFacilitatorConfig } from "@coinbase/x402";
import { HTTPFacilitatorClient } from "@x402/core/server";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
      // A JSON value (X402_EXTRA_EVM_RAILS) arrives quoted and, from `vercel env pull`, with its inner quotes escaped.
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\"/g, '"');
      else if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
      out[m[1]] = v;
    }
  }
  return { ...out, ...process.env };
})();

const CDP_HOST = "api.cdp.coinbase.com";
const isCdpHost = (url) => {
  try {
    const h = new URL(url).hostname;
    return h === CDP_HOST || h.endsWith(`.${CDP_HOST}`);
  } catch {
    return false;
  }
};

const ALIASES = { base: "eip155:8453", "base-sepolia": "eip155:84532" };
const caip2 = (v) => ALIASES[v] ?? v;

const want = caip2(arg("network") ?? env.X402_NETWORK ?? "base-sepolia");

// The extra EVM rails, read the way lib/env.ts#extraEvmRails reads them: a JSON array of
// `{ network, facilitatorUrl? }`. Only the facilitator matters here.
const extraRail = (() => {
  const raw = env.X402_EXTRA_EVM_RAILS;
  if (!raw || raw.trim() === "") return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(`FAIL: X402_EXTRA_EVM_RAILS is not JSON: ${e?.message ?? e}`);
    process.exit(1);
  }
  if (!Array.isArray(parsed)) {
    console.error("FAIL: X402_EXTRA_EVM_RAILS must be a JSON array of rails");
    process.exit(1);
  }
  return parsed.find((r) => r && r.network === want) ?? null;
})();
const railUrl = extraRail && typeof extraRail.facilitatorUrl === "string" && extraRail.facilitatorUrl.length > 0 ? extraRail.facilitatorUrl : null;

const url = arg("url") ?? railUrl ?? (env.X402_FACILITATOR_URL || null);
const source = arg("url")
  ? "--url"
  : railUrl
    ? `X402_EXTRA_EVM_RAILS entry for ${want}`
    : extraRail
      ? `X402_FACILITATOR_URL (the ${want} rail shares the primary's facilitator)`
      : url
        ? "X402_FACILITATOR_URL"
        : "nothing set";
const hasKeys = Boolean(env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET);
const cdp = hasKeys ? createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET) : null;
const config = !url ? (cdp ?? {}) : cdp && isCdpHost(url) ? { ...cdp, url } : { url };

console.log(`facilitator   ${config.url ?? "(library default)"}  [from ${source}]`);
console.log(`credentials   ${config.createAuthHeaders ? "CDP key pair, attached" : hasKeys ? "present but NOT attached (facilitator is not a CDP host)" : "none"}`);
console.log(`asking about  ${want}\n`);

let supported;
try {
  supported = await new HTTPFacilitatorClient(config).getSupported();
} catch (e) {
  console.error(`FAIL: /supported did not answer — ${e?.message ?? e}`);
  if (config.createAuthHeaders) console.error("If this is a 401/403, the CDP key pair is wrong or lacks x402 access.");
  process.exit(1);
}

const kinds = supported?.kinds ?? [];
console.log(`${kinds.length} kind(s) supported:`);
for (const k of kinds) console.log(`  ${k.scheme ?? "?"} on ${k.network ?? "?"}`);

const match = kinds.filter((k) => k.network === want);
console.log("");
if (!match.length) {
  console.error(`FAIL: this facilitator does not settle on ${want}. Do not point money at it.`);
  process.exit(1);
}
if (!match.some((k) => k.scheme === "exact")) {
  console.error(`FAIL: ${want} is served, but not with the 'exact' scheme this product uses.`);
  process.exit(1);
}
console.log(`ok: 'exact' on ${want} is supported. Settlement is reachable.`);
