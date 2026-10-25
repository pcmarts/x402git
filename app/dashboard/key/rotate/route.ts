/**
 * POST /dashboard/key/rotate — mint a new agent key for the signed-in creator (FR-4).
 *
 * Rotation breaks agents. That is what it is *for*: the old `x4c_live_…` starts getting
 * `401 invalid_key` the moment this returns, which is the point when the key has leaked
 * or the laptop holding it is gone. What it no longer does — FR-58, D14 — is break
 * anything else. The session cookie is not resealed and not consulted for a key: this
 * browser is on its own `session` row, and so is the creator's other laptop, so both
 * keep working. Before session keys the cookie carried this very key in plaintext, so
 * rotating had to sign the web out everywhere; that side-effect is gone with the epoch.
 *
 * The GitHub session is the proof, which FR-5 allows on Rail A. The new key goes into
 * the one-time sealed cookie and is shown once on `/dashboard/key` — never in the URL.
 */

import { NextResponse } from "next/server";
import { rotateAgentKey } from "@/lib/auth/api-key";
import { appUrl } from "@/lib/env";
import { handle } from "@/lib/errors";
import { requireActor } from "@/lib/web/dashboard";
import { agentKeyFor } from "@/lib/web/loaders";
import { cookieOptions, KEY_BOX_COOKIE, KEY_BOX_TTL_SEC, sealBox } from "@/lib/web/session";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: Request) => {
  const actor = await requireActor(req, "/dashboard/key");
  if (actor instanceof NextResponse) return actor;

  // Since 25 Oct 2026 the first key is made here too, not at sign-up (DECISIONS.md), so
  // the sentence has to know whether there was a key to revoke.
  const had = (await agentKeyFor(actor.creator.id)) !== null;
  const { key } = await rotateAgentKey(actor.creator.id);

  const base = appUrl();
  const url = new URL("/dashboard/key", base);
  url.searchParams.set("ok", had ? "New key issued. The old one no longer works." : "Key created.");
  const response = NextResponse.redirect(url, { status: 303 });
  response.cookies.set(KEY_BOX_COOKIE, sealBox(key), cookieOptions(KEY_BOX_TTL_SEC, base));
  response.headers.set("cache-control", "no-store");
  return response;
});
