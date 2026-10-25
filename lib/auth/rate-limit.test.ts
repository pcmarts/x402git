import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { makeMockDb } from "@/lib/test/mock-db";
import { IP_CAPS, LIMITS, addressKey, challengeLimit, clientIp, enforceAddressLimit, enforceLimit, hitLimit } from "./rate-limit";

let mock: ReturnType<typeof makeMockDb>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
});
afterEach(() => resetDb());

describe("the PRD §9 limits", () => {
  it("are the numbers the PRD fixes", () => {
    expect(LIMITS.registration).toMatchObject({ max: 5, windowSec: 3600, per: "ip" });
    expect(LIMITS.challenge).toMatchObject({ max: 30, windowSec: 60, per: "address" });
    expect(LIMITS.resource).toMatchObject({ max: 60, windowSec: 60, per: "address" });
    expect(LIMITS.version).toMatchObject({ max: 600, windowSec: 60, per: "ip" });
    expect(LIMITS.push).toMatchObject({ max: 20, windowSec: 3600, per: "repo" });
  });

  it("give rotate_key and step_up the challenge number in buckets of their own (PAY-12)", () => {
    expect(LIMITS.rotate_key).toMatchObject({ max: 30, windowSec: 60, per: "address" });
    expect(LIMITS.step_up).toMatchObject({ max: 30, windowSec: 60, per: "address" });
  });

  it("cap each address limit per IP with headroom over the per-address number (CORE-3, CORE-4)", () => {
    for (const name of ["challenge", "rotate_key", "step_up", "resource"] as const) {
      expect(IP_CAPS[name].per).toBe("ip");
      expect(IP_CAPS[name].windowSec).toBe(LIMITS[name].windowSec);
      expect(IP_CAPS[name].max).toBeGreaterThan(LIMITS[name].max);
    }
  });
});

describe("addressKey", () => {
  it("lowercases a 0x-and-40-hex address", () => {
    expect(addressKey("0xAbCdEf0123456789aBcDeF0123456789AbCdEf01")).toBe("0xabcdef0123456789abcdef0123456789abcdef01");
  });

  it("is null for anything else, so it never becomes a bucket key", () => {
    for (const bad of ["", "0x1", "abcdef0123456789abcdef0123456789abcdef01", "0xZZcdef0123456789abcdef0123456789abcdef01", "0xabcdef0123456789abcdef0123456789abcdef0100", " 0xabcdef0123456789abcdef0123456789abcdef01", 1, null, undefined, {}]) {
      expect(addressKey(bad), String(bad)).toBeNull();
    }
  });
});

describe("challengeLimit (PAY-12)", () => {
  it("sends rotate_key and step_up to their own buckets and everything else to challenge", () => {
    expect(challengeLimit("rotate_key")).toBe("rotate_key");
    expect(challengeLimit("step_up")).toBe("step_up");
    expect(challengeLimit("address_proof")).toBe("challenge");
    expect(challengeLimit("wallet_ownership")).toBe("challenge");
  });
});

describe("enforceAddressLimit (CORE-3, CORE-4, PAY-12)", () => {
  const VICTIM = "0x" + "a1".repeat(20);
  const fresh = (i: number) => "0x" + i.toString(16).padStart(40, "0");

  it("counts the address per IP: an attacker's IP cannot exhaust the victim's bucket", async () => {
    for (let i = 0; i < 30; i++) await enforceAddressLimit("challenge", "198.51.100.66", VICTIM);
    const over = await enforceAddressLimit("challenge", "198.51.100.66", VICTIM).catch((e) => e);
    expect(over.code).toBe("rate_limited");
    expect(over.message).toContain("30 per minute per address from one IP");

    // The victim, from their own IP, is untouched.
    await expect(enforceAddressLimit("challenge", "203.0.113.5", VICTIM)).resolves.toMatchObject({ allowed: true, count: 1 });
    // And nothing was spent under the old address-only key.
    expect(mock.rows("rate_limit").some((r) => r.bucket === `challenge:${VICTIM}`)).toBe(false);
  });

  it("caps the IP: a fresh address per request does not escape the limit", async () => {
    for (let i = 0; i < IP_CAPS.resource.max; i++) await enforceAddressLimit("resource", "198.51.100.77", fresh(i));
    const over = await enforceAddressLimit("resource", "198.51.100.77", fresh(9999)).catch((e) => e);
    expect(over.code).toBe("rate_limited");
    expect(over.status).toBe(429);
    expect(over.message).toContain(`${IP_CAPS.resource.max} per minute per IP`);
    expect(over.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("does not create a per-address row once the IP cap is spent, so rotation cannot grow the table", async () => {
    for (let i = 0; i < IP_CAPS.challenge.max; i++) await enforceAddressLimit("challenge", "198.51.100.88", fresh(i));
    const rowsBefore = mock.rows("rate_limit").length;
    await enforceAddressLimit("challenge", "198.51.100.88", fresh(4242)).catch(() => {});
    expect(mock.rows("rate_limit")).toHaveLength(rowsBefore);
  });

  it("treats the checksummed and lowercase forms of one address as one bucket", async () => {
    const checksummed = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
    for (let i = 0; i < 15; i++) await enforceAddressLimit("challenge", "192.0.2.1", checksummed);
    for (let i = 0; i < 15; i++) await enforceAddressLimit("challenge", "192.0.2.1", checksummed.toLowerCase());
    await expect(enforceAddressLimit("challenge", "192.0.2.1", checksummed)).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("refuses a malformed address as invalid_request and writes no row", async () => {
    for (const bad of ["0x1234", "hello", "0x" + "g".repeat(40)]) {
      await expect(enforceAddressLimit("resource", "192.0.2.2", bad)).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    }
    expect(mock.rows("rate_limit")).toHaveLength(0);
  });

  it("counts an anonymous caller as one more address from its IP", async () => {
    for (let i = 0; i < LIMITS.resource.max; i++) await enforceAddressLimit("resource", "192.0.2.3", null);
    await expect(enforceAddressLimit("resource", "192.0.2.3", null)).rejects.toMatchObject({ code: "rate_limited" });
    await expect(enforceAddressLimit("resource", "192.0.2.3", VICTIM)).resolves.toMatchObject({ allowed: true });
  });

  it("keeps rotate_key and step_up apart from challenge minting, even from the same IP", async () => {
    for (let i = 0; i < IP_CAPS.challenge.max; i++) await enforceAddressLimit("challenge", "192.0.2.4", i < 30 ? VICTIM : fresh(i));
    await expect(enforceAddressLimit("challenge", "192.0.2.4", VICTIM)).rejects.toMatchObject({ code: "rate_limited" });
    await expect(enforceAddressLimit("rotate_key", "192.0.2.4", VICTIM)).resolves.toMatchObject({ allowed: true });
    await expect(enforceAddressLimit("step_up", "192.0.2.4", VICTIM)).resolves.toMatchObject({ allowed: true });
  });
});

describe("hitLimit", () => {
  it("counts up and flips to disallowed one past the limit", async () => {
    for (let i = 1; i <= 5; i++) {
      const result = await hitLimit("registration", "1.2.3.4");
      expect(result.count).toBe(i);
      expect(result.allowed).toBe(true);
    }
    const sixth = await hitLimit("registration", "1.2.3.4");
    expect(sixth.count).toBe(6);
    expect(sixth.allowed).toBe(false);
  });

  it("counts each key in its own bucket", async () => {
    for (let i = 0; i < 5; i++) await hitLimit("registration", "1.2.3.4");
    expect((await hitLimit("registration", "5.6.7.8")).allowed).toBe(true);
  });

  it("counts each limit in its own bucket", async () => {
    for (let i = 0; i < 6; i++) await hitLimit("registration", "1.2.3.4");
    expect((await hitLimit("challenge", "1.2.3.4")).allowed).toBe(true);
  });

  it("starts a fresh window once the old one has passed", async () => {
    for (let i = 0; i < 6; i++) await hitLimit("registration", "1.2.3.4");
    const row = mock.rows("rate_limit").find((r) => r.bucket === "registration:1.2.3.4")!;
    row.window_start = new Date(Date.now() - 2 * 3600 * 1000).toISOString();

    const next = await hitLimit("registration", "1.2.3.4");
    expect(next.count).toBe(1);
    expect(next.allowed).toBe(true);
  });

  it("fails open when the counter itself is unavailable", async () => {
    mock.setRpc("rate_limit_hit", () => {
      throw new Error("connection refused");
    });
    // The mock returns an error result rather than throwing; either way, allow.
    mock.client.rpc = async () => ({ data: null, error: { message: "down", code: "08006" } });
    expect((await hitLimit("registration", "1.2.3.4")).allowed).toBe(true);
  });
});

describe("enforceLimit", () => {
  it("throws rate_limited with a retry-after once over", async () => {
    for (let i = 0; i < 5; i++) await enforceLimit("registration", "9.9.9.9");
    const error = await enforceLimit("registration", "9.9.9.9").catch((e) => e);
    expect(error.code).toBe("rate_limited");
    expect(error.status).toBe(429);
    expect(error.retryAfterSeconds).toBeGreaterThan(0);
    expect(error.retryAfterSeconds).toBeLessThanOrEqual(3600);
    expect(error.message).toContain("5 per hour per ip");
  });
});

describe("clientIp", () => {
  it("takes the first entry of x-forwarded-for, which the platform sets", () => {
    const req = new Request("https://x402git.com/", { headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" } });
    expect(clientIp(req)).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip, then to a constant", () => {
    expect(clientIp(new Request("https://x402git.com/", { headers: { "x-real-ip": "198.51.100.2" } }))).toBe("198.51.100.2");
    expect(clientIp(new Request("https://x402git.com/"))).toBe("unknown");
  });
});
