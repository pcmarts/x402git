/**
 * lib/auth/cron.ts — the Vercel Cron credential.
 *
 * Vercel's convention is `Authorization: Bearer $CRON_SECRET` on the scheduled
 * invocation. The check is mandatory whenever `CRON_SECRET` is set and skipped when it
 * is not, so a local `next dev` can run the job by hand — the same shape as the invite
 * gate in `POST /api/creators`.
 *
 * The comparison is constant-time. These routes move money; a timing oracle on the
 * secret is not a theoretical problem.
 */

import { timingSafeEqual } from "node:crypto";
import { cronSecret } from "@/lib/env";
import { ApiError } from "@/lib/errors";

export function requireCron(req: Request): void {
  const secret = cronSecret();
  if (!secret) {
    // Fail closed in production: an unset secret must never silently expose the money
    // routes (W2.3). The dev-convenience skip survives only outside production.
    if (process.env.VERCEL === "1" || process.env.NODE_ENV === "production") {
      throw new ApiError("invalid_key", { message: "CRON_SECRET is not configured; this route is refused." });
    }
    return;
  }

  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const presented = match ? match[1].trim() : "";
  if (!constantTimeEqual(presented, secret)) {
    throw new ApiError("invalid_key", { message: "This route is invoked by Vercel Cron and requires the cron bearer token." });
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length) return false;
  return x.length > 0 && timingSafeEqual(x, y);
}
