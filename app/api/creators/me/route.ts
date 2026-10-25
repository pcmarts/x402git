/**
 * GET/PATCH /api/creators/me — FR-5.
 *
 * Both changes here are deliberately slow. A payout address change and an abuse
 * contact change are exactly what an attacker with a stolen API key would do first, so
 * each needs a signature from the *currently bound* payout address (which a bearer key
 * cannot produce, §14.7) and each takes 48 hours to land. Sweeps continue to the old
 * address throughout. Nothing is sent to anyone yet: FR-5's announcement to the old abuse
 * contact has no sender (RED-TEAM-2026-09-21.md PAY-10), and no page may claim one.
 *
 * The Stellar payout address (25 Oct 2026, HACKMERIDIAN-JOURNEYS C3–C5) rides the same
 * route with one more proof: a SEP-53 signature from the new `G…` itself. Adding it is
 * live at once; changing it keeps the 48-hour delay. The account must hold an authorised
 * trustline in the configured asset (`lib/auth/stellar-binding.ts`) or nothing is written.
 *
 * The mirror (C4): a Stellar-only account adds an EVM address with `payout_address` plus
 * `payout_proof` from the new `0x…`. Also live at once. The EVM address becomes the
 * identity and the `G…` stays the Stellar payout address, which is the row an EVM creator
 * who added Stellar (C3) has, and the row the 48-hour rebind without a proof already ends
 * in when the sweep promotes it.
 *
 * Adding versus changing (25 Oct 2026, ~21:30, HackMeridian; the founder: "lets not have
 * the confirm the last 6 digits of your evm wallet - a lot of hassle. Do we need to have
 * the stellar wallet confirm? Feels needless."). Adding a rail the account has no address
 * on yet (C3, C4) takes only the new wallet's own proof when it comes from the dashboard's
 * session key: no step-up from the other wallet, no type-to-confirm. The proof already
 * shows control of the destination, the session is a signed-in GitHub session, and
 * nothing already flowing is redirected — the new rail had no money on it. The accepted
 * risk: a stolen GitHub session could add a payout address for a rail the creator had not
 * yet opened. An agent key still sends both for an addition: §14.7 assumes that key
 * leaks, and the case above rests on a GitHub sign-in it does not have. A `step_up`
 * sent on an addition is still verified, and the write only lands while
 * the rail is still empty, so an addition can never overwrite an address that appeared
 * while the request was in flight.
 *
 * Changing an address (C5, either family) is the step-up from the wallet bound now,
 * naming the new address — money already flowing is what it protects — plus, when the
 * dashboard sends one, the new address's own proof. Since 25 Oct 2026, 23:30 (founder:
 * "remove the 48 hour delay … make it instant"; "drop that requirement" on the typed
 * characters) nothing is typed to confirm, and the change lands at once unless the
 * deployment runs a rebind delay (`payoutRebindDelayHours`, lib/auth/step-up.ts), in
 * which case it is queued and the sweep promotes it as before. `confirm_address` is
 * accepted and ignored so older clients keep working.
 */

import { type NextRequest, NextResponse } from "next/server";
import { type AuthedCreator, requireCreator } from "@/lib/auth/api-key";
import { dbAddress, normaliseAddress } from "@/lib/auth/challenge";
import { enforceLimit } from "@/lib/auth/rate-limit";
import { inspectStellarPayoutAccount, railBeingAdded, stellarBindPatch } from "@/lib/auth/stellar-binding";
import { payoutRebindEffectiveAt, rebindContext, rebindEffectiveAt, requireStepUp } from "@/lib/auth/step-up";
import { consumeChallenge } from "@/lib/auth/challenge";
import { db } from "@/lib/db";
import type { CreatorRow } from "@/lib/db/types";
import { holdbackDays, platformFeeBps } from "@/lib/env";
import { ApiError, handle } from "@/lib/errors";
import { CreatorMeResponse, UpdateCreatorRequest, UpdateCreatorResponse } from "@/lib/schemas";
import { screen } from "@/lib/screening";
import { addressFamily } from "@/lib/x402/stellar";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  const creator = await requireCreator(req);
  return NextResponse.json(profile(creator), { headers: { "cache-control": "no-store" } });
});

export const PATCH = handle(async (req: NextRequest) => {
  const creator = await requireCreator(req);
  await enforceLimit("creator_write", creator.id);

  const body = UpdateCreatorRequest.parse(await req.json());

  // FR-5: every field on this route is a step-up field, bar opening an empty payout rail
  // from the dashboard (header, and `proofAlone` below). A payout rebind additionally
  // binds the signature to the incoming address (`rebindContext`): the challenge must
  // have been minted naming it, so a phished generic step-up cannot redirect earnings.
  // The Stellar address is a payout rebind in that sense too: the step-up names the G….
  const rebindTo = body.payout_address !== undefined ? normaliseAddress(body.payout_address) : null;
  const stellarTo = body.stellar_payout_address !== undefined ? normaliseAddress(body.stellar_payout_address) : null;

  // JOURNEYS C4: an EVM address proved by its own signature on a Stellar-only account is
  // an addition. The same proof on an EVM account is a change that also proves its
  // destination (25 Oct 2026, 23:30: the dashboard's change flow connects the new wallet,
  // so it signs); the step-up below still decides whether the change may happen.
  const identityFamily = addressFamily(creator.payout_address);
  const provesEvm = rebindTo !== null && body.payout_proof !== undefined;
  const addingEvm = provesEvm && identityFamily === "stellar" && addressFamily(rebindTo) === "evm";
  // An EVM account keeps an EVM payout_address: moving it to a G… would take Base off every
  // listing. A Stellar wallet is `stellar_payout_address`.
  if (rebindTo !== null && identityFamily === "evm" && addressFamily(rebindTo) !== "evm") {
    throw new ApiError("invalid_request", {
      message: "This account is paid on Base at an EVM address, so payout_address must stay an EVM address. Add or change a Stellar wallet with stellar_payout_address.",
      details: { field: "payout_address" },
    });
  }

  // 25 Oct 2026 (header): opening an empty rail from the dashboard is the new wallet's
  // proof alone. Never when an abuse-contact change rides along, which is a step-up field.
  const adding = railBeingAdded(creator, body);
  const proofAlone =
    adding !== null && creator.apiKey.kind === "session" && body.abuse_contact_url === undefined && body.abuse_contact_email === undefined;

  // Nothing is typed to confirm an address (25 Oct 2026, 23:30, founder): the new
  // wallet's own signature is the proof of the destination.

  const stepUpTarget = rebindTo ?? stellarTo;
  if (!proofAlone || body.step_up !== undefined) {
    await requireStepUp(creator, body.step_up, stepUpTarget ? rebindContext(stepUpTarget) : null);
  }

  const now = new Date();
  const effectiveAt = rebindEffectiveAt(now);
  const patch: Record<string, unknown> = {};
  let stellarEffectiveAt: string | null = null;

  if (stellarTo !== null) {
    // JOURNEYS C3 step 3: the new account proves itself. The step-up above, when one is
    // due, proved the owner; this proves the destination, so a mistyped or
    // pasted-from-elsewhere G… can never be bound. Purpose `address_proof`, as a first bind.
    if (!body.stellar_proof) {
      throw new ApiError("payout_address_unverified", {
        message: "stellar_proof is required: a SEP-53 signature from the Stellar account being bound.",
        details: { how: "GET /api/auth/challenge?address=<G…>&purpose=address_proof, sign `message` with that account (your wallet's SEP-43 signMessage, e.g. Freighter), resend as stellar_proof: { nonce, signature }." },
      });
    }
    // Horizon before the proof: a missing trustline is the creator's to fix in Freighter,
    // and should not cost them the signature they just made.
    const inspected = await inspectStellarPayoutAccount(stellarTo, { now });
    try {
      await consumeChallenge(stellarTo, body.stellar_proof.nonce, body.stellar_proof.signature, "address_proof");
    } catch (e) {
      throw new ApiError("payout_address_unverified", { message: e instanceof ApiError ? e.message : "The Stellar proof could not be verified." });
    }
    // FR-38: screening records the address (unscreened on this rail, finding 16).
    const screening = await screen(stellarTo, "bind");
    if (screening.hit) throw new ApiError("sanctioned_counterparty");

    const outcome = stellarBindPatch(creator, inspected, now);
    Object.assign(patch, outcome.patch);
    stellarEffectiveAt = outcome.effectiveAt;
  }

  if (rebindTo !== null) {
    const next = rebindTo;
    if (dbAddress(next) === dbAddress(creator.payout_address)) {
      throw new ApiError("invalid_request", { message: "That is already the bound payout address." });
    }
    if (addingEvm && creator.pending_payout_address) {
      throw new ApiError("invalid_request", { message: "A payout address change is already queued. Add the EVM address after it takes effect." });
    }
    if (body.payout_proof) {
      // C4, and a change from the dashboard: the new EVM address proves itself, as the G… does in C3.
      try {
        await consumeChallenge(next, body.payout_proof.nonce, body.payout_proof.signature, "address_proof");
      } catch (e) {
        throw new ApiError("payout_address_unverified", { message: e instanceof ApiError ? e.message : "The EVM proof could not be verified." });
      }
    }
    // FR-38: screen the incoming address before it can ever receive a sweep.
    const screening = await screen(next, "bind");
    if (screening.hit) throw new ApiError("sanctioned_counterparty");

    if (addingEvm) {
      patch.payout_address = dbAddress(next);
      patch.pending_payout_address = null;
      patch.rebind_effective_at = null;
      // The G… that was the identity keeps being paid on Stellar. A web sign-up already
      // wrote it here (BUILD §2.5); a row seeded without it would otherwise lose the rail.
      if (!creator.stellar_payout_address) patch.stellar_payout_address = creator.payout_address;
    } else {
      // A change: at once, or queued when the deployment runs a rebind delay (header).
      const landsAt = payoutRebindEffectiveAt(now);
      if (landsAt === null) {
        patch.payout_address = dbAddress(next);
        patch.pending_payout_address = null;
        patch.rebind_effective_at = null;
      } else {
        patch.pending_payout_address = dbAddress(next);
        patch.rebind_effective_at = landsAt.toISOString();
      }
    }
  }

  if (body.abuse_contact_url !== undefined || body.abuse_contact_email !== undefined) {
    if (body.abuse_contact_url !== undefined) patch.pending_abuse_contact_url = body.abuse_contact_url;
    if (body.abuse_contact_email !== undefined) patch.pending_abuse_contact_email = body.abuse_contact_email;
    patch.abuse_contact_effective_at = effectiveAt.toISOString();
  }

  // An addition lands only on a rail that is still empty. Without this, a request that read
  // the row before another one bound the rail would overwrite that address with no step-up.
  let write = db().from("creator").update(patch).eq("id", creator.id);
  if (adding === "stellar") write = write.is("stellar_payout_address", null);
  if (adding === "evm") write = write.eq("payout_address", creator.payout_address);
  const { data, error } = await write.select("*").maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new ApiError("invalid_request", {
      message: "That rail got a payout address while this request was being signed, so nothing was changed. Reload the wallet page: changing it now is signed off by the wallet bound now.",
    });
  }
  const updated = data as CreatorRow;

  return NextResponse.json(
    UpdateCreatorResponse.parse({
      creator_id: updated.id,
      payout_address: normaliseAddress(updated.payout_address),
      pending_payout_address: updated.pending_payout_address ? normaliseAddress(updated.pending_payout_address) : null,
      rebind_effective_at: iso(updated.rebind_effective_at),
      stellar_payout_address: updated.stellar_payout_address ?? null,
      pending_stellar_payout_address: updated.pending_stellar_payout_address ?? null,
      stellar_rebind_effective_at: iso(updated.stellar_rebind_effective_at),
      abuse_contact_url: updated.abuse_contact_url,
      abuse_contact_email: updated.abuse_contact_email,
      pending_abuse_contact_url: updated.pending_abuse_contact_url,
      pending_abuse_contact_email: updated.pending_abuse_contact_email,
      // Non-null only when something was queued: a Stellar *addition* is applied, not queued.
      effective_at:
        stellarTo !== null && rebindTo === null
          ? stellarEffectiveAt
          : iso(updated.rebind_effective_at ?? (body.abuse_contact_url !== undefined || body.abuse_contact_email !== undefined ? updated.abuse_contact_effective_at : null)),
    }),
    { headers: { "cache-control": "no-store" } },
  );
});

function profile(creator: AuthedCreator) {
  return CreatorMeResponse.parse({
    creator_id: creator.id,
    handle: creator.handle,
    payout_address: normaliseAddress(creator.payout_address),
    pending_payout_address: creator.pending_payout_address ? normaliseAddress(creator.pending_payout_address) : null,
    rebind_effective_at: iso(creator.rebind_effective_at),
    stellar_payout_address: creator.stellar_payout_address ?? null,
    pending_stellar_payout_address: creator.pending_stellar_payout_address ?? null,
    stellar_rebind_effective_at: iso(creator.stellar_rebind_effective_at),
    stellar_payout_verified_at: iso(creator.stellar_payout_verified_at),
    wallet_mode: creator.wallet_mode,
    onboarded_via: creator.onboarded_via,
    // FR-54/FR-56: scopes belong to the key that authenticated this request, not to the
    // creator — an agent key and a session key can carry different ones.
    api_key_scopes: creator.apiKey.scopes,
    abuse_contact_url: creator.abuse_contact_url,
    abuse_contact_email: creator.abuse_contact_email,
    pending_abuse_contact_url: creator.pending_abuse_contact_url,
    pending_abuse_contact_email: creator.pending_abuse_contact_email,
    terms_version: creator.terms_version,
    terms_accepted_at: iso(creator.terms_accepted_at),
    created_at: iso(creator.created_at),
    platform_fee_bps: Number(platformFeeBps()),
    holdback_days: holdbackDays(),
  });
}

function iso(value: string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}
