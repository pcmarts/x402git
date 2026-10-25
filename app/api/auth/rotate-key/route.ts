/**
 * POST /api/auth/rotate-key — FR-4.
 *
 * Deliberately unauthenticated in the bearer sense: the whole point is to recover from
 * a key you no longer have, or no longer trust. The credential is a signature from the
 * bound payout address, which is what D11 makes the real identity. The old key stops
 * working the moment this returns.
 */

import { type NextRequest, NextResponse } from "next/server";
import { rotateAgentKey } from "@/lib/auth/api-key";
import { consumeChallenge, dbAddress, normaliseAddress } from "@/lib/auth/challenge";
import { clientIp, enforceAddressLimit } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import type { CreatorRow } from "@/lib/db/types";
import { ApiError, handle } from "@/lib/errors";
import { RotateKeyRequest, RotateKeyResponse } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest) => {
  const body = RotateKeyRequest.parse(await req.json());
  const address = normaliseAddress(body.address);
  // PAY-12: its own bucket, shared only with minting a `rotate_key` challenge, and keyed
  // per IP as well as per address. A stranger minting challenges in this creator's name
  // can no longer use up the limit that recovering from a leaked key depends on.
  await enforceAddressLimit("rotate_key", clientIp(req), dbAddress(address));

  // Verify first, then look up: a wrong signature must not reveal whether the address
  // is registered at all.
  await consumeChallenge(address, body.nonce, body.signature, "rotate_key");

  // Select by (handle, payout_address). A payout address may be shared across creators
  // (W3.8), so `.maybeSingle()` on the address alone would 500 on a collision; the handle
  // makes the lookup unambiguous, and the signed challenge proves the address (W2.5).
  const { data, error } = await db()
    .from("creator")
    .select("*")
    .eq("handle", body.handle)
    .eq("payout_address", dbAddress(address))
    .maybeSingle();
  if (error) throw error;
  const creator = data as CreatorRow | null;
  if (!creator) throw new ApiError("not_found", { message: "No creator with that handle is bound to that address." });

  // FR-58: this rotates the `agent` row and nothing else. Session keys are their own
  // rows (D14) and are not derived from this one, so the creator's browser sessions —
  // here and on any other machine — survive a rotation. Before session keys the cookie
  // carried this very key in plaintext, so rotation had to sign the web out too; it no
  // longer does, and the epoch counter that did it is retired ("PRD Session Keys.md").
  const { key, row } = await rotateAgentKey(creator.id);

  return NextResponse.json(
    RotateKeyResponse.parse({
      creator_id: creator.id,
      handle: creator.handle,
      api_key: key,
      api_key_scopes: row.scopes,
      rotated_at: new Date().toISOString(),
    }),
    { headers: { "cache-control": "no-store" } },
  );
});
