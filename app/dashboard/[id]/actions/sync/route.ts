/**
 * POST /dashboard/:id/actions/sync — FR-8's manual trigger.
 *
 * The same `POST /api/listings/:id/sync` a creator would call from a script. The PRD is
 * explicit that the button in the web UI calls the same route: this is the recovery path
 * for a webhook that never arrived, and a second implementation of it would be a second
 * thing to be wrong at the moment you need it most.
 *
 * No `ref` and no `version` are sent, so the route cuts the repository's newest `vX.Y.Z`
 * tag that has not been cut yet — which is what "Check for releases" answers for a person
 * looking at a repo. Until 2026-09-01 the same empty body answered `invalid_version` on every
 * repository in the world, because nothing looked at the tags; see FR-8.2's amendment.
 */

import { handle } from "@/lib/errors";
import { creatorApi } from "@/lib/web/api-client";
import { back, requireActor } from "@/lib/web/dashboard";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const target = `/dashboard/${id}`;

  const actor = await requireActor(req, target);
  if (actor instanceof Response) return actor;

  const result = await creatorApi<{ version?: string; scan?: string }>({
    method: "POST",
    path: `/api/listings/${id}/sync`,
    apiKey: actor.apiKey,
    body: {},
  });

  if (!result.ok) return back(target, { error: result.message });

  // The cut is synchronous, so by the time this redirect lands the scan has a verdict;
  // "not sellable until the scan passes" after a scan that passed read as a stall
  // (25 Oct 2026, founder). Say what was found.
  const version = result.data?.version;
  const scan = result.data?.scan;
  const ok = !version
    ? "Sync started."
    : scan === "pass"
      ? `Cut v${version}. The security scan passed; it sells once the listing is published.`
      : scan === "fail"
        ? `Cut v${version}, but the security scan failed. The report is below; a new tag is the way past it.`
        : `Cut v${version}. The security scan has not finished; it is not sellable until it passes.`;
  return back(target, { ok });
});
