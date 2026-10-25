/**
 * GET /api/auth/github/callback — FR-1, step two.
 *
 * The whole body is `lib/web/oauth-callback.ts`, which takes `fetch` as a parameter so
 * the state check can be tested without a GitHub account.
 */

import { handle } from "@/lib/errors";
import { completeGithubCallback } from "@/lib/web/oauth-callback";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: Request) => completeGithubCallback(req));
