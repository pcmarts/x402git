/** BATTLE-TEST finding 14: `GET /api/auth/challenge?address=G…` is 200, and the bucket key is the upper-case strkey. */

import { Keypair } from "@stellar/stellar-sdk";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { makeMockDb } from "@/lib/test/mock-db";
import { STELLAR_CONTRACT_PAYER } from "@/lib/test/stellar";
import { GET } from "./route";

const G = Keypair.random().publicKey();
const IP = "203.0.113.77";
let mock: ReturnType<typeof makeMockDb>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
});
afterEach(() => resetDb());

function get(query: string): NextRequest {
  return new NextRequest(`https://x402git.com/api/auth/challenge${query}`, { headers: { "x-real-ip": IP } });
}

describe("GET /api/auth/challenge with a Stellar account", () => {
  it("mints a wallet_ownership challenge for a G…", async () => {
    const res = await GET(get(`?address=${G}&purpose=wallet_ownership`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.address).toBe(G);
    expect(body.message).toContain(`address: ${G}`);
    expect(body.message).toContain("purpose: wallet_ownership");
    expect(mock.rows("challenge")[0].address).toBe(G);
    expect(mock.rows("rate_limit").map((r) => r.bucket)).toContain(`challenge:ip:${IP}:address:${G}`);
  });

  it("mints an address_proof for a lower-cased G… and stores it upper-case (never lower-cased, BUILD H11)", async () => {
    const res = await GET(get(`?address=${G.toLowerCase()}&purpose=address_proof`));
    expect(res.status).toBe(200);
    expect((await res.json()).address).toBe(G);
    expect(mock.rows("challenge")[0].address).toBe(G);
  });

  it("mints a step_up naming a new Stellar payout address for an EVM identity (C3)", async () => {
    const res = await GET(get(`?address=0x2222222222222222222222222222222222222222&purpose=step_up&new_payout_address=${G}`));
    expect(res.status).toBe(200);
    expect((await res.json()).message).toContain(`context: rebind:${G}`);
  });

  it("refuses a contract account with a clear 400", async () => {
    const res = await GET(get(`?address=${STELLAR_CONTRACT_PAYER}&purpose=wallet_ownership`));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("invalid_request");
    expect(body.message).toMatch(/contract account/);
    expect(mock.rows("challenge")).toHaveLength(0);
  });
});
