/**
 * The Stellar half of the challenge primitive (25 Oct 2026, BUILD §0a F3/F4, BATTLE-TEST
 * finding 14): a `G…` account mints and consumes the same challenge an EVM wallet does,
 * verified as SEP-53 from its own key; the rate limiter buckets it instead of 400ing;
 * `X-Wallet-Signature` carries it; and a strkey is never lower-cased anywhere.
 */

import { Keypair } from "@stellar/stellar-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { makeMockDb } from "@/lib/test/mock-db";
import { STELLAR_CONTRACT_PAYER } from "@/lib/test/stellar";
import { consumeChallenge, dbAddress, decodeSep53Signature, issueChallenge, normaliseAddress, verifySep53 } from "./challenge";
import { addressKey, enforceAddressLimit } from "./rate-limit";
import { rebindContext, requireStepUp } from "./step-up";
import { WALLET_SIGNATURE_HEADER, parseWalletSignature, walletFrom } from "./wallet-signature";

// Generated per run: no key is ever committed.
const stellar = Keypair.random();
const other = Keypair.random();
const G = stellar.publicKey();
const evm = privateKeyToAccount(generatePrivateKey());

/** What Freighter v4 and the CLI hand back: the 64 SEP-53 signature bytes as base64. */
const sep53 = (signer: Keypair, message: string) => signer.signMessage(message).toString("base64");

let mock: ReturnType<typeof makeMockDb>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
});
afterEach(() => resetDb());

describe("normaliseAddress / dbAddress with a Stellar account", () => {
  it("keeps a G… upper-case in both forms, and repairs a lower-cased one", () => {
    expect(normaliseAddress(G)).toBe(G);
    expect(dbAddress(G)).toBe(G);
    expect(normaliseAddress(G.toLowerCase())).toBe(G);
    expect(dbAddress(G.toLowerCase())).toBe(G);
  });

  it("still checksums an EVM address and lower-cases it for the database", () => {
    expect(normaliseAddress(evm.address.toLowerCase())).toBe(evm.address);
    expect(dbAddress(evm.address)).toBe(evm.address.toLowerCase());
  });

  it("refuses a contract account (C…) by name: it has no key that could sign", () => {
    expect(() => normaliseAddress(STELLAR_CONTRACT_PAYER)).toThrow(/contract account \(C…\) cannot sign/);
    expect(() => normaliseAddress(STELLAR_CONTRACT_PAYER)).toThrow(expect.objectContaining({ code: "invalid_request" }));
  });

  it("refuses a strkey with a bad checksum and anything that is neither family", () => {
    const corrupted = `${G.slice(0, -1)}${G.endsWith("A") ? "B" : "A"}`;
    for (const bad of [corrupted, "hello", "", "0x1234"]) {
      expect(() => normaliseAddress(bad), bad).toThrow(expect.objectContaining({ code: "invalid_request" }));
    }
  });
});

describe("rate-limit bucket keys for a Stellar payer (finding 14)", () => {
  it("addressKey is the canonical strkey, never lower-cased", () => {
    expect(addressKey(G)).toBe(G);
    expect(addressKey(G.toLowerCase())).toBe(G);
    // A C… payer can pay (lib/x402), so it has a bucket too.
    expect(addressKey(STELLAR_CONTRACT_PAYER)).toBe(STELLAR_CONTRACT_PAYER);
    expect(addressKey(`${G.slice(0, -1)}${G.endsWith("A") ? "B" : "A"}`)).toBeNull();
  });

  it("enforceAddressLimit buckets a G… without throwing, keyed on the upper-case spelling", async () => {
    await expect(enforceAddressLimit("resource", "198.51.100.9", G)).resolves.toMatchObject({ allowed: true, count: 1 });
    await expect(enforceAddressLimit("resource", "198.51.100.9", G.toLowerCase())).resolves.toMatchObject({ allowed: true, count: 2 });
    const buckets = mock.rows("rate_limit").map((r) => r.bucket);
    expect(buckets).toContain(`resource:ip:198.51.100.9:address:${G}`);
    expect(buckets.some((b) => b.includes(G.toLowerCase()))).toBe(false);
  });
});

describe("a Stellar challenge (SEP-53)", () => {
  it("is stored upper-case and names the account in the message", async () => {
    const challenge = await issueChallenge(G.toLowerCase(), "address_proof");
    expect(challenge.address).toBe(G);
    expect(challenge.message).toContain(`address: ${G}`);
    expect(mock.rows("challenge")[0].address).toBe(G);
  });

  it("verifies a signature from the account's own key, returns the G…, burns the nonce and records the signer", async () => {
    const challenge = await issueChallenge(G, "address_proof");
    await expect(consumeChallenge(G, challenge.nonce, sep53(stellar, challenge.message), "address_proof")).resolves.toBe(G);
    const row = mock.rows("challenge")[0];
    expect(row.used_at).not.toBeNull();
    expect(row.signer).toBe(G);
  });

  it("accepts the URL-safe base64 some wallets emit", async () => {
    const challenge = await issueChallenge(G, "wallet_ownership");
    const urlSafe = sep53(stellar, challenge.message).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    await expect(consumeChallenge(G, challenge.nonce, urlSafe, "wallet_ownership")).resolves.toBe(G);
  });

  it("refuses a signature from another key (F4: the signer must be the address), and still burns the nonce", async () => {
    const challenge = await issueChallenge(G, "address_proof");
    await expect(consumeChallenge(G, challenge.nonce, sep53(other, challenge.message), "address_proof")).rejects.toMatchObject({
      code: "invalid_signature",
      status: 401,
    });
    expect(mock.rows("challenge")[0].used_at).not.toBeNull();
    // The burnt nonce cannot be retried, even with the right key.
    await expect(consumeChallenge(G, challenge.nonce, sep53(stellar, challenge.message), "address_proof")).rejects.toMatchObject({ code: "invalid_signature" });
  });

  it("never verifies an EVM signature on a Stellar challenge, nor a SEP-53 signature on an EVM one", async () => {
    const forStellar = await issueChallenge(G, "address_proof");
    const evmSig = await evm.signMessage({ message: forStellar.message });
    await expect(consumeChallenge(G, forStellar.nonce, evmSig, "address_proof")).rejects.toMatchObject({ code: "invalid_signature" });

    const forEvm = await issueChallenge(evm.address, "address_proof");
    await expect(consumeChallenge(evm.address, forEvm.nonce, sep53(stellar, forEvm.message), "address_proof")).rejects.toMatchObject({ code: "invalid_signature" });

    // And the EVM path is untouched: the same key still verifies its own challenge.
    const again = await issueChallenge(evm.address, "address_proof");
    await expect(consumeChallenge(evm.address, again.nonce, await evm.signMessage({ message: again.message }), "address_proof")).resolves.toBe(evm.address);
  });

  it("refuses a challenge for a contract account", async () => {
    await expect(issueChallenge(STELLAR_CONTRACT_PAYER, "address_proof")).rejects.toMatchObject({ code: "invalid_request" });
    expect(mock.rows("challenge")).toHaveLength(0);
  });

  it("verifySep53 is false for a wrong message and for anything that is not 64 bytes", () => {
    const message = "x402git challenge\naddress: " + G;
    const sig = sep53(stellar, message);
    expect(verifySep53(G, message, sig)).toBe(true);
    expect(verifySep53(G, message + " ", sig)).toBe(false);
    expect(verifySep53(other.publicKey(), message, sig)).toBe(false);
    expect(verifySep53(G, message, "AAAA")).toBe(false);
    expect(verifySep53(G, message, "0x" + "ab".repeat(65))).toBe(false);
    expect(decodeSep53Signature(Buffer.alloc(63, 1).toString("base64"))).toBeNull();
    expect(decodeSep53Signature(Buffer.alloc(64, 1).toString("base64"))?.length).toBe(64);
  });
});

describe("X-Wallet-Signature with a G… (F3: Stellar buyers re-download like Base buyers)", () => {
  it("parses <G>.<nonce>.<base64> and returns the canonical account", () => {
    const parsed = parseWalletSignature(`${G.toLowerCase()}.abc.${Buffer.alloc(64, 7).toString("base64")}`);
    expect(parsed).toEqual({ address: G, nonce: "abc", signature: Buffer.alloc(64, 7).toString("base64") });
  });

  it("is malformed when the signature shape belongs to the other family", () => {
    expect(() => parseWalletSignature(`${G}.abc.0x${"ab".repeat(65)}`)).toThrow(expect.objectContaining({ code: "invalid_signature" }));
    expect(() => parseWalletSignature(`${evm.address}.abc.${Buffer.alloc(64, 7).toString("base64")}`)).toThrow(
      expect.objectContaining({ code: "invalid_signature" }),
    );
    expect(() => parseWalletSignature(`${STELLAR_CONTRACT_PAYER}.abc.${Buffer.alloc(64, 7).toString("base64")}`)).toThrow(
      expect.objectContaining({ code: "invalid_signature" }),
    );
  });

  it("walletFrom returns the G… for a valid wallet_ownership challenge, and 401s a wrong key", async () => {
    const good = await issueChallenge(G, "wallet_ownership");
    const req = new Request("https://x402git.test/api/r/a/b", { headers: { [WALLET_SIGNATURE_HEADER]: `${G}.${good.nonce}.${sep53(stellar, good.message)}` } });
    await expect(walletFrom(req)).resolves.toBe(G);

    const bad = await issueChallenge(G, "wallet_ownership");
    const forged = new Request("https://x402git.test/api/r/a/b", { headers: { [WALLET_SIGNATURE_HEADER]: `${G}.${bad.nonce}.${sep53(other, bad.message)}` } });
    await expect(walletFrom(forged)).rejects.toMatchObject({ code: "invalid_signature", status: 401 });
  });
});

describe("step-up from a Stellar identity (C4, C5)", () => {
  it("accepts a SEP-53 step-up from the bound G…, bound to the rebind context", async () => {
    const creator = { payout_address: G };
    const context = rebindContext(evm.address);
    const challenge = await issueChallenge(G, "step_up", context);
    await expect(requireStepUp(creator, { nonce: challenge.nonce, signature: sep53(stellar, challenge.message) }, context)).resolves.toBe(G);
  });

  it("is step_up_required when another key signs, or when the context names a different address", async () => {
    const creator = { payout_address: G };
    const context = rebindContext(evm.address);
    const wrongKey = await issueChallenge(G, "step_up", context);
    await expect(requireStepUp(creator, { nonce: wrongKey.nonce, signature: sep53(other, wrongKey.message) }, context)).rejects.toMatchObject({
      code: "step_up_required",
    });

    const otherContext = await issueChallenge(G, "step_up", rebindContext(other.publicKey()));
    await expect(requireStepUp(creator, { nonce: otherContext.nonce, signature: sep53(stellar, otherContext.message) }, context)).rejects.toMatchObject({
      code: "step_up_required",
    });
  });
});
