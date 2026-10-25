import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage } from "viem";
import { describe, expect, it } from "vitest";
import type { Eip1193Provider } from "./wallet-checkout";
import { connectAndSign, signAs, utf8ToHex } from "./wallet-bind";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const account = privateKeyToAccount(KEY);

function fakeWallet(): Eip1193Provider & { signed: string[] } {
  const signed: string[] = [];
  return {
    signed,
    async request({ method, params }) {
      if (method === "eth_requestAccounts") return [account.address];
      if (method === "personal_sign") {
        const [hex] = params as [string, string];
        signed.push(hex);
        return account.signMessage({ message: { raw: hex as `0x${string}` } });
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

describe("utf8ToHex", () => {
  it("encodes bytes, not code points", () => {
    expect(utf8ToHex("hi")).toBe("0x6869");
    expect(utf8ToHex("é")).toBe("0xc3a9");
  });
});

describe("connectAndSign", () => {
  it("fetches a challenge for the connected address and returns a verifiable signature", async () => {
    const wallet = fakeWallet();
    const message = `x402git wants to verify ${account.address}\nnonce: abc`;
    const fetch = async (url: string) => {
      expect(url).toBe(`/api/auth/challenge?address=${account.address}&purpose=address_proof`);
      return new Response(JSON.stringify({ nonce: "abc", message }), { status: 200 });
    };
    const out = await connectAndSign(wallet, { fetch: fetch as unknown as typeof globalThis.fetch, baseUrl: "" });
    expect(out.address).toBe(account.address);
    expect(out.nonce).toBe("abc");
    expect(await verifyMessage({ address: account.address, message, signature: out.signature as `0x${string}` })).toBe(true);
  });

  it("surfaces the server's message when the challenge is refused", async () => {
    const fetch = async () => new Response(JSON.stringify({ message: "Too many challenges." }), { status: 429 });
    await expect(connectAndSign(fakeWallet(), { fetch: fetch as unknown as typeof globalThis.fetch, baseUrl: "" })).rejects.toThrow(
      "Too many challenges.",
    );
  });
});

describe("signAs", () => {
  it("refuses to sign from the wrong account", async () => {
    await expect(signAs(fakeWallet(), "0x1111111111111111111111111111111111111111", "m")).rejects.toThrow(/Switch to that account/);
  });
  it("signs when the wallet holds the address", async () => {
    const sig = await signAs(fakeWallet(), account.address.toLowerCase(), "m");
    expect(await verifyMessage({ address: account.address, message: "m", signature: sig as `0x${string}` })).toBe(true);
  });
});
