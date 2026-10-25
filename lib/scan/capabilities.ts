/**
 * lib/scan/capabilities.ts — "Permissions required", computed.
 *
 * "PRD Trust Report.md" §4.3 (accepted 13 Sep 2026): the buyer's question is "will
 * installing this run something on my machine, and will it talk to anyone?", and the
 * answer is already in the bytes we hold. Agensi's answer is a creator checkbox and an
 * empty accordion (docs/research/Battle Test.md §6.3a); ours is computed from the
 * snapshot at cut time and published whether the creator likes it or not.
 *
 * Three properties hold this module to what §6.1 promises for everything under
 * `lib/scan/`:
 *
 * 1. **Pure.** No network, no model, no binary, no clock beyond the check row's `at`.
 *    Same bytes in, same inventory out — which is what lets us print a rule version
 *    beside the claim and let a creator reproduce it.
 * 2. **Nothing here is ever a verdict.** Every finding is `tier: "disclosed"`,
 *    `blocking: false`. A skill that runs a hook is a different purchase from a prompt
 *    pack, not a worse one. §4.1: the gate stays the small set of absolutes.
 * 3. **An empty inventory is a claim.** `summary` says it in the words §4.3 fixes:
 *    "No tools, no hosts, no environment variables, nothing runs at install." That
 *    sentence is the all-clear state Quality Signals §9a says to verify first, so it is
 *    a computed sentence and not an absence of UI.
 *
 * Severity is the buyer's reading time, not a risk score: LOW is "here is what it
 * declares", MODERATE is "this executes code you did not write" — hooks, install-time
 * scripts, build hooks and CI workflows. Nothing reaches HIGH, because nothing here can.
 */

import type { Capabilities, CapabilityHost, CapabilityRun, ScanCheck, ScanFinding, ScanSeverity } from "./report";

/** Bump when a rule below changes. Goes on the check row, in front of the buyer. */
export const CAPABILITIES_RULESET_VERSION = "2026.09.1";

/**
 * Host and environment extraction is regex over decoded text, so it needs a per-file
 * bound: a snapshot is capped at 20,000 files and 200 MB (§6) and a single generated
 * bundle can be most of that. Files past this are still classified by *path* — a 4 MB
 * `scripts/bundle.sh` still counts as a script — they are simply not read for hosts and
 * env names. Measured in characters, which is the cheap proxy for bytes here.
 *
 * A file the cap keeps us out of is **disclosed** as `capabilities-unscannable`
 * (13 Sep 2026), because "no hosts" is a claim and this module does not make claims about
 * bytes it did not read.
 */
const MAX_SCAN_CHARS = 2 * 1024 * 1024;

/** Report-size bounds. A monorepo with 400 shell scripts must not produce 400 findings. */
const MAX_SCRIPT_RUNS = 50;
const MAX_HOSTS = 100;
const MAX_ENV = 100;
const MAX_TOOLS = 200;
/** Paths kept per host / per environment variable. §4.3 wants the evidence, not all of it. */
const MAX_PATHS_PER_ENTRY = 5;

// ---------------------------------------------------------------------------
// Path classification
// ---------------------------------------------------------------------------

/** `SKILL.md` anywhere, which covers `.claude/skills/**\/SKILL.md` without a second rule. */
const SKILL_FILE = /(^|\/)skill\.md$/i;
/** `commands/foo.md`, `.claude/commands/git/commit.md`, `agents/reviewer.md`. Namespaced dirs included. */
const COMMAND_OR_AGENT_FILE = /(^|\/)(commands|agents)\/.+\.md$/i;
const CLAUDE_SETTINGS = /(^|\/)\.claude\/settings(\.local)?\.json$/i;
/**
 * `mcp.json`, `.mcp.json`, `mcp-servers.json`. Same shape as the `mcp_servers` bucket
 * detector in lib/analysis/files.ts, widened to the `mcp*.json` family §4.3 names.
 */
const MCP_CONFIG_FILE = /(^|\/)\.?mcp[a-z0-9._-]*\.json$/i;
const WORKFLOW_FILE = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i;
const PACKAGE_JSON = /(^|\/)package\.json$/;
const SETUP_PY = /(^|\/)setup\.py$/;
const PYPROJECT = /(^|\/)pyproject\.toml$/;
const MAKE_FILE = /(^|\/)(makefile|justfile)$/i;
const SHELL_EXTENSION = /\.(sh|bash|zsh|ps1)$/i;
const SCRIPT_DIR = /(^|\/)(scripts?|bin)\//i;

/**
 * Under `scripts/`/`bin/` and *not* a thing that runs: a README, a fixture, an icon.
 * §4.3 says "any file under `scripts/`, `bin/`"; taken literally that discloses
 * `scripts/README.md` as something the artifact runs, which is a false disclosure and
 * those are the expensive kind. A shebang overrides this — an extensionless or
 * oddly-named file that declares an interpreter runs.
 */
const NOT_A_SCRIPT_EXTENSION = new Set([
  "md", "markdown", "mdx", "txt", "rst", "adoc", "org",
  "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties", "lock",
  "csv", "tsv", "png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico", "pdf",
  "zip", "tar", "gz", "tgz", "bz2", "xz", "html", "htm", "css", "scss", "sass", "less",
]);

/** Hosts in these carry `from: "docs"` — "documentation links", never "talks to" (§4.3). */
const DOC_EXTENSION = /\.(md|markdown|mdx|txt|rst|adoc|org)$/i;
const DOC_DIR = /(^|\/)docs?\//i;

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function isDocsPath(path: string): boolean {
  return DOC_EXTENSION.test(path) || DOC_DIR.test(path);
}

// ---------------------------------------------------------------------------
// Precompiled scanners. All single-pass character classes: no nested quantifier, so
// no input can make one of these backtrack catastrophically.
// ---------------------------------------------------------------------------

const URL_LITERAL = /\b(https?):\/\/([^\s"'`<>()[\]{},;\\|^]+)/gi;
/** `"url": "redis:6379"`, `host = db.internal:5432`. Key-anchored so it cannot eat code. */
const KEYED_HOST_PORT = /["']?(?:url|uri|host|hostname|endpoint|base[_-]?url)["']?\s*[:=]\s*["']?([A-Za-z0-9._-]+:\d{1,5})(?=["'\s,}\]]|$)/gi;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const XMLNS_ATTR = /xmlns(?::[A-Za-z0-9_-]+)?\s*=\s*["'][^"']*["']|xsi:schemaLocation\s*=\s*["'][^"']*["']/gi;

const PROCESS_ENV = /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*["'`]([^"'`\n]{1,128})["'`]\s*\])/g;
const PYTHON_ENV = /os\.(?:environ(?:\.get)?\s*[[(]\s*|getenv\s*\(\s*)["']([^"'\n]{1,128})["']/g;
const SHELL_ENV = /\$\{([A-Z][A-Z0-9_]+)[^}\n]{0,120}\}|\$([A-Z][A-Z0-9_]+)\b/g;
const GHA_SECRET = /\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * `$PATH` is not a capability. Shell specials and the ambient environment every process
 * already has would otherwise dominate the list and bury `ANTHROPIC_API_KEY`.
 */
const AMBIENT_ENV = new Set([
  "PATH", "HOME", "PWD", "OLDPWD", "SHELL", "USER", "LOGNAME", "TERM", "TMPDIR", "TMP", "TEMP",
  "IFS", "PS1", "PS2", "PS4", "RANDOM", "SECONDS", "LINENO", "BASH", "BASH_SOURCE", "BASHPID",
  "FUNCNAME", "HOSTNAME", "LANG", "LC_ALL", "EDITOR", "PAGER", "SHLVL", "UID", "EUID", "OSTYPE",
  "MAKEFLAGS", "MAKELEVEL", "CDPATH", "COLUMNS", "LINES",
]);

/**
 * A namespace is not a network call. `xmlns="http://www.w3.org/2000/svg"` on every icon
 * in the repo would put w3.org at the top of "talks to" on half the catalogue.
 * `example.com` is deliberately *not* here: the founder's Agensi example listed
 * `example-plumbing.com`, and a listing that talks to an example host should say so.
 */
const NAMESPACE_HOSTS = new Set([
  "w3.org", "www.w3.org", "json-schema.org", "www.json-schema.org", "spdx.org", "www.spdx.org",
  "schema.org", "www.schema.org", "purl.org", "xmlns.com", "docbook.org", "www.docbook.org",
]);

function isNamespaceHost(host: string): boolean {
  const bare = host.replace(/:\d+$/, "");
  return NAMESPACE_HOSTS.has(bare) || /^schemas?\./.test(bare);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type CapabilityInventoryInput = {
  /** Path → decoded text, for every file that decoded as text. */
  textFiles: Map<string, string>;
  /** Every file in the snapshot, binary included — a shell script in `bin/` need not decode. */
  paths: string[];
};

export type CapabilityInventory = {
  capabilities: Capabilities;
  findings: ScanFinding[];
  check: ScanCheck;
};

/**
 * The whole of §4.3. Deterministic in `textFiles`/`paths` and nothing else; the only
 * non-deterministic value returned is the check row's `at`, which is the time the row
 * was produced and is meant to move.
 */
export function inventoryCapabilities(input: CapabilityInventoryInput): CapabilityInventory {
  const textFiles = input.textFiles;
  const paths = [...new Set(input.paths)].sort();
  const textPaths = [...textFiles.keys()].sort();

  const tools: { name: string; from: string }[] = [];
  const toolsByFile = new Map<string, string[]>();
  const runs: CapabilityRun[] = [];
  const hosts = new Map<string, CapabilityHost>();
  const env = new Map<string, string[]>();
  let installRuns = false;

  const addTool = (name: string, from: string) => {
    if (tools.length >= MAX_TOOLS) return;
    if (tools.some((t) => t.name === name && t.from === from)) return;
    tools.push({ name, from });
    const seen = toolsByFile.get(from);
    if (seen) seen.push(name);
    else toolsByFile.set(from, [name]);
  };

  const addRun = (run: CapabilityRun) => {
    if (runs.some((r) => r.path === run.path && r.kind === run.kind && r.detail === run.detail)) return;
    runs.push(run);
  };

  const addHost = (host: string, from: CapabilityHost["from"], path: string) => {
    const key = `${host} ${from}`;
    const existing = hosts.get(key);
    if (existing) {
      if (existing.paths.length < MAX_PATHS_PER_ENTRY && !existing.paths.includes(path)) existing.paths.push(path);
      return;
    }
    if (hosts.size >= MAX_HOSTS) return;
    hosts.set(key, { host, local: isLocalHost(host), from, paths: [path] });
  };

  const addEnv = (name: string, path: string) => {
    const existing = env.get(name);
    if (existing) {
      if (existing.length < MAX_PATHS_PER_ENTRY && !existing.includes(path)) existing.push(path);
      return;
    }
    if (env.size >= MAX_ENV) return;
    env.set(name, [path]);
  };

  // --- Runs and tools, from paths and the structured files that declare them. ---------

  for (const path of paths) {
    const base = baseName(path).toLowerCase();
    const text = textFiles.get(path);

    // Claude Code tools: `allowed-tools:` frontmatter, and the settings allow list.
    if (text && (SKILL_FILE.test(path) || COMMAND_OR_AGENT_FILE.test(path))) {
      for (const name of allowedToolsFromFrontmatter(text)) addTool(name, path);
    }

    if (CLAUDE_SETTINGS.test(path) && text) {
      const settings = parseJson(text);
      for (const entry of settingsAllowList(settings)) addTool(entry, path);
      // A hook is arbitrary shell on an event (§4.3, "disclosed as its own line, loudly").
      for (const hook of settingsHooks(settings)) addRun({ path, kind: "hook", detail: hook });
    }

    if (MCP_CONFIG_FILE.test(path) && text) {
      for (const server of mcpServers(parseJson(text))) {
        if (server.command) {
          addRun({ path, kind: "mcp_server", detail: truncate([server.command, ...server.args].join(" ")) });
        } else if (server.url) {
          // A remote server runs nothing locally; what it does is talk to a host, so
          // that is where it is disclosed (§4.3).
          const host = hostFromUrl(server.url);
          if (host && !isNamespaceHost(host)) addHost(host, "code", path);
        }
        for (const name of server.env) addEnv(name, path);
      }
    }

    if (PACKAGE_JSON.test(path) && text) {
      for (const name of lifecycleScripts(parseJson(text))) {
        addRun({ path, kind: "install_script", detail: name });
        installRuns = true;
      }
    }

    if (SETUP_PY.test(path)) {
      addRun({ path, kind: "build_hook", detail: "setup.py" });
      installRuns = true;
    }

    if (PYPROJECT.test(path) && text) {
      const detail = pyprojectBuildHook(text);
      if (detail) {
        addRun({ path, kind: "build_hook", detail });
        installRuns = true;
      }
    }

    if (MAKE_FILE.test(path)) addRun({ path, kind: "make", detail: baseName(path) });

    if (WORKFLOW_FILE.test(path)) {
      const triggers = text ? workflowTriggers(text) : [];
      addRun({ path, kind: "workflow", detail: triggers.length > 0 ? truncate(triggers.join(", ")) : undefined });
    }

    // A script: named as one, filed as one, or declaring its own interpreter.
    if (!WORKFLOW_FILE.test(path) && !MCP_CONFIG_FILE.test(path) && !CLAUDE_SETTINGS.test(path)) {
      const shebang = text !== undefined && text.startsWith("#!");
      const named = SHELL_EXTENSION.test(path);
      const filed = SCRIPT_DIR.test(path) && !NOT_A_SCRIPT_EXTENSION.has(extensionOf(base));
      if (shebang || named || filed) {
        if (runs.filter((r) => r.kind === "script").length < MAX_SCRIPT_RUNS) addRun({ path, kind: "script" });
      }
    }
  }

  // --- Hosts and environment names, from the text. ------------------------------------

  /** Files the cap below kept us out of. Disclosed, so the row cannot read `pass` (§4.1). */
  const unscannable: string[] = [];

  for (const path of textPaths) {
    const text = textFiles.get(path) ?? "";
    if (text.length > MAX_SCAN_CHARS) {
      unscannable.push(path);
      continue;
    }

    const from: CapabilityHost["from"] = isDocsPath(path) ? "docs" : "code";
    for (const host of hostsIn(text)) addHost(host, from, path);
    for (const name of envNamesIn(path, text)) addEnv(name, path);
  }

  // --- Assemble. ----------------------------------------------------------------------

  const runList = [...runs].sort(
    (a, b) => RUN_RANK[a.kind] - RUN_RANK[b.kind] || a.path.localeCompare(b.path) || (a.detail ?? "").localeCompare(b.detail ?? ""),
  );
  const hostList = [...hosts.values()].sort((a, b) => (a.from === b.from ? a.host.localeCompare(b.host) : a.from === "code" ? -1 : 1));
  const envList = [...env.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, paths]) => ({ name, paths }));

  const capabilities: Capabilities = {
    tools,
    runs: runList,
    hosts: hostList,
    env: envList,
    install_runs: installRuns,
    summary: summarise(tools, runList, hostList, envList, installRuns),
  };

  const findings: ScanFinding[] = [];
  for (const [path, names] of [...toolsByFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    findings.push(
      capabilityFinding("tools", "LOW", `Asks for ${count(names.length, "tool")}: ${nameList(names)}`, path),
    );
  }
  for (const run of runList) findings.push(runFinding(run));
  for (const host of hostList) {
    // Documentation links and `localhost` are in the inventory and on the page; neither
    // is a network call the buyer's machine will make, so neither is a finding.
    if (host.from !== "code" || host.local) continue;
    findings.push(capabilityFinding("host", "LOW", `Talks to ${host.host}`, host.paths[0]));
  }
  for (const entry of envList) {
    findings.push(capabilityFinding("env", "LOW", `Reads the environment variable ${entry.name}`, entry.paths[0]));
  }
  // 13 Sep 2026: the `MAX_SCAN_CHARS` skip was a bare `continue`, so an artifact whose only
  // network call sat in a 3 MB generated file produced an inventory that said "no hosts" —
  // a computed claim about bytes nothing had read. The skip is now a line on the report,
  // which is the same rule lib/scan/injection.ts applies to its own cap.
  for (const path of unscannable) {
    findings.push(capabilityFinding("capabilities-unscannable", "LOW", `${path} is too large to read for hosts and environment variables`, path));
  }

  const check: ScanCheck = {
    id: "capabilities",
    tool: "x402git/caps",
    tool_version: CAPABILITIES_RULESET_VERSION,
    status: findings.length > 0 ? "findings" : "pass",
    at: new Date().toISOString(),
    findings: findings.length,
  };

  return { capabilities, findings, check };
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/** Most-alarming first, so the summary reads "runs an install script and 3 scripts". */
const RUN_RANK: Record<CapabilityRun["kind"], number> = {
  install_script: 0,
  build_hook: 1,
  hook: 2,
  mcp_server: 3,
  workflow: 4,
  make: 5,
  script: 6,
};

function capabilityFinding(ruleId: string, severity: ScanSeverity, description: string, path?: string): ScanFinding {
  return {
    kind: "capability",
    check: "capabilities",
    tier: "disclosed",
    public: true,
    rule_id: ruleId,
    severity,
    description,
    blocking: false,
    ...(path ? { path } : {}),
  };
}

/**
 * One line a buyer reads. Never a line *of* the file: the path and the kind are the
 * disclosure, and quoting the body would turn a capability report into a code excerpt
 * (and, for a hook, into a copy of whatever the creator wrote there).
 *
 * `build_hook` is MODERATE alongside hooks, install scripts and workflows: it is an
 * install script wearing Python's clothes, and `pip install` runs it on the buyer's
 * machine exactly as `npm install` runs a `postinstall`.
 */
function runFinding(run: CapabilityRun): ScanFinding {
  switch (run.kind) {
    case "hook":
      return capabilityFinding("hook", "MODERATE", `A .claude hook runs on ${run.detail ?? "a tool event"}`, run.path);
    case "install_script":
      return capabilityFinding("install-script", "MODERATE", `${run.detail ?? "An npm lifecycle script"} runs when this is installed`, run.path);
    case "build_hook":
      return capabilityFinding("build-hook", "MODERATE", `${run.detail ?? "A build hook"} runs when this is installed`, run.path);
    case "workflow":
      return capabilityFinding(
        "workflow",
        "MODERATE",
        run.detail ? `A GitHub Actions workflow runs on ${run.detail}` : "A GitHub Actions workflow runs in CI",
        run.path,
      );
    case "mcp_server":
      return capabilityFinding("mcp-server", "LOW", "Runs a local MCP server", run.path);
    case "make":
      return capabilityFinding("make", "LOW", `Ships a ${run.detail ?? "makefile"}`, run.path);
    case "script":
      return capabilityFinding("script", "LOW", `Ships the script ${run.path}`, run.path);
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * YAML frontmatter, without a YAML parser (§6.1: no new dependency in the scan path).
 * Only the `allowed-tools:` line is read, in either of the two forms Claude Code accepts:
 * inline (`Bash(git *), Read`) and a block list of `- Bash`.
 */
export function allowedToolsFromFrontmatter(text: string): string[] {
  const block = frontmatterBlock(text);
  if (block === null) return [];
  const lines = block.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^allowed[-_]tools\s*:\s*(.*)$/i.exec(lines[i]);
    if (!match) continue;
    const inline = match[1].trim();
    if (inline) {
      for (const entry of splitToolList(inline)) out.push(entry);
    } else {
      for (let j = i + 1; j < lines.length; j++) {
        const item = /^\s*-\s*(.+?)\s*$/.exec(lines[j]);
        if (!item) break;
        for (const entry of splitToolList(item[1])) out.push(entry);
      }
    }
    break;
  }
  return dedupe(out);
}

/** The text between the opening `---` and the next `---`/`...`, or null. First 64 KB only. */
function frontmatterBlock(text: string): string | null {
  let head = text.slice(0, 65536);
  if (head.charCodeAt(0) === 0xfeff) head = head.slice(1);
  if (!head.startsWith("---")) return null;
  const rest = head.slice(3);
  if (rest.length > 0 && !/^\r?\n/.test(rest)) return null;
  const end = rest.search(/\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/);
  if (end < 0) return null;
  return rest.slice(0, end);
}

/**
 * `Bash(git *), Read, WebFetch` and `Bash Read WebFetch` are both in the wild, and the
 * space inside `Bash(git *)` is why this is a depth-aware split rather than a `.split`.
 * The tool is the name before the paren — the argument pattern is the creator's scoping
 * of it, not a second capability.
 */
function splitToolList(raw: string): string[] {
  const trimmed = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  const out: string[] = [];
  let depth = 0;
  let current = "";
  const flush = () => {
    const name = toolName(current);
    if (name) out.push(name);
    current = "";
  };
  for (const ch of trimmed) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === "," || ch === " " || ch === "\t")) {
      flush();
      continue;
    }
    current += ch;
  }
  flush();
  return out;
}

function toolName(entry: string): string | null {
  const cleaned = entry.trim().replace(/^["']|["']$/g, "").trim();
  if (!cleaned) return null;
  const paren = cleaned.indexOf("(");
  const name = (paren >= 0 ? cleaned.slice(0, paren) : cleaned).trim();
  if (!name || !/^[A-Za-z][A-Za-z0-9_.:*-]*$/.test(name)) return null;
  return name;
}

/** `permissions.allow[]` in `.claude/settings.json`: the tool is the name before the paren. */
function settingsAllowList(settings: unknown): string[] {
  if (!isRecord(settings)) return [];
  const permissions = settings.permissions;
  if (!isRecord(permissions)) return [];
  const allow = permissions.allow;
  if (!Array.isArray(allow)) return [];
  const out: string[] = [];
  for (const entry of allow) {
    if (typeof entry !== "string") continue;
    const name = toolName(entry);
    if (name) out.push(name);
  }
  return dedupe(out);
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** `hooks: { PostToolUse: [{ matcher, hooks: [...] }] }` → `PostToolUse (Edit|Write)`. */
function settingsHooks(settings: unknown): string[] {
  if (!isRecord(settings)) return [];
  const hooks = settings.hooks;
  if (!isRecord(hooks)) return [];
  const out: string[] = [];
  for (const event of Object.keys(hooks).sort()) {
    const groups = hooks[event];
    if (!Array.isArray(groups) || groups.length === 0) {
      out.push(event);
      continue;
    }
    for (const group of groups) {
      const matcher = isRecord(group) && typeof group.matcher === "string" ? group.matcher.trim() : "";
      out.push(matcher && matcher !== "*" ? `${event} (${matcher})` : event);
    }
  }
  return dedupe(out);
}

type McpServer = { command: string | null; args: string[]; url: string | null; env: string[] };

/**
 * `mcpServers` (Claude Code, `.mcp.json`), `servers` (the VS Code spelling), or a bare
 * map of servers. A server with a `command` runs a process on the buyer's machine; one
 * with only a `url` does not, and is disclosed as a host instead.
 */
function mcpServers(config: unknown): McpServer[] {
  if (!isRecord(config)) return [];
  const container = isRecord(config.mcpServers) ? config.mcpServers : isRecord(config.servers) ? config.servers : config;
  const out: McpServer[] = [];
  for (const key of Object.keys(container).sort()) {
    const server = container[key];
    if (!isRecord(server)) continue;
    const command = typeof server.command === "string" && server.command.trim() ? server.command.trim() : null;
    const url = typeof server.url === "string" && server.url.trim() ? server.url.trim() : null;
    if (!command && !url) continue;
    const args = Array.isArray(server.args) ? server.args.filter((a): a is string => typeof a === "string") : [];
    const env = isRecord(server.env) ? Object.keys(server.env).filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) : [];
    out.push({ command, args, url, env });
  }
  return out;
}

/** The npm lifecycle names that run without anyone typing them (§4.3). */
const INSTALL_LIFECYCLE = ["preinstall", "install", "postinstall", "prepare", "prepublish"];

function lifecycleScripts(pkg: unknown): string[] {
  if (!isRecord(pkg)) return [];
  const scripts = pkg.scripts;
  if (!isRecord(scripts)) return [];
  return INSTALL_LIFECYCLE.filter((name) => typeof scripts[name] === "string" && scripts[name] !== "");
}

/**
 * `[build-system]` means pip builds this from source on install; a `[tool.x.build…]`
 * table means the backend has hooks of its own. Regex, not a TOML parser — §6.1.
 */
function pyprojectBuildHook(text: string): string | null {
  if (/^\s*\[build-system\]/m.test(text)) return "[build-system]";
  const tool = /^\s*\[(tool\.[a-z0-9_-]+\.build[a-z0-9_.-]*)\]/im.exec(text);
  return tool ? `[${tool[1]}]` : null;
}

/**
 * The `on:` triggers of a workflow, cheaply. Three forms: `on: push`, `on: [push, pr]`,
 * and a block of keys. Anything else yields nothing and the finding says "runs in CI".
 */
export function workflowTriggers(text: string): string[] {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = /^(?:["']?on["']?)\s*:\s*(.*)$/.exec(lines[i]);
    if (!match) continue;
    const inline = match[1].trim();
    if (inline.startsWith("[")) {
      return dedupe(
        inline
          .replace(/^\[|\].*$/g, "")
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean),
      );
    }
    if (inline && !inline.startsWith("#")) return [inline.replace(/\s*#.*$/, "").trim()].filter(Boolean);
    // Block form. Only the first child indent is a trigger; `branches:` under `push:` is
    // a filter on one, not a second one.
    const out: string[] = [];
    let childIndent = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const indent = line.length - line.trimStart().length;
      if (indent === 0) break;
      if (childIndent < 0) childIndent = indent;
      if (indent !== childIndent) continue;
      const key = /^\s*([a-z_][a-z0-9_-]*)\s*:/i.exec(line);
      if (key) out.push(key[1]);
    }
    return dedupe(out);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

function hostsIn(text: string): string[] {
  // A namespace declaration and an HTML comment are not network calls. Removing them
  // before the scan is cheaper and more honest than a proximity heuristic afterwards.
  let scannable = text;
  if (scannable.includes("<!--")) scannable = scannable.replace(HTML_COMMENT, " ");
  if (/xmlns|schemaLocation/i.test(scannable)) scannable = scannable.replace(XMLNS_ATTR, " ");

  const out: string[] = [];
  URL_LITERAL.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_LITERAL.exec(scannable)) !== null) {
    const host = hostFromAuthority(match[2], match[1].toLowerCase());
    if (host && !isNamespaceHost(host)) out.push(host);
  }
  KEYED_HOST_PORT.lastIndex = 0;
  while ((match = KEYED_HOST_PORT.exec(scannable)) !== null) {
    const host = hostFromAuthority(match[1], "");
    if (host && !isNamespaceHost(host)) out.push(host);
  }
  return dedupe(out);
}

function hostFromUrl(url: string): string | null {
  const match = /^(https?):\/\/([^\s/?#]+)/i.exec(url.trim());
  if (!match) return null;
  return hostFromAuthority(match[2], match[1].toLowerCase());
}

/**
 * Lowercase, credentials stripped, path and query dropped, port kept only when it is not
 * the scheme's default — `https://user:pw@API.Example.com:443/v1?k=1` is `api.example.com`.
 */
function hostFromAuthority(authority: string, scheme: string): string | null {
  let value = authority.split(/[/?#]/, 1)[0];
  const at = value.lastIndexOf("@");
  if (at >= 0) value = value.slice(at + 1);
  if (!value) return null;

  let host: string;
  let port = "";
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close < 0) return null;
    host = value.slice(0, close + 1);
    if (value[close + 1] === ":") port = value.slice(close + 2);
  } else {
    const colon = value.indexOf(":");
    if (colon >= 0) {
      host = value.slice(0, colon);
      port = value.slice(colon + 1);
    } else {
      host = value;
    }
  }

  host = host.toLowerCase().replace(/\.+$/, "");
  if (!isPlausibleHost(host)) return null;
  if (!/^\d{1,5}$/.test(port)) port = "";
  if ((scheme === "https" && port === "443") || (scheme === "http" && port === "80")) port = "";
  return port ? `${host}:${port}` : host;
}

function isPlausibleHost(host: string): boolean {
  if (!host || host.length > 253) return false;
  if (host.startsWith("[")) return /^\[[0-9a-f:.]{2,45}\]$/.test(host);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) return false;
  const labels = host.split(".");
  if (labels.length === 1) return true; // `localhost`, `redis`, an internal name.
  const tld = labels[labels.length - 1];
  return /^[a-z]{2,63}$/.test(tld);
}

/** §4.3: kept and labelled, never dropped. A local host is still a capability. */
function isLocalHost(hostPort: string): boolean {
  const host = hostPort.replace(/:\d+$/, "");
  if (host === "localhost" || host === "0.0.0.0" || host === "::1" || host === "[::1]") return true;
  return /^127\./.test(host) || /\.local$/.test(host) || /\.localhost$/.test(host);
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

function envNamesIn(path: string, text: string): string[] {
  const out: string[] = [];
  const push = (name: string | undefined) => {
    if (!name) return;
    if (!/^[A-Z][A-Z0-9_]+$/.test(name)) return;
    if (AMBIENT_ENV.has(name)) return;
    out.push(name);
  };

  let match: RegExpExecArray | null;
  PROCESS_ENV.lastIndex = 0;
  while ((match = PROCESS_ENV.exec(text)) !== null) push(match[1] ?? match[2]);
  PYTHON_ENV.lastIndex = 0;
  while ((match = PYTHON_ENV.exec(text)) !== null) push(match[1]);

  const base = baseName(path).toLowerCase();
  const isWorkflow = WORKFLOW_FILE.test(path);
  const isShell = SHELL_EXTENSION.test(path) || base === "makefile" || base === "justfile" || text.startsWith("#!");

  if (isShell || isWorkflow) {
    SHELL_ENV.lastIndex = 0;
    while ((match = SHELL_ENV.exec(text)) !== null) push(match[1] ?? match[2]);
  }
  if (isWorkflow) {
    GHA_SECRET.lastIndex = 0;
    while ((match = GHA_SECRET.exec(text)) !== null) push(match[1]);
    for (const name of yamlEnvKeys(text)) push(name);
  }
  return dedupe(out);
}

/** Keys of every `env:` mapping in a workflow. Names only — §4.3, the value is never ours. */
function yamlEnvKeys(text: string): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const header = /^(\s*)env\s*:\s*$/.exec(lines[i]);
    if (!header) continue;
    const base = header[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim()) continue;
      const indent = line.length - line.trimStart().length;
      if (indent <= base) break;
      const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line);
      if (key) out.push(key[1]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const RUN_NOUNS: Record<CapabilityRun["kind"], [string, string]> = {
  install_script: ["an install script", "install scripts"],
  build_hook: ["a build hook", "build hooks"],
  hook: ["a hook", "hooks"],
  mcp_server: ["an MCP server", "MCP servers"],
  workflow: ["a workflow", "workflows"],
  make: ["a makefile", "makefiles"],
  script: ["a script", "scripts"],
};

/** The exact sentence §4.3 fixes for an empty inventory. Do not reword without the PRD. */
export const EMPTY_CAPABILITIES_SUMMARY = "No tools, no hosts, no environment variables, nothing runs at install.";

/**
 * One sentence, clauses joined by `·`, only the non-empty ones — except the install
 * clause, which is always present because "nothing runs at install" is the claim buyers
 * came for and its absence would read as an omission rather than an answer.
 *
 * `install_script`/`build_hook` are left out of the "runs" clause: the install clause
 * already says they run, and saying it twice reads as two capabilities.
 */
function summarise(
  tools: { name: string; from: string }[],
  runs: CapabilityRun[],
  hosts: CapabilityHost[],
  env: { name: string; paths: string[] }[],
  installRuns: boolean,
): string {
  const codeHosts = hosts.filter((h) => h.from === "code").length;
  const docHosts = hosts.filter((h) => h.from === "docs").length;
  const otherRuns = runs.filter((r) => r.kind !== "install_script" && r.kind !== "build_hook");

  if (tools.length === 0 && runs.length === 0 && hosts.length === 0 && env.length === 0 && !installRuns) {
    return EMPTY_CAPABILITIES_SUMMARY;
  }

  const clauses: string[] = [];
  if (tools.length > 0) clauses.push(`Tools: ${nameList(dedupe(tools.map((t) => t.name)).sort())}`);
  if (otherRuns.length > 0) {
    const byKind = new Map<CapabilityRun["kind"], number>();
    for (const run of otherRuns) byKind.set(run.kind, (byKind.get(run.kind) ?? 0) + 1);
    const parts = [...byKind.entries()]
      .sort(([a], [b]) => RUN_RANK[a] - RUN_RANK[b])
      .map(([kind, n]) => (n === 1 ? RUN_NOUNS[kind][0] : `${n} ${RUN_NOUNS[kind][1]}`));
    clauses.push(`runs ${joinAnd(parts)}`);
  }
  if (codeHosts > 0) clauses.push(`talks to ${count(codeHosts, "host")}`);
  if (docHosts > 0) clauses.push(`links to ${count(docHosts, "host")} in its docs`);
  if (env.length > 0) clauses.push(`reads ${count(env.length, "environment variable")}`);
  clauses.push(installRuns ? "runs at install" : "nothing runs at install");
  return clauses.join(" · ");
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Up to eight names, then a count — a finding is a line, not a list. */
function nameList(names: string[]): string {
  if (names.length <= 8) return names.join(", ");
  return `${names.slice(0, 8).join(", ")} and ${names.length - 8} more`;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function truncate(value: string, max = 80): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A settings file with a trailing comma discloses nothing rather than guessing at
    // its contents with a regex; the check row still counts everything else.
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
