/**
 * lib/analysis — the manifest analyser (PRD §6, FR-10, FR-15, FR-47…53).
 *
 * §6 is the load-bearing claim: **no clone is needed for the manifest.**
 * `GET /repos/{o}/{r}/git/trees/{sha}?recursive=1` returns every path, blob size and
 * blob SHA in one call, which is file count, byte totals, the text/binary split, the
 * extension histogram, directory depth and blob-SHA originality. Add `languages`,
 * `readme`, `license`, `releases`, the owner's public profile and the SBOM endpoint —
 * plus `compare` on an update — and the whole manifest costs about eight REST calls. The tarball is fetched once, for the
 * snapshot, which is also when the scan runs.
 *
 * Nothing here executes creator code (NG6) and nothing shells out to a binary — the
 * function runtime has no Go toolchain and would not be given one (FR-35).
 *
 * Two-phase by design:
 *   `analyze()`          the REST half, before the tarball exists
 *   `composeComputed()`  the `Manifest.computed` block, once the snapshot and scan are in
 */

import { narrowOwner, narrowRepo } from "@/lib/github/profile";
import type { ManifestComputedOutput, ManifestOwnerOutput, ManifestRepoMetaOutput } from "@/lib/schemas/manifest";
import type { DiffSummaryOutput } from "@/lib/schemas/releases";
import { type Cadence, cadence } from "./cadence";
import { type Classification, bucketsTouched, classify } from "./classify";
import { depthOf, extensionOf, isLicenceFile, isTextPath } from "./files";
import { renderMarkdown } from "./markdown";
import { assetCollector, directoryOf, linkResolver } from "./readme-assets";
import type { OriginalityResult } from "./originality";

export * from "./cadence";
export * from "./classify";
export * from "./files";
export * from "./markdown";
export * from "./originality";
export * from "./readme-assets";

/** PRD §6 caps. Exceeding either is `repo_too_large` (§9). */
export const MAX_FILES = 20_000;
export const MAX_EXTRACTED_BYTES = 200 * 1024 * 1024;

export class RepoTooLargeError extends Error {
  readonly code = "repo_too_large" as const;
  constructor(
    message: string,
    readonly limit: "files" | "bytes",
    readonly observed: number,
  ) {
    super(message);
    this.name = "RepoTooLargeError";
  }
}

/**
 * The slice of Octokit this module uses. Structural so a test passes a plain object
 * and never touches the network.
 */
export type OctokitLike = {
  request: (route: string, params?: Record<string, unknown>) => Promise<{ data: any; status?: number; headers?: Record<string, unknown> }>;
};

export type AnalyzeInput = {
  owner: string;
  repo: string;
  /** Tag, branch or sha. Defaults to the repository's default branch. */
  ref?: string;
  /** The previous release's commit, for the `compare` call behind `diff_summary` (FR-15). */
  previousCommitSha?: string | null;
  /**
   * The commit `ref` already resolves to. The pipeline resolves it before inserting the
   * `pending` release row (`commit_sha` is `NOT NULL`), so passing it here saves the
   * second identical lookup.
   */
  resolvedCommitSha?: string;
  /**
   * Timestamps of this listing's earlier releases on the platform. Merged with
   * GitHub's release list so a repo that tags without publishing releases still has
   * an honest cadence (QS §4).
   */
  priorReleaseDates?: string[];
  /**
   * Where a README image the creator referenced by a relative path will be served from:
   * `/api/label/:owner/:slug/asset`. Given, relative images are rewritten to it and
   * their paths come back on `readme_assets` for the snapshot to keep. Absent — a repo
   * analysed outside a listing, or a test — every relative image stays markdown source,
   * which is what it was before 2026-08-30 (FR-49).
   */
  assetBase?: string | null;
};

export type TreeBlob = { path: string; size: number; sha: string };

export type RepoFacts = {
  default_branch: string;
  size_kb: number;
  pushed_at: string | null;
  open_issues: number;
  archived: boolean;
  private: boolean;
  description: string | null;
};

/**
 * GitHub's dependency graph for the repository's **default branch** — the SBOM endpoint takes
 * no ref, so this is the one result in `RepoAnalysis` not pinned to `commit_sha`. `branch` says
 * which branch it describes. SCAN-2: it is never the source of truth for the dependency scan;
 * `dependencyInventory` (lib/scan) reads the snapshot's own manifests and lets this add only
 * packages they do not name.
 */
export type SbomResult = {
  packages: { name: string; version?: string; ecosystem: string; purl?: string }[];
  /** The branch the graph describes: the default branch at the time of the call. */
  branch?: string;
  error?: string;
};

export type RepoAnalysis = {
  owner: string;
  repo: string;
  git_ref: string;
  commit_sha: string;
  facts: RepoFacts;
  /**
   * The repository's own GitHub metadata — homepage, topics, language, dates, counts.
   * Persisted into `Manifest.computed.repo_meta` so a release keeps its context after
   * the installation is gone. Not a computed signal: nothing derives from it.
   */
  repo_meta: ManifestRepoMetaOutput | null;
  /** The creator's public GitHub profile, from the one extra best-effort call below. */
  owner_profile: ManifestOwnerOutput | null;
  tree: TreeBlob[];
  /** GitHub truncates a very large tree; the manifest says so rather than lying. */
  tree_truncated: boolean;
  file_count: number;
  dir_depth: number;
  bytes_text: number;
  bytes_binary: number;
  extensions: Record<string, number>;
  languages: Record<string, number>;
  readme_html: string | null;
  readme_path: string | null;
  /**
   * FR-49: repository-relative image paths the README references, in document order,
   * capped at 20. The pipeline keeps exactly these files out of the snapshot and copies
   * them into the public `readme-assets` bucket; `readme_html` already points at them.
   */
  readme_assets: string[];
  licence_spdx: string | null;
  licence_key: string | null;
  has_licence_file: boolean;
  releases: { tag: string; published_at: string | null; name: string | null; body: string | null }[];
  cadence: Cadence;
  sbom: SbomResult;
  diff_summary: DiffSummaryOutput | null;
  /** Non-fatal failures, so the manifest can say what it could not compute. */
  warnings: string[];
};

/**
 * The ~8 REST calls of §6. Every optional call is best effort: a repo with no README,
 * no licence file, no releases and no SBOM still gets a manifest, and the reason each
 * one is missing lands in `warnings` rather than failing the release.
 */
export async function analyze(octokit: OctokitLike, input: AnalyzeInput): Promise<RepoAnalysis> {
  const { owner, repo } = input;
  const warnings: string[] = [];

  // 1. The repository itself — default branch, size, cadence inputs (FR-10).
  const { data: repoData } = await octokit.request("GET /repos/{owner}/{repo}", { owner, repo });
  const repoFacts: RepoFacts = {
    default_branch: repoData.default_branch ?? "main",
    size_kb: Number(repoData.size ?? 0),
    pushed_at: repoData.pushed_at ?? null,
    open_issues: Number(repoData.open_issues_count ?? 0),
    archived: !!repoData.archived,
    private: !!repoData.private,
    description: repoData.description ?? null,
  };

  // The same payload, narrowed for the manifest and the product page. Free: this is
  // call 1's answer, not a second request.
  const repoMeta = narrowRepo(repoData);

  const ref = input.ref && input.ref.length > 0 ? input.ref : repoFacts.default_branch;

  // 2. Resolve the ref to a commit. Everything after this is pinned to one sha, so a
  //    push mid-analysis cannot produce a manifest describing two different trees.
  let commitSha = input.resolvedCommitSha ?? "";
  if (!commitSha) {
    const { data: commitData } = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", { owner, repo, ref });
    commitSha = commitData.sha;
  }

  // 3. The whole tree in one call (§6).
  const { data: treeData } = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
    owner,
    repo,
    tree_sha: commitSha,
    recursive: "1",
  });

  const tree: TreeBlob[] = [];
  for (const entry of treeData.tree ?? []) {
    if (entry.type !== "blob") continue;
    if (entry.path === ".git" || entry.path?.startsWith(".git/")) continue;
    tree.push({ path: entry.path, size: Number(entry.size ?? 0), sha: entry.sha });
  }
  if (treeData.truncated) warnings.push("tree_truncated");

  assertWithinCaps(tree);

  let bytesText = 0;
  let bytesBinary = 0;
  let maxDepth = 0;
  const extensions: Record<string, number> = {};
  for (const blob of tree) {
    if (isTextPath(blob.path)) bytesText += blob.size;
    else bytesBinary += blob.size;
    maxDepth = Math.max(maxDepth, depthOf(blob.path));
    const ext = extensionOf(blob.path) || "(none)";
    extensions[ext] = (extensions[ext] ?? 0) + 1;
  }

  // 4. Languages.
  const languages = await best(octokit, "GET /repos/{owner}/{repo}/languages", { owner, repo }, warnings, "languages");
  const languageBytes: Record<string, number> = {};
  for (const [name, bytes] of Object.entries(languages ?? {})) languageBytes[name] = Number(bytes);

  // 5. README, rendered here rather than in the browser (§14.1).
  const readme = await best(octokit, "GET /repos/{owner}/{repo}/readme", { owner, repo, ref: commitSha }, warnings, "readme");
  let readmeHtml: string | null = null;
  let readmePath: string | null = null;
  let readmeAssets: string[] = [];
  if (readme?.content) {
    readmePath = readme.path ?? "README.md";
    const readmeDir = directoryOf(readmePath);
    // One pass rewrites the `src` attributes and records which files the snapshot has to
    // keep. Two passes would be two chances for the markup and the list to disagree.
    const assets = assetCollector({ readmeDir, assetBase: input.assetBase ?? null });
    readmeHtml = renderMarkdown(decodeBase64(readme.content), {
      imageSrc: assets.resolve,
      // A relative link resolves to the repository on GitHub when the repository is
      // public, and to nothing when it is not — a link that 404s for everyone but the
      // owner is worse than the words, which is the rule About already follows.
      linkHref: linkResolver({ repoHtmlUrl: repoMeta?.html_url ?? null, ref: commitSha, readmeDir }),
    });
    readmeAssets = assets.paths();
  }

  // 6. Licence (FR-11). The gate itself lives in lib/licence.ts.
  const licence = await best(octokit, "GET /repos/{owner}/{repo}/license", { owner, repo, ref: commitSha }, warnings, "license");
  const licenceSpdx: string | null = licence?.license?.spdx_id ?? null;
  const licenceKey: string | null = licence?.license?.key ?? null;

  // 7. Releases, for the cadence sentence (FR-49, QS §4).
  const releaseList = await best(octokit, "GET /repos/{owner}/{repo}/releases", { owner, repo, per_page: 10 }, warnings, "releases");
  const releases = (releaseList ?? [])
    .filter((r: any) => !r.draft)
    .map((r: any) => ({
      tag: r.tag_name as string,
      published_at: (r.published_at ?? r.created_at ?? null) as string | null,
      name: (r.name ?? null) as string | null,
      body: (r.body ?? null) as string | null,
    }));

  const publishedAt = [...releases.map((r: { published_at: string | null }) => r.published_at).filter(Boolean), ...(input.priorReleaseDates ?? [])] as string[];
  const cadenceResult = cadence({
    publishedAt: [...new Set(publishedAt)],
    finished: {
      stable: releases.length > 0 && isStableTag(releases[0].tag),
      hasReadme: readmeHtml !== null,
      hasTests: tree.some((b) => /(^|\/)(tests?|__tests__|spec)(\/|$)/i.test(b.path) || /\.(test|spec)\.[a-z0-9]+$/i.test(b.path)),
      openIssues: repoFacts.open_issues,
      archived: repoFacts.archived,
    },
  });

  // 7b. The creator's public profile. One extra best-effort call, and the only one in
  //     this module that is about a person rather than a repository — the product page
  //     reads it live and falls back to this copy (lib/web/github-profile.ts).
  const ownerLogin = repoMeta?.full_name?.includes("/") ? repoMeta.full_name.split("/")[0] : owner;
  const ownerData = await best(octokit, "GET /users/{username}", { username: ownerLogin }, warnings, "owner_profile");
  const ownerProfile = ownerData ? narrowOwner(ownerData, ownerLogin) : null;

  // 8. SBOM. §14.4: 100/hour per installation, shared with Rail B, so this runs on
  //    release only and the result is cached on the release row. Never a hard failure.
  //    It describes the default branch, not `commitSha` (SCAN-2) — see `SbomResult`.
  const sbom = await loadSbom(octokit, owner, repo, repoFacts.default_branch, warnings);

  // 9. Compare against the previous release, for `diff_summary` (FR-15).
  const diffSummary = input.previousCommitSha ? await loadDiff(octokit, owner, repo, input.previousCommitSha, commitSha, warnings) : null;

  return {
    owner,
    repo,
    git_ref: ref,
    commit_sha: commitSha,
    facts: repoFacts,
    repo_meta: repoMeta,
    owner_profile: ownerProfile,
    tree,
    tree_truncated: !!treeData.truncated,
    file_count: tree.length,
    dir_depth: maxDepth,
    bytes_text: bytesText,
    bytes_binary: bytesBinary,
    extensions,
    languages: languageBytes,
    readme_html: readmeHtml,
    readme_path: readmePath,
    readme_assets: readmeAssets,
    licence_spdx: licenceSpdx,
    licence_key: licenceKey,
    has_licence_file: tree.some((b) => isLicenceFile(b.path)),
    releases,
    cadence: cadenceResult,
    sbom,
    diff_summary: diffSummary,
    warnings,
  };
}

/** §6 / §9: the caps are checked before anything is downloaded. */
export function assertWithinCaps(tree: TreeBlob[]): void {
  if (tree.length > MAX_FILES) {
    throw new RepoTooLargeError(`Repository has ${tree.length} files; the cap is ${MAX_FILES}.`, "files", tree.length);
  }
  let total = 0;
  for (const blob of tree) total += blob.size;
  if (total > MAX_EXTRACTED_BYTES) {
    throw new RepoTooLargeError(`Repository is ${total} bytes extracted; the cap is ${MAX_EXTRACTED_BYTES}.`, "bytes", total);
  }
}

// --- composing Manifest.computed ------------------------------------------------

export type ComposeInput = {
  analysis: RepoAnalysis;
  /** Paths and text from the snapshot: the artifact class is computed from what we sell. */
  classification: Classification;
  licence: { spdx?: string | null; verdict: "pass" | "manual" | "block" };
  /**
   * FR-37, widened 13 Sep 2026 by "PRD Trust Report.md" §4.2: the badge became the trust
   * report, so this block became the whole of `computed.scan`.
   *
   * Typed off the manifest schema rather than restated, because the manifest is the
   * contract and a second copy of its field list here is how the two start disagreeing.
   * Everything past the original three fields is optional in that schema, so the pipeline
   * lights the new rows up by passing `publicChecks(report)`, `publicFindings(report)`,
   * `report.capabilities`, `report.counts` and `report.advisories_refreshed_at` — and
   * every caller that does not yet still compiles and still produces a valid manifest.
   */
  scan: ManifestComputedOutput["scan"];
  originality?: OriginalityResult;
  /**
   * FR-49: README image path → its object in the public `readme-assets` bucket. Written
   * by the pipeline after the snapshot, because until the files have been uploaded there
   * is nothing to point at. Absent means the README references no relative images, or
   * the upload failed — either way the page renders the README without them rather than
   * with broken ones.
   */
  readmeAssets?: Record<string, string>;
  analyzerVersion: string;
  computedAt?: string;
};

/**
 * FR-52: every computed number carries when it was computed and by which analyzer,
 * and none of it is editable by the creator. The manifest never gates a computed
 * field on a simplicity condition — a two-file Prompt gets the same fields as a System.
 */
export function composeComputed(input: ComposeInput): ManifestComputedOutput {
  const { analysis, classification } = input;
  const computedAt = input.computedAt ?? new Date().toISOString();

  return {
    artifact_class: classification.artifact_class,
    component_inventory: classification.inventory,
    file_count: analysis.file_count,
    dir_depth: analysis.dir_depth,
    bytes_text: analysis.bytes_text,
    bytes_binary: analysis.bytes_binary,
    languages: analysis.languages,
    tree: analysis.tree.map((b) => ({ path: b.path, size: b.size, binary: !isTextPath(b.path) })),
    readme_html: analysis.readme_html,
    readme_assets: input.readmeAssets && Object.keys(input.readmeAssets).length > 0 ? input.readmeAssets : undefined,
    dependencies: analysis.sbom.packages.map((p) => ({ name: p.name, version: p.version, ecosystem: p.ecosystem })),
    licence: { spdx: input.licence.spdx ?? undefined, verdict: input.licence.verdict },
    scan: input.scan,
    cadence_sentence: analysis.cadence.sentence,
    originality: input.originality,
    engineering: {
      unique_5gram_ratio: classification.metrics.unique_5gram_ratio,
      type_token_ratio: classification.metrics.type_token_ratio,
      effective_code_lines: classification.metrics.effective_code_lines,
      effective_doc_words: classification.metrics.effective_doc_words,
      code_files: classification.metrics.code_files,
      test_files: classification.metrics.test_files,
      padding_suspected: classification.metrics.padding_suspected,
      class_note: classification.guard_note,
    },
    cadence: {
      releases: analysis.cadence.releases,
      median_days_between_releases: analysis.cadence.median_days_between_releases,
      on_time_fraction: analysis.cadence.on_time_fraction,
      days_since_last: analysis.cadence.days_since_last,
      score: analysis.cadence.score,
      finished: analysis.cadence.finished,
    },
    inventory_sentence: classification.inventory_sentence,
    extensions: analysis.extensions,
    lines_of_code: classification.metrics.code_lines,
    warnings: analysis.warnings,
    repo_meta: analysis.repo_meta ?? undefined,
    owner: analysis.owner_profile ?? undefined,
    computed_at: computedAt,
    analyzer_version: input.analyzerVersion,
  };
}

/** Convenience for the pipeline: classify the snapshot's contents. */
export function classifySnapshot(paths: string[], textFiles: Map<string, string>): Classification {
  return classify({ allPaths: paths, textFiles });
}

// --- helpers ---------------------------------------------------------------------

async function best(
  octokit: OctokitLike,
  route: string,
  params: Record<string, unknown>,
  warnings: string[],
  label: string,
): Promise<any | null> {
  try {
    const { data } = await octokit.request(route, params);
    return data;
  } catch (e) {
    warnings.push(`${label}_unavailable`);
    return null;
  }
}

/**
 * `GET /repos/{o}/{r}/dependency-graph/sbom` has no `ref` parameter: the graph is the default
 * branch's, whatever ref is being released. SCAN-2 (red team 21 Sep 2026) was this list being
 * handed to OSV as the whole truth — tag a dirty branch, keep `main` clean, and `known_malware`
 * passed. It is now a supplement only (`dependencyInventory`, lib/scan/index.ts), and the
 * result carries the branch it describes.
 */
async function loadSbom(octokit: OctokitLike, owner: string, repo: string, branch: string, warnings: string[]): Promise<SbomResult> {
  try {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/dependency-graph/sbom", { owner, repo });
    const packages = (data?.sbom?.packages ?? [])
      .map((pkg: any) => {
        const purl: string | undefined = (pkg.externalRefs ?? []).find((r: any) => r.referenceType === "purl")?.referenceLocator;
        return {
          name: String(pkg.name ?? "").replace(/^[^:]+:/, ""),
          version: pkg.versionInfo && pkg.versionInfo !== "NOASSERTION" ? String(pkg.versionInfo) : undefined,
          ecosystem: ecosystemFromPurl(purl) ?? ecosystemFromSpdxName(String(pkg.name ?? "")),
          purl,
        };
      })
      .filter((p: { name: string }) => p.name.length > 0);
    return { packages, branch };
  } catch (e) {
    warnings.push("sbom_unavailable");
    return { packages: [], branch, error: e instanceof Error ? e.message : String(e) };
  }
}

async function loadDiff(
  octokit: OctokitLike,
  owner: string,
  repo: string,
  base: string,
  head: string,
  warnings: string[],
): Promise<DiffSummaryOutput | null> {
  try {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", { owner, repo, basehead: `${base}...${head}` });
    const files = (data.files ?? []) as { filename: string; status: string; additions?: number; deletions?: number }[];
    let added = 0;
    let changed = 0;
    let removed = 0;
    let additions = 0;
    let deletions = 0;
    for (const file of files) {
      if (file.status === "added") added++;
      else if (file.status === "removed") removed++;
      else changed++;
      additions += Number(file.additions ?? 0);
      deletions += Number(file.deletions ?? 0);
    }
    return {
      files_added: added,
      files_changed: changed,
      files_removed: removed,
      additions,
      deletions,
      components_touched: bucketsTouched(files.map((f) => f.filename)),
    };
  } catch {
    warnings.push("compare_unavailable");
    return null;
  }
}

function ecosystemFromPurl(purl: string | undefined): string | null {
  if (!purl) return null;
  const match = /^pkg:([^/]+)\//.exec(purl);
  if (!match) return null;
  return PURL_TO_OSV[match[1].toLowerCase()] ?? match[1];
}

function ecosystemFromSpdxName(name: string): string {
  const prefix = name.includes(":") ? name.slice(0, name.indexOf(":")).toLowerCase() : "";
  return PURL_TO_OSV[prefix] ?? "unknown";
}

/** purl type → OSV ecosystem name, for the OSV batch query (FR-35). */
export const PURL_TO_OSV: Record<string, string> = {
  npm: "npm",
  pypi: "PyPI",
  golang: "Go",
  go: "Go",
  cargo: "crates.io",
  crates: "crates.io",
  gem: "RubyGems",
  rubygems: "RubyGems",
  maven: "Maven",
  nuget: "NuGet",
  composer: "Packagist",
  hex: "Hex",
  pub: "Pub",
  actions: "GitHub Actions",
};

function isStableTag(tag: string): boolean {
  const version = tag.replace(/^v/i, "");
  const major = Number.parseInt(version.split(".")[0] ?? "0", 10);
  return Number.isFinite(major) && major >= 1;
}

function decodeBase64(content: string): string {
  return Buffer.from(content.replace(/\s/g, ""), "base64").toString("utf8");
}
