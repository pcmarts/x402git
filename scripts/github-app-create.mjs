#!/usr/bin/env node
// Create the X402 Git GitHub App via the manifest flow and write its credentials to .env.
//
//   node scripts/github-app-create.mjs [--name x402git-dev] [--org some-org] [--env .env]
//
// GitHub has no API for creating an App from nothing; the manifest flow is the closest thing.
// This script: (1) serves a self-submitting form to github.com/settings/apps/new, (2) receives
// the redirect with a one-time code, (3) exchanges it with `gh api`, (4) upserts
// GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY / GITHUB_APP_WEBHOOK_SECRET / GITHUB_OAUTH_CLIENT_ID /
// GITHUB_OAUTH_CLIENT_SECRET into .env. One browser click is required ("Create GitHub App").
//
// Permissions follow PRD Final.md D10 / FR-1 / FR-7: contents:read + metadata:read for analysis
// and tarballs; administration:write so installation tokens can create hosted-org repos and add
// per-repo deploy keys (Rail B). The App is public so creators (Rail A) and the separately-owned
// hosted orgs can install it. Never org-wide write beyond that.

import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "true"]);
    return acc;
  }, []),
);
const ENV_PATH = args.env ?? ".env";
const env = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
const appUrl = (env.match(/^NEXT_PUBLIC_APP_URL=(.+)$/m)?.[1] ?? "http://localhost:3000").trim();
const ghUser = execFileSync("gh", ["api", "user", "--jq", ".login"]).toString().trim();
const name = args.name ?? `x402git-dev-${ghUser}`;
const PORT = 3979;
const state = crypto.randomBytes(16).toString("hex");

const manifest = {
  name,
  url: appUrl,
  description: "Paid access to private git repos over x402/USDC (X402 Git).",
  public: true,
  hook_attributes: { url: `${appUrl}/api/webhooks/github`, active: true },
  redirect_url: `http://127.0.0.1:${PORT}/callback`,
  callback_urls: [`${appUrl}/api/auth/github/callback`],
  // After an install, or a change to which repos it covers, GitHub sends the creator back
  // to the repo picker instead of leaving them on github.com (RED-TEAM-2026-09-21 UXC-5).
  // request_oauth_on_install must stay false: when true GitHub ignores setup_url and sends
  // installers to the sign-in callback, which refuses any round trip it did not start.
  setup_url: `${appUrl}/dashboard/new`,
  setup_on_update: true,
  request_oauth_on_install: false,
  default_permissions: { contents: "read", metadata: "read", administration: "write" },
  default_events: ["push", "release"],
};

const target = args.org
  ? `https://github.com/organizations/${args.org}/settings/apps/new?state=${state}`
  : `https://github.com/settings/apps/new?state=${state}`;

function upsertEnv(pairs) {
  let out = env;
  for (const [k, v] of Object.entries(pairs)) {
    const line = `${k}=${v}`;
    const re = new RegExp(`^${k}=.*$`, "m");
    out = re.test(out) ? out.replace(re, line) : out.replace(/\n?$/, `\n${line}\n`);
  }
  fs.writeFileSync(ENV_PATH, out);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>Create ${name}</title>
<body style="font:16px system-ui;padding:2rem">
<p>Redirecting to GitHub to create the App <b>${name}</b>&hellip; click <b>Create GitHub App</b> there.</p>
<form id="f" method="post" action="${target}">
<input type="hidden" name="manifest" value='${JSON.stringify(manifest).replace(/'/g, "&#39;")}'>
<button>Continue</button></form>
<script>document.getElementById("f").submit()</script></body>`);
    return;
  }
  if (url.pathname === "/callback") {
    const code = url.searchParams.get("code");
    if (!code || url.searchParams.get("state") !== state) {
      res.writeHead(400).end("bad state/code");
      return;
    }
    try {
      const app = JSON.parse(
        execFileSync("gh", ["api", "-X", "POST", `/app-manifests/${code}/conversions`]).toString(),
      );
      upsertEnv({
        GITHUB_APP_ID: app.id,
        GITHUB_APP_SLUG: app.slug,
        GITHUB_APP_PRIVATE_KEY: `"${app.pem.trim().replace(/\n/g, "\\n")}"`,
        GITHUB_APP_WEBHOOK_SECRET: app.webhook_secret,
        GITHUB_OAUTH_CLIENT_ID: app.client_id,
        GITHUB_OAUTH_CLIENT_SECRET: app.client_secret,
      });
      const msg = `Created ${app.html_url} (id ${app.id}). Credentials written to ${ENV_PATH}.`;
      console.log(msg);
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<body style="font:16px system-ui;padding:2rem"><p>${msg}</p><p>You can close this tab.</p></body>`);
      setTimeout(() => process.exit(0), 200);
    } catch (e) {
      console.error(e.stderr?.toString() ?? e);
      res.writeHead(500).end("conversion failed; see terminal");
      setTimeout(() => process.exit(1), 200);
    }
    return;
  }
  res.writeHead(404).end();
});

server.listen(PORT, "127.0.0.1", () => {
  const open = `http://127.0.0.1:${PORT}/`;
  console.log(`Waiting for GitHub. If a browser didn't open, visit ${open}`);
  try { execFileSync("open", [open]); } catch {}
});
