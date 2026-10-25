/**
 * POST /dashboard/wallet/evm — add or change the EVM payout address (JOURNEYS C4, C5).
 *
 * The mirror of `stellar/route.ts`, and like it a client of `PATCH /api/creators/me`,
 * which does the whole of it: the EIP-191 proof from the new `0x…`, the step-up from the
 * wallet bound now on a change, and screening.
 *
 * Adding (a Stellar-only creator opening the EVM rail) is one signature since 25 Oct 2026,
 * ~21:30 (HackMeridian; the founder: "lets not have the confirm the last 6 digits of your
 * evm wallet - a lot of hassle"): the new wallet's own proof from a dashboard session.
 * Changing (an EVM creator moving to another account) arrived the same evening, 23:30
 * (founder: "allow me to just choose a new wallet by pressing a button - i don't like this
 * whole manually challenge ux"): the new account's proof plus the step-up from the account
 * bound now, and the change lands at once unless the deployment runs a rebind delay.
 * Nothing is typed to confirm, either way. Which sentence to say when a change arrives
 * without its sign-off is decided here, before a nonce is spent; the API decides the rest.
 */

import { paymentChain } from "@/lib/env";
import { handle } from "@/lib/errors";
import { creatorApi } from "@/lib/web/api-client";
import { back, requireActor } from "@/lib/web/dashboard";
import { chainInfo } from "@/lib/web/wallet-checkout";
import { addressFamily } from "@/lib/x402/stellar";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: Request) => {
  const actor = await requireActor(req, "/dashboard/wallet");
  if (actor instanceof Response) return actor;

  const form = await req.formData();
  const field = (name: string) => String(form.get(name) ?? "").trim();
  const address = field("evm_address");
  const proofNonce = field("proof_nonce");
  const proofSignature = field("proof_signature");
  const stepUpNonce = field("step_up_nonce");
  const stepUpSignature = field("step_up_signature");

  if (!address || !proofNonce || !proofSignature) return back("/dashboard/wallet", { error: "Connect your EVM wallet and sign first." });
  const change = addressFamily(actor.creator.payout_address) === "evm";
  if (change && (!stepUpNonce || !stepUpSignature)) return back("/dashboard/wallet", { error: "Sign with the wallet bound now to authorise the change." });

  const result = await creatorApi<{ rebind_effective_at?: string | null }>({
    method: "PATCH",
    path: "/api/creators/me",
    apiKey: actor.apiKey,
    body: {
      payout_address: address,
      payout_proof: { nonce: proofNonce, signature: proofSignature },
      ...(stepUpNonce && stepUpSignature ? { step_up: { nonce: stepUpNonce, signature: stepUpSignature } } : {}),
    },
  });

  if (!result.ok) return back("/dashboard/wallet", { error: result.message });

  const chainName = chainInfo(paymentChain().chainId).name;
  const when = result.data?.rebind_effective_at;
  return back("/dashboard/wallet", {
    ok: when
      ? `Change queued, effective ${when}. Payouts keep going to the current address until then.`
      : change
        ? `EVM wallet changed. Payouts on ${chainName} go to the new wallet from now on.`
        : `EVM wallet added. Your listings can be paid in USDC on ${chainName} from now on.`,
  });
});
