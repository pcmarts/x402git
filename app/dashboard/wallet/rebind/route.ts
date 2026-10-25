/**
 * POST /dashboard/wallet/rebind — change the bound payout address (FR-5).
 *
 * Unlike the first bind, this one goes over HTTP to `PATCH /api/creators/me` with the
 * creator's bearer key, because that route already exists and already does the whole of
 * FR-5: step-up against the *current* address, sanctions screening on the incoming one,
 * and the 48-hour delay with sweeps continuing to the old address throughout. Calling it
 * is the point — D9 says the website is a client of the API, and a second implementation
 * of a 48-hour queue is exactly the kind of drift that rule exists to prevent.
 */

import { handle } from "@/lib/errors";
import { creatorApi } from "@/lib/web/api-client";
import { back, requireActor } from "@/lib/web/dashboard";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: Request) => {
  const actor = await requireActor(req, "/dashboard/wallet");
  if (actor instanceof Response) return actor;

  const form = await req.formData();
  // `address` is the *current* bound address, the one the challenge was issued to;
  // `new_address` is where payouts should go after the delay.
  const nextAddress = String(form.get("new_address") ?? "").trim();
  const nonce = String(form.get("nonce") ?? "").trim();
  const signature = String(form.get("signature") ?? "").trim();
  if (!nextAddress || !nonce || !signature) return back("/dashboard/wallet", { error: "Paste the signature before submitting." });

  const result = await creatorApi<{ rebind_effective_at?: string | null }>({
    method: "PATCH",
    path: "/api/creators/me",
    apiKey: actor.apiKey,
    // FR-5: the signature proves the address that is bound *now*, which is why it is
    // the step_up rather than a proof of the incoming one.
    body: { payout_address: nextAddress, step_up: { nonce, signature } },
  });

  if (!result.ok) return back("/dashboard/wallet", { error: result.message });

  const when = result.data?.rebind_effective_at;
  return back("/dashboard/wallet", {
    ok: `Change queued${when ? `, effective ${when}` : ""}. Payouts keep going to the current address until then.`,
  });
});
