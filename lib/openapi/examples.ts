/**
 * lib/openapi/examples.ts — FR-21: one canonical 402 example per kind.
 *
 * These are documentation, not behaviour. The only place a real 402 body is built is
 * `lib/core/access.ts#toPaymentRequirements`. If the two ever disagree, the code is
 * right and this file is a bug — `lib/openapi/openapi.test.ts` validates both examples
 * against `PaymentRequiredBody`, so the disagreement fails the build.
 */

import { buyLinks, paymentInstructions } from "@/lib/buy-links";
import type { PaymentRequiredBodyOutput } from "@/lib/schemas";

/** Canonical USDC on Base mainnet (`eip155:8453`). Base Sepolia is 0x036CbD53842c5426634e7929541eC2318f3dCF7e on `eip155:84532`. */
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PLATFORM_RECEIVER = "0x1111111111111111111111111111111111111111";

/**
 * 2026-09-02: the 402 tells a reader that is not an x402 client what to do next. Built
 * by the same functions the wire uses, so the example cannot say something the server
 * does not. Both examples are on Base mainnet, hence the chain name.
 */
const LINKS = buyLinks({ owner: "adrian", slug: "humanizer", appUrl: "https://x402git.com" });
const SELF_DESCRIBING = {
  instructions: paymentInstructions(LINKS, "Base"),
  listing_url: LINKS.listing_url,
  skill_url: LINKS.skill_url,
  mcp_url: LINKS.mcp_url,
};

export const PAYMENT_REQUIRED_EXAMPLE_NEW: PaymentRequiredBodyOutput = {
  x402Version: 2,
  resource: {
    url: "https://x402git.com/api/r/adrian/humanizer",
    description: "humanizer 1.2.0 — a Harness of 1 skill, 9 scripts and 3 test files. MIT, resale permitted. Security scan passed.",
    mimeType: "application/zip",
  },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:8453",
      asset: USDC_BASE,
      payTo: PLATFORM_RECEIVER,
      amount: "9000000",
      maxAmountRequired: "9000000",
      resource: "https://x402git.com/api/r/adrian/humanizer",
      description: "humanizer 1.2.0 — a Harness of 1 skill, 9 scripts and 3 test files. MIT, resale permitted. Security scan passed.",
      maxTimeoutSeconds: 300,
      mimeType: "application/zip",
      extra: { name: "USD Coin", version: "2" },
    },
  ],
  extra: {
    kind: "new",
    version: "1.2.0",
    manifest_url: "https://x402git.com/api/label/adrian/humanizer",
    scan_badge_url: "https://x402git.com/api/label/adrian/humanizer#scan",
    ...SELF_DESCRIBING,
    update_price_micro: "3000000",
    quote_id: "q_01J9Z4Q2W0X1Y2Z3A4B5C6D7E8",
    valid_before: "2026-08-29T12:05:00Z",
  },
};

export const PAYMENT_REQUIRED_EXAMPLE_UPDATE: PaymentRequiredBodyOutput = {
  x402Version: 2,
  resource: {
    url: "https://x402git.com/api/r/adrian/humanizer",
    description: "humanizer 1.2.0 → 1.3.0 — 6 files, 210 lines changed. You already own 1.2.0; this is the update price.",
    mimeType: "application/zip",
  },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:8453",
      asset: USDC_BASE,
      payTo: PLATFORM_RECEIVER,
      // FR-16: the lower of the stamped update price and the current one.
      amount: "3000000",
      maxAmountRequired: "3000000",
      resource: "https://x402git.com/api/r/adrian/humanizer",
      description: "humanizer 1.2.0 → 1.3.0 — 6 files, 210 lines changed. You already own 1.2.0; this is the update price.",
      maxTimeoutSeconds: 300,
      mimeType: "application/zip",
      extra: { name: "USD Coin", version: "2" },
    },
  ],
  extra: {
    kind: "update",
    version: "1.3.0",
    from: "1.2.0",
    to: "1.3.0",
    manifest_url: "https://x402git.com/api/label/adrian/humanizer",
    scan_badge_url: "https://x402git.com/api/label/adrian/humanizer#scan",
    ...SELF_DESCRIBING,
    update_price_micro: "3000000",
    // FR-17: every release-log entry between the owned version and the latest.
    releases: [
      {
        version: "1.3.0",
        tag: "v1.3.0",
        commit_sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
        artifact_sha256: "9f2c00000000000000000000000000000000000000000000000000000000abcd",
        published_at: "2026-08-28T09:14:00Z",
        changelog: "Handles em-dash runs and rule-of-three sentences.",
        diff_summary: {
          files_added: 1,
          files_changed: 4,
          files_removed: 1,
          additions: 176,
          deletions: 34,
          components_touched: ["scripts", "tests"],
        },
        scan: "pass",
        scanner_version: "2026.08.2",
        analyzer_version: "0.1.0",
        price_micro: "9000000",
        update_price_micro: "3000000",
      },
    ],
    quote_id: "q_01J9Z4Q2W0X1Y2Z3A4B5C6D7E9",
    valid_before: "2026-08-29T12:05:00Z",
  },
};
