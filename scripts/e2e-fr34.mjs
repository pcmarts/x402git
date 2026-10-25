#!/usr/bin/env node
/**
 * scripts/e2e-fr34.mjs — PRD FR-34, for real, on Base Sepolia.
 *
 *   node scripts/e2e-fr34.mjs --rail b --base http://localhost:3000
 *   node scripts/e2e-fr34.mjs --rail a --base http://localhost:3000 --rail-a-installation <id> --rail-a-repo-id <id>
 *
 * The hosted service at https://x402git.com is the maintainers' target only.
 *
 * FR-34 is the definition of done for the headless rail:
 *
 *   register (API) → provision/attach a repo → push a tag → PATCH the price → publish
 *   → buy from wallet B → push a second tag → wallet B sees an update 402 at the
 *   *stamped* price → wallet B re-fetches v1 → sweep pays wallet A.
 *
 * This script drives both rails against a running deployment with two real wallets and
 * the public x402 facilitator. Nothing is mocked: the 402s are real 402s, the two
 * settlements are real Base Sepolia transactions, and the artifact that is downloaded
 * is hashed and compared against the `artifact_sha256` the scanner saw (§6, FR-51).
 *
 * Wallets
 *   A — the creator. A throwaway key generated per run, in memory only. The server
 *       never sees it (NG10); it only ever sees an EIP-191 signature over a challenge.
 *   B — the buyer. `TEST_BUYER_PRIVATE_KEY` from `.env`, funded with Base Sepolia USDC.
 *
 * Neither key is ever printed. Addresses and transaction hashes are.
 *
 * Locally, GitHub webhooks are delivered to the production host, so "a tag push
 * produces a release" is exercised through the PRD's documented recovery path,
 * `POST /api/listings/:id/sync { ref }` (FR-8.2). Against a real deployment the webhook
 * usually wins the race, so `version_exists` on sync is treated as success.
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// --- .env, the same minimal loader scripts/github-app-check.mjs uses -----------

const env = (() => {
  try {
    return Object.fromEntries(
      fs
        .readFileSync(path.join(ROOT, ".env"), "utf8")
        .split("\n")
        .filter((l) => /^[A-Z0-9_]+=/.test(l))
        .map((l) => {
          const i = l.indexOf("=");
          let v = l.slice(i + 1).trim();
          if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\n/g, "\n");
          return [l.slice(0, i), v];
        }),
    );
  } catch {
    return {};
  }
})();
const conf = (key, fallback) => process.env[key] ?? env[key] ?? fallback;

// --- arguments ----------------------------------------------------------------

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

const RAIL = (arg("rail", "both") || "both").toLowerCase();
if (!["a", "b", "both"].includes(RAIL)) die("--rail must be a, b or both");

const BASE = (arg("base", conf("BASE_URL", "http://localhost:3000")) || "").replace(/\/+$/, "");
const WORKDIR = arg("workdir", conf("E2E_WORKDIR", path.join(os.tmpdir(), "x402-e2e")));
const JSON_OUT = arg("json", null);

// Rail A: a private repo that already exists, with your App installed on it. No defaults.
const RAIL_A_INSTALLATION = arg("rail-a-installation", conf("E2E_RAIL_A_INSTALLATION_ID"));
const RAIL_A_REPO_ID = arg("rail-a-repo-id", conf("E2E_RAIL_A_REPO_ID"));
if (RAIL !== "b" && (!RAIL_A_INSTALLATION || !RAIL_A_REPO_ID)) {
  die(
    "Rail A needs your own App installation id and repo id: set E2E_RAIL_A_INSTALLATION_ID and " +
      "E2E_RAIL_A_REPO_ID (or pass --rail-a-installation and --rail-a-repo-id), or run --rail b",
  );
}
const RAIL_A_CLONE = arg("rail-a-clone", conf("E2E_RAIL_A_CLONE", path.join(WORKDIR, "rail-a")));

/**
 * The two tags a run cuts. Rail A's fixture repo is shared across runs and a tag can only
 * be pushed once, so a production pass that wants to exercise the *webhook* rather than
 * `sync` needs a pair nobody has used: `--first-tag v1.2.0 --second-tag v1.3.0`.
 */
const TAG1 = arg("first-tag", "v1.0.0");
const TAG2 = arg("second-tag", "v1.1.0");
const VER1 = TAG1.replace(/^v/, "");
const VER2 = TAG2.replace(/^v/, "");

const PRICE_MICRO = arg("price", "100000"); //  $0.10
const UPDATE_PRICE_MICRO = arg("update-price", "50000"); // $0.05

const BUYER_KEY = conf("TEST_BUYER_PRIVATE_KEY");
if (!BUYER_KEY) die("TEST_BUYER_PRIVATE_KEY is missing from .env — this script needs a funded Base Sepolia wallet");

const FACILITATOR = conf("X402_FACILITATOR_URL", "(unset)");
const NETWORK = conf("X402_NETWORK", "eip155:84532");

/** How long to let a real push webhook land before falling back to `sync` (FR-8.2). */
const WEBHOOK_WAIT_SEC = Number(arg("webhook-wait", "75"));

/** How many times a payment is signed before a retryable settlement failure is fatal. */
const SETTLE_ATTEMPTS = Number(arg("settle-attempts", "3"));

/** How long a run will idle waiting out §9's registration limit before giving up. */
const REGISTRATION_WAIT_CAP_SEC = Number(arg("registration-wait", "3900"));

fs.mkdirSync(WORKDIR, { recursive: true });

// --- output -------------------------------------------------------------------

const bold = (s) => (process.stdout.isTTY ? `\u001b[1m${s}\u001b[0m` : s);
const dim = (s) => (process.stdout.isTTY ? `\u001b[2m${s}\u001b[0m` : s);

class StepFailed extends Error {}

/** Everything the report needs, accumulated as the run goes. */
const run = {
  started_at: new Date().toISOString(),
  base: BASE,
  network: NETWORK,
  facilitator: FACILITATOR,
  rails: {},
};

let ctx = null; // the rail currently running

function beginRail(rail) {
  ctx = { rail, steps: [], facts: {}, current: null };
  run.rails[rail] = ctx;
  console.log(`\n${bold(`════ Rail ${rail.toUpperCase()} ════`)}`);
}

function step(n, title) {
  ctx.current = { n, title, status: "pass", notes: [] };
  ctx.steps.push(ctx.current);
  console.log(`\n${bold(`${n}. ${title}`)}`);
}

const say = (label, value) => console.log(`   ${dim(String(label).padEnd(24))} ${value}`);

function ok(message) {
  ctx.current.notes.push(message);
  console.log(`   ✓ ${message}`);
}

function bad(message) {
  ctx.current.status = "fail";
  ctx.current.notes.push(message);
  console.log(`   ✗ ${message}`);
  throw new StepFailed(message);
}

function check(condition, message) {
  if (!condition) bad(message);
  ok(message);
}

/** An observation worth recording that is neither a pass nor a failure. */
function note(message) {
  ctx.current.notes.push(`note: ${message}`);
  console.log(`   ${dim(`· ${message}`)}`);
}

function skipped(message) {
  ctx.current.status = "skip";
  ctx.current.notes.push(message);
  console.log(`   ⊘ ${message}`);
}

function fact(key, value) {
  ctx.facts[key] = value;
}

function die(message) {
  console.error(`\nFATAL: ${message}`);
  process.exit(2);
}

const usd = (micro) => `$${(Number(micro) / 1e6).toFixed(2)}`;
const explorer = (tx) => `https://sepolia.basescan.org/tx/${tx}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- http ---------------------------------------------------------------------

/** `TypeError: fetch failed` hides the real reason in `cause`. Unwrap the whole chain. */
function causeChain(e) {
  const parts = [];
  for (let c = e; c; c = c.cause) {
    parts.push(`${c.name ?? "?"}: ${c.message ?? c}${c.code ? ` (${c.code})` : ""}`);
    if (parts.length > 4) break;
  }
  return parts.join(" ← ");
}

/**
 * `fetch`, retried on a *connection-level* failure only.
 *
 * A run interleaves multi-second `git push` calls with HTTP, and a pooled keep-alive
 * socket that the dev server has since closed surfaces as a bare `TypeError: fetch
 * failed` with no request ever reaching the server. Retrying is safe even for the paid
 * requests: §13 makes `/api/r` idempotent on the EIP-3009 nonce, so a resent
 * authorization is answered from our own ledger rather than settled twice.
 */
async function fetchRetry(url, init = {}, attempts = 4) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      last = e;
      console.log(`   ${dim(`… ${init.method ?? "GET"} ${String(url).replace(BASE, "")} attempt ${i}/${attempts}: ${causeChain(e)}`)}`);
      if (i < attempts) await sleep(500 * i);
    }
  }
  throw last;
}

async function body(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text.slice(0, 500) };
  }
}

async function api(method, url, { json, headers = {}, apiKey } = {}) {
  const res = await fetchRetry(url.startsWith("http") ? url : `${BASE}${url}`, {
    method,
    headers: {
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  return { res, data: await body(res) };
}

// --- git ----------------------------------------------------------------------

function git(cwd, args, extraEnv = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extraEnv },
  }).trim();
}

/** Does the remote already carry this tag? Cheap, and it makes the run re-runnable. */
function remoteHasTag(cwd, tag, extraEnv = {}) {
  return git(cwd, ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], extraEnv).length > 0;
}

// --- wallets ------------------------------------------------------------------

const buyer = privateKeyToAccount(BUYER_KEY);

/** `<address>.<nonce>.<eip191_sig>` over a fresh single-use challenge (FR-20). */
async function walletSignature(account) {
  const { res, data } = await api("GET", `/api/auth/challenge?address=${account.address}&purpose=wallet_ownership`);
  if (!res.ok) throw new Error(`GET /api/auth/challenge → ${res.status} ${JSON.stringify(data)}`);
  const signature = await account.signMessage({ message: data.message });
  return `${account.address}.${data.nonce}.${signature}`;
}

/** The x402 client an agent would build: `exact` on any EVM network, the server's price. */
function x402For(account) {
  return new x402HTTPClient(
    x402Client.fromConfig({
      schemes: [{ network: "eip155:*", client: new ExactEvmScheme(account) }],
      spendControls: false,
    }),
  );
}

const buyerHttp = x402For(buyer);

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

console.log(bold(`FR-34 end-to-end — ${BASE}`));
say("network", NETWORK);
say("facilitator", FACILITATOR);
say("buyer (wallet B)", buyer.address);
say("workdir", WORKDIR);

const stamp = new Date();
const hhmm = `${String(stamp.getHours()).padStart(2, "0")}${String(stamp.getMinutes()).padStart(2, "0")}`;
const rand = () => crypto.randomBytes(3).toString("hex");

const rails = RAIL === "both" ? ["a", "b"] : [RAIL];
for (const rail of rails) {
  beginRail(rail);
  try {
    await runRail(rail);
    console.log(`\n${bold(`Rail ${rail.toUpperCase()}: complete.`)}`);
  } catch (e) {
    if (e instanceof StepFailed) {
      console.log(`\n${bold(`Rail ${rail.toUpperCase()}: stopped at step ${ctx.current.n}.`)}`);
    } else {
      ctx.current = ctx.current ?? { n: 0, title: "setup", status: "fail", notes: [] };
      ctx.current.status = "fail";
      ctx.current.notes.push(causeChain(e));
      ctx.steps.includes(ctx.current) || ctx.steps.push(ctx.current);
      console.log(`\n   ✗ ${causeChain(e)}`);
      if (e?.stack) console.log(dim(e.stack));
      console.log(`\n${bold(`Rail ${rail.toUpperCase()}: stopped with an error.`)}`);
    }
  }
}

run.finished_at = new Date().toISOString();

// --- summary -------------------------------------------------------------------

console.log(`\n${bold("Summary")}`);
let failures = 0;
for (const [rail, r] of Object.entries(run.rails)) {
  const pass = r.steps.filter((s) => s.status === "pass").length;
  const fail = r.steps.filter((s) => s.status === "fail").length;
  const skip = r.steps.filter((s) => s.status === "skip").length;
  failures += fail;
  console.log(`   Rail ${rail.toUpperCase()}: ${pass} passed, ${fail} failed, ${skip} skipped  (${r.steps.length} steps run)`);
  for (const s of r.steps) console.log(`      ${s.status === "pass" ? "✓" : s.status === "skip" ? "⊘" : "✗"} ${s.n}. ${s.title}`);
  if (r.facts.tx_new) console.log(`      new     ${r.facts.tx_new}  ${explorer(r.facts.tx_new)}`);
  if (r.facts.tx_update) console.log(`      update  ${r.facts.tx_update}  ${explorer(r.facts.tx_update)}`);
}

if (JSON_OUT) {
  for (const r of Object.values(run.rails)) delete r.current;
  fs.writeFileSync(JSON_OUT, JSON.stringify(run, null, 2));
  console.log(`\n   wrote ${JSON_OUT}`);
}

process.exit(failures > 0 ? 1 : 0);

// ---------------------------------------------------------------------------

async function runRail(rail) {
  const handle = `e2e${rail}${rand()}`;
  const slug = `e2e-${rail}-${hhmm}-${rand().slice(0, 4)}`;
  fact("handle", handle);
  fact("slug", slug);

  // --- 1. terms ---------------------------------------------------------------

  step(1, "GET /api/terms — the version a registration must accept (FR-6)");
  const terms = await api("GET", "/api/terms");
  check(terms.res.ok, `200 from /api/terms (${terms.res.status})`);
  say("version", terms.data.version);
  say("sha256", terms.data.sha256);
  fact("terms_version", terms.data.version);

  // --- 2. register ------------------------------------------------------------

  step(2, "GET /api/auth/challenge + POST /api/creators — headless registration (FR-2)");
  const creatorAccount = privateKeyToAccount(generatePrivateKey());
  say("creator (wallet A)", creatorAccount.address);
  fact("creator_address", creatorAccount.address);

  const challenge = await api("GET", `/api/auth/challenge?address=${creatorAccount.address}&purpose=address_proof`);
  check(challenge.res.ok, `200 from /api/auth/challenge (${challenge.res.status})`);
  const proof = {
    nonce: challenge.data.nonce,
    // NG10: the server never sees this key. It sees an EIP-191 signature and nothing else.
    signature: await creatorAccount.signMessage({ message: challenge.data.message }),
  };

  const idempotencyKey = crypto.randomUUID();
  const register = () =>
    api("POST", "/api/creators", {
      headers: { "idempotency-key": idempotencyKey },
      json: {
        handle,
        payout_address: creatorAccount.address,
        address_proof: proof,
        accepted_terms_version: terms.data.version,
        ...(conf("RAIL_B_INVITE_CODES") ? { invite_code: conf("RAIL_B_INVITE_CODES").split(",")[0].trim() } : {}),
        abuse_contact_url: "https://example.com/abuse",
      },
    });

  let registration = await register();

  // §9 allows 5 registrations per hour per IP, and a both-rails run spends two of them
  // (BLOCKERS.md B3). Rather than fail a long overnight run on arithmetic, wait out the
  // window the server itself names — once, and only up to REGISTRATION_WAIT_CAP_SEC.
  if (registration.res.status === 429) {
    const wait = Math.min(Number(registration.data.retry_after_seconds ?? 0) + 15, REGISTRATION_WAIT_CAP_SEC);
    note(`registration is rate limited; waiting ${wait}s for the window (${registration.data.message ?? ""})`);
    await sleep(wait * 1000);
    // The same Idempotency-Key: if the first attempt did land, this replays its 201.
    registration = await register();
  }

  check(registration.res.status === 201, `201 from /api/creators (${registration.res.status}) ${registration.res.status === 201 ? "" : JSON.stringify(registration.data)}`);
  const apiKey = registration.data.api_key;
  check(typeof apiKey === "string" && apiKey.length > 0, "the API key is returned exactly once");
  say("handle", registration.data.handle);
  say("creator_id", registration.data.creator_id);
  say("platform_fee_bps", registration.data.platform_fee_bps);
  say("holdback_days", registration.data.holdback_days);
  fact("creator_id", registration.data.creator_id);
  fact("platform_fee_bps", registration.data.platform_fee_bps);
  fact("holdback_days", registration.data.holdback_days);

  // --- 3. create the listing ---------------------------------------------------

  step(3, `POST /api/listings — ${rail === "a" ? "Rail A: the creator's own repo (FR-8)" : "Rail B: a provisioned hosted repo (FR-7, G6)"}`);

  let keyPath = null;
  let sshEnv = {};
  let listingBody;

  if (rail === "a") {
    listingBody = {
      slug,
      source: "github",
      installation_id: RAIL_A_INSTALLATION,
      github_repo_id: RAIL_A_REPO_ID,
      price_micro: PRICE_MICRO,
      update_price_micro: UPDATE_PRICE_MICRO,
    };
  } else {
    // §14.6: one public key, one repo. A fresh pair per listing, per run.
    keyPath = path.join(WORKDIR, `railb_${slug}_key`);
    fs.rmSync(keyPath, { force: true });
    fs.rmSync(`${keyPath}.pub`, { force: true });
    execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", `x402git-e2e-${slug}`, "-f", keyPath], { stdio: "ignore" });
    fs.chmodSync(keyPath, 0o600);
    const publicKey = fs.readFileSync(`${keyPath}.pub`, "utf8").trim();
    sshEnv = { GIT_SSH_COMMAND: `ssh -i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new` };
    say("deploy key", `${publicKey.split(/\s+/)[0]} … ${publicKey.split(/\s+/)[2] ?? ""}`);
    listingBody = {
      slug,
      source: "hosted",
      ssh_public_key: publicKey,
      price_micro: PRICE_MICRO,
      update_price_micro: UPDATE_PRICE_MICRO,
    };
  }

  const created = await api("POST", "/api/listings", { apiKey, json: listingBody });
  check(created.res.status === 201, `201 from /api/listings (${created.res.status}) ${created.res.status === 201 ? "" : JSON.stringify(created.data)}`);
  const listingId = created.data.listing_id;
  const owner = created.data.owner;
  say("listing_id", listingId);
  say("owner/slug", `${owner}/${created.data.slug}`);
  say("status", created.data.status);
  say("price", `${usd(created.data.pricing.price_micro)} · updates ${usd(created.data.pricing.update_price_micro)}`);
  fact("listing_id", listingId);
  fact("owner", owner);
  fact("source", created.data.source);

  if (rail === "b") {
    check(Boolean(created.data.remote), "the response carries a git remote to push to (G6)");
    say("remote", created.data.remote);
    say("default_branch", created.data.default_branch);
    say("host key fingerprints", String((created.data.ssh_host_key_fingerprints ?? []).length));
    fact("remote", created.data.remote);
  }

  // --- 4. push the code and the first tag --------------------------------------

  const repoDir = rail === "a" ? RAIL_A_CLONE : path.join(WORKDIR, `rail-b-${slug}`);
  let pushed1 = false;
  let pushed2 = false;

  if (rail === "b") {
    step(4, `git push — code and ${TAG1} over the deploy key`);
    fs.rmSync(repoDir, { recursive: true, force: true });
    // The repo is `auto_init`, so it already has a `main` with a README. Clone it and
    // build on top rather than force-pushing over a history we did not write.
    git(WORKDIR, ["clone", created.data.remote, repoDir], sshEnv);
    writeRailBProject(repoDir, `${owner}/${slug}`);
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["-c", "user.email=e2e@x402git.com", "-c", "user.name=x402git e2e", "commit", "-m", `${TAG1}: a small MIT-licensed skill`]);
    git(repoDir, ["tag", "-a", TAG1, "-m", TAG1]);
    git(repoDir, ["push", "origin", "HEAD:main"], sshEnv);
    git(repoDir, ["push", "origin", TAG1], sshEnv);
    pushed1 = true;
    ok(`pushed main and the tag ${TAG1} with no GitHub account and no browser`);
    say("head", git(repoDir, ["rev-parse", "HEAD"]).slice(0, 12));
  } else {
    step(4, `Rail A: the repo and its ${TAG1} tag`);
    check(fs.existsSync(path.join(repoDir, ".git")), `a clone of the Rail A repo is at ${repoDir}`);
    if (!remoteHasTag(repoDir, TAG1)) {
      // A production pass uses fresh tags so the push fires a real webhook (FR-8).
      git(repoDir, ["fetch", "origin"]);
      git(repoDir, ["checkout", "main"]);
      git(repoDir, ["reset", "--hard", "origin/main"]);
      fs.appendFileSync(path.join(repoDir, "README.md"), `\n## ${VER1}\n\nCut for an FR-34 run.\n`);
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["-c", "user.email=e2e@x402git.com", "-c", "user.name=x402git e2e", "commit", "-m", `${TAG1}: a new fixture release`]);
      git(repoDir, ["tag", "-a", TAG1, "-m", TAG1]);
      git(repoDir, ["push", "origin", "HEAD:main"]);
      git(repoDir, ["push", "origin", TAG1]);
      pushed1 = true;
      ok(`pushed ${TAG1} — this fires the real push webhook (FR-8)`);
    } else {
      ok(`origin carries refs/tags/${TAG1}`);
    }
  }

  // --- 5. cut the release ------------------------------------------------------

  step(5, `Cut ${VER1} — the push webhook (FR-8), or sync as the fallback (FR-8.2)`);
  if (BASE.includes("localhost") || BASE.includes("127.0.0.1")) {
    say("note", "webhooks are delivered to the production host, so sync is the local equivalent");
  }
  const release1 = await releaseFor(apiKey, listingId, TAG1, VER1, { pushed: pushed1 });
  say("version", release1.version);
  say("scan", release1.scan);
  say("commit", (release1.commit_sha ?? "").slice(0, 12));
  if (release1.scan === "fail") {
    say("scan_report", JSON.stringify(release1.scan_report ?? release1));
    bad("the security scan failed — nothing may be sold (FR-35)");
  }

  const listing1 = await pollLatestRelease(apiKey, listingId, VER1);
  check(listing1.latest_release?.version === VER1, `GET /api/listings/:id reports latest_release ${VER1} with scan pass`);
  say("artifact_sha256", listing1.latest_release.artifact_sha256);
  say("manifest_url", listing1.latest_release.manifest_url);
  say("licence", `${listing1.licence.spdx ?? "(none)"} · ${listing1.licence.verdict}`);
  fact("version_1", VER1);
  fact("artifact_sha256_v1", listing1.latest_release.artifact_sha256);
  fact("manifest_url", listing1.latest_release.manifest_url);
  fact("licence", listing1.licence);

  // FR-11 Rail B: a LICENSE GitHub cannot identify is `manual`, which blocks publish.
  // The documented fix is to have one committed for us (D4).
  if (rail === "b" && listing1.licence.verdict !== "pass") {
    const fixed = await api("POST", `/api/listings/${listingId}/licence`, { apiKey, json: { spdx: "MIT" } });
    check(fixed.res.ok, `POST /api/listings/:id/licence committed MIT (${fixed.res.status})`);
    fact("licence", fixed.data.licence);
  }

  // A draft's manifest is a 404, not a 403: a listing nobody has published should not be
  // discoverable by guessing its URL. The computed facts are read after publish, below.
  const draftLabel = await api("GET", `/api/label/${owner}/${slug}`);
  check(draftLabel.res.status === 404, `GET /api/label/${owner}/${slug} is 404 while the listing is a draft (${draftLabel.res.status})`);

  // --- 6. price and copy -------------------------------------------------------

  step(6, "PATCH /api/listings/:id — price, update price, description, trigger hint");
  const patched = await api("PATCH", `/api/listings/${listingId}`, {
    apiKey,
    json: {
      price_micro: PRICE_MICRO,
      update_price_micro: UPDATE_PRICE_MICRO,
      description: `An end-to-end test listing for FR-34 on Rail ${rail.toUpperCase()}. Sold for ${usd(PRICE_MICRO)} on Base Sepolia.`,
      trigger_hint: "Fetch this when you need the FR-34 fixture.",
    },
  });
  check(patched.res.ok, `200 from PATCH (${patched.res.status}) ${patched.res.ok ? "" : JSON.stringify(patched.data)}`);
  check(patched.data.pricing.price_micro === String(PRICE_MICRO), `price_micro is exactly ${PRICE_MICRO} — no rounding (FR-12)`);
  check(patched.data.pricing.update_price_micro === String(UPDATE_PRICE_MICRO), `update_price_micro is exactly ${UPDATE_PRICE_MICRO}`);
  say("price", `${usd(PRICE_MICRO)} · updates ${usd(UPDATE_PRICE_MICRO)}`);
  fact("price_micro", String(PRICE_MICRO));
  fact("update_price_micro", String(UPDATE_PRICE_MICRO));

  // --- 7. publish --------------------------------------------------------------

  step(7, "POST /api/listings/:id/publish — draft → live (FR-42)");
  const published = await api("POST", `/api/listings/${listingId}/publish`, { apiKey });
  check(published.res.ok, `200 from publish (${published.res.status}) ${published.res.ok ? "" : JSON.stringify(published.data)}`);
  check(published.data.status === "live", "status is live");
  say("url", published.data.endpoints.url);
  fact("url", published.data.endpoints.url);
  fact("resource_endpoint", published.data.endpoints.resource_endpoint);

  // The manifest is free and unauthenticated: it is what a buying agent reads first (FR-49).
  const label = await api("GET", `/api/label/${owner}/${slug}`);
  check(label.res.ok, `200 from GET /api/label/${owner}/${slug} now it is live (FR-49)`);
  const computed = label.data.computed ?? {};
  say("artifact_class", computed.artifact_class);
  say("files / bytes", `${computed.file_count} files · ${computed.total_bytes} bytes`);
  say("languages", JSON.stringify(computed.languages ?? computed.language_mix ?? {}));
  say("licence (computed)", JSON.stringify(computed.licence ?? label.data.licence ?? {}));
  say("scan (computed)", JSON.stringify(computed.scan ?? label.data.scan ?? {}));
  check(computed.artifact_sha256 === undefined || computed.artifact_sha256 === listing1.latest_release.artifact_sha256, "the manifest describes the same artifact the listing does");
  fact("manifest_computed", {
    artifact_class: computed.artifact_class,
    file_count: computed.file_count,
    total_bytes: computed.total_bytes,
    licence: computed.licence ?? label.data.licence,
    scan: computed.scan ?? label.data.scan,
  });

  // --- 8. the buyer: 402 → pay → 200 → the bytes -------------------------------

  step(8, "Buyer: GET /api/v, GET /api/r → 402, sign, re-request → 200 (FR-21, FR-22)");

  const anon = await api("GET", `/api/v/${owner}/${slug}`);
  check(anon.res.ok, `200 from the anonymous /api/v (${anon.res.status})`);
  check(anon.data.latest === VER1, `the anonymous version endpoint names ${VER1}`);
  check(anon.data.owned === undefined, "an unsigned /api/v answers no entitlement state (FR-40)");
  say("price", `${usd(anon.data.price_micro)} · updates ${usd(anon.data.update_price_micro)}`);

  const grant1 = await buyRelease(`${BASE}/api/r/${owner}/${slug}`, { expectKind: "new", expectPrice: String(PRICE_MICRO) });
  fact("tx_new", grant1.tx);
  fact("version_bought", grant1.data.version);
  say("tx", `${grant1.tx}  ${explorer(grant1.tx)}`);
  say("version", grant1.data.version);

  const bytes = await download(grant1.data.download_url);
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  say("downloaded", `${bytes.length} bytes · sha256 ${digest}`);
  check(digest === grant1.data.artifact_sha256, "the download hashes to artifact_sha256 — the bytes that were scanned are the bytes sold (§6, FR-51)");
  check(digest === listing1.latest_release.artifact_sha256, "…and to the hash the creator's own listing view reported");
  fact("artifact_bytes", bytes.length);

  const ent1 = await api("GET", "/api/entitlements", { headers: { "x-wallet-signature": await walletSignature(buyer) } });
  check(ent1.res.ok, `200 from GET /api/entitlements (${ent1.res.status})`);
  const mine = (ent1.data.entitlements ?? []).filter((e) => e.owner === owner && e.slug === slug);
  const bought = mine.find((e) => e.version === VER1);
  check(Boolean(bought), "the purchase is visible to the buyer's own wallet (FR-32)");
  check(bought.tx_hash === grant1.tx, "the entitlement carries the same transaction hash the PAYMENT-RESPONSE header did");
  check(bought.gross_micro === String(PRICE_MICRO), `gross_micro is ${PRICE_MICRO}`);
  check(bought.update_price_at_purchase === String(UPDATE_PRICE_MICRO), `update_price_at_purchase is stamped at ${UPDATE_PRICE_MICRO} (FR-16)`);
  say("kind / all_versions", `${bought.kind} · ${bought.all_versions}`);

  // --- 9. the second tag --------------------------------------------------------

  step(9, `Push ${TAG2} and sync it — a newer release exists`);
  if (rail === "b") {
    fs.appendFileSync(path.join(repoDir, "README.md"), "\n## 1.1.0\n\nA second release, so a holder sees an update 402.\n");
    fs.writeFileSync(path.join(repoDir, "scripts", "extra.mjs"), "export const version = \"1.1.0\";\n");
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["-c", "user.email=e2e@x402git.com", "-c", "user.name=x402git e2e", "commit", "-m", `${TAG2}: one more file`]);
    git(repoDir, ["tag", "-a", TAG2, "-m", TAG2]);
    git(repoDir, ["push", "origin", "HEAD:main"], sshEnv);
    git(repoDir, ["push", "origin", TAG2], sshEnv);
    pushed2 = true;
    ok(`pushed ${TAG2} over the deploy key`);
  } else if (remoteHasTag(repoDir, TAG2)) {
    // The Rail A fixture repo is shared between runs. The tag is created once.
    git(repoDir, ["fetch", "--tags", "origin"]);
    ok(`origin already carries refs/tags/${TAG2} (created by an earlier run)`);
  } else {
    git(repoDir, ["fetch", "origin"]);
    fs.appendFileSync(path.join(repoDir, "README.md"), "\n## 1.1.0\n\nA second release, so a holder sees an update 402.\n");
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["-c", "user.email=e2e@x402git.com", "-c", "user.name=x402git e2e", "commit", "-m", `${TAG2}: one more paragraph`]);
    git(repoDir, ["tag", "-a", TAG2, "-m", TAG2]);
    git(repoDir, ["push", "origin", "HEAD:main"]);
    git(repoDir, ["push", "origin", TAG2]);
    pushed2 = true;
    ok(`pushed ${TAG2}`);
  }

  const release2 = await releaseFor(apiKey, listingId, TAG2, VER2, { pushed: pushed2 });
  say("version", release2.version);
  say("scan", release2.scan);
  if (release2.scan === "fail") bad(`the ${TAG2} scan failed`);
  const listing2 = await pollLatestRelease(apiKey, listingId, VER2);
  check(listing2.latest_release?.version === VER2, `latest_release is now ${VER2}`);
  fact("version_2", VER2);
  fact("artifact_sha256_v2", listing2.latest_release.artifact_sha256);

  // --- 10. the update 402 -------------------------------------------------------

  step(10, "The holder sees an update 402 at the stamped price (FR-16, FR-17, FR-18)");
  const signedV = await api("GET", `/api/v/${owner}/${slug}`, { headers: { "x-wallet-signature": await walletSignature(buyer) } });
  check(signedV.res.ok, `200 from the signed /api/v (${signedV.res.status})`);
  say("owned / entitled", `${signedV.data.owned} · ${signedV.data.entitled}`);
  say("price_kind / price", `${signedV.data.price_kind} · ${usd(signedV.data.price_micro)}`);
  check(signedV.data.entitled === false, `entitled is false — ${VER2} is not owned`);
  check(signedV.data.owned === VER1, `owned is still ${VER1}`);
  check(signedV.data.price_kind === "update", 'price_kind is "update"');
  check(signedV.data.price_micro === String(UPDATE_PRICE_MICRO), `price_micro is the stamped ${UPDATE_PRICE_MICRO} (${usd(UPDATE_PRICE_MICRO)})`);
  // FR-18 (DECISIONS 2026-08-29): the free-update window opens on an *update* charge, so
  // the initial purchase minutes ago does not make this release free. If it did, this
  // step would read `entitled: true` and FR-34 could never be observed.
  note("FR-18's free window opens on an update charge, not the initial purchase — so this is a 402, not a free grant");

  const grant2 = await buyRelease(`${BASE}/api/r/${owner}/${slug}`, {
    expectKind: "update",
    expectPrice: String(UPDATE_PRICE_MICRO),
    signed: true,
    assert402: (b) => {
      check(b.extra?.kind === "update", 'the 402 extra.kind is "update"');
      check(b.extra?.from === VER1 && b.extra?.to === VER2, `extra.from → extra.to is ${VER1} → ${VER2}`);
      const versions = (b.extra?.releases ?? []).map((r) => r.version);
      check(versions.includes(VER2), `extra.releases lists ${VER2} (${versions.join(", ") || "none"}) — FR-17`);
    },
  });
  fact("tx_update", grant2.tx);
  check(grant2.data.version === VER2, `the grant is for ${VER2}`);
  say("tx", `${grant2.tx}  ${explorer(grant2.tx)}`);

  const bytes2 = await download(grant2.data.download_url);
  const digest2 = crypto.createHash("sha256").update(bytes2).digest("hex");
  check(digest2 === grant2.data.artifact_sha256, `the ${VER2} download hashes to its artifact_sha256`);
  check(digest2 === listing2.latest_release.artifact_sha256, `…and to the hash the creator's listing view reports for ${VER2}`);
  say(`${VER2} sha256`, digest2);

  // --- 11. the re-fetch ---------------------------------------------------------

  step(11, `GET /api/r/:owner/:slug/v/${VER1} — an owned version stays fetchable (FR-19)`);
  const refetch = await api("GET", `/api/r/${owner}/${slug}/v/${VER1}`, {
    headers: { "x-wallet-signature": await walletSignature(buyer) },
  });
  check(refetch.res.ok, `200 from the version endpoint (${refetch.res.status})`);
  check(refetch.data.artifact_sha256 === listing1.latest_release.artifact_sha256, "the re-fetch serves the identical artifact hash, free");
  check(refetch.data.download_url !== grant1.data.download_url, "the signed URL is fresh, not the one issued at purchase");
  say("expires_at", refetch.data.expires_at);

  // --- 12. earnings --------------------------------------------------------------

  step(12, "GET /api/earnings — the creator's ledger, 10% fee, no buyer data (FR-29, FR-40)");
  const earnings = await api("GET", "/api/earnings", { apiKey });
  check(earnings.res.ok, `200 from /api/earnings (${earnings.res.status})`);
  const gross = BigInt(earnings.data.gross_micro);
  const fee = BigInt(earnings.data.fee_micro);
  const net = BigInt(earnings.data.net_micro);
  say("gross / fee / net", `${usd(gross)} / ${usd(fee)} / ${usd(net)}`);
  say("withdrawable / held", `${usd(earnings.data.withdrawable_micro)} / ${usd(earnings.data.held_micro)}`);
  say("payout_address", earnings.data.payout_address);
  const expectedGross = BigInt(PRICE_MICRO) + BigInt(UPDATE_PRICE_MICRO);
  check(gross === expectedGross, `gross is ${PRICE_MICRO} + ${UPDATE_PRICE_MICRO} = ${expectedGross} micro-USDC`);
  check(fee === (gross * 1000n) / 10_000n, `fee is exactly 10% of gross (${earnings.data.platform_fee_bps} bps)`);
  check(net === gross - fee, "net is gross − fee");
  const kinds = earnings.data.sales.map((s) => s.kind).sort();
  check(kinds.join(",") === "new,update", `the sale rows are exactly [new, update] (got [${kinds.join(", ")}])`);
  const leaked = earnings.data.sales.flatMap((s) => Object.keys(s)).filter((k) => /tx|hash|buyer|address|payer/i.test(k));
  check(leaked.length === 0, `no sale row carries a buyer address or a transaction hash (FR-40)${leaked.length ? `: ${leaked}` : ""}`);
  check(earnings.data.payout_address.toLowerCase() === creatorAccount.address.toLowerCase(), "earnings name the bound payout address (FR-26)");
  fact("earnings", {
    gross_micro: earnings.data.gross_micro,
    fee_micro: earnings.data.fee_micro,
    net_micro: earnings.data.net_micro,
    withdrawable_micro: earnings.data.withdrawable_micro,
    held_micro: earnings.data.held_micro,
    holdback_days: earnings.data.holdback_days,
    next_release_at: earnings.data.next_release_at,
    payout_address: earnings.data.payout_address,
  });

  // --- 13. the sweep --------------------------------------------------------------

  step(13, "POST /api/payouts/sweep — no `to` parameter exists (FR-26)");
  const sweep = await api("POST", "/api/payouts/sweep", { apiKey, json: {} });
  check(sweep.res.ok, `200 from the sweep (${sweep.res.status})`);
  say("to_address", sweep.data.to_address);
  say("amount / gas", `${usd(sweep.data.amount_micro)} / ${usd(sweep.data.gas_micro)}`);
  say("status", String(sweep.data.status));
  say("skipped", String(sweep.data.skipped ?? "(not skipped)"));
  check(sweep.data.to_address.toLowerCase() === creatorAccount.address.toLowerCase(), "the destination is the bound payout address, not anything in the request");
  fact("sweep", sweep.data);
  if (sweep.data.skipped) {
    skipped(
      `sweep did not broadcast: ${sweep.data.skipped}` +
        (sweep.data.skipped === "nothing_to_sweep"
          ? ` — every sale is inside the ${earnings.data.holdback_days}-day holdback (FR-27); next release ${earnings.data.next_release_at}`
          : sweep.data.skipped === "no_sweep_signer"
            ? " — this deployment has no SWEEP_WALLET_PRIVATE_KEY"
            : ""),
    );
  } else {
    check(Boolean(sweep.data.tx_hash), "the sweep broadcast a transaction");
    say("tx", `${sweep.data.tx_hash}  ${explorer(sweep.data.tx_hash)}`);
  }

  // --- 14. the server-rendered manifest ---------------------------------------------

  step(14, "GET /:owner/:slug — the manifest is in the server HTML (§14.1)");
  const pageUrl = `${BASE}/${owner}/${slug}`;
  const html = await (await fetchRetry(pageUrl)).text();
  check(html.includes(`${owner}/${slug}`), "the server HTML names owner/slug");
  check(html.includes(VER2), `the server HTML names the current version (${VER2})`);
  check(html.includes(usd(PRICE_MICRO)), `the server HTML names the price (${usd(PRICE_MICRO)})`);
  try {
    const out = execFileSync("sh", [path.join(ROOT, "scripts", "check-ssr.sh"), pageUrl, slug], { encoding: "utf8" }).trim();
    ok(`scripts/check-ssr.sh: ${out}`);
  } catch (e) {
    bad(`scripts/check-ssr.sh failed: ${String(e.stdout ?? "")}${String(e.stderr ?? "")}`);
  }
  say("url", pageUrl);
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/**
 * FR-8 first, FR-8.2 second.
 *
 * A tag push fires a webhook at whichever host the App points at. When this run pushed the
 * tag itself, give that delivery a chance to land before touching `sync` — otherwise the
 * harness races its own webhook and always "proves" the recovery path. Only if nothing
 * appears do we cut the release by hand, which is exactly what a dropped delivery looks
 * like. The path that actually fired is recorded, because "a release exists" is not the
 * same claim as "the webhook works".
 */
async function releaseFor(apiKey, listingId, tag, version, { pushed }) {
  if (pushed) {
    const landed = await waitForRelease(apiKey, listingId, version, WEBHOOK_WAIT_SEC);
    if (landed) {
      ok(`the push webhook cut ${version} on its own, ${landed}s after the tag went up (FR-8)`);
      fact(`release_path_${version}`, "webhook");
      return { version, scan: "pass", via: "webhook" };
    }
    note(`no webhook-cut release after ${WEBHOOK_WAIT_SEC}s — falling back to sync, which is what a dropped delivery looks like`);
  }
  const result = await syncRelease(apiKey, listingId, tag);
  fact(`release_path_${version}`, result.via ?? "sync");
  return result;
}

/** Poll for a passing release of `version`. Returns the seconds it took, or null. */
async function waitForRelease(apiKey, listingId, version, seconds) {
  const started = Date.now();
  while ((Date.now() - started) / 1000 < seconds) {
    const { res, data } = await api("GET", `/api/listings/${listingId}`, { apiKey });
    if (res.ok && data.latest_release?.version === version && data.latest_release.scan === "pass") {
      return Math.round((Date.now() - started) / 1000);
    }
    await sleep(3000);
  }
  return null;
}

/**
 * `POST /api/listings/:id/sync`. Against a real deployment the webhook may already have
 * cut the release, so `version_exists` is success, not failure (FR-8 and FR-8.2 are two
 * doors into `cutRelease`).
 */
async function syncRelease(apiKey, listingId, ref) {
  const { res, data } = await api("POST", `/api/listings/${listingId}/sync`, { apiKey, json: { ref } });
  if (res.status === 202) {
    ok(`202 from sync { ref: "${ref}" } — release ${data.version} cut, scan ${data.scan}`);
    return { ...data, via: "sync" };
  }
  if (data?.code === "version_exists") {
    ok(`the release for ${ref} already existed — the webhook cut it (FR-8)`);
    return { version: ref.replace(/^v/, ""), scan: "unknown", commit_sha: "", via: "webhook" };
  }
  bad(`sync { ref: "${ref}" } → ${res.status} ${JSON.stringify(data)}`);
}

/** The scan runs inside the sync, but a webhook-cut release may still be pending. */
async function pollLatestRelease(apiKey, listingId, version, attempts = 30) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    const { res, data } = await api("GET", `/api/listings/${listingId}`, { apiKey });
    if (!res.ok) bad(`GET /api/listings/:id → ${res.status} ${JSON.stringify(data)}`);
    last = data;
    if (data.latest_release?.version === version && data.latest_release.scan === "pass") return data;
    await sleep(2000);
  }
  bad(`no passing release ${version} after ${attempts} polls; latest_release = ${JSON.stringify(last?.latest_release)}`);
}

/**
 * The buyer half: 402 → EIP-3009 authorization → 200 with a transaction hash.
 * `signed` adds `X-Wallet-Signature`, which is what turns a `new` 402 into an `update` one.
 */
async function buyRelease(url, { expectKind, expectPrice, signed = false, assert402 } = {}) {
  const headersFor = async () => (signed ? { "x-wallet-signature": await walletSignature(buyer) } : {});

  const unpaid = await fetchRetry(url, { headers: await headersFor() });
  const unpaidBody = await body(unpaid.clone());
  check(unpaid.status === 402, `402 from ${url.replace(BASE, "")} (${unpaid.status})`);
  check(unpaid.headers.get("PAYMENT-REQUIRED") !== null, "the PAYMENT-REQUIRED header is present (FR-21)");

  const required = buyerHttp.getPaymentRequiredResponse((name) => unpaid.headers.get(name), unpaidBody);
  check(unpaidBody.extra?.kind === expectKind, `the 402 kind is "${expectKind}"`);
  check(required.accepts[0].amount === expectPrice, `the 402 asks for exactly ${expectPrice} micro-USDC (${usd(expectPrice)})`);
  say("network / asset", `${required.accepts[0].network} · ${required.accepts[0].asset}`);
  say("payTo", required.accepts[0].payTo);
  say("description", unpaidBody.accepts?.[0]?.description ?? unpaidBody.resource?.description ?? "");
  if (assert402) assert402(unpaidBody);

  // Sign and submit. `settlement_pending` / `settlement_timeout` are the catalogue's two
  // retryable money codes and they are not ours: tonight the public facilitator answered
  // "replacement transaction underpriced" — its own signer's account nonce collided while
  // it was broadcasting another settlement. FR-22 means no purchase row exists when settle
  // fails, so the correct response is to re-quote and sign again, checking the ledger first
  // in case the transaction did land after the response was written.
  let quoteBody = unpaidBody;
  let requirements = required;

  for (let attempt = 1; ; attempt++) {
    const payload = await buyerHttp.createPaymentPayload(requirements);
    const paid = await fetchRetry(url, {
      headers: {
        ...(await headersFor()),
        ...buyerHttp.encodePaymentSignatureHeader(payload),
        "x-quote-id": quoteBody.extra?.quote_id ?? "",
      },
    });
    const data = await body(paid);

    if (paid.status === 200) {
      const settlement = buyerHttp.getPaymentSettleResponse((name) => paid.headers.get(name));
      check(true, `200 after settlement${attempt > 1 ? ` (attempt ${attempt})` : ""}`);
      check(Boolean(settlement.transaction), "PAYMENT-RESPONSE carries a transaction hash (FR-22)");
      return { data, tx: settlement.transaction };
    }

    const retryable = data.code === "settlement_pending" || data.code === "settlement_timeout";
    if (!retryable || attempt >= SETTLE_ATTEMPTS) {
      check(false, `200 after settlement (${paid.status} ${data.code ?? ""}) ${JSON.stringify(data).slice(0, 600)}`);
    }

    note(`${data.code} on attempt ${attempt}: ${String(data.message ?? "").split("\n")[0]} — re-quoting and signing again`);
    await sleep(4000 * attempt);

    // Did it land anyway? A settlement that confirmed after the handler gave up would
    // show as an entitlement, and paying twice for it would be a real loss.
    const landed = await api("GET", "/api/entitlements", { headers: { "x-wallet-signature": await walletSignature(buyer) } });
    const already = (landed.data.entitlements ?? []).find((e) => `${BASE}/api/r/${e.owner}/${e.slug}` === url && e.version === quoteBody.extra?.version);
    if (already) {
      check(true, `the settlement landed after all — ${already.tx_hash}`);
      const refetch = await api("GET", url, { headers: { "x-wallet-signature": await walletSignature(buyer) } });
      return { data: refetch.data, tx: already.tx_hash };
    }

    // FR-23: take a fresh quote rather than reusing a stale one.
    const requote = await fetchRetry(url, { headers: await headersFor() });
    quoteBody = await body(requote.clone());
    requirements = buyerHttp.getPaymentRequiredResponse((name) => requote.headers.get(name), quoteBody);
  }
}

async function download(url) {
  const res = await fetchRetry(url);
  if (!res.ok) bad(`download → ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** A tiny, genuinely MIT-licensed project. The LICENSE must be at the root (FR-11). */
function writeRailBProject(dir, ref) {
  const year = new Date().getFullYear();
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "LICENSE"),
    `MIT License

Copyright (c) ${year} x402git end-to-end test

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
  );
  fs.writeFileSync(
    path.join(dir, "README.md"),
    `# ${ref}

A minimal skill used by the FR-34 end-to-end test. It takes a sentence and returns it
without the em dashes, because that is the smallest useful thing a script can do.

## Usage

    node scripts/dedash.mjs "one — two"

## Licence

MIT.
`,
  );
  fs.writeFileSync(
    path.join(dir, "scripts", "dedash.mjs"),
    `#!/usr/bin/env node
// Replace em dashes with a comma and a space. That is the whole skill.
const input = process.argv.slice(2).join(" ");
process.stdout.write(input.replace(/\\s*\\u2014\\s*/g, ", ") + "\\n");
`,
  );
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: ref.split("/")[1], version: "1.0.0", private: true, license: "MIT", type: "module", bin: { dedash: "scripts/dedash.mjs" } }, null, 2)}\n`,
  );
}
