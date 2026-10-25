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
 * route with one more proof. Adding a second payout address takes the step-up from the
 * identity address *and* a SEP-53 signature from the new `G…`, plus type-to-confirm, and
 * is live at once — both keys signed, and nothing already bound is redirected. Changing
 * the Stellar address keeps the 48-hour delay. The account must hold an authorised
 * trustline in the configured asset (`lib/auth/stellar-binding.ts`) or nothing is written.
 *
 * The mirror (C4): a Stellar-only account adds an EVM address with `payout_address` plus
 * `payout_proof` from the new `0x…`, the step-up from the bound `G…` and type-to-confirm.
 * Also live at once. The EVM address becomes the identity and the `G…` stays the Stellar
 * payout address, which is the row an EVM creator who added Stellar (C3) has, and the row
 * the 48-hour rebind without a proof already ends in when the sweep promotes it.
 */

import { type NextRequest, NextResponse } from "next/server";
import { type AuthedCreator, requireCreator } from "@/lib/auth/api-key";
import { dbAddress, normaliseAddress } from "@/lib/auth/challenge";
import { enforceLimit } from "@/lib/auth/rate-limit";
import { confirmsAddress, inspectStellarPayoutAccount, stellarBindPatch } from "@/lib/auth/stellar-binding";
import { rebindContext, rebindEffectiveAt, requireStepUp } from "@/lib/auth/step-up";
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

  // FR-5: every field on this route is a step-up field. A payout rebind additionally
  // binds the signature to the incoming address (`rebindContext`): the challenge must
  // have been minted naming it, so a phished generic step-up cannot redirect earnings.
  // The Stellar address is a payout rebind in that sense too: the step-up names the G….
  const rebindTo = body.payout_address !== undefined ? normaliseAddress(body.payout_address) : null;
  const stellarTo = body.stellar_payout_address !== undefined ? normaliseAddress(body.stellar_payout_address) : null;

  // JOURNEYS C4: the only `payout_address` that can land at once is an EVM address added
  // to a Stellar-only account, proved by its own signature. Anything else is a change.
  const identityFamily = addressFamily(creator.payout_address);
  const addingEvm = rebindTo !== null && body.payout_proof !== undefined;
  if (addingEvm && (identityFamily !== "stellar" || addressFamily(rebindTo) !== "evm")) {
    throw new ApiError("invalid_request", {
      message: "payout_proof is only for adding an EVM address to a Stellar-only account. To change the EVM address, send payout_address alone; it takes effect after 48 hours.",
      details: { field: "payout_proof" },
    });
  }
  // An EVM account keeps an EVM payout_address: moving it to a G… would take Base off every
  // listing. A Stellar wallet is `stellar_payout_address`.
  if (rebindTo !== null && identityFamily === "evm" && addressFamily(rebindTo) !== "evm") {
    throw new ApiError("invalid_request", {
      message: "This account is paid on Base at an EVM address, so payout_address must stay an EVM address. Add or change a Stellar wallet with stellar_payout_address.",
      details: { field: "payout_address" },
    });
  }

  // Type-to-confirm comes before any signature is spent: a typo is the cheapest thing to
  // bounce on, and both nonces stay usable for the retry.
  if (stellarTo !== null && !confirmsAddress(body.confirm_address, stellarTo)) {
    throw new ApiError("invalid_request", {
      message: "confirm_address must be the Stellar address being bound, or its last six characters.",
      details: { field: "confirm_address" },
    });
  }
  if (addingEvm && !confirmsAddress(body.confirm_address, rebindTo)) {
    throw new ApiError("invalid_request", {
      message: "confirm_address must be the EVM address being added, or its last six characters.",
      details: { field: "confirm_address" },
    });
  }

  const stepUpTarget = rebindTo ?? stellarTo;
  await requireStepUp(creator, body.step_up, stepUpTarget ? rebindContext(stepUpTarget) : null);

  const now = new Date();
  const effectiveAt = rebindEffectiveAt(now);
  const patch: Record<string, unknown> = {};
  let stellarEffectiveAt: string | null = null;

  if (stellarTo !== null) {
    // JOURNEYS C3 step 3: the new account proves itself. The step-up above proved the
    // owner; this proves the destination, so a mistyped or pasted-from-elsewhere G… can
    // never be bound. Purpose `address_proof`, the same as a first bind.
    if (!body.stellar_proof) {
      throw new ApiError("payout_address_unverified", {
        message: "stellar_proof is required: a SEP-53 signature from the Stellar account being bound.",
        details: { how: "GET /api/auth/challenge?address=<G…>&purpose=address_proof, sign `message` with that account (Freighter signMessage), resend as stellar_proof: { nonce, signature }." },
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
    if (addingEvm && body.payout_proof) {
      // C4: the new EVM address proves itself, as the G… does in C3.
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
      patch.pending_payout_address = dbAddress(next);
      patch.rebind_effective_at = effectiveAt.toISOString();
    }
  }

  if (body.abuse_contact_url !== undefined || body.abuse_contact_email !== undefined) {
    if (body.abuse_contact_url !== undefined) patch.pending_abuse_contact_url = body.abuse_contact_url;
    if (body.abuse_contact_email !== undefined) patch.pending_abuse_contact_email = body.abuse_contact_email;
    patch.abuse_contact_effective_at = effectiveAt.toISOString();
  }

  const { data, error } = await db().from("creator").update(patch).eq("id", creator.id).select("*").single();
  if (error) throw error;
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
      effective_at: stellarTo !== null && rebindTo === null ? stellarEffectiveAt : iso(updated.rebind_effective_at ?? updated.abuse_contact_effective_at),
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
