/**
 * POST /api/creators — FR-2. Headless registration.
 *
 * The whole of §7.2 step 3 in one handler, in the order the failures should surface:
 * rate limit, replay, shape, terms, invite, proof of the payout address, sanctions,
 * then the insert. The API key is returned exactly once; `Idempotency-Key` replays the
 * identical 201 for 24 hours so a dropped response does not strand the creator.
 *
 * The address proof is the load-bearing part. D11 makes the wallet the identity and
 * §14.7 assumes the API key will leak, so an unproved payout address would let anyone
 * register earnings to an address they do not control.
 */

import { type NextRequest, NextResponse } from "next/server";
import { DEFAULT_SCOPES, insertApiKey } from "@/lib/auth/api-key";
import { consumeChallenge, dbAddress, normaliseAddress } from "@/lib/auth/challenge";
import { clientIp, enforceLimit } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import type { CreatorRow } from "@/lib/db/types";
import { holdbackDays, inviteCodes, platformFeeBps, termsVersion } from "@/lib/env";
import { record } from "@/lib/events";
import { isPaused } from "@/lib/ops/switches";
import { ApiError, handle, isApiError } from "@/lib/errors";
import { idempotencyKeyFrom, recordIdempotent, replayIdempotent } from "@/lib/idempotency";
import { notifyAdmin } from "@/lib/notify";
import { CreateCreatorRequest, CreateCreatorResponse } from "@/lib/schemas";
import { screen } from "@/lib/screening";

export const dynamic = "force-dynamic";

const ROUTE = "POST /api/creators";

export const POST = handle(async (req: NextRequest) => {
  // §9: 5 per hour per IP.
  await enforceLimit("registration", clientIp(req));

  const raw = await req.json();
  const idempotencyKey = idempotencyKeyFrom(req);

  const prior = await replayIdempotent(ROUTE, idempotencyKey, raw);
  if (prior) {
    return NextResponse.json(prior.response, { status: prior.status, headers: { "idempotency-replayed": "true" } });
  }

  // §19 kill switch, after the idempotency replay above: a retried call to a
  // registration that already succeeded still replays its 201, because that is a
  // response we already gave and pausing does not retract it. Only a new registration
  // is stopped.
  if (await isPaused("registrations")) {
    await record({ name: "paused_block", props: { switch: "registrations", rail: "api" } });
    throw new ApiError("paused");
  }

  const body = CreateCreatorRequest.parse(raw);

  // FR-6: a stale version must be re-accepted before anything else happens.
  const currentTerms = termsVersion();
  if (body.accepted_terms_version !== currentTerms) {
    throw new ApiError("terms_version_stale", {
      message: `The current terms version is ${currentTerms}. Fetch GET /api/terms and accept that version.`,
      details: { accepted: body.accepted_terms_version, current: currentTerms },
    });
  }

  // D2c: the invite gate applies only when codes are configured.
  const codes = inviteCodes();
  if (codes.length > 0 && (!body.invite_code || !codes.includes(body.invite_code))) {
    throw new ApiError("invite_required");
  }

  // FR-2: prove control of the payout address, or no registration.
  const payoutAddress = normaliseAddress(body.payout_address);
  try {
    await consumeChallenge(payoutAddress, body.address_proof.nonce, body.address_proof.signature, "address_proof");
  } catch (e) {
    const message = isApiError(e) ? (e as ApiError).message : "The address proof could not be verified.";
    throw new ApiError("payout_address_unverified", {
      message,
      details: { how: "GET /api/auth/challenge?address=<payout_address>&purpose=address_proof, sign `message`, resend as address_proof." },
    });
  }

  // FR-38: screen at bind, unconditionally.
  const screening = await screen(payoutAddress, "bind");
  if (screening.hit) throw new ApiError("sanctioned_counterparty");

  const { data, error } = await db()
    .from("creator")
    .insert({
      handle: body.handle,
      onboarded_via: "api",
      wallet_mode: "linked",
      payout_address: dbAddress(payoutAddress),
      abuse_contact_url: body.abuse_contact_url ?? null,
      abuse_contact_email: body.abuse_contact_email ?? null,
      terms_version: currentTerms,
    })
    .select("*")
    .single();

  if (error) {
    // 23505 = unique_violation. The only unique columns a caller controls is `handle`.
    if (error.code === "23505") {
      throw new ApiError("invalid_request", { message: "That handle is taken.", details: { field: "handle" } });
    }
    throw error;
  }

  const creator = data as CreatorRow;

  // FR-54: the key is its own row now, so registration is two writes. If this one fails
  // the error surfaces as a 5xx and no 201 is recorded — a creator row with no agent key
  // is recoverable (POST /api/auth/rotate-key mints one from a wallet signature), a 201
  // carrying a key that was never stored is not. Deliberately not swallowed into a
  // "registered, but here is no key" success.
  const { key, row } = await insertApiKey(creator.id, "agent", DEFAULT_SCOPES, null);

  const payload = CreateCreatorResponse.parse({
    creator_id: creator.id,
    api_key: key,
    handle: creator.handle,
    payout_address: normaliseAddress(creator.payout_address),
    api_key_scopes: row.scopes,
    platform_fee_bps: Number(platformFeeBps()),
    holdback_days: holdbackDays(),
    terms_version: creator.terms_version,
    created_at: new Date(creator.created_at).toISOString(),
  });

  // The 201 carries the one plaintext copy of the key, so it is sealed before it is
  // stored: `api_key` rows keep only a hash, and this table must not undo that.
  await recordIdempotent(ROUTE, idempotencyKey, raw, 201, payload, creator.id, ["api_key"]);

  // ADMIN-NOTIFICATIONS.md, 13 Sep 2026. Below the replay above, so a retried
  // `Idempotency-Key` buzzes the phone once and not once per retry — the registration it
  // reports happened only the first time. Never throws, so no try/catch (lib/events.ts).
  await notifyAdmin({ kind: "creator_joined", via: "api", handle: creator.handle, creatorId: creator.id, walletMode: creator.wallet_mode });

  return NextResponse.json(payload, { status: 201, headers: { "cache-control": "no-store" } });
});
