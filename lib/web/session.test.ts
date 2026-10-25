import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnv } from "@/lib/env";
import {
  cookieOptions,
  decodeOAuthState,
  encodeOAuthState,
  KEY_BOX_TTL_SEC,
  newSession,
  newState,
  openBox,
  openSession,
  sealBox,
  sealSession,
  SESSION_TTL_SEC,
  sessionExpiresAt,
  stateMatches,
  type SessionData,
} from "./session";

const SECRET = "test-session-secret-0123456789";

function session(overrides: Partial<SessionData> = {}): SessionData {
  return newSession({
    github: { id: 4242, login: "adrian", token: "gho_test" },
    creatorId: "11111111-1111-4111-8111-111111111111",
    handle: "adrian",
    // FR-55: the cookie carries this session's own key, never the agent key.
    apiKey: "x4s_live_abcdefghijklmnopqrstuvwxyz012345",
    ...overrides,
  });
}

beforeEach(() => {
  process.env.SESSION_SECRET = SECRET;
  resetEnv();
});

afterEach(() => {
  delete process.env.SESSION_SECRET;
  resetEnv();
});

describe("sealSession / openSession", () => {
  it("round-trips every field", () => {
    const original = session();
    const opened = openSession(sealSession(original));
    expect(opened).toEqual(original);
  });

  it("does not put the session key in the cookie in the clear", () => {
    const cookie = sealSession(session());
    // The cookie's own name stem is `x4s`; what must not appear is a key (FR-60).
    expect(cookie).not.toContain("x4s_live_");
    expect(cookie).not.toContain("adrian");
    expect(cookie).not.toContain("gho_test");
  });

  it("produces a different cookie every time for the same data", () => {
    const data = session();
    // A fresh IV per seal: two identical sessions must not be byte-identical.
    expect(sealSession(data)).not.toEqual(sealSession(data));
  });

  it("rejects a tampered payload", () => {
    const [version, payload, signature] = sealSession(session()).split(".");
    const flipped = `${payload.slice(0, -2)}${payload.slice(-2) === "AA" ? "AB" : "AA"}`;
    expect(openSession(`${version}.${flipped}.${signature}`)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const [version, payload] = sealSession(session()).split(".");
    const otherSignature = sealSession(session()).split(".")[2];
    expect(openSession(`${version}.${payload}.${otherSignature}`)).toBeNull();
  });

  it("rejects a cookie sealed under a different secret", () => {
    const cookie = sealSession(session());
    process.env.SESSION_SECRET = "a-completely-different-secret";
    resetEnv();
    expect(openSession(cookie)).toBeNull();
  });

  it("rejects an expired session", () => {
    const cookie = sealSession(session());
    const later = new Date(Date.now() + (SESSION_TTL_SEC + 60) * 1000);
    expect(openSession(cookie, later)).toBeNull();
  });

  it("returns null for junk, an empty string and undefined", () => {
    expect(openSession(undefined)).toBeNull();
    expect(openSession("")).toBeNull();
    expect(openSession("not-a-cookie")).toBeNull();
    expect(openSession("x4s.only-two-parts")).toBeNull();
    expect(openSession("v9.aaaa.bbbb")).toBeNull();
  });

  it("carries a GitHub identity with no creator row, for the pre-wallet state", () => {
    const pre = newSession({ github: { id: 7, login: "newcomer" } });
    const opened = openSession(sealSession(pre));
    expect(opened?.creatorId).toBeUndefined();
    expect(opened?.github.login).toBe("newcomer");
  });
});

describe("sessionExpiresAt (FR-55)", () => {
  it("is the instant the session stamped at the same `now` expires, to the second", () => {
    const now = new Date("2026-08-31T12:00:00.000Z");
    // The row's `expires_at` and the cookie's `exp` have to be the same moment, or a
    // session key outlives its cookie (unrevokable) or dies inside one (signed out
    // mid-click).
    expect(Date.parse(sessionExpiresAt(now))).toBe(newSession({ github: { id: 1, login: "a" } }, now).exp * 1000);
  });

  it("ignores sub-second time, so the two are never a rounding apart", () => {
    const now = new Date("2026-08-31T12:00:00.999Z");
    expect(Date.parse(sessionExpiresAt(now))).toBe(newSession({ github: { id: 1, login: "a" } }, now).exp * 1000);
  });
});

describe("the one-time key box (FR-59)", () => {
  const KEY = "x4c_live_abcdefghijklmnopqrstuvwxyz012345";

  it("round-trips a freshly minted agent key", () => {
    expect(openBox(sealBox(KEY))).toBe(KEY);
  });

  it("does not carry the key in the clear", () => {
    expect(sealBox(KEY)).not.toContain("x4c_live_");
  });

  it("rejects a tampered payload and a tampered signature", () => {
    const [version, payload, signature] = sealBox(KEY).split(".");
    const flipped = `${payload.slice(0, -2)}${payload.slice(-2) === "AA" ? "AB" : "AA"}`;
    expect(openBox(`${version}.${flipped}.${signature}`)).toBeNull();
    expect(openBox(`${version}.${payload}.${sealBox(KEY).split(".")[2]}`)).toBeNull();
  });

  it("expires with its own `exp`, not only with the cookie's maxAge", () => {
    // A server component cannot clear a cookie, so a client that keeps sending the box
    // has to be refused by the box itself.
    const box = sealBox(KEY);
    expect(openBox(box, new Date(Date.now() + (KEY_BOX_TTL_SEC + 1) * 1000))).toBeNull();
  });

  it("is sealed under its own key, so a session cookie is not a key box and vice versa", () => {
    // Distinct HKDF-ish labels: `x402git:keybox:*` against `x402git:session:*`.
    expect(openBox(sealSession(session()))).toBeNull();
    expect(openSession(sealBox(KEY))).toBeNull();
  });

  it("returns null for junk, an empty string and undefined", () => {
    expect(openBox(undefined)).toBeNull();
    expect(openBox("")).toBeNull();
    expect(openBox("not-a-cookie")).toBeNull();
    expect(openBox("x4k.only-two-parts")).toBeNull();
  });

  it("rejects a box sealed under a different secret", () => {
    const box = sealBox(KEY);
    process.env.SESSION_SECRET = "a-completely-different-secret";
    resetEnv();
    expect(openBox(box)).toBeNull();
  });
});

describe("oauth state", () => {
  it("round-trips the state and the return path", () => {
    const state = newState();
    const decoded = decodeOAuthState(encodeOAuthState(state, "/dashboard/new"));
    expect(decoded).toEqual({ state, next: "/dashboard/new" });
  });

  it("refuses an off-site return path", () => {
    const decoded = decodeOAuthState(encodeOAuthState("abc", "https://evil.example/steal"));
    expect(decoded?.next).toBe("/dashboard");
  });

  it("refuses a backslash-smuggled open redirect in the parked next (W2.1)", () => {
    const bs = String.fromCharCode(0x5c);
    expect(decodeOAuthState(encodeOAuthState("abc", `/${bs}evil.com`))?.next).toBe("/dashboard");
    expect(decodeOAuthState(encodeOAuthState("abc", "//evil.com"))?.next).toBe("/dashboard");
    // A legal same-origin path still round-trips.
    expect(decodeOAuthState(encodeOAuthState("abc", "/dashboard/x?y=1#z"))?.next).toBe("/dashboard/x?y=1#z");
  });

  it("matches only an exact state", () => {
    expect(stateMatches("abc", "abc")).toBe(true);
    expect(stateMatches("abc", "abd")).toBe(false);
    expect(stateMatches("abc", "ab")).toBe(false);
    expect(stateMatches("", "")).toBe(false);
    expect(stateMatches(null, "abc")).toBe(false);
    expect(stateMatches("abc", undefined)).toBe(false);
  });
});

describe("cookieOptions", () => {
  it("is httpOnly and lax everywhere, and secure only over https", () => {
    expect(cookieOptions(60, "https://x402git.com")).toEqual({ httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 60 });
    expect(cookieOptions(60, "http://localhost:3000").secure).toBe(false);
  });
});
