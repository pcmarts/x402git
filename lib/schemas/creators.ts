/**
 * lib/schemas/creators.ts — FR-2, FR-4, FR-5.
 *
 * POST /api/creators · GET/PATCH /api/creators/me · POST /api/auth/rotate-key
 */

import * as z from "zod";
import { Address, Email, Handle, HexSignature, HttpsUrl, IsoDateTime, Nonce, SignedChallenge } from "./common";

export const ApiScope = z.enum(["listings:write", "earnings:read"]).meta({ id: "ApiScope" });

export const WalletMode = z.enum(["linked", "custodial"]).meta({
  id: "WalletMode",
  description: "D12. `linked` is the only mode the API accepts; `custodial` is web-only, for GitHub-authenticated humans.",
});

export const OnboardedVia = z.enum(["web", "api"]).meta({ id: "OnboardedVia" });

/** FR-2. `Idempotency-Key` on the request replays the identical 201 for 24 hours. */
export const CreateCreatorRequest = z
  .object({
    handle: Handle,
    payout_address: Address,
    /** Proves control of `payout_address`. Unproved addresses are rejected `payout_address_unverified`. */
    address_proof: SignedChallenge,
    /** Must equal the `version` from GET /api/terms, or `terms_version_stale`. */
    accepted_terms_version: z.string().min(1),
    /** D2c: required in V0 whenever the server has invite codes configured. */
    invite_code: z.string().min(1).max(128).optional(),
    abuse_contact_url: HttpsUrl.optional(),
    abuse_contact_email: Email.optional(),
  })
  .meta({
    id: "CreateCreatorRequest",
    description:
      "Headless registration. The payout address must be an address you control and can sign from — exchange deposit addresses are unsupported.",
  });

export const CreateCreatorResponse = z
  .object({
    creator_id: z.uuid(),
    /** Shown once. Replayable for 24h with the same `Idempotency-Key`; otherwise rotate. */
    api_key: z.string(),
    handle: Handle,
    payout_address: Address,
    api_key_scopes: z.array(ApiScope),
    /** D6. Flat 10%, seller-side. */
    platform_fee_bps: z.number().int(),
    /** FR-27. */
    holdback_days: z.number().int(),
    terms_version: z.string(),
    created_at: IsoDateTime,
  })
  .meta({
    id: "CreateCreatorResponse",
    description: "`api_key` is shown exactly once. Store it before you make the next call.",
  });

export const CreatorMeResponse = z
  .object({
    creator_id: z.uuid(),
    handle: Handle,
    payout_address: Address,
    /** FR-5: set by a PATCH; takes effect at `rebind_effective_at` (48h). */
    pending_payout_address: Address.nullable(),
    rebind_effective_at: IsoDateTime.nullable(),
    wallet_mode: WalletMode,
    onboarded_via: OnboardedVia,
    api_key_scopes: z.array(ApiScope),
    abuse_contact_url: z.string().nullable(),
    abuse_contact_email: z.string().nullable(),
    pending_abuse_contact_url: z.string().nullable().optional(),
    pending_abuse_contact_email: z.string().nullable().optional(),
    terms_version: z.string(),
    terms_accepted_at: IsoDateTime,
    created_at: IsoDateTime,
    platform_fee_bps: z.number().int(),
    holdback_days: z.number().int(),
  })
  .meta({ id: "Creator", description: "The authenticated creator. Never includes the API key." });

/**
 * FR-5. A payout-address change requires `step_up` (a signature from the *current*
 * bound address) and takes effect after 48h; an abuse-contact change also takes 48h
 * and is announced to the pre-change contact.
 */
export const UpdateCreatorRequest = z
  .object({
    payout_address: Address.optional(),
    abuse_contact_url: HttpsUrl.nullable().optional(),
    abuse_contact_email: Email.nullable().optional(),
    step_up: SignedChallenge.optional(),
  })
  .refine((b) => b.payout_address !== undefined || b.abuse_contact_url !== undefined || b.abuse_contact_email !== undefined, {
    error: "nothing to change",
  })
  .meta({
    id: "UpdateCreatorRequest",
    description: "Step-up (a signature from the currently bound payout address) is required for every field here.",
  });

export const UpdateCreatorResponse = z
  .object({
    creator_id: z.uuid(),
    payout_address: Address,
    pending_payout_address: Address.nullable(),
    rebind_effective_at: IsoDateTime.nullable(),
    abuse_contact_url: z.string().nullable(),
    abuse_contact_email: z.string().nullable(),
    pending_abuse_contact_url: z.string().nullable().optional(),
    pending_abuse_contact_email: z.string().nullable().optional(),
    /** Non-null whenever a change was queued rather than applied. */
    effective_at: IsoDateTime.nullable(),
  })
  .meta({
    id: "UpdateCreatorResponse",
    description: "Sweeps continue to the old address until `rebind_effective_at` passes (§7.6).",
  });

/** FR-4: rotate without the old key. The signature proves the bound payout address. */
export const RotateKeyRequest = z
  .object({ handle: Handle, address: Address, nonce: Nonce, signature: HexSignature })
  .meta({
    id: "RotateKeyRequest",
    description:
      "No Authorization header is required: the wallet signature is the credential. `handle` disambiguates which creator, since a payout address may be shared (W2.5).",
  });

export const RotateKeyResponse = z
  .object({
    creator_id: z.uuid(),
    handle: Handle,
    api_key: z.string(),
    api_key_scopes: z.array(ApiScope),
    rotated_at: IsoDateTime,
  })
  .meta({ id: "RotateKeyResponse", description: "The previous key is revoked the moment this returns." });

export type CreateCreatorInput = z.infer<typeof CreateCreatorRequest>;
export type UpdateCreatorInput = z.infer<typeof UpdateCreatorRequest>;
export type RotateKeyInput = z.infer<typeof RotateKeyRequest>;
