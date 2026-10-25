/**
 * GET /api/v/:owner/:slug — FR-20. The cheap, cacheable "what is the latest and what
 * would it cost me" call that every agent makes before it fetches (FR-30).
 *
 * Two shapes, and the difference is the point:
 *
 * - **Without `X-Wallet-Signature`** it is version data only. `?address=` is not
 *   accepted and never will be: entitlement state is not a public oracle (FR-40).
 * - **With a valid signature** it also answers `owned`, `entitled`, `all_versions` and
 *   `price_kind`, and `price_micro` becomes *this caller's* price.
 *
 * The body is `lib/listings/version.ts#versionStatus` — `lib/core/access.ts#quote`
 * serialised, shared with the MCP `check_version` tool (§11). There is no second
 * implementation of the access check anywhere.
 */

import { type NextRequest, NextResponse } from "next/server";
import { clientIp, enforceLimit } from "@/lib/auth/rate-limit";
import { walletFrom } from "@/lib/auth/wallet-signature";
import { handle } from "@/lib/errors";
import { versionStatus } from "@/lib/listings/version";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ owner: string; slug: string }> };

export const GET = handle(async (req: NextRequest, { params }: Params) => {
  const { owner, slug } = await params;
  await enforceLimit("version", clientIp(req));

  // Absent header → anonymous; malformed header → 401, never a silent downgrade.
  const buyer = await walletFrom(req);

  return NextResponse.json(await versionStatus({ owner, slug }, buyer), { headers: { "cache-control": "no-store" } });
});
