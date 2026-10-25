#!/usr/bin/env node
/**
 * scripts/socket-check.mjs — preflight for the Socket integration
 * (docs/proposals/PRD Trust Report.md §6.2). Read-only; costs 2 quota units.
 *
 *   npm run socket:check
 *
 * Reads `.env` then `.env.local` (later wins, shell wins over both — same rule as
 * with-env.mjs), finds the Socket token under whichever name it was saved as, and prints:
 *   - which variable names were found (never a value)
 *   - the organisations the token can see, with slug and plan — the slug is what
 *     `SOCKET_ORG_SLUG` must be set to
 *   - remaining quota and when the window refreshes
 *   - the manifest globs Socket will ingest from an uploaded archive, and whether any of
 *     them would match a skill file (SKILL.md, .claude/, mcp.json) — the answer decides
 *     whether the `skill*` alert family is reachable through the API at all
 *   - a verdict on whether the token carries the scopes the pipeline needs
 *
 * The token is sent as a Bearer header and nowhere else.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://api.socket.dev/v0";

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
      out[m[1]] = v;
    }
  }
  return { ...out, ...process.env };
}

const env = loadFiles();
const socketNames = Object.keys(env).filter((k) => /SOCKET/i.test(k)).sort();
console.log(`Socket-ish variables present: ${socketNames.length ? socketNames.join(", ") : "none"}`);

// The Socket dashboard shows a token as a public "hash" (its id) and a secret "value";
// only the value authenticates. `.env.local` names them SOCKET_TOKEN_VALUE / _HASH.
const TOKEN_NAMES = ["SOCKET_API_TOKEN", "SOCKET_TOKEN_VALUE", "SOCKET_API_KEY", "SOCKET_SECURITY_API_KEY", "SOCKET_TOKEN", "SOCKET_KEY"];
const tokenName = TOKEN_NAMES.find((n) => env[n]) ?? socketNames.find((n) => /TOKEN|KEY|SECRET/i.test(n) && !/HASH|ID$/i.test(n) && env[n]);
if (!tokenName) {
  console.error(`No Socket token found. Expected one of: ${TOKEN_NAMES.join(", ")}`);
  process.exit(1);
}
const token = env[tokenName];
console.log(`Token: read from ${tokenName} (${token.length} chars, starts "${token.slice(0, 4)}…")`);

const slugName = ["SOCKET_ORG_SLUG", "SOCKET_ORG"].find((n) => env[n]);
const configuredSlug = slugName ? env[slugName] : null;

const api = async (p, init = {}) => {
  const r = await fetch(`${BASE}${p}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: "application/json", "user-agent": "x402git-socket-check", ...(init.headers ?? {}) },
  });
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: r.status, body, retryAfter: r.headers.get("retry-after") };
};

const issues = [];

// 1. Who is this token? `GET /organizations` needs no scope, costs 1 unit.
const orgs = await api("/organizations");
if (orgs.status !== 200) {
  console.error(`GET /organizations → ${orgs.status}`, orgs.body);
  process.exit(1);
}
const orgList = Object.values(orgs.body.organizations ?? orgs.body);
console.log(`Organisations (${orgList.length}):`);
for (const o of orgList) console.log(`  ${o.slug}  plan=${o.plan}  id=${o.id}${o.name ? `  name=${o.name}` : ""}`);
const slug = configuredSlug ?? orgList[0]?.slug;
if (!slug) issues.push("token sees no organisation — create one in the Socket dashboard and re-issue the token under it");
else if (!configuredSlug) issues.push(`SOCKET_ORG_SLUG is not set; the pipeline will need SOCKET_ORG_SLUG=${slug}`);
else if (!orgList.some((o) => o.slug === configuredSlug)) issues.push(`${slugName}=${configuredSlug} is not an org this token can see`);

// 2. Quota. Free plan: 500 units/hour, 1 token, 1,000 full scans/month. Costs 0 units.
const quota = await api("/quota");
if (quota.status === 200) {
  const q = quota.body;
  console.log(`Quota: ${q.quota}/${q.maxQuota} units remaining${q.nextWindowRefresh ? `, window refreshes ${q.nextWindowRefresh}` : ""}`);
  if (q.maxQuota && q.quota / q.maxQuota < 0.2) issues.push("under 20% of the quota window left — a cut right now may land on 429");
} else {
  issues.push(`GET /quota → ${quota.status}`);
}

// 3. What will an uploaded archive actually get scanned for? Costs 1 unit.
if (slug) {
  const files = await api(`/orgs/${slug}/supported-files`);
  if (files.status !== 200) {
    issues.push(`GET /orgs/${slug}/supported-files → ${files.status} (needs a valid org slug; ${files.status === 401 || files.status === 403 ? "token may lack org access" : "check the slug"})`);
  } else {
    const patterns = [];
    for (const [eco, entries] of Object.entries(files.body)) {
      for (const [name, def] of Object.entries(entries ?? {})) patterns.push({ eco, name, pattern: def?.pattern ?? name });
    }
    const byEco = patterns.reduce((m, p) => ((m[p.eco] ??= []).push(p.pattern), m), {});
    console.log(`Supported manifest globs (${patterns.length}) across ${Object.keys(byEco).length} ecosystems:`);
    for (const [eco, globs] of Object.entries(byEco)) console.log(`  ${eco.padEnd(12)} ${globs.join("  ")}`);

    // Our snapshots parse npm, PyPI, Go and crates.io lockfiles (lib/scan/osv.ts
    // packagesFromFiles). Anything Socket ingests beyond those is coverage we gain for
    // free; anything it lacks is a gap the OSV path must keep covering.
    const want = ["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "requirements.txt", "pyproject.toml", "poetry.lock", "go.mod", "go.sum", "Cargo.toml", "Cargo.lock"];
    // The globs use brace expansion (`pnpm-lock.y{a,}ml`), so match, don't substring.
    const missing = want.filter((w) => !patterns.some((p) => path.matchesGlob(w, p.pattern)));
    if (missing.length) issues.push(`Socket does not list: ${missing.join(", ")} — OSV stays the source for those`);

    const skillish = patterns.filter((p) => /skill|claude|mcp|agent|\.md/i.test(p.pattern) || /skill|claude|mcp|agent/i.test(p.eco));
    console.log(
      skillish.length
        ? `Skill-shaped globs present: ${skillish.map((p) => `${p.eco}:${p.pattern}`).join(", ")} — the skill* alert family is reachable via full scans`
        : "No skill-shaped globs (SKILL.md, .claude/, mcp.json): the skill* alert family is NOT reachable via full scans today; our own capability/injection checks carry that",
    );
  }
}

// 4. Scopes. There is no introspection endpoint; infer from a harmless call each. A
//    full-scan *list* is 1 unit and needs `full-scans:list`; creating one is not done here.
if (slug) {
  const list = await api(`/orgs/${slug}/full-scans?per_page=1`);
  if (list.status === 200) console.log("Scope full-scans:list — ok");
  else issues.push(`GET /orgs/${slug}/full-scans → ${list.status}: token likely lacks full-scans:list. The pipeline needs full-scans:create and full-scans:list (packages:list only for the PURL fallback).`);
}

console.log("");
if (issues.length) {
  console.log("Issues:");
  for (const i of issues) console.log(`  - ${i}`);
  process.exit(2);
}
console.log("Socket preflight: ok");
