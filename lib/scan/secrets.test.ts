import { describe, expect, it } from "vitest";
import { isNoiseFile, ownApiKeysIn, scanSecrets, shannonEntropy } from "./secrets";

const files = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe("secret detection (FR-35)", () => {
  it("finds an AWS access key id", () => {
    const findings = scanSecrets(files({ "deploy.sh": 'export AWS_ACCESS_KEY_ID="AKIA2E0A8F3B244C9986"' }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule_id: "aws-access-key-id", path: "deploy.sh", line: 1 });
  });

  it("suppresses AWS's own documentation key, which is in a thousand READMEs", () => {
    expect(scanSecrets(files({ "README.md": 'AWS_ACCESS_KEY_ID="AKIAIOSFODNN7EXAMPLE"' }))).toEqual([]);
  });

  it("finds GitHub tokens of every shape", () => {
    const findings = scanSecrets(
      files({
        "a.ts": `const t = "ghp_${"a".repeat(36)}";`,
        "b.ts": `const u = "gho_${"b".repeat(36)}";`,
        "c.ts": `const s = "ghs_${"c".repeat(36)}";`,
        "d.ts": `const f = "github_pat_${"d".repeat(75)}";`,
      }),
    );
    expect(findings.map((f) => f.rule_id).sort()).toEqual(["github-app-token", "github-fine-grained-pat", "github-oauth", "github-pat"]);
  });

  it("finds our own key prefix (FR-4)", () => {
    const key = `x4c_live_${"A1b2C3d4".repeat(4)}`;
    const findings = scanSecrets(files({ "README.md": `Set X402GIT_KEY=${key} before running.` }));
    expect(findings).toHaveLength(1);
    expect(findings[0].rule_id).toBe("x402git-api-key");
    expect(ownApiKeysIn(files({ "README.md": `key ${key}` }))).toEqual([key]);
  });

  it("finds a leaked session key too (FR-60: the pattern is x4[cs]_live_)", () => {
    const key = `x4s_live_${"S1e2s3S4".repeat(4)}`;
    const findings = scanSecrets(files({ "debug.log": `cookie exchanged for ${key}` }));
    expect(findings).toHaveLength(1);
    expect(findings[0].rule_id).toBe("x402git-api-key");
    // FR-57 hangs off this: the caller revokes whatever comes back here.
    expect(ownApiKeysIn(files({ "debug.log": `key ${key}` }))).toEqual([key]);
  });

  it("does not fire on a session cookie, which only shares the x4s stem (FR-60)", () => {
    // `x4s.<payload>.<mac>` — a sealed session cookie, not a key. The pattern requires
    // `_live_`, so a cookie pasted into a repo is not a credential revocation event.
    const cookie = `x4s.${"eyJjcmVhdG9ySWQiOiJhYmMifQ"}.${"Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA"}`;
    expect(scanSecrets(files({ "notes.md": `Cookie: ${cookie}` })).map((f) => f.rule_id)).not.toContain("x402git-api-key");
    expect(ownApiKeysIn(files({ "notes.md": cookie }))).toEqual([]);
  });

  it("finds Slack, Stripe and private key blocks", () => {
    const findings = scanSecrets(
      files({
        "slack.ts": 'const t = "xoxb-1234567890-1234567890-abcdefghijklmnopqrstuvwx";',
        "stripe.ts": `const k = "sk_live_${"9aZ".repeat(9)}";`,
        "id_rsa": "-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----",
      }),
    );
    expect(findings.map((f) => f.rule_id).sort()).toEqual(["private-key", "slack-token", "stripe-secret-key"]);
  });

  it("finds a high-entropy assignment and ignores a low-entropy one", () => {
    const findings = scanSecrets(
      files({
        "real.env": 'api_key = "Zq7Z2xFv93KpLm1WdTa8Ub4Ye6Rn0Sc5"',
        "docs.md": 'api_key = "aaaaaaaaaaaaaaaaaaaa"',
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule_id: "generic-api-key", path: "real.env" });
    expect(findings[0].entropy).toBeGreaterThan(3.5);
  });

  it("does not fire on the most common line in every README", () => {
    const findings = scanSecrets(
      files({
        "README.md": [
          'api_key = "your-api-key-here"',
          'API_KEY="<your key>"',
          'secret_key = "changeme"',
          'password = "xxxxxxxxxxxxxxxxxxxx"',
          'token = "${GITHUB_TOKEN}"',
          'client_secret = "example_client_secret"',
        ].join("\n"),
      }),
    );
    expect(findings).toEqual([]);
  });

  it("does not fire on a clean repository", () => {
    const findings = scanSecrets(
      files({
        "README.md": "# widget\n\nRun `npm test`.\n",
        "src/index.ts": "export const version = '1.2.0';\nexport function widget() { return 42; }\n",
        "package.json": '{"name":"widget","version":"1.2.0","dependencies":{"left-pad":"1.3.0"}}',
      }),
    );
    expect(findings).toEqual([]);
  });

  it("skips lockfiles, where a hash is a hash — and nothing else that ships", () => {
    expect(isNoiseFile("package-lock.json")).toBe(true);
    expect(isNoiseFile("go.sum")).toBe(true);
    // dist/, vendor/, node_modules/ and minified bundles are *sold* in the snapshot,
    // so a credential there must not ship under a "scanned clean" badge.
    expect(isNoiseFile("dist/app.min.js")).toBe(false);
    expect(isNoiseFile("vendor/lib.js")).toBe(false);
    expect(isNoiseFile("node_modules/pkg/index.js")).toBe(false);
    expect(isNoiseFile("src/index.ts")).toBe(false);

    const findings = scanSecrets(files({ "package-lock.json": 'integrity: "AKIA2E0A8F3B244C9986"' }));
    expect(findings).toEqual([]);
  });

  it("finds a credential in a shipped build directory", () => {
    const findings = scanSecrets(files({ "dist/config.js": 'const k = "AKIA2E0A8F3B244C9986";' }));
    expect(findings).toHaveLength(1);
    expect(findings[0].path).toBe("dist/config.js");
  });

  it("finds a credential deep in a single-line minified bundle (no truncation)", () => {
    const bundle = "x".repeat(5000) + ' key="AKIA2E0A8F3B244C9986" ' + "y".repeat(100);
    const findings = scanSecrets(files({ "dist/app.min.js": bundle }));
    expect(findings).toHaveLength(1);
    expect(findings[0].rule_id).toBe("aws-access-key-id");
  });

  it("reports the location and never the value", () => {
    const findings = scanSecrets(files({ "a.ts": ["// header", "", `const k = "AKIA2E0A8F3B244C9986";`].join("\n") }));
    expect(findings[0].line).toBe(3);
    expect(findings[0].match_length).toBe(20);
    expect(JSON.stringify(findings)).not.toContain("AKIA2E0A8F3B244C9986");
  });

  it("caps findings so one generated file cannot produce a megabyte of report", () => {
    const line = 'const k = "AKIA2E0A8F3B244C9986";\n';
    const findings = scanSecrets(files({ "gen.ts": line.repeat(50) }), { maxFindings: 10 });
    expect(findings).toHaveLength(10);
  });
});

describe("shannonEntropy", () => {
  it("is zero for a constant string and high for a random one", () => {
    expect(shannonEntropy("aaaaaaaa")).toBe(0);
    expect(shannonEntropy("Zq7Z2xFv93KpLm1WdTa8Ub4Ye6Rn0Sc5")).toBeGreaterThan(4);
    expect(shannonEntropy("")).toBe(0);
  });
});
