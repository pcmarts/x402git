#!/usr/bin/env node
// Verify GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY in .env: mint an App JWT, fetch /app and
// /app/installations, and compare permissions/events against PRD Final.md (D10, FR-1, FR-7).
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
const { GITHUB_APP_ID: id, GITHUB_APP_PRIVATE_KEY: pem } = env;
if (!id || !pem) throw new Error("GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY missing in .env");

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: id })}`;
const sig = crypto.sign("RSA-SHA256", Buffer.from(unsigned), pem).toString("base64url");
const jwt = `${unsigned}.${sig}`;

const gh = async (path) => {
  const r = await fetch(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "user-agent": "x402git-check" },
  });
  if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`);
  return r.json();
};

const app = await gh("/app");
console.log(`App: ${app.name} (${app.slug}) id=${app.id} owner=${app.owner.login} ${app.html_url}`);
console.log(`client_id matches .env: ${app.client_id === env.GITHUB_OAUTH_CLIENT_ID}`);
console.log("permissions:", app.permissions);
console.log("events:", app.events);

// `members: read` is not a nice-to-have: the Rail A ownership check verifies an org
// installation by *membership* rather than by id equality (security hardening,
// 2026-08-30 — see BLOCKERS.md B8). Without it every org install fails closed.
const want = { contents: "read", metadata: "read", administration: "write", members: "read" };
const issues = [];
for (const [k, v] of Object.entries(want)) if (app.permissions[k] !== v) issues.push(`permission ${k}: want ${v}, have ${app.permissions[k] ?? "none"}`);
for (const k of Object.keys(app.permissions)) if (!(k in want)) issues.push(`extra permission ${k}=${app.permissions[k]} (PRD: least privilege)`);
for (const e of ["push", "release"]) if (!app.events.includes(e)) issues.push(`missing event ${e}`);

const inst = await gh("/app/installations");
console.log(`installations (${inst.length}):`, inst.map((i) => `${i.account.login} [${i.target_type}] id=${i.id} repos=${i.repository_selection}`));

// Adding a permission to the App does not grant it to anything. GitHub holds each
// existing installation at the permission set it accepted until an admin approves the
// new one, so an App that *declares* `members: read` can still be issuing tokens that
// do not carry it — and the Rail A org check would go on failing closed with nothing in
// the App settings to suggest why. This compares what each installation actually holds
// against what the App asks for.
for (const i of inst) {
  const held = i.permissions ?? {};
  const missing = Object.entries(want).filter(([k, v]) => held[k] !== v);
  const label = `${i.account.login} [${i.target_type}]`;
  if (missing.length === 0) {
    console.log(`  ${label}: has every permission the App asks for`);
    continue;
  }
  const detail = missing.map(([k, v]) => `${k}: want ${v}, has ${held[k] ?? "none"}`).join("; ");
  // Only an org install can use `members`, so only an org install failing this is a
  // problem worth failing the check over. A user install is reported and moves on.
  if (i.target_type === "Organization") {
    issues.push(`installation ${label} has not accepted — ${detail}. Approve at https://github.com/organizations/${i.account.login}/settings/installations/${i.id}`);
  } else {
    console.log(`  note: ${label} has not accepted — ${detail} (harmless: a user install cannot use org permissions)`);
  }
}
const hosted = (env.GITHUB_HOSTED_ORGS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
for (const org of hosted) if (!inst.some((i) => i.account.login.toLowerCase() === org.toLowerCase())) issues.push(`not installed on hosted org ${org}`);
if (!env.GITHUB_OAUTH_CLIENT_SECRET) issues.push("GITHUB_OAUTH_CLIENT_SECRET empty");

console.log(issues.length ? `\nISSUES:\n- ${issues.join("\n- ")}` : "\nAll good.");
process.exitCode = issues.length ? 1 : 0;
