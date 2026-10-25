/**
 * lib/licence.ts — FR-11, the three-way licence gate.
 *
 * The correction in Quality Signals §11.5 is the whole point of this file. GitHub's
 * licence endpoint runs licensee against the choosealicense shortlist at a 98%
 * Sørensen–Dice threshold, on one top-level file, and **returns `NOASSERTION` when it
 * cannot tell.** Measured live: `torvalds/linux`, `ffmpeg/FFmpeg` and `nodejs/node`
 * all return `NOASSERTION`. Blocking on "absent or unrecognised" would therefore
 * reject Linux, FFmpeg and Node — which is why FR-11 has three outcomes, not two:
 *
 *   recognised, resale-compatible  → pass
 *   no licence file at all         → block   (all rights reserved; resale infringes)
 *   NOASSERTION / other / copyleft → manual  (never a block)
 *
 * On Rail B the block is recoverable: `POST /api/listings/:id/licence` commits a
 * LICENSE from an allow-list, and the attestation is the registering operator's (D4).
 * On Rail A the creator adds a LICENSE and pushes a new tag.
 */

import { db } from "@/lib/db";
import type { LicenceVerdict } from "@/lib/db/types";

/**
 * SPDX ids that permit resale of a copy with attribution. Deliberately short: this is
 * the set we are willing to defend, not the set of licences that exist.
 */
export const RESALE_COMPATIBLE_SPDX = [
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "MPL-2.0",
  "ISC",
  "Unlicense",
  "CC0-1.0",
  "0BSD",
  "Zlib",
] as const;

/** FR-11: the four a Rail B creator may have committed for them. */
export const RAIL_B_COMMITTABLE_SPDX = ["MIT", "Apache-2.0", "BSD-3-Clause", "MPL-2.0"] as const;

const ALLOWED = new Set<string>(RESALE_COMPATIBLE_SPDX.map((s) => s.toLowerCase()));

export type LicenceInput = {
  /** `spdx_id` from `GET /repos/{o}/{r}/license`. `NOASSERTION` when licensee gave up. */
  spdx?: string | null;
  /** A LICENSE/COPYING file exists in the tree, whatever licensee made of it. */
  hasLicenceFile: boolean;
};

export type LicenceGate = {
  spdx: string | null;
  verdict: LicenceVerdict;
  /** One sentence, shown to the creator and stored on the event. */
  reason: string;
  /** True when the listing may not go live until this is fixed (FR-42). */
  blocking: boolean;
};

export function licenceGate(input: LicenceInput): LicenceGate {
  const raw = (input.spdx ?? "").trim();
  const normalised = raw === "" || raw.toUpperCase() === "NOASSERTION" ? null : raw;

  if (normalised && ALLOWED.has(normalised.toLowerCase())) {
    return { spdx: canonical(normalised), verdict: "pass", reason: `${canonical(normalised)} permits resale with attribution.`, blocking: false };
  }

  if (!normalised && !input.hasLicenceFile) {
    return {
      spdx: null,
      verdict: "block",
      reason: "No licence file was found. Without one the work is all rights reserved and cannot be resold.",
      blocking: true,
    };
  }

  if (!normalised) {
    // A file exists but licensee could not identify it — the `torvalds/linux` case.
    return {
      spdx: null,
      verdict: "manual",
      reason: "A licence file exists but GitHub could not identify it (NOASSERTION). Queued for review.",
      blocking: false,
    };
  }

  return {
    spdx: canonical(normalised),
    verdict: "manual",
    reason: `${canonical(normalised)} was recognised but is not on the resale-compatible list. Queued for review.`,
    blocking: false,
  };
}

/** Case-correct the SPDX id when we know it; otherwise leave the creator's spelling. */
function canonical(spdx: string): string {
  const match = RESALE_COMPATIBLE_SPDX.find((s) => s.toLowerCase() === spdx.toLowerCase());
  return match ?? spdx;
}

/**
 * Run the gate and write `listing.licence_spdx` / `listing.licence_verdict` (FR-11).
 * Called on every release cut, because a licence can be added or removed by a push.
 */
export async function applyLicenceGate(listingId: string, input: LicenceInput): Promise<LicenceGate> {
  const gate = licenceGate(input);
  const { error } = await db().from("listing").update({ licence_spdx: gate.spdx, licence_verdict: gate.verdict }).eq("id", listingId);
  if (error) throw error;
  return gate;
}
