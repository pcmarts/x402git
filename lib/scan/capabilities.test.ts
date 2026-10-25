import { describe, expect, it } from "vitest";
import { CAPABILITIES_RULESET_VERSION, EMPTY_CAPABILITIES_SUMMARY, inventoryCapabilities, workflowTriggers } from "./capabilities";

const run = (entries: Record<string, string>, extraPaths: string[] = []) => {
  const textFiles = new Map(Object.entries(entries));
  return inventoryCapabilities({ textFiles, paths: [...textFiles.keys(), ...extraPaths] });
};

/**
 * The shape "PRD Trust Report.md" §4.3 was written for: a Claude Code skill that asks for
 * tools, installs a hook, starts an MCP server, ships a build script, runs something at
 * install, reads a key out of the environment and calls an API. Every clause of the
 * inventory has to come out of this one repository correctly, because this is the
 * repository the founder pointed at Agensi's empty accordion about.
 */
const SKILL_REPO: Record<string, string> = {
  "SKILL.md": ["---", "name: git-helper", "allowed-tools: Bash(git *), Read, WebFetch", "---", "", "# git helper", ""].join("\n"),
  ".claude/settings.json": JSON.stringify({
    permissions: { allow: ["Bash(npm run test:*)", "WebSearch"] },
    hooks: { PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "npm run lint" }] }] },
  }),
  ".mcp.json": JSON.stringify({
    mcpServers: {
      github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "" } },
      remote: { url: "https://mcp.example.com/sse" },
    },
  }),
  "scripts/build.sh": ['#!/usr/bin/env bash', "set -euo pipefail", 'echo "building for $BUILD_ENV"', ""].join("\n"),
  "package.json": JSON.stringify({ name: "git-helper", scripts: { build: "tsc", postinstall: "node ./scripts/postinstall.js" } }),
  "src/client.ts": [
    "const key = process.env.ANTHROPIC_API_KEY;",
    'const res = await fetch("https://api.anthropic.com/v1/messages", { headers: { "x-api-key": key } });',
    "",
  ].join("\n"),
  "README.md": [
    "# git helper",
    "",
    "[![build](https://img.shields.io/badge/build-passing-green)](https://github.com/acme/git-helper)",
    "",
    "Run it at http://localhost:3000 while developing.",
    "",
  ].join("\n"),
};

describe("capability inventory (PRD Trust Report §4.3)", () => {
  it("reads a Claude Code skill repository end to end", () => {
    const { capabilities, findings, check } = run(SKILL_REPO, ["assets/logo.png"]);

    expect(capabilities.tools).toEqual([
      { name: "Bash", from: ".claude/settings.json" },
      { name: "WebSearch", from: ".claude/settings.json" },
      { name: "Bash", from: "SKILL.md" },
      { name: "Read", from: "SKILL.md" },
      { name: "WebFetch", from: "SKILL.md" },
    ]);

    expect(capabilities.runs).toEqual([
      { path: "package.json", kind: "install_script", detail: "postinstall" },
      { path: ".claude/settings.json", kind: "hook", detail: "PostToolUse (Edit|Write)" },
      { path: ".mcp.json", kind: "mcp_server", detail: "npx -y @modelcontextprotocol/server-github" },
      { path: "scripts/build.sh", kind: "script" },
    ]);

    expect(capabilities.hosts).toEqual([
      { host: "api.anthropic.com", local: false, from: "code", paths: ["src/client.ts"] },
      { host: "mcp.example.com", local: false, from: "code", paths: [".mcp.json"] },
      { host: "github.com", local: false, from: "docs", paths: ["README.md"] },
      { host: "img.shields.io", local: false, from: "docs", paths: ["README.md"] },
      { host: "localhost:3000", local: true, from: "docs", paths: ["README.md"] },
    ]);

    expect(capabilities.env).toEqual([
      { name: "ANTHROPIC_API_KEY", paths: ["src/client.ts"] },
      { name: "BUILD_ENV", paths: ["scripts/build.sh"] },
      { name: "GITHUB_TOKEN", paths: [".mcp.json"] },
    ]);

    expect(capabilities.install_runs).toBe(true);
    expect(capabilities.summary).toBe(
      "Tools: Bash, Read, WebFetch, WebSearch · runs a hook, an MCP server and a script · " +
        "talks to 2 hosts · links to 3 hosts in its docs · reads 3 environment variables · runs at install",
    );

    expect(findings.map((f) => [f.rule_id, f.severity, f.description])).toEqual([
      ["tools", "LOW", "Asks for 2 tools: Bash, WebSearch"],
      ["tools", "LOW", "Asks for 3 tools: Bash, Read, WebFetch"],
      ["install-script", "MODERATE", "postinstall runs when this is installed"],
      ["hook", "MODERATE", "A .claude hook runs on PostToolUse (Edit|Write)"],
      ["mcp-server", "LOW", "Runs a local MCP server"],
      ["script", "LOW", "Ships the script scripts/build.sh"],
      ["host", "LOW", "Talks to api.anthropic.com"],
      ["host", "LOW", "Talks to mcp.example.com"],
      ["env", "LOW", "Reads the environment variable ANTHROPIC_API_KEY"],
      ["env", "LOW", "Reads the environment variable BUILD_ENV"],
      ["env", "LOW", "Reads the environment variable GITHUB_TOKEN"],
    ]);

    expect(check).toMatchObject({
      id: "capabilities",
      tool: "x402git/caps",
      tool_version: CAPABILITIES_RULESET_VERSION,
      status: "findings",
      findings: 11,
    });
    expect(Date.parse(check.at)).not.toBeNaN();
  });

  it("never blocks and never asks for review — §4.1 keeps the gate to the absolutes", () => {
    const { findings } = run(SKILL_REPO);
    for (const finding of findings) {
      expect(finding).toMatchObject({ kind: "capability", check: "capabilities", tier: "disclosed", public: true, blocking: false });
    }
  });

  it("says the empty inventory in the words §4.3 fixes, and finds nothing", () => {
    const { capabilities, findings, check } = run({
      "README.md": "# prompt pack\n\nCopy the prompts below into your agent.\n",
      "docs/usage.md": "Paste the prompt. There is nothing to install.\n",
      "prompts/review.md": "You are a careful reviewer.\n",
    });

    expect(capabilities).toEqual({
      tools: [],
      runs: [],
      hosts: [],
      env: [],
      install_runs: false,
      summary: "No tools, no hosts, no environment variables, nothing runs at install.",
    });
    expect(capabilities.summary).toBe(EMPTY_CAPABILITIES_SUMMARY);
    expect(findings).toEqual([]);
    expect(check.status).toBe("pass");
    expect(check.findings).toBe(0);
  });
});

describe("runs", () => {
  it("discloses a workflow, its triggers and its secrets", () => {
    const ci = [
      "name: CI",
      "on:",
      "  push:",
      "    branches: [main]",
      "  pull_request:",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    env:",
      "      NODE_ENV: production",
      "    steps:",
      "      - run: npm publish",
      "        env:",
      "          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}",
      "",
    ].join("\n");
    const { capabilities, findings } = run({ ".github/workflows/ci.yml": ci });

    expect(capabilities.runs).toEqual([{ path: ".github/workflows/ci.yml", kind: "workflow", detail: "push, pull_request" }]);
    expect(capabilities.env.map((e) => e.name)).toEqual(["NODE_ENV", "NPM_TOKEN"]);
    expect(capabilities.install_runs).toBe(false);
    expect(findings[0]).toMatchObject({
      rule_id: "workflow",
      severity: "MODERATE",
      description: "A GitHub Actions workflow runs on push, pull_request",
    });
    expect(capabilities.summary).toBe("runs a workflow · reads 2 environment variables · nothing runs at install");
  });

  it("reads the three inline forms of an `on:` block", () => {
    expect(workflowTriggers("on: push\njobs:\n")).toEqual(["push"]);
    expect(workflowTriggers("on: [push, workflow_dispatch]\njobs:\n")).toEqual(["push", "workflow_dispatch"]);
    expect(workflowTriggers("name: x\njobs:\n  a:\n    steps: []\n")).toEqual([]);
  });

  it("counts a Python build hook as install-time execution", () => {
    const setup = run({ "setup.py": "from setuptools import setup\nsetup(name='x')\n" });
    expect(setup.capabilities.runs).toEqual([{ path: "setup.py", kind: "build_hook", detail: "setup.py" }]);
    expect(setup.capabilities.install_runs).toBe(true);
    expect(setup.findings[0]).toMatchObject({ rule_id: "build-hook", severity: "MODERATE", description: "setup.py runs when this is installed" });

    const project = run({ "pyproject.toml": '[build-system]\nrequires = ["hatchling"]\n' });
    expect(project.capabilities.runs).toEqual([{ path: "pyproject.toml", kind: "build_hook", detail: "[build-system]" }]);
    expect(project.capabilities.install_runs).toBe(true);

    const plain = run({ "pyproject.toml": '[project]\nname = "x"\n' });
    expect(plain.capabilities.runs).toEqual([]);
    expect(plain.capabilities.install_runs).toBe(false);
  });

  it("finds a script by shebang, by extension, by folder — and never a README in scripts/", () => {
    const { capabilities } = run(
      {
        "tools/release": "#!/usr/bin/env python3\nprint('release')\n",
        "deploy.ps1": "Write-Host 'deploy'\n",
        "scripts/README.md": "# how these scripts work\n",
        "scripts/fixtures/data.json": "{}",
        "bin/cli": "#!/bin/sh\nexec node ./index.js\n",
      },
      ["bin/helper"],
    );
    expect(capabilities.runs.map((r) => r.path).sort()).toEqual(["bin/cli", "bin/helper", "deploy.ps1", "tools/release"]);
  });

  it("names the makefile it ships", () => {
    const { capabilities, findings } = run({ Makefile: "build:\n\tgo build ./...\n" });
    expect(capabilities.runs).toEqual([{ path: "Makefile", kind: "make", detail: "Makefile" }]);
    expect(findings[0]).toMatchObject({ rule_id: "make", severity: "LOW", description: "Ships a Makefile" });
  });

  it("truncates a long MCP command rather than pasting a shell line into the report", () => {
    const { capabilities } = run({
      "mcp.json": JSON.stringify({ mcpServers: { big: { command: "node", args: [`./${"a".repeat(200)}.js`] } } }),
    });
    const detail = capabilities.runs[0].detail ?? "";
    expect(detail.length).toBe(80);
    expect(detail.endsWith("…")).toBe(true);
  });
});

describe("tools", () => {
  it("accepts the block-list form of allowed-tools and strips the argument pattern", () => {
    const { capabilities } = run({
      ".claude/commands/ship.md": ["---", "allowed-tools:", "  - Bash(git push:*)", "  - Read", "---", "Ship it.", ""].join("\n"),
      "agents/reviewer.md": ["---", "allowed-tools: Grep Glob Read", "---", "Review it.", ""].join("\n"),
    });
    expect(capabilities.tools).toEqual([
      { name: "Bash", from: ".claude/commands/ship.md" },
      { name: "Read", from: ".claude/commands/ship.md" },
      { name: "Grep", from: "agents/reviewer.md" },
      { name: "Glob", from: "agents/reviewer.md" },
      { name: "Read", from: "agents/reviewer.md" },
    ]);
  });

  it("discloses nothing from a settings file it cannot parse", () => {
    const { capabilities, findings } = run({ ".claude/settings.json": '{ "permissions": { "allow": ["Bash",] } }' });
    expect(capabilities.tools).toEqual([]);
    expect(findings).toEqual([]);
  });
});

describe("hosts", () => {
  it("normalises credentials, case, paths and default ports", () => {
    const { capabilities } = run({
      "src/net.ts": [
        'await fetch("https://USER:pw@API.Example.COM:443/v1/things?x=1");',
        'await fetch("http://internal.svc:8080/health");',
        'await fetch("https://cdn.example.org:8443/asset.png");',
        'const cache = { url: "redis-primary.internal:6379" };',
        "",
      ].join("\n"),
    });
    expect(capabilities.hosts.map((h) => h.host)).toEqual([
      "api.example.com",
      "cdn.example.org:8443",
      "internal.svc:8080",
      "redis-primary.internal:6379",
    ]);
    expect(capabilities.hosts.every((h) => h.from === "code" && !h.local)).toBe(true);
  });

  it("keeps example hosts — a listing that talks to one should say so", () => {
    const { capabilities } = run({ "src/a.ts": 'fetch("https://example-plumbing.com/api");' });
    expect(capabilities.hosts.map((h) => h.host)).toEqual(["example-plumbing.com"]);
  });

  it("labels local hosts rather than dropping them", () => {
    const { capabilities, findings } = run({
      "src/dev.ts": ['fetch("http://localhost:3000/api");', 'fetch("http://127.0.0.1:5432");', 'fetch("http://printer.local/status");', ""].join("\n"),
    });
    expect(capabilities.hosts).toEqual([
      { host: "127.0.0.1:5432", local: true, from: "code", paths: ["src/dev.ts"] },
      { host: "localhost:3000", local: true, from: "code", paths: ["src/dev.ts"] },
      { host: "printer.local", local: true, from: "code", paths: ["src/dev.ts"] },
    ]);
    // Local is a capability, not a network call the buyer's machine makes outward.
    expect(findings.filter((f) => f.rule_id === "host")).toEqual([]);
  });

  it("skips namespaces, xmlns declarations and HTML comments", () => {
    const { capabilities } = run({
      "assets/icon.svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path d="M0 0h8v8H0z"/></svg>',
      "schema.json": '{"$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object"}',
      "LICENSE.md": "SPDX at https://spdx.org/licenses/MIT.html\n",
      "notes.md": ["<!-- internal: https://plans.internal.example.net/roadmap -->", "See https://docs.example.net/guide.", ""].join("\n"),
      "config.xml": '<config xmlns:x="http://schemas.acme.test/config/v1"><endpoint>https://api.acme.test/v2</endpoint></config>',
    });
    expect(capabilities.hosts.map((h) => `${h.host} (${h.from})`)).toEqual(["api.acme.test (code)", "docs.example.net (docs)"]);
  });

  it("counts documentation links separately from what the code talks to", () => {
    const { capabilities } = run({
      "src/a.ts": 'fetch("https://api.acme.test/v1");',
      "docs/setup.md": "Read more at https://acme.test/docs.\n",
    });
    expect(capabilities.summary).toBe("talks to 1 host · links to 1 host in its docs · nothing runs at install");
  });
});

describe("environment", () => {
  it("reads the four notations and drops the ambient shell variables", () => {
    const { capabilities } = run({
      "src/a.ts": 'const a = process.env.API_TOKEN; const b = process.env["REGION"];',
      "src/b.py": 'import os\nk = os.environ["OPENAI_KEY"]\nr = os.environ.get("RETRIES")\nu = os.getenv("USER_AGENT")\n',
      "deploy.sh": ['#!/bin/bash', 'cd "$HOME" || exit 1', 'echo "$PATH $PWD $1 $@ $?"', 'aws s3 cp "$ARTIFACT" "s3://$BUCKET_NAME/"', 'echo "${DEPLOY_TARGET:-staging}"', ""].join("\n"),
    });
    expect(capabilities.env.map((e) => e.name)).toEqual([
      "API_TOKEN",
      "ARTIFACT",
      "BUCKET_NAME",
      "DEPLOY_TARGET",
      "OPENAI_KEY",
      "REGION",
      "RETRIES",
      "USER_AGENT",
    ]);
  });

  it("does not read shell expansions out of source that is not a shell script", () => {
    const { capabilities } = run({ "src/template.ts": "const t = `${TOTAL_COUNT} of ${LIMIT}`;" });
    expect(capabilities.env).toEqual([]);
  });
});

describe("bounds", () => {
  /**
   * 13 Sep 2026: the skip is disclosed. "No hosts, no environment variables" is a computed
   * claim — §4.3's whole argument against a creator checkbox — and it may not be made about
   * bytes nothing read. Putting the one `fetch` in a 3 MB generated file was otherwise all
   * it took to publish an inventory that said the artifact talks to nobody.
   */
  it("discloses a file past the 2 MB read budget, and still classifies it by path", () => {
    const filler = "x".repeat(2_200_000);
    const { capabilities, findings, check } = run({
      "big.ts": `// ${filler}\nconst k = process.env.BIG_SECRET;\nfetch("https://big.example.com/");\n`,
      "scripts/huge.sh": `#!/bin/bash\n# ${filler}\necho "$HUGE_VAR"\n`,
    });
    // The path still runs — the bytes were simply not read for hosts and env names.
    expect(capabilities.runs).toEqual([{ path: "scripts/huge.sh", kind: "script" }]);
    expect(capabilities.hosts).toEqual([]);
    expect(capabilities.env).toEqual([]);

    const unscannable = findings.filter((f) => f.rule_id === "capabilities-unscannable");
    expect(unscannable.map((f) => f.path)).toEqual(["big.ts", "scripts/huge.sh"]);
    expect(unscannable.every((f) => f.tier === "disclosed" && !f.blocking)).toBe(true);
    expect(check.status).toBe("findings");
  });

  it("caps the paths kept per host and per environment variable at five", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 9; i++) files[`src/m${i}.ts`] = 'fetch("https://api.acme.test/x"); const k = process.env.SHARED_KEY;';
    const { capabilities } = run(files);
    expect(capabilities.hosts[0].paths).toEqual(["src/m0.ts", "src/m1.ts", "src/m2.ts", "src/m3.ts", "src/m4.ts"]);
    expect(capabilities.env[0].paths).toHaveLength(5);
  });

  it("is deterministic: the same bytes give the same inventory", () => {
    const a = run(SKILL_REPO);
    const b = run(SKILL_REPO);
    expect(JSON.stringify(a.capabilities)).toBe(JSON.stringify(b.capabilities));
    expect(JSON.stringify(a.findings)).toBe(JSON.stringify(b.findings));
  });
});
