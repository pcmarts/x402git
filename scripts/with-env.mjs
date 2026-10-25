#!/usr/bin/env node
/**
 * scripts/with-env.mjs — run a command with this repo's env loaded, pointed at either
 * Supabase project. Exists for the org migration (docs/MIGRATION-PRD.md §5), where two
 * projects are live at once and the `supabase` CLI auto-loads `.env`, which names only
 * the old one.
 *
 *   node scripts/with-env.mjs supabase migration list --linked          # old project
 *   node scripts/with-env.mjs --new supabase link --project-ref        # ref from SUPABASE_PROJECT_REF
 *   node scripts/with-env.mjs --new sh -c 'psql "$NEW_..." -c "select 1"'
 *
 * `.env` then `.env.local` (later wins — the real old secret key lives in `.env.local`),
 * and nothing overrides a variable already set in the calling shell. With `--new`, the
 * four canonical names (SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY /
 * SUPABASE_DB_PASSWORD) are rewritten from their `SUPABASE_x402_*` counterparts, so any
 * tool that reads the ordinary names — including `supabase link` and `db push` — reaches
 * the new project without editing a file on disk.
 *
 * The project ref is never written into this file. A bare `--project-ref` (last argument,
 * or followed by another flag) is filled from SUPABASE_PROJECT_REF, read from the shell or
 * the env files like everything else; there is no default, and the wrapper refuses to run
 * the command if it is unset.
 *
 * Both modes also export the side-explicit pairs OLD_SUPABASE_URL /
 * OLD_SUPABASE_SECRET_KEY / OLD_PGPASSWORD and NEW_SUPABASE_URL / NEW_SUPABASE_SECRET_KEY
 * / NEW_PGPASSWORD, which is what a script that must touch both sides in one process
 * (scripts/migrate-storage.mjs) reads.
 *
 * This wrapper prints nothing of its own: whatever it runs owns stdout, and none of these
 * values is ever safe to echo.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** `.env` then `.env.local`, later file wins; the shell always wins over both. */
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
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[m[1]] = v;
    }
  }
  return out;
}

const argv = process.argv.slice(2);
const useNew = argv[0] === "--new";
const cmd = useNew ? argv.slice(1) : argv;
if (cmd.length === 0) {
  console.error("usage: node scripts/with-env.mjs [--new] <command> [args...]");
  process.exit(2);
}

const file = loadFiles();
// The shell wins: a variable already exported by the caller is left exactly as it is.
const env = { ...file, ...process.env };

// Side-explicit names, from the canonical values as the files define them — these are the
// same in both modes, so a script can address either project regardless of --new.
const both = {
  OLD_SUPABASE_URL: file.SUPABASE_URL,
  OLD_SUPABASE_SECRET_KEY: file.SUPABASE_SECRET_KEY,
  OLD_PGPASSWORD: file.SUPABASE_DB_PASSWORD,
  NEW_SUPABASE_URL: file.SUPABASE_x402_URL,
  NEW_SUPABASE_SECRET_KEY: file.SUPABASE_x402_SECRET_KEY,
  NEW_PGPASSWORD: file.SUPABASE_x402_DB_PASSWORD,
};
for (const [k, v] of Object.entries(both)) {
  if (v !== undefined && env[k] === undefined) env[k] = v;
}

if (useNew) {
  const swap = {
    SUPABASE_DB_PASSWORD: file.SUPABASE_x402_DB_PASSWORD,
    SUPABASE_URL: file.SUPABASE_x402_URL,
    SUPABASE_PUBLISHABLE_KEY: file.SUPABASE_x402_PUBLISHABLE_KEY,
    SUPABASE_SECRET_KEY: file.SUPABASE_x402_SECRET_KEY,
  };
  for (const [k, v] of Object.entries(swap)) {
    if (v === undefined) {
      console.error(`error: --new needs SUPABASE_x402_${k.replace(/^SUPABASE_/, "")} in .env`);
      process.exit(2);
    }
    env[k] = v;
  }
}

// `--project-ref` with no value takes SUPABASE_PROJECT_REF. No default: a wrong project is
// worse than no project, so an unset variable stops here rather than reaching the CLI.
const refAt = cmd.indexOf("--project-ref");
if (refAt > 0 && (refAt === cmd.length - 1 || cmd[refAt + 1] === "" || cmd[refAt + 1].startsWith("-"))) {
  const ref = (env.SUPABASE_PROJECT_REF ?? "").trim();
  if (!ref) {
    console.error(
      "error: --project-ref was given without a value and SUPABASE_PROJECT_REF is not set.\n" +
        "  Set it in the shell or in .env (it is the <project-ref> in https://<project-ref>.supabase.co), or pass the ref explicitly.",
    );
    process.exit(2);
  }
  if (cmd[refAt + 1] === "") cmd[refAt + 1] = ref;
  else cmd.splice(refAt + 1, 0, ref);
}

const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit", env, cwd: process.cwd() });
child.on("error", (err) => {
  console.error(`error: ${err.message}`);
  process.exit(127);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
