import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { ChallengePurpose } from "@/lib/db/types";
import { type Db, resetDb, setDb } from "@/lib/db";
import { makeMockDb } from "@/lib/test/mock-db";
import { CHALLENGE_TTL_SEC, challengeMessage, consumeChallenge, dbAddress, issueChallenge, normaliseAddress } from "./challenge";

// Generated per run: no key is ever committed, and the test needs no credentials.
const account = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey());

let mock: ReturnType<typeof makeMockDb>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
});
afterEach(() => resetDb());

async function issueAndSign(address = account.address, signer = account, purpose: ChallengePurpose = "address_proof") {
  const challenge = await issueChallenge(address, purpose);
  const signature = await signer.signMessage({ message: challenge.message });
  return { challenge, signature };
}

describe("issueChallenge", () => {
  it("stores a single-use challenge that expires in five minutes", async () => {
    const before = Date.now();
    const challenge = await issueChallenge(account.address, "address_proof");

    expect(mock.rows("challenge")).toHaveLength(1);
    const ttl = new Date(challenge.expires_at).getTime() - before;
    expect(ttl).toBeGreaterThan((CHALLENGE_TTL_SEC - 5) * 1000);
    expect(ttl).toBeLessThanOrEqual(CHALLENGE_TTL_SEC * 1000 + 50);
    expect(mock.rows("challenge")[0].used_at).toBeNull();
  });

  it("stores the purpose it was issued for", async () => {
    await issueChallenge(account.address, "step_up");
    expect(mock.rows("challenge")[0].purpose).toBe("step_up");
  });

  it("stores the address lowercased so .eq() is always correct", async () => {
    await issueChallenge(account.address, "address_proof");
    expect(mock.rows("challenge")[0].address).toBe(account.address.toLowerCase());
    expect(dbAddress(account.address)).toBe(account.address.toLowerCase());
  });

  it("names the site, the address, the purpose and the expiry in the signed message", async () => {
    const challenge = await issueChallenge(account.address, "rotate_key");
    expect(challenge.message).toBe(challengeMessage(normaliseAddress(account.address), challenge.nonce, new Date(challenge.expires_at), "rotate_key"));
    expect(challenge.message.startsWith("x402git challenge\n")).toBe(true);
    expect(challenge.message).toContain(normaliseAddress(account.address));
    expect(challenge.message).toContain("purpose: rotate_key");
  });

  it("binds a context into the signed message and refuses any other at consume time", async () => {
    const context = `rebind:${other.address.toLowerCase()}`;
    const challenge = await issueChallenge(account.address, "step_up", context);
    // The wallet screen shows where the money will go.
    expect(challenge.message).toContain(`context: ${context}`);

    const signature = await account.signMessage({ message: challenge.message });
    // Presented for a different operand — or for none — the signature is refused.
    await expect(consumeChallenge(account.address, challenge.nonce, signature, "step_up", "rebind:0x0000000000000000000000000000000000000001")).rejects.toMatchObject({
      code: "invalid_signature",
    });
  });

  it("refuses a contextless challenge where a context is required, and vice versa", async () => {
    const context = `rebind:${other.address.toLowerCase()}`;
    const plain = await issueChallenge(account.address, "step_up");
    const plainSig = await account.signMessage({ message: plain.message });
    await expect(consumeChallenge(account.address, plain.nonce, plainSig, "step_up", context)).rejects.toMatchObject({ code: "invalid_signature" });

    const bound = await issueChallenge(account.address, "step_up", context);
    const boundSig = await account.signMessage({ message: bound.message });
    await expect(consumeChallenge(account.address, bound.nonce, boundSig, "step_up")).rejects.toMatchObject({ code: "invalid_signature" });
  });

  it("accepts the matching context", async () => {
    const context = `rebind:${other.address.toLowerCase()}`;
    const challenge = await issueChallenge(account.address, "step_up", context);
    const signature = await account.signMessage({ message: challenge.message });
    await expect(consumeChallenge(account.address, challenge.nonce, signature, "step_up", context)).resolves.toBe(account.address);
  });

  it("never repeats a nonce", async () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 25; i++) nonces.add((await issueChallenge(account.address, "address_proof")).nonce);
    expect(nonces.size).toBe(25);
  });
});

describe("consumeChallenge", () => {
  it("accepts a correct EIP-191 signature and returns the checksummed address", async () => {
    const { challenge, signature } = await issueAndSign();
    await expect(consumeChallenge(account.address, challenge.nonce, signature, "address_proof")).resolves.toBe(account.address);
  });

  it("is single use: the second attempt fails", async () => {
    const { challenge, signature } = await issueAndSign();
    await consumeChallenge(account.address, challenge.nonce, signature, "address_proof");
    await expect(consumeChallenge(account.address, challenge.nonce, signature, "address_proof")).rejects.toMatchObject({ code: "invalid_signature" });
  });

  it("burns the nonce even when verification fails, so it cannot be retried", async () => {
    const { challenge } = await issueAndSign();
    const wrong = await other.signMessage({ message: challenge.message });
    await expect(consumeChallenge(account.address, challenge.nonce, wrong, "address_proof")).rejects.toMatchObject({ code: "invalid_signature" });

    // Now sign it correctly: still refused, because the nonce is spent.
    const right = await account.signMessage({ message: challenge.message });
    await expect(consumeChallenge(account.address, challenge.nonce, right, "address_proof")).rejects.toMatchObject({ code: "invalid_signature" });
  });

  it("rejects a signature from a different address", async () => {
    const { challenge } = await issueAndSign();
    const signature = await other.signMessage({ message: challenge.message });
    await expect(consumeChallenge(account.address, challenge.nonce, signature, "address_proof")).rejects.toMatchObject({ code: "invalid_signature" });
  });

  it("rejects a challenge issued to someone else", async () => {
    const { challenge } = await issueAndSign(other.address, other);
    const signature = await account.signMessage({ message: challenge.message });
    await expect(consumeChallenge(account.address, challenge.nonce, signature, "address_proof")).rejects.toMatchObject({ code: "invalid_signature" });
  });

  it("rejects a challenge presented for a different purpose than it was issued for", async () => {
    // A benign "prove your wallet" signature must not be replayable as a payout rebind (W2.2).
    const { challenge, signature } = await issueAndSign(account.address, account, "wallet_ownership");
    await expect(consumeChallenge(account.address, challenge.nonce, signature, "step_up")).rejects.toMatchObject({ code: "invalid_signature" });
  });

  it("accepts a challenge presented for the purpose it was issued for", async () => {
    const { challenge, signature } = await issueAndSign(account.address, account, "step_up");
    await expect(consumeChallenge(account.address, challenge.nonce, signature, "step_up")).resolves.toBe(account.address);
  });

  it("rejects an expired challenge", async () => {
    const { challenge, signature } = await issueAndSign();
    const later = new Date(new Date(challenge.expires_at).getTime() + 1000);
    await expect(consumeChallenge(account.address, challenge.nonce, signature, "address_proof", null, later)).rejects.toMatchObject({ code: "invalid_signature" });
  });

  it("rejects an unknown nonce", async () => {
    const signature = await account.signMessage({ message: "anything" });
    await expect(consumeChallenge(account.address, "no-such-nonce", signature, "address_proof")).rejects.toMatchObject({ code: "invalid_signature" });
  });

  it("rejects a signature over a different message", async () => {
    const { challenge } = await issueAndSign();
    const signature = await account.signMessage({ message: "x402git challenge\naddress: 0x0\npurpose: address_proof\nnonce: 0\nexpires: 0" });
    await expect(consumeChallenge(account.address, challenge.nonce, signature, "address_proof")).rejects.toMatchObject({ code: "invalid_signature" });
  });

  it("is case-insensitive about the address the caller supplies", async () => {
    const { challenge, signature } = await issueAndSign();
    await expect(consumeChallenge(account.address.toLowerCase(), challenge.nonce, signature, "address_proof")).resolves.toBe(account.address);
  });

  it("is safe under concurrency: two presentations of the same nonce, exactly one wins (W2.8)", async () => {
    const { challenge, signature } = await issueAndSign();
    const results = await Promise.allSettled([
      consumeChallenge(account.address, challenge.nonce, signature, "address_proof"),
      consumeChallenge(account.address, challenge.nonce, signature, "address_proof"),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "invalid_signature" });
  });
});

describe("normaliseAddress", () => {
  it("rejects a non-address with invalid_request", () => {
    expect(() => normaliseAddress("not-an-address")).toThrow(expect.objectContaining({ code: "invalid_request" }));
  });
});
