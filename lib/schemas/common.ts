/**
 * lib/schemas/common.ts — the primitives every other schema is built from.
 *
 * Two rules that the rest of the codebase depends on:
 *
 * 1. **Money crosses JSON as a decimal string of an integer** (`"9000000"`), never as
 *    a JSON number. A JSON number is a double; a lifetime ledger total will eventually
 *    exceed 2^53 and there is no error when it does, only a wrong number. Parse with
 *    `micro.parse` into a bigint at the edge, serialise with `micro.serialize` on the
 *    way out. See DECISIONS.md.
 * 2. **Every exported schema carries `.meta({ id })`** so `lib/openapi.ts` can name it
 *    as a `#/components/schemas/<id>` component instead of inlining it (FR-33).
 */

import * as z from "zod";

// --- money -------------------------------------------------------------------

/** Micro-USDC (6 decimals) as a decimal integer string. */
export const MicroUsdc = z
  .string()
  .regex(/^\d+$/, "must be a non-negative integer in micro-USDC, as a string")
  .meta({
    id: "MicroUsdc",
    title: "Micro-USDC",
    description: "An amount in micro-USDC (6 decimals) encoded as a decimal integer string. 9000000 = $9.00.",
    examples: ["9000000"],
  });

export const micro = {
  /** JSON string (or bigint/safe integer) → bigint. Throws on anything else. */
  parse(v: string | number | bigint): bigint {
    if (typeof v === "bigint") return v;
    if (typeof v === "number") {
      if (!Number.isSafeInteger(v)) throw new TypeError("micro.parse: not a safe integer (money is never a float)");
      return BigInt(v);
    }
    const s = v.trim();
    if (!/^-?\d+$/.test(s)) throw new TypeError("micro.parse: not an integer string");
    return BigInt(s);
  },
  /** bigint → the JSON string form. */
  serialize(v: bigint | number): string {
    if (typeof v === "number") {
      if (!Number.isSafeInteger(v)) throw new TypeError("micro.serialize: not a safe integer");
      return String(v);
    }
    return v.toString();
  },
} as const;

/**
 * D2b: technical minimum $0.01. Never surfaced as a *suggestion* — no preset, no
 * placeholder, no default, anywhere. Since 2026-09-01 it may be stated as a constraint
 * under a custom-price field the creator has already opened (FR-12), which is where the
 * listing dashboard reads it from rather than typing the number, and it binds a *typed*
 * update price too — `actions/save` calls `validatePrice` on it when `update_choice` is
 * `custom`. `UpdatePriceMicro` itself still carries no minimum, because the $0 preset is
 * lifetime access (D1) and has to keep crossing the API.
 */
export const MIN_PRICE_MICRO = 10_000n;

/** D2a. Order matters: these are rendered as presets in this order. The $0 preset
 * left on 2026-08-31 (founder): a release is never free, so the first purchase
 * always costs something. Updates keep their $0 — that one is lifetime access. */
export const PRICE_PRESETS_MICRO = [1_000_000n, 5_000_000n, 9_000_000n, 19_000_000n] as const;
export const UPDATE_PRICE_PRESETS_MICRO = [0n, 3_000_000n, 5_000_000n, 9_000_000n] as const;
export const DEFAULT_PRICE_MICRO = 9_000_000n;
export const DEFAULT_UPDATE_PRICE_MICRO = 5_000_000n;

/**
 * A price a creator may set: ≥ $0.01, never 0. The $0 release left on 2026-08-31
 * (founder): the first purchase always costs something, so a listing cannot exist
 * only to farm links. Rows saved as 0 before that date keep serving (FR-24); they
 * just cannot be set that way again. The DB CHECK is the older, looser rule — this
 * schema guards every write path, so the two diverging is deliberate.
 * `update_price_micro` has no floor — $0 is lifetime (D1) and is celebrated, not blocked.
 */
export const PriceMicro = z
  .string()
  .regex(/^\d+$/, "must be a non-negative integer in micro-USDC, as a string")
  .refine((v) => v !== "0" && BigInt(v) >= MIN_PRICE_MICRO, { error: "price must be at least 10000 micro-USDC" })
  .meta({
    id: "PriceMicro",
    description: "A listing price in micro-USDC: at least 10000 (D2b), never 0. The floor is technical and is never suggested.",
    examples: ["9000000"],
  });

export const UpdatePriceMicro = z
  .string()
  .regex(/^\d+$/, "must be a non-negative integer in micro-USDC, as a string")
  .meta({
    id: "UpdatePriceMicro",
    description: "The update price in micro-USDC. 0 means lifetime access: a purchase made at 0 is stamped all_versions (FR-16, D1).",
    examples: ["5000000"],
  });

// --- identity ----------------------------------------------------------------

export const AddressRegex = /^0x[0-9a-fA-F]{40}$/;

export const Address = z
  .string()
  .regex(AddressRegex, "must be a 0x-prefixed 20-byte EVM address")
  .meta({ id: "Address", description: "An EVM address, 0x-prefixed and 40 hex characters.", examples: ["0x0000000000000000000000000000000000000001"] });

/**
 * Either rail's account address (25 Oct 2026, the Stellar rail): an EVM `0x…` or a
 * Stellar `G…` account. Contracts (`C…`) are deliberately not payees — a classic
 * payment cannot reach one — so this is the payout shape, matching the `payout` CHECK.
 */
export const AnyAddressRegex = /^(0x[0-9a-fA-F]{40}|G[A-Z2-7]{55})$/;

export const AnyAddress = z
  .string()
  .regex(AnyAddressRegex, "must be an EVM address (0x…) or a Stellar account (G…)")
  .meta({
    id: "AnyAddress",
    description: "An EVM address (0x-prefixed, 40 hex characters) or a Stellar account (G…, 56 base32 characters).",
    examples: ["0x0000000000000000000000000000000000000001", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"],
  });

/** A Stellar account alone: the shape of `creator.stellar_payout_address` (migration 20261025090100). */
export const StellarAccountRegex = /^G[A-Z2-7]{55}$/;

export const StellarAccount = z
  .string()
  .regex(StellarAccountRegex, "must be a Stellar account (G…, 56 base32 characters)")
  .meta({
    id: "StellarAccount",
    description: "A Stellar account address: G followed by 55 base32 characters. Contract (C…) and muxed (M…) addresses are not payout addresses.",
    examples: ["GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"],
  });

/**
 * FR-3: handles that would collide with a platform path. Shared by both rails.
 *
 * The list grew on 2026-08-30 when `/:owner` became a real page (the author page). Until
 * then a top-level route and a handle could not collide, because there was no route that
 * took a handle in the first segment; now every one of these words is either a page, a
 * route handler or a file convention that Next resolves *before* `app/[owner]`, so a
 * creator who claimed one would get a handle whose page they could never reach.
 * `loadAuthorPage` refuses them a second time, so a route added tomorrow cannot be
 * shadowed by a row written yesterday.
 */
export const RESERVED_HANDLES = [
  "api",
  "docs",
  "dashboard",
  // Added 2026-09-07 with `app/admin/`. Without it a creator could register the handle
  // `admin`, and Next would resolve `/admin` to the operator surface rather than to
  // their author page — the exact shadowing the paragraph above describes. Their
  // listings slugged `money`, `activity`, `creators` or `people` would go the same way.
  "admin",
  "purchases",
  "how-it-works",
  "signin",
  "public",
  "_next",
  "favicon.ico",
  "robots.txt",
  "sitemap.xml",
  "icon.svg",
  "opengraph-image",
  "v",
  "r",
  "label",
] as const;

/** FR-3: the `owner` segment of every URL, on both rails. */
export const Handle = z
  .string()
  .regex(/^[a-z0-9-]{2,40}$/, "must be 2-40 characters of a-z, 0-9 or -")
  .refine((s) => !(RESERVED_HANDLES as readonly string[]).includes(s), { error: "that handle is reserved" })
  .meta({ id: "Handle", description: "A creator handle. The `owner` segment of every URL." });

/** FR-3: reserved because they are path segments under /api. */
export const RESERVED_SLUGS = ["api", "v", "r", "label"] as const;

export const Slug = z
  .string()
  .regex(/^[a-z0-9-]{2,40}$/, "must be 2-40 characters of a-z, 0-9 or -")
  .refine((s) => !(RESERVED_SLUGS as readonly string[]).includes(s), { error: "that slug is reserved" })
  .meta({ id: "Slug", description: "A listing slug, unique per owner. `api`, `v`, `r` and `label` are reserved. Never reused after retirement." });

/** FR-9: the tag with a leading `v` stripped. */
export const SemVer = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "must be MAJOR.MINOR.PATCH")
  .meta({ id: "SemVer", description: "A release version: the git tag with any leading `v` stripped.", examples: ["1.2.0"] });

export const Sha256 = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex characters")
  .meta({ id: "Sha256" });

export const IsoDateTime = z.iso.datetime({ offset: true }).meta({ id: "IsoDateTime", description: "RFC 3339 timestamp." });

// --- signed challenges (FR-2, FR-4, FR-5, FR-20) ------------------------------

export const Nonce = z
  .string()
  .regex(/^[A-Za-z0-9_-]{16,128}$/, "must be 16-128 url-safe base64 characters")
  .meta({ id: "Nonce", description: "The opaque nonce from GET /api/auth/challenge. Single use, 5-minute expiry." });

export const HexSignature = z
  .string()
  .regex(/^0x[0-9a-fA-F]+$/, "must be a 0x-prefixed hex signature")
  .max(4096, "signature is too long")
  .meta({ id: "HexSignature", description: "An EIP-191 personal_sign signature, or an ERC-1271 payload for a contract wallet." });

/**
 * SEP-53 over the challenge message from a Stellar `G…` account: the 64 ed25519
 * signature bytes as base64 (standard or URL-safe), which is what Freighter's
 * `signMessage` and the SDK's `Keypair.signMessage` produce (25 Oct 2026, BUILD F3).
 */
export const Sep53Signature = z
  .string()
  .regex(/^[A-Za-z0-9+/_-]{86,88}={0,2}$/, "must be a base64 SEP-53 signature (64 bytes)")
  .meta({ id: "Sep53Signature", description: "A SEP-53 signature from a Stellar account over the challenge message, base64-encoded." });

/** Whichever family signed: hex for an EVM wallet, base64 for a Stellar account. Verification decides which one applies. */
export const WalletSignature = z
  .union([HexSignature, Sep53Signature])
  .meta({ id: "WalletSignature", description: "An EIP-191 signature (0x-hex) from an EVM address, or a SEP-53 signature (base64) from a Stellar account." });

/** The `address_proof` of FR-2 and the `step_up` of FR-5: one nonce, one signature. */
export const SignedChallenge = z
  .object({ nonce: Nonce, signature: WalletSignature })
  .meta({ id: "SignedChallenge", description: "A signature over the message returned by GET /api/auth/challenge for the address in question." });

export type SignedChallengeInput = z.infer<typeof SignedChallenge>;

// --- misc --------------------------------------------------------------------

export const Cursor = z.string().min(1).max(256).meta({ id: "Cursor", description: "Opaque pagination cursor. Pass it back as ?cursor=." });

export const HttpsUrl = z
  .string()
  .refine((v) => {
    try {
      return new URL(v).protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an https URL")
  .meta({ id: "HttpsUrl", description: "An https URL. FR-41: no http, no redirects, must resolve to a public unicast IP at call time." });

export const Email = z.email().meta({ id: "Email" });
