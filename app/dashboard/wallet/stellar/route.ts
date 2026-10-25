/**
 * POST /dashboard/wallet/stellar — add or change the Stellar payout address (JOURNEYS C3, C5).
 *
 * Like `rebind/route.ts`, this goes over HTTP to `PATCH /api/creators/me` with the
 * creator's bearer key, because that route already does the whole of it: the step-up
 * from the identity address, the SEP-53 proof from the new `G…`, type-to-confirm, the
 * Horizon trustline check, and the addition-now / change-in-48h rule. D9 says the website
 * is a client of the API; a second copy of those rules is the drift that rule prevents.
 *
 * One thing is the page's, not the API's: when the account has no trustline, the reader
 * is sent back with `?trustline=<G…>` so the wallet page can show the Freighter steps and
 * a Refresh for that account, instead of a sentence in a notice.
 */

import { handle } from "@/lib/errors";
import { creatorApi } from "@/lib/web/api-client";
import { back, requireActor, seeOther } from "@/lib/web/dashboard";
import { appUrl } from "@/lib/env";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: Request) => {
  const actor = await requireActor(req, "/dashboard/wallet");
  if (actor instanceof Response) return actor;

  const form = await req.formData();
  const field = (name: string) => String(form.get(name) ?? "").trim();
  const address = field("stellar_address");
  const proofNonce = field("proof_nonce");
  const proofSignature = field("proof_signature");
  const stepUpNonce = field("step_up_nonce");
  const stepUpSignature = field("step_up_signature");
  const confirm = field("confirm_address");

  if (!address || !proofNonce || !proofSignature) return back("/dashboard/wallet", { error: "Connect Freighter and sign first." });
  if (!stepUpNonce || !stepUpSignature) return back("/dashboard/wallet", { error: "Sign with the wallet bound now to authorise the change." });
  if (!confirm) return back("/dashboard/wallet", { error: "Type the last six characters of the Stellar address to confirm." });

  const result = await creatorApi<{ stellar_payout_address?: string | null; pending_stellar_payout_address?: string | null; effective_at?: string | null }>({
    method: "PATCH",
    path: "/api/creators/me",
    apiKey: actor.apiKey,
    body: {
      stellar_payout_address: address,
      stellar_proof: { nonce: proofNonce, signature: proofSignature },
      step_up: { nonce: stepUpNonce, signature: stepUpSignature },
      confirm_address: confirm,
    },
  });

  if (!result.ok) {
    const reason = result.details && typeof result.details === "object" ? (result.details as { reason?: unknown }).reason : null;
    if (reason === "no_trustline") {
      const url = new URL("/dashboard/wallet", appUrl());
      url.searchParams.set("trustline", address);
      return seeOther(url);
    }
    return back("/dashboard/wallet", { error: result.message });
  }

  const when = result.data?.effective_at;
  return back("/dashboard/wallet", {
    ok: when
      ? `Change queued, effective ${when}. Stellar payouts keep going to the current address until then.`
      : "Stellar wallet added. Your listings can be paid on Stellar from now on.",
  });
});
