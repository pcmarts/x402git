#!/usr/bin/env node
/**
 * scripts/audit-check.mjs — the CI dependency gate for the production tree.
 *
 *   npm run audit:check
 *
 * Runs `npm audit --omit=dev --json`, drops every advisory whose GHSA id is listed in
 * `.audit-allowlist.json`, and fails (exit 1) when a high or critical advisory remains.
 * It exists because `npm audit --audit-level=high` has no way to accept a single advisory
 * that cannot be fixed without breaking a dependency's declared range.
 *
 * `.audit-allowlist.json` is an array of
 *   { "id": "GHSA-xxxx-xxxx-xxxx", "reason": "...", "added": "YYYY-MM-DD", "review_by": "YYYY-MM-DD" }
 * Every entry expires: once its `review_by` date has passed the gate fails and names it,
 * so an exception is re-justified or removed rather than forgotten.
 *
 * Fails closed: an unreadable allowlist, a malformed entry, or an audit that returns no
 * report (registry down, no lockfile) is exit 1, never a pass. Node built-ins only.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWLIST_FILE = path.join(ROOT, ".audit-allowlist.json");
const SEVERITIES = ["critical", "high", "moderate", "low", "info"];
const BLOCKING = new Set(["critical", "high"]);
const GHSA = /^GHSA(-[a-z0-9]{4}){3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function fail(message) {
  console.error(`audit:check: ${message}`);
  process.exit(1);
}

function isDate(value) {
  return typeof value === "string" && DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** The allowlist, validated. Any problem with the file is a failure, not an empty list. */
function readAllowlist() {
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(ALLOWLIST_FILE, "utf8"));
  } catch (err) {
    fail(`cannot read ${path.basename(ALLOWLIST_FILE)}: ${err.message}`);
  }
  if (!Array.isArray(entries)) fail(`${path.basename(ALLOWLIST_FILE)} must be a JSON array`);

  const today = new Date().toISOString().slice(0, 10);
  const byId = new Map();
  for (const [i, entry] of entries.entries()) {
    const where = `${path.basename(ALLOWLIST_FILE)}[${i}]`;
    if (!entry || typeof entry !== "object") fail(`${where} is not an object`);
    const { id, reason, added, review_by: reviewBy } = entry;
    if (typeof id !== "string" || !GHSA.test(id)) fail(`${where}.id must be a GHSA id, got ${JSON.stringify(id)}`);
    if (typeof reason !== "string" || reason.trim() === "") fail(`${where} (${id}) has no reason`);
    if (!isDate(added)) fail(`${where} (${id}).added must be YYYY-MM-DD`);
    if (!isDate(reviewBy)) fail(`${where} (${id}).review_by must be YYYY-MM-DD`);
    if (byId.has(id)) fail(`${where} (${id}) is listed twice`);
    if (reviewBy < today) {
      fail(
        `allowlist entry ${id} expired: review_by ${reviewBy} is before today (${today}). ` +
          `Re-check the advisory, then remove the entry or extend review_by with a fresh reason.`,
      );
    }
    byId.set(id, { id, reason, reviewBy });
  }
  return byId;
}

/** The parsed `npm audit --json` report. npm exits 1 whenever it finds anything, so the
 *  exit code says nothing on its own; the report on stdout is what counts. */
function runAudit() {
  const res = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  if (res.error) fail(`could not run npm audit: ${res.error.message}`);
  let report;
  try {
    report = JSON.parse(res.stdout);
  } catch {
    fail(`npm audit did not return JSON (exit ${res.status}):\n${(res.stderr || res.stdout || "").trim()}`);
  }
  if (report.error) fail(`npm audit failed: ${report.error.summary || JSON.stringify(report.error)}`);
  if (!report.vulnerabilities || typeof report.vulnerabilities !== "object") {
    fail("npm audit returned no vulnerabilities object (is this an audit report v2?)");
  }
  return report;
}

/** One record per advisory, with every package that carries it directly. Entries in `via`
 *  that are strings only say "depends on a vulnerable package" and repeat an advisory
 *  already collected from that package, so they are skipped. */
function collectAdvisories(report) {
  const advisories = new Map();
  for (const [pkg, vuln] of Object.entries(report.vulnerabilities)) {
    for (const via of vuln.via ?? []) {
      if (typeof via !== "object" || via === null) continue;
      const id = String(via.url ?? "").match(/GHSA-[\w-]+/)?.[0] ?? `npm-${via.source}`;
      const known = advisories.get(id);
      if (known) {
        known.packages.add(via.name ?? pkg);
        continue;
      }
      advisories.set(id, {
        id,
        severity: SEVERITIES.includes(via.severity) ? via.severity : "info",
        title: via.title ?? "",
        range: via.range ?? "",
        packages: new Set([via.name ?? pkg]),
      });
    }
  }
  return [...advisories.values()];
}

function counts(list) {
  const c = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const a of list) c[a.severity] += 1;
  return SEVERITIES.map((s) => `${s} ${c[s]}`).join(", ");
}

function describe(a) {
  return `${a.id} ${a.severity} ${[...a.packages].join(", ")} ${a.range} — ${a.title}`;
}

const allowlist = readAllowlist();
const all = collectAdvisories(runAudit());
const skipped = all.filter((a) => allowlist.has(a.id));
const remaining = all.filter((a) => !allowlist.has(a.id));
const blocking = remaining.filter((a) => BLOCKING.has(a.severity));

console.log(`npm audit (production deps), advisories before allowlist: ${counts(all)} | after: ${counts(remaining)}`);

if (skipped.length > 0) {
  console.log("Allowlisted (skipped):");
  for (const a of skipped) {
    const entry = allowlist.get(a.id);
    console.log(`  ${describe(a)}`);
    console.log(`    reason: ${entry.reason} (review by ${entry.reviewBy})`);
  }
}

const unused = [...allowlist.keys()].filter((id) => !all.some((a) => a.id === id));
if (unused.length > 0) {
  console.log(`Allowlist entries that no longer match any advisory (remove them): ${unused.join(", ")}`);
}

const nonBlocking = remaining.filter((a) => !BLOCKING.has(a.severity));
if (nonBlocking.length > 0) {
  console.log("Below the gate (moderate, low, info):");
  for (const a of nonBlocking) console.log(`  ${describe(a)}`);
}

if (blocking.length > 0) {
  console.error("High or critical advisories not on the allowlist:");
  for (const a of blocking) console.error(`  ${describe(a)}`);
  process.exit(1);
}

console.log("audit:check passed: no high or critical advisory outside the allowlist.");
