import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { IP_CAPS } from "@/lib/auth/rate-limit";
import { type Db, resetDb, setDb } from "@/lib/db";
import { makeMockDb } from "@/lib/test/mock-db";
import { GET } from "./route";

const account = privateKeyToAccount(generatePrivateKey());
let mock: ReturnType<typeof makeMockDb>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
});
afterEach(() => resetDb());

function get(query: string, ip?: string): NextRequest {
  return new NextRequest(`https://x402git.com/api/auth/challenge${query}`, ip ? { headers: { "x-real-ip": ip } } : undefined);
}

describe("GET /api/auth/challenge (FR-20)", () => {
  it("issues a nonce, a message to sign and an expiry", async () => {
    const res = await GET(get(`?address=${account.address}&purpose=address_proof`));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.nonce).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(body.message).toContain(account.address);
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(mock.rows("challenge")).toHaveLength(1);
  });

  it("is never cached: a reused challenge is a replay", async () => {
    const res = await GET(get(`?address=${account.address}&purpose=address_proof`));
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("requires an address", async () => {
    const res = await GET(get(""));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_request");
  });

  it("rejects something that is not an address", async () => {
    const res = await GET(get(`?address=hello&purpose=address_proof`));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_request");
  });

  it("requires a valid purpose (W2.2)", async () => {
    const missing = await GET(get(`?address=${account.address}`));
    expect(missing.status).toBe(400);
    expect((await missing.json()).code).toBe("invalid_request");

    const bogus = await GET(get(`?address=${account.address}&purpose=nonsense`));
    expect(bogus.status).toBe(400);
    expect((await bogus.json()).code).toBe("invalid_request");
  });

  it("stores the purpose it was issued for", async () => {
    await GET(get(`?address=${account.address}&purpose=step_up`));
    expect(mock.rows("challenge")[0].purpose).toBe("step_up");
  });

  it("rate limits to 30 a minute per address (§9)", async () => {
    for (let i = 0; i < 30; i++) {
      expect((await GET(get(`?address=${account.address}&purpose=address_proof`))).status).toBe(200);
    }
    const res = await GET(get(`?address=${account.address}&purpose=address_proof`));
    expect(res.status).toBe(429);

    const body = await res.json();
    expect(body.code).toBe("rate_limited");
    expect(body.retry_after_seconds).toBeGreaterThan(0);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });

  it("limits each address separately", async () => {
    const other = privateKeyToAccount(generatePrivateKey());
    for (let i = 0; i < 31; i++) await GET(get(`?address=${account.address}&purpose=address_proof`));
    expect((await GET(get(`?address=${other.address}&purpose=address_proof`))).status).toBe(200);
  });
});

describe("GET /api/auth/challenge — whose quota a request spends (CORE-4, PAY-12)", () => {
  const ATTACKER = "198.51.100.13";
  const OWNER = "203.0.113.40";

  it("a stranger naming this address from another IP cannot use up its quota", async () => {
    for (let i = 0; i < 30; i++) await GET(get(`?address=${account.address}&purpose=wallet_ownership`, ATTACKER));
    expect((await GET(get(`?address=${account.address}&purpose=wallet_ownership`, ATTACKER))).status).toBe(429);

    expect((await GET(get(`?address=${account.address}&purpose=wallet_ownership`, OWNER))).status).toBe(200);
  });

  it("one IP cannot dodge the limit by naming a new address each time, and a refusal writes no challenge row", async () => {
    for (let i = 0; i < IP_CAPS.challenge.max; i++) {
      const address = privateKeyToAccount(generatePrivateKey()).address;
      expect((await GET(get(`?address=${address}&purpose=address_proof`, ATTACKER))).status).toBe(200);
    }
    const res = await GET(get(`?address=${privateKeyToAccount(generatePrivateKey()).address}&purpose=address_proof`, ATTACKER));
    expect(res.status).toBe(429);
    expect((await res.json()).message).toContain("per IP");
    expect(mock.rows("challenge")).toHaveLength(IP_CAPS.challenge.max);
  });

  it("rotate_key and step_up challenges keep their own quota when ordinary minting is spent, even from the same IP", async () => {
    for (let i = 0; i < 31; i++) await GET(get(`?address=${account.address}&purpose=address_proof`, OWNER));
    expect((await GET(get(`?address=${account.address}&purpose=wallet_ownership`, OWNER))).status).toBe(429);

    expect((await GET(get(`?address=${account.address}&purpose=rotate_key`, OWNER))).status).toBe(200);
    expect((await GET(get(`?address=${account.address}&purpose=step_up`, OWNER))).status).toBe(200);
  });

  it("validates the address before it is a key: a malformed one is 400 and spends nothing", async () => {
    for (const bad of ["0x1234", "0x" + "g".repeat(40), "hello"]) {
      const res = await GET(get(`?address=${bad}&purpose=address_proof`, ATTACKER));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("invalid_request");
    }
    expect(mock.rows("rate_limit")).toHaveLength(0);
    expect(mock.rows("challenge")).toHaveLength(0);
  });
});
