#!/usr/bin/env node
// Redeliver the most recent GitHub App webhook delivery for a repo and report the response
// status (PRD FR-8.1; OVERNIGHT-PROMPT "redeliver one from the App's Advanced tab via gh api").
// Usage: node scripts/github-webhook-redeliver.mjs [repo-name] [event]
import fs from "node:fs";
import crypto from "node:crypto";

const env = Object.fromEntries(
  fs.readFileSync(".env", "utf8").split("\n").filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => {
    const i = l.indexOf("=");
    let v = l.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\n/g, "\n");
    return [l.slice(0, i), v];
  }),
);
const repoName = process.argv[2] ?? "x402git-e2e-rail-a";
const wantEvent = process.argv[3] ?? "push";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID })}`;
const jwt = `${unsigned}.${crypto.sign("RSA-SHA256", Buffer.from(unsigned), env.GITHUB_APP_PRIVATE_KEY).toString("base64url")}`;
const gh = async (path, init = {}) => {
  const r = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "user-agent": "x402git-redeliver", ...(init.headers ?? {}) },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path} → ${r.status} ${text.slice(0, 200)}`);
  // Delivery ids exceed 2^53; keep them as strings.
  return text ? JSON.parse(text.replace(/"id":(\d{16,})/g, "\"id\":\"$1\"")) : null;
};

const deliveries = await gh("/app/hook/deliveries?per_page=50");
const pick = deliveries.find((d) => d.event === wantEvent && !d.redelivery && (repoName === "any" || d.repository?.name === repoName));
if (!pick) throw new Error(`no ${wantEvent} delivery found for ${repoName}`);
console.log(`original: id=${pick.id} event=${pick.event} action=${pick.action ?? "-"} status=${pick.status_code} at=${pick.delivered_at}`);
await gh(`/app/hook/deliveries/${pick.id}/attempts`, { method: "POST" });
let attempt;
for (let i = 0; i < 15 && !attempt; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const list = await gh("/app/hook/deliveries?per_page=20");
  attempt = list.find((d) => d.guid === pick.guid && d.redelivery && d.id !== pick.id);
}
if (!attempt) throw new Error("redelivery not visible after 30s");
const full = await gh(`/app/hook/deliveries/${attempt.id}`);
console.log(`redelivery: id=${full.id} status=${full.status_code} (${full.status}) duration=${full.duration}s url=${full.url}`);
console.log(`response body: ${JSON.stringify(full.response?.payload ?? "").slice(0, 300)}`);
process.exitCode = full.status_code >= 200 && full.status_code < 300 ? 0 : 1;
