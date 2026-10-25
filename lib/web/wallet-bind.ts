/**
 * lib/web/wallet-bind.ts — binding a payout address from a browser wallet (FR-1, FR-5).
 *
 * The whole ceremony, with nothing a person has to understand: ask the wallet which
 * address it holds, fetch a challenge for that address from the same route an agent
 * would use, have the wallet sign it, and hand back the three strings the bind form
 * needs. The form then POSTs exactly what a reader with no wallet would have typed, so
 * the server does not know or care that a wallet was involved.
 *
 * Nothing here imports React or anything server-only; it is unit tested against a
 * fake provider in `wallet-bind.test.ts`.
 */

import type { Eip1193Provider, Transport } from "./wallet-checkout";

export type SignedChallenge = { address: string; nonce: string; signature: string };

/** `personal_sign` wants the message as hex bytes; wallets show the decoded text. */
export function utf8ToHex(text: string): `0x${string}` {
  const bytes = new TextEncoder().encode(text);
  let out = "0x";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out as `0x${string}`;
}

/** The address the wallet is offering; prompts the wallet to connect if it has not. */
export async function connectedAddress(provider: Eip1193Provider): Promise<string> {
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[] | null;
  const address = accounts?.[0];
  if (!address) throw new Error("Your wallet did not share an address. Unlock it and try again.");
  return address;
}

/**
 * Sign a challenge message with a specific address. Throws a readable sentence when the
 * wallet is holding some other account, which is the one mistake a change-of-address
 * step (FR-5: the *current* address signs) invites.
 */
export async function signAs(provider: Eip1193Provider, address: string, message: string): Promise<string> {
  const held = await connectedAddress(provider);
  if (held.toLowerCase() !== address.toLowerCase()) {
    throw new Error(`Your wallet is on ${held}, not ${address}. Switch to that account and try again.`);
  }
  return (await provider.request({ method: "personal_sign", params: [utf8ToHex(message), held] })) as string;
}

/** First bind: connect, fetch a challenge for the connected address, sign it. */
export async function connectAndSign(provider: Eip1193Provider, transport: Transport): Promise<SignedChallenge> {
  const address = await connectedAddress(provider);
  const res = await transport.fetch(`${transport.baseUrl}/api/auth/challenge?address=${address}&purpose=address_proof`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `The challenge could not be issued (HTTP ${res.status}).`);
  }
  const { nonce, message } = (await res.json()) as { nonce: string; message: string };
  const signature = (await provider.request({ method: "personal_sign", params: [utf8ToHex(message), address] })) as string;
  return { address, nonce, signature };
}
