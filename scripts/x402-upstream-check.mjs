#!/usr/bin/env node
/**
 * scripts/x402-upstream-check.mjs — what has upstream x402 done since we last looked?
 *
 *   npm run x402:check              # report only
 *   npm run x402:check -- --record  # report, then move the watermark to now
 *   node scripts/x402-upstream-check.mjs --since 2026-08-01
 *
 * The protocol we sell over is not ours, it moves weekly, and the parts that matter to
 * this product are not the ones a version number advertises. So the check asks four
 * questions, in the order that decides whether anyone has to act:
 *
 * 1. **Are we behind on `@x402/*`?** npm's `latest` against what is installed.
 * 2. **What changed in the packages we import?** The changelog sections above our
 *    version, verbatim — that is where the breaking notes live (2.25.0's
 *    `buildPaymentRequirements` throw, for one).
 * 3. **Is there a new capability?** A new file under `docs/extensions/` or
 *    `docs/schemes/` upstream is a new extension or scheme, which is the only kind of
 *    upstream news that can change the product rather than the dependency.
 * 4. **What landed in the TypeScript SDK since the watermark?** Commit subjects only,
 *    filtered to `typescript/` and `docs/`; the noise from six other SDKs is dropped.
 *
 * The watermark lives in x402-upstream.state.json next to this file, and the standing
 * decisions — what we adopted, what we declined and why — live in
 * docs/x402-upstream.md. Read that before acting on anything printed here.
 *
 * Exit status is 1 when there is news and 0 when there is not, so a scheduled runner
 * can stay quiet on a quiet week. `--record` writes the watermark only on a clean run
 * of the fetches; a network failure leaves it alone.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = path.join(ROOT, "scripts", "x402-upstream.state.json");
const REPO = "x402-foundation/x402";

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
};
const flag = (name) => process.argv.includes(`--${name}`);

/** The packages this repo actually imports, and where their changelog lives upstream. */
const CHANGELOG_DIR = {
  "@x402/core": "typescript/packages/core",
  "@x402/evm": "typescript/packages/mechanisms/evm",
  "@x402/fetch": "typescript/packages/http/fetch",
  "@x402/extensions": "typescript/packages/extensions",
};

const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

/**
 * Installed, not requested: the caret in package.json is not what runs in production.
 * A fresh checkout with no `node_modules` — a CI or scheduled runner — falls back to the
 * declared range with its caret stripped, which is the floor rather than the truth, and
 * says so in the report.
 */
function installedVersion(name) {
  try {
    return { version: JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", name, "package.json"), "utf8")).version, exact: true };
  } catch {
    const range = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? null;
    return range ? { version: range.replace(/^[^\d]*/, ""), exact: false } : { version: null, exact: false };
  }
}

const gh = (p) => {
  const headers = { accept: "application/vnd.github+json", "user-agent": "x402git-upstream-check" };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`https://api.github.com/repos/${REPO}${p}`, { headers });
};

async function json(res, what) {
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`);
  return res.json();
}

/** Semver compare, minor-release channel only — x402 publishes no prereleases. */
function cmp(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

/** The `## x.y.z` sections of a changelog strictly newer than `floor`. */
function sectionsAbove(markdown, floor) {
  const out = [];
  const parts = markdown.split(/^## /m).slice(1);
  for (const part of parts) {
    const version = part.split(/\s/)[0].trim();
    if (/^\d+\.\d+\.\d+$/.test(version) && cmp(version, floor) > 0) out.push(`## ${part.trim()}`);
  }
  return out;
}

async function changelogFor(name) {
  const dir = CHANGELOG_DIR[name];
  if (!dir) return null;
  const url = `https://raw.githubusercontent.com/${REPO}/main/${dir}/CHANGELOG.md`;
  const res = await fetch(url);
  return res.ok ? res.text() : null;
}

async function main() {
  let news = false;
  const lines = [];
  const say = (s = "") => lines.push(s);

  // 1 + 2. Versions, and the changelog above ours.
  say("── versions ─────────────────────────────────────────────");
  const names = Object.keys(pkg.dependencies)
    .concat(Object.keys(pkg.devDependencies ?? {}))
    .filter((n) => n.startsWith("@x402/") || n === "@coinbase/x402");
  const behind = [];
  for (const name of names.sort()) {
    const { version: have, exact } = installedVersion(name);
    const meta = await json(await fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}`), name);
    const latest = meta["dist-tags"].latest;
    const when = (meta.time?.[latest] ?? "").slice(0, 10);
    const stale = have && cmp(latest, have) > 0;
    if (stale) behind.push({ name, have, latest });
    const label = exact ? "installed" : "declared ";
    say(`  ${stale ? "!" : "·"} ${name.padEnd(20)} ${label} ${String(have).padEnd(8)} latest ${latest} (${when})`);
  }
  if (behind.length) {
    news = true;
    for (const { name, have, latest } of behind) {
      const md = await changelogFor(name);
      if (!md) continue;
      const sections = sectionsAbove(md, have);
      if (!sections.length) continue;
      say();
      say(`── ${name} ${have} → ${latest} ─────────────────────────`);
      say(sections.join("\n\n"));
    }
  }

  // 3. New extension or scheme docs — the capability question.
  for (const [dir, known] of [
    ["docs/extensions", state.knownExtensions],
    ["docs/schemes", state.knownSchemes],
  ]) {
    const files = (await json(await gh(`/contents/${dir}`), dir)).map((f) => f.name);
    const added = files.filter((f) => !known.includes(f));
    const removed = known.filter((f) => !files.includes(f));
    say();
    say(`── ${dir} ───────────────────────────────────────────────`);
    if (!added.length && !removed.length) say(`  · no change since ${state.lastReviewed} (${files.length} files)`);
    for (const f of added) {
      news = true;
      say(`  + NEW ${f}  → https://github.com/${REPO}/blob/main/${dir}/${f}`);
    }
    for (const f of removed) say(`  - gone ${f}`);
  }

  // 4. TypeScript SDK and docs commits since the watermark.
  const since = arg("since") ?? state.lastReviewed;
  say();
  say(`── typescript/ + docs/ commits since ${since} ───────────`);
  const seen = new Set();
  for (const p of ["typescript", "docs"]) {
    const commits = await json(await gh(`/commits?since=${since}T00:00:00Z&path=${p}&per_page=100`), `commits ${p}`);
    for (const c of commits) {
      if (seen.has(c.sha)) continue;
      seen.add(c.sha);
      say(`  ${c.commit.author.date.slice(0, 10)}  ${c.commit.message.split("\n")[0]}`);
    }
  }
  if (seen.size) news = true;
  else say("  · nothing");

  say();
  say(news ? "NEWS — review against docs/x402-upstream.md before acting." : "Nothing new.");
  console.log(lines.join("\n"));

  if (flag("record")) {
    const next = {
      ...state,
      lastReviewed: new Date().toISOString().slice(0, 10),
      installed: Object.fromEntries(names.map((n) => [n, installedVersion(n).version])),
    };
    fs.writeFileSync(STATE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`\nWatermark moved to ${next.lastReviewed}.`);
  }

  process.exit(news ? 1 : 0);
}

main().catch((err) => {
  console.error(`x402-upstream-check: ${err.message}`);
  process.exit(2);
});
