import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnv } from "@/lib/env";
import { INDEXNOW_ENDPOINT, notifyIndexNow } from "./indexnow";

describe("IndexNow (lib/indexnow.ts)", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = "https://x402git.test";
    resetEnv();
  });
  afterEach(() => {
    delete process.env.INDEXNOW_KEY;
    resetEnv();
    vi.restoreAllMocks();
  });

  it("is skipped without a key, and never calls out", async () => {
    const fetchMock = vi.fn();
    expect(await notifyIndexNow(["/adrian/humanizer"], { fetch: fetchMock as unknown as typeof fetch })).toEqual({
      status: "skipped",
      reason: "INDEXNOW_KEY is not set",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the host, the key, its location and absolute URLs", async () => {
    process.env.INDEXNOW_KEY = "k".repeat(32);
    resetEnv();
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));

    const result = await notifyIndexNow(["/adrian/humanizer", "bea/thing"], { fetch: fetchMock as unknown as typeof fetch });
    expect(result).toEqual({ status: "sent", urls: ["https://x402git.test/adrian/humanizer", "https://x402git.test/bea/thing"] });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(INDEXNOW_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      host: "x402git.test",
      key: "k".repeat(32),
      keyLocation: `https://x402git.test/${"k".repeat(32)}.txt`,
      urlList: ["https://x402git.test/adrian/humanizer", "https://x402git.test/bea/thing"],
    });
  });

  it("reports a refusal and a network failure without throwing", async () => {
    process.env.INDEXNOW_KEY = "k".repeat(32);
    resetEnv();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const refused = vi.fn(async () => new Response("bad key", { status: 403 }));
    expect(await notifyIndexNow(["/a/b"], { fetch: refused as unknown as typeof fetch })).toEqual({ status: "failed", reason: "IndexNow answered 403" });

    const down = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    expect(await notifyIndexNow(["/a/b"], { fetch: down as unknown as typeof fetch })).toEqual({ status: "failed", reason: "ECONNRESET" });
  });
});
