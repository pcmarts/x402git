/**
 * lib/scan/osv.ts — FR-35 dependency CVEs, via `POST https://api.osv.dev/v1/querybatch`.
 *
 * The package list comes from the manifests inside the snapshot itself — the commit being
 * sold — and GitHub's SBOM endpoint may only add packages they do not name (SCAN-2,
 * `dependencyInventory` in lib/scan/index.ts). The SBOM used to win whenever it was
 * non-empty, and it describes the default branch: it takes no ref.
 *
 * Two operational traps from Quality Signals §11.3 are handled:
 * - **A response may carry only a `next_page_token` and zero results**, meaning more
 *   data exists but was not found inside the server's time budget. A client that stops
 *   on an empty result set under-reports, so paging continues until the token is gone.
 * - **32 MiB response ceiling on HTTP/1.1.** Batches are kept small for that reason.
 *
 * `querybatch` returns ids only, so severity needs a second call per unique id. That
 * is capped: a repo with 400 distinct advisories is a fail on volume alone.
 *
 * **`MAL-` records are malware, not vulnerabilities** ("PRD Trust Report.md" §1(1), §6.1,
 * accepted 13 Sep 2026). OSV ingests `ossf/malicious-packages` as `MAL-…` records, and
 * those carry no CVSS vector and no severity word — so `severityOf` returned `UNKNOWN`,
 * and DECISIONS 2026-08-29 says `UNKNOWN` never blocks. A dependency OSV itself lists as
 * malware walked through the gate. The id is now the signal: `MAL-` is `CRITICAL` and
 * `malware: true` whatever the record's severity fields say, and `scanArtifact` puts it
 * on the `known_malware` check row as a blocking finding.
 */

import { osvTimeoutMs } from "@/lib/env";

export type OsvPackage = { name: string; version?: string; ecosystem: string };

export type OsvSeverity = "CRITICAL" | "HIGH" | "MODERATE" | "LOW" | "UNKNOWN";

export type OsvVulnerability = {
  id: string;
  package: string;
  ecosystem: string;
  version?: string;
  severity: OsvSeverity;
  summary?: string;
  cvss_score?: number;
  /**
   * True when the id is an `ossf/malicious-packages` record. The record is a statement
   * that the package *is* malware, not that it has a flaw, so it is a `known_malware`
   * finding at `CRITICAL` and it blocks.
   */
  malware: boolean;
  /**
   * Every other id this advisory is known by — the `aliases` array of the OSV record,
   * which is where GHSA↔CVE mapping lives. Kept so Socket's `cve`/`criticalCVE` alerts
   * ("PRD Trust Report.md" §6.2) de-duplicate against OSV by id rather than by package.
   * Absent when the detail lookup did not run (past `MAX_DETAIL_LOOKUPS`, or a 404).
   */
  aliases?: string[];
};

/**
 * An `ossf/malicious-packages` advisory. The prefix is the whole of the test: OSV mints
 * these ids itself (`MAL-2024-1234`) and no other database uses the prefix.
 */
export function isMalwareAdvisory(id: string): boolean {
  return id.startsWith("MAL-");
}

export const OSV_BATCH_URL = "https://api.osv.dev/v1/querybatch";
export const OSV_VULN_URL = "https://api.osv.dev/v1/vulns";

const BATCH_SIZE = 100;
const MAX_PAGES_PER_BATCH = 10;
const MAX_DETAIL_LOOKUPS = 200;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * W3.2 (DC): fetch with an `AbortController` timeout. A hung OSV must not hang the cut, and
 * a timeout is surfaced as an error (below) so the scan is recorded `incomplete`, never a
 * silent `pass`. The signal fires the same rejection path a network failure does.
 */
async function fetchWithTimeout(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`osv fetch timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Query OSV for every package. Returns one entry per (package, advisory) pair.
 *
 * W3.2 (DC): a network failure, timeout or non-200 is reported as an `error`, and the
 * caller (`scanArtifact`) treats that as an **incomplete** scan — the release is left
 * pending, never passed. The gap is auditable exactly as FR-38 screening does.
 */
export type QueryOsvOptions = {
  /**
   * Absolute epoch milliseconds the caller must be finished by (13 Sep 2026), and the clock
   * to read it against.
   *
   * The batch queries are the answer and are never truncated; the **detail lookups** are.
   * There can be {@link MAX_DETAIL_LOOKUPS} of them, one at a time, each with its own
   * timeout, and 200 × 20 s is longer than any handler this runs inside. When the deadline
   * is close the remaining ids keep their batch-level answer, which is `severity: "UNKNOWN"`
   * — the band DECISIONS 2026-08-29 says never blocks, so a truncated lookup can only ever
   * *under*-report, never fail a release on a guess. A `MAL-` id is still promoted to
   * CRITICAL and blocking, because that promotion is read off the **id** and has never
   * needed the record.
   */
  deadlineMs?: number;
  now?: () => number;
};

export async function queryOsv(
  packages: OsvPackage[],
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = osvTimeoutMs(),
  options: QueryOsvOptions = {},
): Promise<{ vulnerabilities: OsvVulnerability[]; error?: string }> {
  const queried = dedupePackages(packages);
  if (queried.length === 0) return { vulnerabilities: [] };
  const now = options.now ?? Date.now;

  const hits: { pkg: OsvPackage; id: string }[] = [];

  try {
    for (let start = 0; start < queried.length; start += BATCH_SIZE) {
      const chunk = queried.slice(start, start + BATCH_SIZE);
      const tokens: (string | undefined)[] = chunk.map(() => undefined);

      for (let page = 0; page < MAX_PAGES_PER_BATCH; page++) {
        const queries = chunk.map((pkg, i) => ({
          package: { name: pkg.name, ecosystem: pkg.ecosystem },
          ...(pkg.version ? { version: pkg.version } : {}),
          ...(tokens[i] ? { page_token: tokens[i] } : {}),
        }));
        // Only ask again for the entries that still have a page token.
        const active = page === 0 ? queries.map((_, i) => i) : queries.map((_, i) => i).filter((i) => tokens[i]);
        if (active.length === 0) break;

        const response = await fetchWithTimeout(
          fetchImpl,
          OSV_BATCH_URL,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ queries: active.map((i) => queries[i]) }),
          },
          timeoutMs,
        );
        if (!response.ok) throw new Error(`osv querybatch returned ${response.status}`);
        const body = (await response.json()) as { results?: { vulns?: { id: string }[]; next_page_token?: string }[] };

        const results = body.results ?? [];
        let anyToken = false;
        for (let r = 0; r < active.length; r++) {
          const index = active[r];
          const result = results[r];
          for (const vuln of result?.vulns ?? []) hits.push({ pkg: chunk[index], id: vuln.id });
          // §11.3: an empty page with a token still means "keep going".
          tokens[index] = result?.next_page_token;
          if (result?.next_page_token) anyToken = true;
        }
        if (!anyToken) break;
      }
    }
  } catch (e) {
    return { vulnerabilities: [], error: e instanceof Error ? e.message : String(e) };
  }

  const uniqueIds = [...new Set(hits.map((h) => h.id))].slice(0, MAX_DETAIL_LOOKUPS);
  const severities = new Map<string, OsvRecordDetail>();
  for (const id of uniqueIds) {
    // One lookup has to fit in what is left, or the rest of the list keeps the batch's own
    // answer. See {@link QueryOsvOptions.deadlineMs}: `UNKNOWN` does not block, and `MAL-`
    // is decided by the id below whatever this map holds.
    if (options.deadlineMs !== undefined && options.deadlineMs - now() < timeoutMs) break;
    severities.set(id, await vulnerabilitySeverity(id, fetchImpl, timeoutMs));
  }

  const vulnerabilities = hits.map(({ pkg, id }) => {
    const detail = severities.get(id);
    const malware = isMalwareAdvisory(id);
    return {
      id,
      package: pkg.name,
      ecosystem: pkg.ecosystem,
      version: pkg.version,
      // The id decides for `MAL-`: the detail lookup may have been capped, 404'd or —
      // the usual case — carried no severity at all, and none of those may downgrade a
      // malware record to `UNKNOWN`, which does not block.
      severity: malware ? "CRITICAL" : (detail?.severity ?? "UNKNOWN"),
      summary: detail?.summary,
      cvss_score: malware ? undefined : detail?.score,
      malware,
      ...(detail?.aliases && detail.aliases.length > 0 ? { aliases: detail.aliases } : {}),
    } satisfies OsvVulnerability;
  });

  return { vulnerabilities: dedupeVulns(vulnerabilities) };
}

/** What one `GET /v1/vulns/{id}` is read for. `aliases` is the de-duplication key. */
export type OsvRecordDetail = { severity: OsvSeverity; summary?: string; score?: number; aliases?: string[] };

type OsvRecord = {
  summary?: string;
  aliases?: string[];
  database_specific?: { severity?: string };
  severity?: { type?: string; score?: string }[];
  affected?: { database_specific?: { severity?: string } }[];
};

async function vulnerabilitySeverity(id: string, fetchImpl: FetchLike, timeoutMs: number = osvTimeoutMs()): Promise<OsvRecordDetail> {
  try {
    const response = await fetchWithTimeout(fetchImpl, `${OSV_VULN_URL}/${encodeURIComponent(id)}`, { headers: { accept: "application/json" } }, timeoutMs);
    if (!response.ok) return { severity: "UNKNOWN" };
    return severityOf((await response.json()) as OsvRecord);
  } catch {
    return { severity: "UNKNOWN" };
  }
}

/**
 * The severity of an OSV record: the advisory's own word first, CVSS second.
 *
 * This does *not* special-case `MAL-`, because it is handed a record and not an id — the
 * promotion to `CRITICAL` lives with `isMalwareAdvisory` at the one place both are known
 * (`queryOsv`, and `scanArtifact` for the check row).
 */
export function severityOf(record: OsvRecord): OsvRecordDetail {
  const stated = record.database_specific?.severity ?? record.affected?.find((a) => a.database_specific?.severity)?.database_specific?.severity;
  const vector = record.severity?.find((s) => s.type === "CVSS_V3" || s.type === "CVSS_V3_1")?.score;
  const score = vector ? cvss3BaseScore(vector) : undefined;
  const aliases = record.aliases?.filter((a) => typeof a === "string" && a.length > 0);

  const word = stated ? severityWord(stated) : null;
  if (word) return { severity: word, summary: record.summary, score, aliases };
  if (score !== undefined) return { severity: bandFor(score), summary: record.summary, score, aliases };
  return { severity: "UNKNOWN", summary: record.summary, aliases };
}

/**
 * The advisory's own word, normalised onto `OsvSeverity`. Databases disagree on the middle
 * band — GHSA says `MODERATE`, several CVE feeds say `MEDIUM` — and passing the raw word
 * through put a value outside the union onto `ScanFinding.severity`.
 */
function severityWord(value: string): OsvSeverity | null {
  const upper = value.toUpperCase();
  if (upper === "MEDIUM") return "MODERATE";
  return upper === "CRITICAL" || upper === "HIGH" || upper === "MODERATE" || upper === "LOW" ? upper : null;
}

export function bandFor(score: number): OsvSeverity {
  if (score >= 9) return "CRITICAL";
  if (score >= 7) return "HIGH";
  if (score >= 4) return "MODERATE";
  if (score > 0) return "LOW";
  return "UNKNOWN";
}

/**
 * CVSS v3.1 base score from a vector string. The formula is fixed and public, and
 * implementing it here avoids a dependency for forty lines of arithmetic.
 */
export function cvss3BaseScore(vector: string): number | undefined {
  const parts = new Map<string, string>();
  for (const segment of vector.split("/")) {
    const [key, value] = segment.split(":");
    if (key && value) parts.set(key, value);
  }
  const scope = parts.get("S");
  if (!scope) return undefined;
  const changed = scope === "C";

  const av = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }[parts.get("AV") ?? ""];
  const ac = { L: 0.77, H: 0.44 }[parts.get("AC") ?? ""];
  const pr = changed
    ? { N: 0.85, L: 0.68, H: 0.5 }[parts.get("PR") ?? ""]
    : { N: 0.85, L: 0.62, H: 0.27 }[parts.get("PR") ?? ""];
  const ui = { N: 0.85, R: 0.62 }[parts.get("UI") ?? ""];
  const weight = { H: 0.56, L: 0.22, N: 0 };
  const c = weight[(parts.get("C") ?? "") as keyof typeof weight];
  const i = weight[(parts.get("I") ?? "") as keyof typeof weight];
  const a = weight[(parts.get("A") ?? "") as keyof typeof weight];
  if ([av, ac, pr, ui, c, i, a].some((v) => v === undefined)) return undefined;

  const iscBase = 1 - (1 - c!) * (1 - i!) * (1 - a!);
  const impact = changed ? 7.52 * (iscBase - 0.029) - 3.25 * (iscBase - 0.02) ** 15 : 6.42 * iscBase;
  if (impact <= 0) return 0;
  const exploitability = 8.22 * av! * ac! * pr! * ui!;
  const raw = changed ? Math.min(1.08 * (impact + exploitability), 10) : Math.min(impact + exploitability, 10);
  return Math.ceil(raw * 10) / 10;
}

// --- package discovery ----------------------------------------------------------

/** A dependency file inside `node_modules/` or `vendor/` is somebody else's, not this repo's. */
const VENDORED = /(^|\/)(node_modules|vendor)\//;

/**
 * Does `packagesFromFiles` read this path? Exported because two other callers need the
 * *same* answer and must not re-derive it: `manifestFilesOf` below, which hands Socket the
 * step-1′ manifest set ("PRD Trust Report.md" §6.2), and the tests. One predicate, so the
 * files we parse ourselves and the files we upload can never drift apart.
 */
export function isManifestPath(path: string): boolean {
  if (VENDORED.test(path)) return false;
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return (
    base === "package.json" ||
    base === "package-lock.json" ||
    base === "requirements.txt" ||
    /^requirements[-.].*\.txt$/.test(base) ||
    base === "go.mod" ||
    base === "cargo.toml"
  );
}

/**
 * The subset of the snapshot's decoded text that is a dependency manifest — the fallback
 * body for Socket's `POST /full-scans` when the archive route cannot be used (§6.2 step 1′,
 * over 10,000 files). Insertion order is the snapshot's, which is path order.
 */
export function manifestFilesOf(textFiles: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, text] of textFiles) if (isManifestPath(path)) out.set(path, text);
  return out;
}

/**
 * Dependencies from the files inside the snapshot — the authority for the dependency scan
 * since SCAN-2, with the SBOM a supplement (`dependencyInventory`, lib/scan/index.ts).
 */
export function packagesFromFiles(textFiles: Map<string, string>): OsvPackage[] {
  const out: OsvPackage[] = [];

  for (const [path, text] of textFiles) {
    if (!isManifestPath(path)) continue;
    const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
    try {
      if (base === "package.json") out.push(...fromPackageJson(text));
      else if (base === "package-lock.json") out.push(...fromPackageLock(text));
      else if (base === "requirements.txt" || /^requirements[-.].*\.txt$/.test(base)) out.push(...fromRequirements(text));
      else if (base === "go.mod") out.push(...fromGoMod(text));
      else if (base === "cargo.toml") out.push(...fromCargoToml(text));
    } catch {
      // A malformed manifest is a creator problem, not a scanner crash.
    }
  }

  return dedupePackages(out);
}

function fromPackageJson(text: string): OsvPackage[] {
  const json = JSON.parse(text) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const out: OsvPackage[] = [];
  for (const block of [json.dependencies, json.devDependencies]) {
    for (const [name, range] of Object.entries(block ?? {})) {
      const version = exactVersion(range);
      out.push({ name, ecosystem: "npm", version });
    }
  }
  return out;
}

function fromPackageLock(text: string): OsvPackage[] {
  const json = JSON.parse(text) as { packages?: Record<string, { version?: string }>; dependencies?: Record<string, { version?: string }> };
  const out: OsvPackage[] = [];
  for (const [key, value] of Object.entries(json.packages ?? {})) {
    if (!key.startsWith("node_modules/")) continue;
    const name = key.slice("node_modules/".length).replace(/^.*node_modules\//, "");
    if (value?.version) out.push({ name, ecosystem: "npm", version: value.version });
  }
  for (const [name, value] of Object.entries(json.dependencies ?? {})) {
    if (value?.version) out.push({ name, ecosystem: "npm", version: value.version });
  }
  return out;
}

function fromRequirements(text: string): OsvPackage[] {
  const out: OsvPackage[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("-")) continue;
    const match = /^([A-Za-z0-9._-]+)\s*(?:\[[^\]]*\])?\s*(?:==\s*([A-Za-z0-9._!+-]+))?/.exec(trimmed);
    if (match) out.push({ name: match[1], ecosystem: "PyPI", version: match[2] });
  }
  return out;
}

function fromGoMod(text: string): OsvPackage[] {
  const out: OsvPackage[] = [];
  let inBlock = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (/^require\s*\($/.test(trimmed)) {
      inBlock = true;
      continue;
    }
    if (inBlock && trimmed === ")") {
      inBlock = false;
      continue;
    }
    const body = inBlock ? trimmed : /^require\s+(.*)$/.exec(trimmed)?.[1];
    if (!body) continue;
    const match = /^([^\s]+)\s+v([^\s/]+)/.exec(body);
    if (match) out.push({ name: match[1], ecosystem: "Go", version: match[2] });
  }
  return out;
}

function fromCargoToml(text: string): OsvPackage[] {
  const out: OsvPackage[] = [];
  let section = "";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const header = /^\[([^\]]+)\]$/.exec(trimmed);
    if (header) {
      section = header[1];
      continue;
    }
    if (!/^(dependencies|dev-dependencies|build-dependencies)$/.test(section)) continue;
    const inline = /^([A-Za-z0-9._-]+)\s*=\s*"([^"]+)"/.exec(trimmed);
    if (inline) {
      out.push({ name: inline[1], ecosystem: "crates.io", version: exactVersion(inline[2]) });
      continue;
    }
    const table = /^([A-Za-z0-9._-]+)\s*=\s*\{.*version\s*=\s*"([^"]+)"/.exec(trimmed);
    if (table) out.push({ name: table[1], ecosystem: "crates.io", version: exactVersion(table[2]) });
  }
  return out;
}

/** A range OSV can use only if it pins a version; `^1.2.3` does not. */
function exactVersion(range: string): string | undefined {
  const trimmed = range.trim();
  return /^\d+\.\d+(\.\d+)?([-+][0-9A-Za-z.-]+)?$/.test(trimmed) ? trimmed : undefined;
}

/**
 * One row per package, and **a pinned version beats no version** (fixed 2026-09-01).
 *
 * A versionless query is not a narrower question, it is a different one: OSV answers it
 * with every advisory ever filed against the package, at any version, forever. So a repo
 * that ships both a `package.json` (`"vite": "^7.3.6"` — a range, which `exactVersion`
 * cannot pin) and a `package-lock.json` (`vite@7.3.6` — exact) used to produce *two*
 * entries for vite, and the versionless one failed the release on advisories against
 * vite 2. That is every lockfile'd npm project in existence, and the finding it produced
 * was unfalsifiable: the creator upgrades, the advisory is still returned, the scan fails
 * again. `pcmarts/acl-recovery-tracker` v1.0.2 was cut with the commit message "Fix HIGH
 * dependency advisories" and failed for the second time on the same eight.
 *
 * Dropping the versionless duplicate loses nothing. It is the same dependency, read from
 * a weaker source; the lockfile says what is actually installed, which is what FR-35 is
 * asking about. A package named *only* in a range — no lockfile in the repo at all —
 * still gets its versionless query, because a vague answer there beats no answer — but
 * since 2026-10-15 a vague answer only discloses; it never blocks (`osvFinding`).
 */
export function dedupePackages(packages: OsvPackage[]): OsvPackage[] {
  const pinned = new Set<string>();
  for (const pkg of packages) {
    if (pkg.version) pinned.add(`${pkg.ecosystem}|${pkg.name}`);
  }

  const seen = new Map<string, OsvPackage>();
  for (const pkg of packages) {
    if (!pkg.name || !pkg.ecosystem || pkg.ecosystem === "unknown") continue;
    if (!pkg.version && pinned.has(`${pkg.ecosystem}|${pkg.name}`)) continue;
    const key = `${pkg.ecosystem}|${pkg.name}|${pkg.version ?? ""}`;
    if (!seen.has(key)) seen.set(key, pkg);
  }
  return [...seen.values()].sort((a, b) => (`${a.ecosystem}|${a.name}` < `${b.ecosystem}|${b.name}` ? -1 : 1));
}

function dedupeVulns(vulns: OsvVulnerability[]): OsvVulnerability[] {
  const seen = new Map<string, OsvVulnerability>();
  for (const vuln of vulns) {
    const key = `${vuln.id}|${vuln.ecosystem}|${vuln.package}|${vuln.version ?? ""}`;
    if (!seen.has(key)) seen.set(key, vuln);
  }
  return [...seen.values()];
}
