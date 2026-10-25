/**
 * lib/web/onboard.ts — creating a creator from the web (FR-1).
 *
 * ## Why this is not a call to `POST /api/creators`
 *
 * D9 makes the website a client of the API, and every *mutation* on the dashboard is.
 * This one is the exception, and the reason is in the route itself. `POST /api/creators`
 * is FR-2 — headless registration — and it hard-codes three things this path must not
 * do: `onboarded_via: "api"`, no `github_user_id`, and D2c's invite gate, which exists
 * to slow down anonymous API registration and has nothing to say to a human who just
 * proved a GitHub account. There is no route in §9 for the web half of FR-1.
 *
 * So this module does the same work with the same primitives — `consumeChallenge`,
 * `screen`, `insertApiKey`, `termsVersion` — and differs only in the three columns that
 * have to differ. Nothing about entitlement or money is decided here.
 * Recorded in DECISIONS.md.
 *
 * ## Why two keys come out of one write
 *
 * D14 ("PRD Session Keys.md"): a creator has an `agent` key their programmes hold and a
 * `session` key per browser session. Binding a wallet is both events at once — the
 * account comes into existence and the human is sitting in front of it — so it mints
 * both. The agent key is shown once and never again; the session key goes into the
 * sealed cookie and is never shown at all (FR-55).
 *
 * ## Why the creator row is not written until a wallet is bound
 *
 * `creator.payout_address` is `NOT NULL` and FR-26 sends every payout to it, so a
 * placeholder would be an address the platform chose for someone else's money. Between
 * signing in with GitHub and binding a wallet, the identity lives in the session cookie
 * and nowhere else.
 *
 * ## Why one function binds either kind of wallet
 *
 * 25 Oct 2026 (HACKMERIDIAN-JOURNEYS C2, BUILD H5): a creator with only Freighter signs
 * the same challenge as SEP-53, and the `G…` becomes `payout_address` — the identity —
 * exactly as an EVM address would. The only Stellar-specific step is the trustline: a
 * classic payment to an account that has not allowed the asset fails, so Horizon is read
 * first and the bind is refused, with the Freighter steps spelled out, until the trustline
 * exists. The `G…` is also written to `stellar_payout_address` so the money core and the
 * dashboard see one Stellar address wherever they look.
 */

import { DEFAULT_SCOPES, insertApiKey } from "@/lib/auth/api-key";
import { consumeChallenge, dbAddress, normaliseAddress } from "@/lib/auth/challenge";
import { type InspectedStellarAccount, inspectStellarPayoutAccount } from "@/lib/auth/stellar-binding";
import { db } from "@/lib/db";
import type { CreatorRow } from "@/lib/db/types";
import { termsVersion } from "@/lib/env";
import { ApiError } from "@/lib/errors";
import { record } from "@/lib/events";
import { notifyAdmin } from "@/lib/notify";
import { isPaused } from "@/lib/ops/switches";
import { screen } from "@/lib/screening";
import { addressFamily } from "@/lib/x402/stellar";
import { handleCandidates } from "./github-oauth";
import { creatorByHandle } from "./loaders";

export type OnboardInput = {
  github: { id: number; login: string };
  address: string;
  nonce: string;
  signature: string;
  /**
   * FR-55: the session key's `expires_at`, which must be the sealed cookie's `exp`. The
   * caller owns the cookie, so it owns the instant — `sessionExpiresAt(now)` and
   * `newSession(…, now)` in `lib/web/session.ts` agree by construction.
   */
  sessionExpiresAt: string;
};

export type OnboardResult = {
  creator: CreatorRow;
  /** `x4c_live_…`. Shown to the creator exactly once, then only its hash exists. */
  agentKey: string;
  /** `x4s_live_…`. Goes straight into the sealed cookie; the creator never sees it. */
  sessionKey: string;
};

/**
 * Bind a payout address and create the creator. Throws catalogue errors, which the
 * calling route handler renders back on the form.
 */
export async function createCreatorFromGithub(input: OnboardInput): Promise<OnboardResult> {
  // §19 kill switch. The web rail is a second door into the same room as
  // POST /api/creators, so it carries the same switch; pausing one and not the other
  // would be a pause that a sign-in link walks straight through.
  if (await isPaused("registrations")) {
    await record({ name: "paused_block", props: { switch: "registrations", rail: "web" } });
    throw new ApiError("paused");
  }

  const address = normaliseAddress(input.address);
  const stellar = addressFamily(address) === "stellar";

  // The trustline is checked *before* the nonce is spent: a missing trustline is the
  // common first-time stall (BATTLE-TEST finding 18), and it is the creator's to fix in
  // Freighter, not a reason to make them sign again. Nothing is written either way.
  const inspected: InspectedStellarAccount | null = stellar ? await inspectStellarPayoutAccount(address, { now: new Date() }) : null;

  // FR-2's rule applies on both rails: an unproved payout address is never bound.
  try {
    await consumeChallenge(address, input.nonce, input.signature, "address_proof");
  } catch (e) {
    throw new ApiError("payout_address_unverified", {
      message: e instanceof ApiError ? e.message : "That signature does not match the challenge for that address.",
    });
  }

  // FR-38: screen at bind, unconditionally.
  const screening = await screen(address, "bind");
  if (screening.hit) throw new ApiError("sanctioned_counterparty");

  const handle = await availableHandle(input.github.login);

  const { data, error } = await db()
    .from("creator")
    .insert({
      handle,
      github_user_id: String(input.github.id),
      onboarded_via: "web",
      // D12: `custodial` is out of scope for V0. Every web creator is `linked`.
      wallet_mode: "linked",
      payout_address: dbAddress(address),
      terms_version: termsVersion(),
      // BUILD §2.5: a Stellar identity is also the Stellar payout address, with the
      // trustline check that proved it payable.
      ...(inspected
        ? { stellar_payout_address: address, stellar_payout_meta: inspected.meta, stellar_payout_verified_at: inspected.verifiedAt }
        : {}),
    })
    .select("*")
    .single();

  if (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new ApiError("invalid_request", { message: "That GitHub account or handle is already registered. Sign in again." });
    }
    throw error;
  }

  // FR-54: keys are their own rows, so they are written after the creator exists rather
  // than as columns on it. Agent first: it is the one the creator is about to be shown,
  // and the one the partial unique index has an opinion about.
  const creator = data as CreatorRow;
  const agent = await insertApiKey(creator.id, "agent", DEFAULT_SCOPES, null);
  const session = await insertApiKey(creator.id, "session", DEFAULT_SCOPES, input.sessionExpiresAt);

  // ADMIN-NOTIFICATIONS.md, 13 Sep 2026. Last, after both keys: an account that failed
  // half-way is not a signup worth announcing. No try/catch — `notifyAdmin` never throws
  // and has a 3 s ceiling, the same discipline `record` keeps in lib/events.ts.
  await notifyAdmin({ kind: "creator_joined", via: "web", handle: creator.handle, creatorId: creator.id, walletMode: creator.wallet_mode });

  return { creator, agentKey: agent.key, sessionKey: session.key };
}

/**
 * FR-3. The GitHub login first; a suffixed form only when the plain one already belongs
 * to somebody else. A handle held by a creator with the *same* GitHub id cannot happen
 * here — the caller checks `github_user_id` before calling.
 */
async function availableHandle(login: string): Promise<string> {
  for (const candidate of handleCandidates(login)) {
    const existing = await creatorByHandle(candidate);
    if (!existing) return candidate;
  }
  throw new ApiError("invalid_request", { message: "Every handle derived from that GitHub login is taken. Register through the API with a handle of your choosing." });
}
