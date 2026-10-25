/**
 * POST /dashboard/wallet/challenge — step one of binding an address.
 *
 * Mints the same single-use, five-minute challenge `GET /api/auth/challenge` mints, from
 * the same module, and sends the reader back to the wallet page with the nonce in the
 * URL. It is a POST rather than a link because it writes a row.
 */

import { challengeLimit, clientIp, enforceAddressLimit } from "@/lib/auth/rate-limit";
import { issueChallenge, normaliseAddress } from "@/lib/auth/challenge";
import { rebindContext } from "@/lib/auth/step-up";
import { appUrl } from "@/lib/env";
import { ApiError, handle } from "@/lib/errors";
import { currentCreator, currentSession, signInPath } from "@/lib/web/current";
import { back, seeOther } from "@/lib/web/dashboard";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: Request) => {
  const session = await currentSession();
  if (!session) return seeOther(new URL(signInPath("/dashboard/wallet"), appUrl()));

  const form = await req.formData();
  const current = await currentCreator();

  // Two cases, and the difference is FR-5. Binding for the first time proves the address
  // being bound. *Changing* it must be signed by the address bound now — otherwise
  // anyone holding the API key could redirect the money to an address they control.
  const nextAddress = String(form.get("new_address") ?? "").trim();
  const raw = nextAddress || String(form.get("address") ?? "").trim();

  let target: string;
  let queued: string | null = null;
  try {
    if (current) {
      target = normaliseAddress(current.creator.payout_address);
      queued = normaliseAddress(raw);
      if (queued.toLowerCase() === target.toLowerCase()) {
        return back("/dashboard/wallet", { error: "That is already the bound payout address." });
      }
    } else {
      target = normaliseAddress(raw);
    }
  } catch {
    return back("/dashboard/wallet", { error: "That is not an EVM address. It is 0x followed by 40 hex characters." });
  }
  const address = target;

  // §9: 30/min/address, counted exactly as the public challenge route counts it: per
  // (IP, address) under a per-IP cap, and a rebind's `step_up` in its own bucket
  // (CORE-4, PAY-12). Keyed on the address alone, any signed-in account could use up
  // the bucket for another creator's bound address and block that creator's rebind.
  await enforceAddressLimit(challengeLimit(current ? "step_up" : "address_proof"), clientIp(req), address);

  try {
    // Binding for the first time proves the new address (`address_proof`); changing a
    // bound address is a payout rebind and must be a `step_up` from the address bound
    // now — issued *naming the new address*, so the signature authorises this rebind
    // and no other (see lib/auth/step-up.ts `rebindContext`).
    const challenge = current
      ? await issueChallenge(address, "step_up", rebindContext(queued as string))
      : await issueChallenge(address, "address_proof");
    const url = new URL("/dashboard/wallet", appUrl());
    url.searchParams.set("address", address);
    url.searchParams.set("nonce", challenge.nonce);
    if (queued) url.searchParams.set("new", queued);
    return seeOther(url);
  } catch (e) {
    return back("/dashboard/wallet", {
      error: e instanceof ApiError ? e.message : "The challenge could not be issued. Try again.",
    });
  }
});
