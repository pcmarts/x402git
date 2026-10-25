#!/usr/bin/env node
/**
 * scripts/hm-stellar-facilitator.mjs — a self-hosted x402 facilitator for Stellar.
 *
 *   node scripts/hm-stellar-facilitator.mjs                 # http://localhost:4402
 *   PORT=8080 node scripts/hm-stellar-facilitator.mjs
 *
 * The HackMeridian hot standby (docs/HACKMERIDIAN-USDT0.md V1, §4). It exists for one
 * reason: if the hosted facilitator will not settle our asset on `stellar:pubnet`, the
 * app points `STELLAR_FACILITATOR_URL` at this process instead and nothing else changes.
 * It speaks the same three routes `HTTPFacilitatorClient` calls (`GET /supported`,
 * `POST /verify`, `POST /settle`) and runs `@x402/stellar`'s own facilitator scheme, so
 * the verification rules are the package's, not ours.
 *
 * It settles from ONE account, which pays the XLM fees and must hold XLM. That account
 * is the facilitator, not the receiver: the package refuses any payment that touches the
 * facilitator's own address, so do not point `STELLAR_RECEIVING_ADDRESS` at it.
 *
 * Reads `.env` then `.env.local`, shell wins:
 *   STELLAR_NETWORK         stellar:testnet (default) | stellar:pubnet
 *   STELLAR_RPC_URL         Soroban RPC; required on pubnet
 *   HM_FACILITATOR_SECRET   S… of the fee-paying account. Never an argument, never logged.
 *   HM_FACILITATOR_TOKEN    optional; when set, every request needs `Authorization: Bearer <token>`
 *   PORT                    default 4402
 *
 * Expose it beyond localhost only with HM_FACILITATOR_TOKEN set: a facilitator that
 * settles anything it is handed is a fee-paying service for strangers.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import { createEd25519Signer } from "@x402/stellar";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

const network = env.STELLAR_NETWORK || "stellar:testnet";
const rpcUrl = env.STELLAR_RPC_URL || null;
const secret = env.HM_FACILITATOR_SECRET || null;
const token = env.HM_FACILITATOR_TOKEN || null;
const port = Number(env.PORT || 4402);

if (!["stellar:testnet", "stellar:pubnet"].includes(network)) {
  console.error(`FAIL: STELLAR_NETWORK must be stellar:testnet or stellar:pubnet, got ${network}`);
  process.exit(2);
}
if (!secret) {
  console.error("FAIL: HM_FACILITATOR_SECRET is missing");
  process.exit(2);
}
if (network === "stellar:pubnet" && !rpcUrl) {
  console.error("FAIL: STELLAR_RPC_URL is required on pubnet");
  process.exit(2);
}

const signer = createEd25519Signer(secret, network);
const scheme = new ExactStellarScheme([signer], rpcUrl ? { rpcConfig: { url: rpcUrl } } : undefined);
const facilitator = new x402Facilitator().register(network, scheme);

console.log(`network       ${network}`);
console.log(`rpc           ${rpcUrl ?? "(package default)"}`);
console.log(`fee account   ${signer.address}  (must hold XLM; never the receiving address)`);
console.log(`fee ceiling   ${scheme.maxTransactionFeeStroops} stroops per settle`);
console.log(`auth          ${token ? "Bearer token required" : "none (localhost only!)"}`);

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const readJson = (req) =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("body is not JSON"));
      }
    });
    req.on("error", reject);
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const route = url.pathname.replace(/\/+$/, "");
  if (token && req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: "unauthorized" });

  try {
    if (req.method === "GET" && route === "/supported") return json(res, 200, facilitator.getSupported());
    if (req.method === "POST" && (route === "/verify" || route === "/settle")) {
      const body = await readJson(req);
      const { paymentPayload, paymentRequirements } = body ?? {};
      if (!paymentPayload || !paymentRequirements) return json(res, 400, { error: "expected { x402Version, paymentPayload, paymentRequirements }" });
      const started = Date.now();
      const result = route === "/verify" ? await facilitator.verify(paymentPayload, paymentRequirements) : await facilitator.settle(paymentPayload, paymentRequirements);
      // Enough to audit from the terminal, never the payload.
      const outcome = route === "/verify" ? `isValid=${result.isValid}${result.invalidReason ? ` ${result.invalidReason}` : ""}` : `success=${result.success}${result.transaction ? ` tx=${result.transaction}` : ""}${result.errorReason ? ` ${result.errorReason}` : ""}`;
      console.log(`${new Date().toISOString()} ${route} ${paymentRequirements.network} ${paymentRequirements.amount} → ${paymentRequirements.payTo} ${outcome} (${Date.now() - started}ms)`);
      return json(res, 200, result);
    }
    return json(res, 404, { error: "not found" });
  } catch (e) {
    console.error(`${new Date().toISOString()} ${route} error: ${e?.message ?? e}`);
    return json(res, 500, { error: "facilitator error", message: String(e?.message ?? e) });
  }
});

server.listen(port, () => {
  console.log(`\nlistening on http://localhost:${port}  (GET /supported, POST /verify, POST /settle)`);
  console.log(`point the app at it with STELLAR_FACILITATOR_URL=http://localhost:${port}`);
});
