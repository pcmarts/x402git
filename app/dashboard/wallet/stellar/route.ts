/**
 * POST /dashboard/wallet/stellar — add or change the Stellar payout address (JOURNEYS C3, C5).
 *
 * Like `rebind/route.ts`, this goes over HTTP to `PATCH /api/creators/me` with the
 * creator's bearer key, because that route already does the whole of it: the SEP-53
 * proof from the new `G…`, the step-up on a change, the Horizon trustline check, and
 * the addition-now / change rule (instant since 25 Oct 2026 23:30 unless the deployment
 * runs a rebind delay; nothing typed to confirm). D9 says the website is a
 * client of the API; a second copy of those rules is the drift that rule prevents.
 *
 * Adding versus changing (25 Oct 2026, ~21:30, HackMeridian; the founder: "Do we need to
 * have the stellar wallet confirm? Feels needless."). Adding a Stellar wallet to an
 * account with none is the new wallet's proof alone — no sign-off from the EVM wallet;
 * the API's header says why. Changing one keeps the sign-off. The only reading of the
 * rule here is which sentence to say when a change arrives without it, before a nonce is
 * spent; the API decides either way, and whatever the form sends is passed through.
 *
 * One thing is the page's, not the API's: when the account has no trustline, the reader
 * is sent back with `?trustline=<G…>` so the wallet page can show the Freighter steps and
 * a Refresh for that account, instead of a sentence in a notice.
 */

import { currentStellarPayoutAddress } from "@/lib/auth/stellar-binding";
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

  if (!address || !proofNonce || !proofSignature) return back("/dashboard/wallet", { error: "Connect a Stellar wallet and sign first." });
  const change = currentStellarPayoutAddress(actor.creator) !== null;
  if (change && (!stepUpNonce || !stepUpSignature)) return back("/dashboard/wallet", { error: "Sign with the wallet bound now to authorise the change." });

  const result = await creatorApi<{ stellar_payout_address?: string | null; pending_stellar_payout_address?: string | null; effective_at?: string | null }>({
    method: "PATCH",
    path: "/api/creators/me",
    apiKey: actor.apiKey,
    body: {
      stellar_payout_address: address,
      stellar_proof: { nonce: proofNonce, signature: proofSignature },
      ...(stepUpNonce && stepUpSignature ? { step_up: { nonce: stepUpNonce, signature: stepUpSignature } } : {}),
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
      : change
        ? "Stellar wallet changed. Stellar payouts go to the new wallet from now on."
        : "Stellar wallet added. Your listings can be paid on Stellar from now on.",
  });
});
