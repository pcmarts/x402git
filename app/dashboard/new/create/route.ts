/**
 * POST /dashboard/new/create — creates the listing by calling `POST /api/listings`.
 *
 * The body is the Rail A shape from §7.2: `{ slug, source: "github", installation_id,
 * github_repo_id }`. Prices are omitted so the route applies D2a's defaults ($9 / $5)
 * rather than this page carrying a second copy of them.
 */

import { handle } from "@/lib/errors";
import { creatorApi } from "@/lib/web/api-client";
import { back, requireActor } from "@/lib/web/dashboard";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: Request) => {
  const actor = await requireActor(req, "/dashboard/new");
  if (actor instanceof Response) return actor;

  const form = await req.formData();
  const slug = String(form.get("slug") ?? "").trim();
  const installationId = String(form.get("installation_id") ?? "").trim();
  const repoId = String(form.get("github_repo_id") ?? "").trim();
  if (!slug || !installationId || !repoId) return back("/dashboard/new", { error: "Pick a repository from the list." });

  const result = await creatorApi<{ listing_id: string }>({
    method: "POST",
    path: "/api/listings",
    apiKey: actor.apiKey,
    body: { slug, source: "github", installation_id: installationId, github_repo_id: repoId },
  });

  if (!result.ok) return back("/dashboard/new", { error: result.message });

  const id = result.data?.listing_id;
  // `check=1`: the listing page runs Check for releases on arrival (25 Oct 2026, founder:
  // the first question on that page is whether the repo has a release, and the answer
  // should be on its way before anyone finds the button). See check-for-releases.tsx.
  return id
    ? back(`/dashboard/${id}`, { ok: "Listing created. Checking the repository for its newest release.", extra: { check: "1" } })
    : back("/dashboard", { ok: "Listing created." });
});
