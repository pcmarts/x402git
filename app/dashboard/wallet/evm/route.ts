/**
 * POST /dashboard/wallet/evm — a Stellar-only creator adds an EVM payout address (JOURNEYS C4).
 *
 * The mirror of `stellar/route.ts`, and like it a client of `PATCH /api/creators/me`,
 * which does the whole of it: the EIP-191 proof from the new `0x…` and screening. Live at
 * once; Base is offered from then on.
 *
 * One signature since 25 Oct 2026, ~21:30 (HackMeridian; the founder: "lets not have the
 * confirm the last 6 digits of your evm wallet - a lot of hassle"). Adding a rail the
 * account has no address on yet takes only the new wallet's own proof from a dashboard
 * session — no Freighter sign-off, no type-to-confirm; the API's header says why. This
 * form only ever adds, so the proof is all it requires. `step_up_*` and `confirm_address`
 * are still passed through when a hand-built form sends them, and the API checks them.
 */

import { handle } from "@/lib/errors";
import { creatorApi } from "@/lib/web/api-client";
import { back, requireActor } from "@/lib/web/dashboard";

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
  const confirm = field("confirm_address");

  if (!address || !proofNonce || !proofSignature) return back("/dashboard/wallet", { error: "Connect your EVM wallet and sign first." });

  const result = await creatorApi({
    method: "PATCH",
    path: "/api/creators/me",
    apiKey: actor.apiKey,
    body: {
      payout_address: address,
      payout_proof: { nonce: proofNonce, signature: proofSignature },
      ...(stepUpNonce && stepUpSignature ? { step_up: { nonce: stepUpNonce, signature: stepUpSignature } } : {}),
      ...(confirm ? { confirm_address: confirm } : {}),
    },
  });

  if (!result.ok) return back("/dashboard/wallet", { error: result.message });
  return back("/dashboard/wallet", { ok: "EVM wallet added. Your listings can be paid in USDC on Base from now on." });
});
