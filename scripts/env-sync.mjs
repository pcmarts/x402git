#!/usr/bin/env node
/**
 * scripts/env-sync.mjs — keep `.env` and `.env.local` in 1Password so the team shares one copy.
 *
 *   npm run env:status          which files differ from 1Password, by variable name only
 *   npm run env:pull            1Password → disk (the old file is kept as `<file>.bak`)
 *   npm run env:push            disk → 1Password; refuses if someone pushed since your last sync
 *   npm run env:push -- --force overwrite anyway
 *
 * Maintainer-only: it syncs the operators' shared copy and is not needed to run or develop
 * the app (copy .env.example instead). Each file is one 1Password **Document** item in the
 * vault named by X402_OP_VAULT, in the account named by X402_OP_ACCOUNT, stored byte for
 * byte — so the multi-line GITHUB_APP_PRIVATE_KEY survives, and comments come along.
 * Setup and onboarding: docs/ENV-SYNC.md (internal).
 *
 * Per-person variables (VERCEL_OIDC_TOKEN, written by `vercel env pull` and expiring within
 * hours) are stripped on push and kept from your own file on pull.
 *
 * Conflict guard: every pull or push records the sha256 of what 1Password held in
 * `.env.sync.json` (gitignored by `.env.*`). A push whose remote no longer matches that hash
 * means a teammate pushed in between — pull first, or pass --force.
 *
 * X402_OP_ACCOUNT (the 1Password account UUID or sign-in address) and X402_OP_VAULT are
 * both required and have no default; set X402_OP_VAULT=Private to try it alone. Values are
 * never printed — only variable names.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Which 1Password account and vault hold the shared copy. Required, no defaults: the
// operators' account and vault are not written into the source.
const ACCOUNT = (process.env.X402_OP_ACCOUNT ?? "").trim();
const VAULT = (process.env.X402_OP_VAULT ?? "").trim();
const FILES = [
  { file: ".env", title: "x402git — .env" },
  { file: ".env.local", title: "x402git — .env.local" },
];
const PERSONAL = new Set(["VERCEL_OIDC_TOKEN"]);
const STATE_FILE = path.join(ROOT, ".env.sync.json");

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

function op(args) {
  try {
    return execFileSync("op", [...args, "--account", ACCOUNT, "--vault", VAULT], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    if (err.code === "ENOENT") fail("the 1Password CLI (`op`) is not installed — see docs/ENV-SYNC.md");
    const e = new Error((err.stderr || err.message).trim());
    e.notFound = /isn't an item|not found|no item/i.test(e.message);
    throw e;
  }
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

/** The document's text, or null if the item does not exist yet. */
function getRemote(title) {
  try {
    return op(["document", "get", title]);
  } catch (e) {
    if (e.notFound) return null;
    if (/vault/i.test(e.message)) fail(`${e.message}\n  (is the "${VAULT}" vault shared with you? docs/ENV-SYNC.md)`);
    fail(e.message);
  }
}

/** Split an env file into logical entries (a quoted value may span lines). */
function entries(text) {
  const out = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(lines[i]);
    if (!m) {
      out.push({ key: null, raw: lines[i] });
      continue;
    }
    const raw = [lines[i]];
    const v = m[2].trim();
    const q = v[0];
    if ((q === '"' || q === "'") && !(v.length > 1 && v.endsWith(q))) {
      while (i + 1 < lines.length) {
        raw.push(lines[++i]);
        if (lines[i].trimEnd().endsWith(q)) break;
      }
    }
    out.push({ key: m[1], raw: raw.join("\n") });
  }
  return out;
}

const shareable = (text) =>
  entries(text).filter((e) => !PERSONAL.has(e.key)).map((e) => e.raw).join("\n");

const personalLines = (text) => entries(text).filter((e) => PERSONAL.has(e.key)).map((e) => e.raw);

/** Variable names added, removed and changed going from `a` to `b`. */
function diff(a, b) {
  const map = (t) => new Map(entries(t).filter((e) => e.key).map((e) => [e.key, sha(e.raw)]));
  const A = map(a);
  const B = map(b);
  const added = [...B.keys()].filter((k) => !A.has(k));
  const removed = [...A.keys()].filter((k) => !B.has(k));
  const changed = [...B.keys()].filter((k) => A.has(k) && A.get(k) !== B.get(k));
  const comments = added.length + removed.length + changed.length === 0 && a !== b;
  return { added, removed, changed, comments, same: a === b };
}

function describe(d) {
  if (d.same) return "in sync";
  const parts = [];
  if (d.added.length) parts.push(`+ ${d.added.join(", ")}`);
  if (d.removed.length) parts.push(`- ${d.removed.join(", ")}`);
  if (d.changed.length) parts.push(`~ ${d.changed.join(", ")}`);
  if (d.comments) parts.push("comments/whitespace only");
  return parts.join("   ");
}

const readLocal = (file) => {
  try {
    return fs.readFileSync(path.join(ROOT, file), "utf8");
  } catch {
    return null;
  }
};
const loadState = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
};
const saveState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });

const [cmd, ...flags] = process.argv.slice(2);
const force = flags.includes("--force");

const missing = [!ACCOUNT && "X402_OP_ACCOUNT", !VAULT && "X402_OP_VAULT"].filter(Boolean);
if (missing.length) {
  fail(
    `${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set. This script is maintainer-only and has no defaults:\n` +
      "  export X402_OP_ACCOUNT=<1Password account UUID or sign-in address> X402_OP_VAULT=<vault name>\n" +
      "  To run the app you do not need it — copy .env.example to .env instead.",
  );
}

const state = loadState();
const key = `${ACCOUNT}/${VAULT}`;
state[key] ??= {};

console.log(`1Password: account ${ACCOUNT}, vault "${VAULT}"`);

if (cmd === "status") {
  for (const { file, title } of FILES) {
    const local = readLocal(file);
    const remote = getRemote(title);
    if (local === null && remote === null) console.log(`${file}: absent on disk and in 1Password`);
    else if (remote === null) console.log(`${file}: not in 1Password yet — npm run env:push`);
    else if (local === null) console.log(`${file}: not on disk — npm run env:pull`);
    else {
      const stale = state[key][file] && state[key][file] !== sha(remote) ? "  (1Password changed since your last sync)" : "";
      console.log(`${file}: ${describe(diff(remote, shareable(local)))}${stale}`);
    }
  }
} else if (cmd === "pull") {
  for (const { file, title } of FILES) {
    const remote = getRemote(title);
    if (remote === null) {
      console.log(`${file}: not in 1Password — skipped`);
      continue;
    }
    const local = readLocal(file);
    const mine = local === null ? [] : personalLines(local);
    const next = mine.length ? `${remote.replace(/\n*$/, "\n")}${mine.join("\n")}\n` : remote;
    // Compare without personal lines, so an unchanged pull never reorders your token.
    if (local !== null && shareable(local) === remote) {
      console.log(`${file}: already up to date`);
    } else {
      if (local !== null) fs.writeFileSync(path.join(ROOT, `${file}.bak`), local, { mode: 0o600 });
      fs.writeFileSync(path.join(ROOT, file), next, { mode: 0o600 });
      const d = local === null ? "created" : `${describe(diff(shareable(local), remote))}  (old copy: ${file}.bak)`;
      console.log(`${file}: ${d}`);
    }
    state[key][file] = sha(remote);
  }
  saveState(state);
} else if (cmd === "push") {
  for (const { file, title } of FILES) {
    const local = readLocal(file);
    if (local === null) {
      console.log(`${file}: not on disk — skipped`);
      continue;
    }
    const body = shareable(local);
    const remote = getRemote(title);
    if (remote !== null && remote === body) {
      console.log(`${file}: already in 1Password`);
      state[key][file] = sha(remote);
      continue;
    }
    if (remote !== null && state[key][file] !== sha(remote) && !force) {
      console.log(
        `${file}: REFUSED — 1Password has changes you have not pulled (${describe(diff(body, remote))}).\n` +
          `  Run npm run env:pull, re-apply your edit, push again — or push with --force to overwrite.`,
      );
      process.exitCode = 1;
      continue;
    }
    // `op document` will not read piped stdin from a child process, so hand it a private
    // temp file and remove it whatever happens.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x402-env-"));
    const tmp = path.join(dir, file);
    try {
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      if (remote === null) {
        op(["document", "create", tmp, "--title", title, "--file-name", file]);
        console.log(`${file}: created in 1Password`);
      } else {
        op(["document", "edit", title, tmp, "--file-name", file]);
        console.log(`${file}: ${describe(diff(remote, body))}`);
      }
    } catch (e) {
      fail(e.message);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    state[key][file] = sha(body);
  }
  saveState(state);
} else {
  console.error("usage: node scripts/env-sync.mjs <status|pull|push> [--force]");
  process.exit(2);
}
