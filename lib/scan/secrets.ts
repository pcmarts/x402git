/**
 * lib/scan/secrets.ts — FR-35 secret detection, in process.
 *
 * §11 and FR-35 both rule out the obvious implementation: gitleaks is a Go binary and
 * there is no Go toolchain in a Vercel function, nor would we add one — NG6 says
 * nothing untrusted executes anywhere near a secret. So the rules are ported, not
 * shelled out to: a subset of the gitleaks default ruleset expressed as regexes and
 * run over the decoded text of the snapshot we are about to sell.
 *
 * Two properties matter more than coverage:
 *
 * 1. **A finding never carries the secret.** Rule id, path, line and a length. The scan
 *    report is stored on the release row and is visible to operators; a report that
 *    quotes the key has leaked it a second time.
 * 2. **Our own prefix is a rule.** FR-4 and §14.7: one of our own keys found in a repo
 *    is revoked, not merely reported. Since FR-60 that means both kinds — the agent key
 *    (`x4c_live_…`) and the session key (`x4s_live_…`, "PRD Session Keys.md" D14) — and a
 *    hit on an agent key also kills that creator's web sessions (FR-57). The caller wires
 *    that up; this module only says which rule fired.
 *
 * The generic assignment rule is entropy-gated because `api_key = "your-key-here"` is
 * the single most common line in a README and is not a finding.
 */

export type SecretRule = {
  id: string;
  description: string;
  pattern: RegExp;
  /** Capture group holding the secret itself, for the entropy gate. */
  valueGroup?: number;
  /** Minimum Shannon entropy of the captured value, in bits per character. */
  minEntropy?: number;
};

/** Placeholder values that are documentation, not credentials. */
const PLACEHOLDER =
  /^(?:x{3,}|\.{3,}|<.*>|\$\{.*\}|\{\{.*\}\}|%[a-z_]+%|(?:your|my|the|example|sample|test|dummy|fake|placeholder|redacted|changeme|todo|none|null|nil|abc|foo|bar)[-_a-z0-9]*|[a-z0-9]*(?:here|goes_here|example|placeholder|redacted)|(.)\1{7,})$/i;

/**
 * FR-60: both creator credentials, one shape — `x4[cs]_live_` + 32 base62. `x4c_` is the
 * long-lived agent key, `x4s_` a browser session's key; finding either in a repository
 * revokes it (FR-4), and an agent-key hit takes the creator's sessions with it (FR-57).
 *
 * The session *cookie* is separately named `x4s` (`x4s.<payload>.<mac>`) — a different
 * thing sharing a stem, and one this pattern cannot match, because it requires `_live_`.
 *
 * Shared as a source string rather than a RegExp: a `/g` regex carries `lastIndex`, so the
 * rule below and `ownApiKeysIn` need their own instances, and two hand-written copies are
 * two places to forget when a prefix changes.
 */
const OWN_KEY_PATTERN = String.raw`\b(x4[cs]_live_[0-9A-Za-z]{32})\b`;

/**
 * A subset of the gitleaks default ruleset. Providers were chosen by blast radius:
 * cloud credentials, source-forge tokens, payment keys, chat webhooks, model-provider
 * keys, and any private key block.
 */
export const RULES: SecretRule[] = [
  {
    id: "aws-access-key-id",
    description: "AWS access key id",
    pattern: /\b((?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16})\b/g,
    valueGroup: 1,
  },
  {
    id: "aws-secret-access-key",
    description: "AWS secret access key",
    pattern: /(?:aws)?_?(?:secret)_?(?:access)?_?key["'\s]*[:=]\s*["']([A-Za-z0-9/+=]{40})["']/gi,
    valueGroup: 1,
    minEntropy: 3.5,
  },
  { id: "github-pat", description: "GitHub personal access token", pattern: /\b(ghp_[0-9A-Za-z]{36})\b/g, valueGroup: 1 },
  { id: "github-oauth", description: "GitHub OAuth token", pattern: /\b(gho_[0-9A-Za-z]{36})\b/g, valueGroup: 1 },
  { id: "github-app-token", description: "GitHub App installation token", pattern: /\b((?:ghu|ghs)_[0-9A-Za-z]{36})\b/g, valueGroup: 1 },
  { id: "github-refresh-token", description: "GitHub refresh token", pattern: /\b(ghr_[0-9A-Za-z]{36})\b/g, valueGroup: 1 },
  {
    id: "github-fine-grained-pat",
    description: "GitHub fine-grained personal access token",
    pattern: /\b(github_pat_[0-9A-Za-z_]{70,90})\b/g,
    valueGroup: 1,
  },
  {
    // FR-4: our own credential. Finding it revokes it — either kind (FR-60).
    id: "x402git-api-key",
    description: "X402 Git creator API key (agent or session)",
    pattern: new RegExp(OWN_KEY_PATTERN, "g"),
    valueGroup: 1,
  },
  { id: "slack-token", description: "Slack token", pattern: /\b(xox[baprs]-[0-9A-Za-z-]{10,72})\b/g, valueGroup: 1 },
  {
    id: "slack-webhook",
    description: "Slack incoming webhook",
    pattern: /(https:\/\/hooks\.slack\.com\/(?:services|workflows)\/[A-Za-z0-9+/]{40,})/g,
    valueGroup: 1,
  },
  { id: "stripe-secret-key", description: "Stripe secret key", pattern: /\b((?:sk|rk)_(?:live|test)_[0-9A-Za-z]{24,99})\b/g, valueGroup: 1 },
  { id: "google-api-key", description: "Google API key", pattern: /\b(AIza[0-9A-Za-z_-]{35})\b/g, valueGroup: 1 },
  { id: "sendgrid-api-key", description: "SendGrid API key", pattern: /\b(SG\.[0-9A-Za-z_-]{20,24}\.[0-9A-Za-z_-]{39,45})\b/g, valueGroup: 1 },
  { id: "npm-access-token", description: "npm access token", pattern: /\b(npm_[0-9A-Za-z]{36})\b/g, valueGroup: 1 },
  { id: "openai-api-key", description: "OpenAI API key", pattern: /\b(sk-(?:proj-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,})\b/g, valueGroup: 1 },
  { id: "anthropic-api-key", description: "Anthropic API key", pattern: /\b(sk-ant-[A-Za-z0-9_-]{40,150})\b/g, valueGroup: 1 },
  {
    id: "private-key",
    description: "Private key block",
    pattern: /-----BEGIN\s+(?:RSA|DSA|EC|OPENSSH|PGP|ENCRYPTED)?\s*PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    id: "generic-api-key",
    description: "High-entropy credential assignment",
    pattern:
      /(?:api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|private[_-]?token|password|passwd)["'\s]*[:=]\s*["']([A-Za-z0-9+/=_.~-]{16,120})["']/gi,
    valueGroup: 1,
    minEntropy: 3.5,
  },
];

export type SecretFinding = {
  rule_id: string;
  description: string;
  path: string;
  /** 1-based. */
  line: number;
  /** Length of the matched credential, never the credential. */
  match_length: number;
  entropy?: number;
};

export type ScanSecretsOptions = {
  /** Skip files whose contents are machine-generated noise; they only produce noise. */
  skip?: (path: string) => boolean;
  /** Cap on findings, so a generated file cannot produce a megabyte of report. */
  maxFindings?: number;
};

const DEFAULT_MAX_FINDINGS = 500;

/**
 * Lockfiles only: their hashes are hashes, not credentials, and none of the keyed rules
 * match their field names anyway. Nothing else is skipped — `dist/`, `vendor/`,
 * `node_modules/` and minified bundles *ship in the snapshot*, so a credential there is
 * exactly as sold as one in `src/`, and the "scanned clean" badge must cover the bytes
 * the buyer actually receives.
 */
export function isNoiseFile(path: string): boolean {
  const lower = path.toLowerCase();
  return /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|cargo\.lock|composer\.lock|gemfile\.lock|go\.sum)$/.test(lower);
}

/** Run the ruleset over decoded text. Deterministic and order-stable. */
export function scanSecrets(textFiles: Map<string, string>, options: ScanSecretsOptions = {}): SecretFinding[] {
  const skip = options.skip ?? isNoiseFile;
  const max = options.maxFindings ?? DEFAULT_MAX_FINDINGS;
  const findings: SecretFinding[] = [];

  for (const path of [...textFiles.keys()].sort()) {
    if (skip(path)) continue;
    const lines = (textFiles.get(path) ?? "").split("\n");
    for (let index = 0; index < lines.length; index++) {
      // The whole line, however long: a minified bundle is one line, and a credential
      // past any truncation point would ship under a "scanned clean" badge.
      const line = lines[index];
      for (const rule of RULES) {
        rule.pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = rule.pattern.exec(line)) !== null) {
          const value = rule.valueGroup ? match[rule.valueGroup] : match[0];
          if (!value) break;
          if (rule.valueGroup && PLACEHOLDER.test(value)) continue;
          const entropy = shannonEntropy(value);
          if (rule.minEntropy !== undefined && entropy < rule.minEntropy) continue;
          findings.push({
            rule_id: rule.id,
            description: rule.description,
            path,
            line: index + 1,
            match_length: value.length,
            entropy: rule.minEntropy !== undefined ? round2(entropy) : undefined,
          });
          if (findings.length >= max) return findings;
          if (!rule.pattern.global) break;
        }
      }
    }
  }

  return findings;
}

/** Shannon entropy in bits per character. Gitleaks' own gate, same units. */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * FR-4: the plaintext keys of our own that were found, so the caller can revoke them.
 * Returned separately from the findings, which never carry a value. Both kinds (FR-60):
 * a leaked session key is revoked exactly as a leaked agent key is.
 */
export function ownApiKeysIn(textFiles: Map<string, string>): string[] {
  const pattern = new RegExp(OWN_KEY_PATTERN, "g");
  const keys = new Set<string>();
  for (const text of textFiles.values()) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) keys.add(match[1]);
  }
  return [...keys];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
