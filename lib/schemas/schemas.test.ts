import { describe, expect, it } from "vitest";
import {
  CreateCreatorRequest,
  CreateListingRequest,
  CreatorScanReport,
  LatestRelease,
  ListingResponse,
  ScanInfo as ManifestScan,
  DEFAULT_PRICE_MICRO,
  DEFAULT_UPDATE_PRICE_MICRO,
  HexSignature,
  Manifest,
  MicroUsdc,
  PRICE_PRESETS_MICRO,
  PaymentRequiredBody,
  PriceMicro,
  PublicScanFinding,
  RESERVED_SLUGS,
  Slug,
  SshKeyRequest,
  UPDATE_PRICE_PRESETS_MICRO,
  VersionResponse,
  VersionScan,
  micro,
  pricingBlock,
} from "./index";
import { PAYMENT_REQUIRED_EXAMPLE_NEW, PAYMENT_REQUIRED_EXAMPLE_UPDATE } from "@/lib/openapi/examples";

const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const NONCE = "abcdefghijklmnopqrstuvwx";
const SIG = `0x${"ab".repeat(65)}`;

describe("micro-USDC on the wire", () => {
  it("accepts a decimal integer string and rejects everything else", () => {
    expect(MicroUsdc.safeParse("9000000").success).toBe(true);
    expect(MicroUsdc.safeParse("0").success).toBe(true);
    expect(MicroUsdc.safeParse(9_000_000).success).toBe(false); // a JSON number is a double
    expect(MicroUsdc.safeParse("9.00").success).toBe(false);
    expect(MicroUsdc.safeParse("-1").success).toBe(false);
  });

  it("round-trips through bigint without losing precision beyond 2^53", () => {
    const huge = "90071992547409910";
    expect(micro.serialize(micro.parse(huge))).toBe(huge);
    expect(micro.parse(huge)).toBe(90071992547409910n);
  });

  it("refuses a float outright", () => {
    expect(() => micro.parse(9.5 as unknown as number)).toThrow();
    expect(() => micro.serialize(9.5)).toThrow();
  });
});

describe("PriceMicro (D2b)", () => {
  it("allows anything at or above the $0.01 technical minimum", () => {
    expect(PriceMicro.safeParse("10000").success).toBe(true);
    expect(PriceMicro.safeParse("9000000").success).toBe(true);
  });

  it("rejects free — a release always costs something (2026-08-31, founder)", () => {
    expect(PriceMicro.safeParse("0").success).toBe(false);
  });

  it("rejects a price between zero and the minimum", () => {
    expect(PriceMicro.safeParse("9999").success).toBe(false);
  });
});

describe("the pricing block (FR-13, D2a)", () => {
  it("carries the presets and defaults the PRD fixes", () => {
    const block = pricingBlock(9_000_000n, 5_000_000n);
    expect(block.presets.price).toEqual(["1000000", "5000000", "9000000", "19000000"]);
    expect(block.presets.update).toEqual(["0", "3000000", "5000000", "9000000"]);
    expect(block.defaults).toEqual({ price_micro: "9000000", update_price_micro: "5000000" });
    expect(block.platform_fee_bps).toBe(1000);
  });

  it("matches the constants the rest of the codebase reads", () => {
    expect(PRICE_PRESETS_MICRO).toEqual([1_000_000n, 5_000_000n, 9_000_000n, 19_000_000n]);
    expect(UPDATE_PRICE_PRESETS_MICRO).toEqual([0n, 3_000_000n, 5_000_000n, 9_000_000n]);
    expect(DEFAULT_PRICE_MICRO).toBe(9_000_000n);
    expect(DEFAULT_UPDATE_PRICE_MICRO).toBe(5_000_000n);
  });
});

describe("Slug (FR-3)", () => {
  it("reserves the path segments under /api", () => {
    for (const reserved of RESERVED_SLUGS) expect(Slug.safeParse(reserved).success).toBe(false);
  });

  it("takes lowercase, digits and dashes, 2 to 40 characters", () => {
    expect(Slug.safeParse("humanizer").success).toBe(true);
    expect(Slug.safeParse("a").success).toBe(false);
    expect(Slug.safeParse("Humanizer").success).toBe(false);
    expect(Slug.safeParse("a".repeat(41)).success).toBe(false);
  });
});

describe("CreateCreatorRequest (FR-2)", () => {
  const valid = {
    handle: "a1b2c3",
    payout_address: ADDRESS,
    address_proof: { nonce: NONCE, signature: SIG },
    accepted_terms_version: "2026-08-29",
  };

  it("accepts the §7.2 body", () => {
    expect(CreateCreatorRequest.safeParse(valid).success).toBe(true);
  });

  it("requires the address proof", () => {
    const { address_proof: _omitted, ...withoutProof } = valid;
    expect(CreateCreatorRequest.safeParse(withoutProof).success).toBe(false);
  });

  it("rejects an http abuse contact (FR-41 is https only)", () => {
    expect(CreateCreatorRequest.safeParse({ ...valid, abuse_contact_url: "http://example.com/abuse" }).success).toBe(false);
    expect(CreateCreatorRequest.safeParse({ ...valid, abuse_contact_url: "https://example.com/abuse" }).success).toBe(true);
  });

  it("rejects a malformed address", () => {
    expect(CreateCreatorRequest.safeParse({ ...valid, payout_address: "0x123" }).success).toBe(false);
  });
});

describe("the 402 body (FR-21)", () => {
  it("validates the canonical `new` example", () => {
    expect(PaymentRequiredBody.safeParse(PAYMENT_REQUIRED_EXAMPLE_NEW).success).toBe(true);
  });

  it("validates the canonical `update` example, evidence and all (FR-17)", () => {
    const parsed = PaymentRequiredBody.safeParse(PAYMENT_REQUIRED_EXAMPLE_UPDATE);
    expect(parsed.success).toBe(true);
    expect(PAYMENT_REQUIRED_EXAMPLE_UPDATE.extra.releases).toHaveLength(1);
    expect(PAYMENT_REQUIRED_EXAMPLE_UPDATE.extra.from).toBe("1.2.0");
  });

  it("insists the amount is a string, not a number", () => {
    const broken = structuredClone(PAYMENT_REQUIRED_EXAMPLE_NEW) as unknown as { accepts: { maxAmountRequired: unknown }[] };
    broken.accepts[0].maxAmountRequired = 9_000_000;
    expect(PaymentRequiredBody.safeParse(broken).success).toBe(false);
  });
});

describe("the manifest (FR-52)", () => {
  it("keeps computed and self-reported in separate namespaces", () => {
    const shape = Manifest.shape;
    expect(Object.keys(shape)).toContain("computed");
    expect(Object.keys(shape)).toContain("self_reported");
    // A consuming agent must be able to drop every unverified claim in one line.
    expect(Object.keys(Manifest.shape.computed.shape)).not.toContain("description");
  });

  it("requires computed_at and analyzer_version on every computed block", () => {
    const computed = Manifest.shape.computed.shape;
    expect(computed.computed_at).toBeDefined();
    expect(computed.analyzer_version).toBeDefined();
  });
});

/**
 * "PRD Trust Report.md" §4.2 and §4.4, accepted 13 Sep 2026.
 *
 * The two properties worth a test: a manifest written before the report existed must
 * still validate (or every listing on the platform loses its file tree at once —
 * `manifestFor` drops a manifest whole), and the fields §4.4 makes private must be
 * stripped by the schema rather than by a caller remembering to.
 */
describe("the trust report on the manifest (PRD Trust Report §4.2)", () => {
  const scan = {
    verdict: "pass" as const,
    scanner_version: "2026.09.1",
    at: "2026-08-21T10:00:00Z",
    checks: [
      {
        id: "dep_behaviour",
        tool: "socket.dev",
        tool_version: "2026-09-13",
        status: "findings",
        at: "2026-08-21T10:00:00Z",
        findings: 1,
        packages: 63,
        socket_scan_id: "sock_123",
      },
    ],
    findings: [
      { kind: "behaviour", check: "dep_behaviour", tier: "disclosed", rule_id: "installScripts", severity: "LOW", description: "install scripts run" },
    ],
    counts: { blocking: 0, disclosed: 1, review: 0 },
    advisories_refreshed_at: "2026-09-12T04:00:00Z",
  };

  it("keeps the three original fields required, so a pre-report manifest still validates", () => {
    const shape = ManifestScan.shape;
    expect(shape.verdict.safeParse(undefined).success).toBe(false);
    expect(ManifestScan.safeParse({ verdict: "pass", scanner_version: "2026.08.2", at: "2026-08-21T10:00:00Z" }).success).toBe(true);
  });

  it("strips the vendor scan id from a check row — §4.2 keeps it ours", () => {
    const parsed = ManifestScan.parse(scan);
    expect(parsed.checks?.[0]).not.toHaveProperty("socket_scan_id");
    expect(parsed.checks?.[0].packages).toBe(63);
    expect(JSON.stringify(parsed)).not.toContain("sock_123");
  });

  /**
   * 13 Sep 2026. `PublicScanFinding` said in a comment that a secret and an injection match
   * never appear on it, and enforced nothing: it stripped `public`, `blocking` and
   * `match_length` — the marks a producer puts on a secret — and kept `kind`, `path` and
   * `line`, which is the leak with the evidence that it was one removed. The rule is now
   * the schema's.
   */
  it("refuses a secret or an injection finding on the public copy (§4.4)", () => {
    for (const kind of ["secret", "injection"]) {
      const leak = { kind, check: kind === "secret" ? "secrets" : "injection", tier: "blocking", rule_id: "anthropic-api-key", severity: "CRITICAL", description: "a key", path: "src/config.ts", line: 12 };
      expect([kind, PublicScanFinding.safeParse(leak).success]).toEqual([kind, false]);
    }
    // A capability finding is *about* a path and keeps both fields; the rule is the kind.
    expect(PublicScanFinding.safeParse({ kind: "capability", check: "capabilities", tier: "disclosed", rule_id: "hook", severity: "MODERATE", description: "a hook", path: ".claude/settings.json" }).success).toBe(true);
  });

  it("carries the counts and the advisory refresh an agent branches on", () => {
    const parsed = ManifestScan.parse(scan);
    expect(parsed.counts).toEqual({ blocking: 0, disclosed: 1, review: 0 });
    expect(parsed.advisories_refreshed_at).toBe("2026-09-12T04:00:00Z");
  });

  it("gives the version endpoint the three numbers, and never requires them", () => {
    expect(VersionScan.parse({ verdict: "pass", at: null, scanner_version: null, blocking: 0, disclosed: 9, review: 0 }).disclosed).toBe(9);
    // Absent, not zeroed, is a valid answer on the response itself.
    const base = {
      owner: "adrian",
      slug: "humanizer",
      latest: "1.2.0",
      published_at: "2026-08-21T00:00:00Z",
      price_micro: "9000000",
      update_price_micro: "5000000",
      releases_url: "https://x402git.com/api/v/adrian/humanizer/releases",
      resource_endpoint: "https://x402git.com/api/r/adrian/humanizer",
      status: "live",
    };
    expect(VersionResponse.safeParse(base).success).toBe(true);
    expect(VersionResponse.parse({ ...base, scan: { verdict: "pass", at: null, scanner_version: null, blocking: 0, disclosed: 2, review: 1 } }).scan?.review).toBe(1);
  });

  it("lets the creator's copy carry a secret's path, line and length — and never its value", () => {
    const report = CreatorScanReport.parse({
      version: 2,
      scanner_version: "2026.09.1",
      scanned_at: "2026-08-21T10:00:00Z",
      checks: [{ id: "secrets", tool: "x402git/secrets", tool_version: "2026.09.1", status: "fail", at: "2026-08-21T10:00:00Z", findings: 1 }],
      findings: [
        {
          kind: "secret",
          check: "secrets",
          tier: "blocking",
          rule_id: "anthropic-api-key",
          severity: "CRITICAL",
          description: "Anthropic API key",
          path: "src/leaked.py",
          line: 42,
          blocking: true,
          public: false,
          match_length: 108,
          // A producer that ever put the credential itself on a finding would be a bug;
          // the schema is the last line and drops anything it does not name.
          value: "sk-ant-DO-NOT-KEEP-THIS",
        },
      ],
      counts: { blocking: 1, disclosed: 0, review: 0 },
    });
    expect(report.findings[0]).toMatchObject({ path: "src/leaked.py", line: 42, match_length: 108 });
    expect(JSON.stringify(report)).not.toContain("DO-NOT-KEEP-THIS");
  });

  it("puts the creator's report on the release, never on the list route's shape", () => {
    expect(Object.keys(LatestRelease.shape)).toContain("scan_report");
    // `latest_release` is FR-9's passing release; the failing one is where the report is
    // actually needed, and it has its own field on the single-listing read.
    expect(Object.keys(ListingResponse.shape)).toContain("newest_release");
  });
});

describe("bounded credentials (W2.4)", () => {
  it("rejects an over-length signature and accepts a normal one", () => {
    const eoa = `0x${"ab".repeat(65)}`; // 132 chars — a normal EOA signature
    expect(HexSignature.safeParse(eoa).success).toBe(true);

    const tooLong = `0x${"a".repeat(4096)}`; // > 4096 total
    expect(HexSignature.safeParse(tooLong).success).toBe(false);
  });

  it("rejects an over-length ssh_public_key and accepts a normal one", () => {
    const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEKEYVALUEEXAMPLE user@host";
    expect(CreateListingRequest.safeParse({ slug: "widget", source: "hosted", ssh_public_key: key }).success).toBe(true);

    const huge = `ssh-rsa ${"A".repeat(16384)}`; // > 16384
    expect(SshKeyRequest.safeParse({ ssh_public_key: huge }).success).toBe(false);
    expect(SshKeyRequest.safeParse({ ssh_public_key: key }).success).toBe(true);
  });
});
