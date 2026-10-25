import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnv } from "@/lib/env";
import { requireCron } from "./cron";

/** A request with an optional Authorization bearer. */
function req(bearer?: string): Request {
  return new Request("https://x402git.com/api/cron/sweep", {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
}

const savedEnv = { ...process.env };
// `NODE_ENV` is typed read-only; the test genuinely needs to flip it at runtime.
const mutableEnv = process.env as Record<string, string | undefined>;

beforeEach(() => {
  delete process.env.CRON_SECRET;
  delete process.env.VERCEL;
  mutableEnv.NODE_ENV = "test";
  resetEnv();
});

afterEach(() => {
  // Restore the process env exactly as it was.
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  resetEnv();
});

describe("requireCron (W2.3)", () => {
  it("fails closed in production when CRON_SECRET is unset (VERCEL=1)", () => {
    process.env.VERCEL = "1";
    resetEnv();
    expect(() => requireCron(req())).toThrow(expect.objectContaining({ code: "invalid_key" }));
  });

  it("fails closed in production when CRON_SECRET is unset (NODE_ENV=production)", () => {
    mutableEnv.NODE_ENV = "production";
    resetEnv();
    expect(() => requireCron(req())).toThrow(expect.objectContaining({ code: "invalid_key" }));
  });

  it("skips the check outside production when CRON_SECRET is unset (dev convenience)", () => {
    // Neither VERCEL nor NODE_ENV=production: a local `next dev` can run the job by hand.
    expect(() => requireCron(req())).not.toThrow();
  });

  it("still enforces the bearer when CRON_SECRET is set, even in production", () => {
    process.env.VERCEL = "1";
    process.env.CRON_SECRET = "s3cret";
    resetEnv();
    expect(() => requireCron(req("s3cret"))).not.toThrow();
    expect(() => requireCron(req("wrong"))).toThrow(expect.objectContaining({ code: "invalid_key" }));
    expect(() => requireCron(req())).toThrow(expect.objectContaining({ code: "invalid_key" }));
  });
});
