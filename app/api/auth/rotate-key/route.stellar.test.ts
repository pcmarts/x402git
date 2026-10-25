/** BATTLE-TEST finding 14: a Stellar-only creator can recover their key with a SEP-53 signature. */

import { Keypair } from "@stellar/stellar-sdk";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueChallenge } from "@/lib/auth/challenge";
import { type Db, resetDb, setDb } from "@/lib/db";
import { makeMockDb } from "@/lib/test/mock-db";
import { POST } from "./route";

const stellar = Keypair.random();
const other = Keypair.random();
const G = stellar.publicKey();
const CREATOR_ID = "11111111-1111-4111-8111-111111111111";

let mock: ReturnType<typeof makeMockDb>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  mock.seed("creator", [{ id: CREATOR_ID, handle: "orbit", payout_address: G, onboarded_via: "web", terms_version: "2026-09-16" }]);
});
afterEach(() => resetDb());

async function rotate(signer: Keypair, address = G) {
  const challenge = await issueChallenge(address, "rotate_key");
  const signature = signer.signMessage(challenge.message).toString("base64");
  return POST(
    new NextRequest("https://x402git.com/api/auth/rotate-key", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "203.0.113.9" },
      body: JSON.stringify({ handle: "orbit", address, nonce: challenge.nonce, signature }),
    }),
  );
}

describe("POST /api/auth/rotate-key with a Stellar identity", () => {
  it("mints a fresh agent key for a SEP-53 signature from the bound G…", async () => {
    const res = await rotate(stellar);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.handle).toBe("orbit");
    expect(body.api_key).toMatch(/^x4c_live_/);
    expect(mock.rows("api_key").filter((k) => k.kind === "agent" && k.revoked_at === null)).toHaveLength(1);
  });

  it("is 401 for another key, and mints nothing", async () => {
    const res = await rotate(other);
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("invalid_signature");
    expect(mock.rows("api_key")).toHaveLength(0);
  });
});
