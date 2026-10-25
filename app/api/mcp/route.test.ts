/**
 * app/api/mcp/route.test.ts — FR-31 over the wire.
 *
 * `lib/mcp/server.test.ts` covers what the tools do. This covers that they are reachable
 * as JSON-RPC over Streamable HTTP: a real `initialize` handshake, `tools/list` naming
 * the six tools (four with their "wraps" descriptions), and a `tools/call` that comes back
 * shaped as the x402 MCP transport's structured 402. It also covers what one request may
 * cost (AGENT-2: the body and batch caps, one token per message) and that GET is a 405,
 * never a stream (AGENT-3).
 */

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, resetDb, setDb } from "@/lib/db";
import { resetEnv } from "@/lib/env";
import { TOOL_NAMES } from "@/lib/mcp/server";
import { resetScreeningCache } from "@/lib/screening";
import { seedListing } from "@/lib/test/fixtures";
import { makeMockDb } from "@/lib/test/mock-db";
import { GET, OPTIONS, POST } from "./route";

let mock: ReturnType<typeof makeMockDb>;

beforeEach(() => {
  mock = makeMockDb();
  setDb(mock.client as unknown as Db);
  resetScreeningCache();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
  process.env.NEXT_PUBLIC_APP_URL = "https://x402git.test";
  process.env.PLATFORM_RECEIVING_ADDRESS = "0x1111111111111111111111111111111111111111";
  process.env.X402_NETWORK = "base-sepolia";
  resetEnv();
});

afterEach(() => {
  resetDb();
  resetScreeningCache();
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.PLATFORM_RECEIVING_ADDRESS;
  delete process.env.X402_NETWORK;
  resetEnv();
});

const PROTOCOL_VERSION = "2025-06-18";

/** One JSON-RPC request, as a Streamable HTTP client sends it. */
async function rpc(method: string, params: Record<string, unknown> = {}, id: number | string = 1) {
  const req = new NextRequest("https://x402git.test/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
      "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 250) + 1}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const res = await POST(req);
  return { res, body: await res.json() };
}

describe("POST /api/mcp — JSON-RPC over Streamable HTTP", () => {
  it("initializes and names the server", async () => {
    const { res, body } = await rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "test-agent", version: "0.0.0" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(body.result.serverInfo.name).toBe("git-x402");
    // Directories build the listing page from these three, not from the publish call.
    expect(body.result.serverInfo.description).toBeTruthy();
    expect(body.result.serverInfo.websiteUrl).toMatch(/^https?:\/\//);
    expect(body.result.serverInfo.icons[0]).toMatchObject({ mimeType: "image/png", sizes: ["512x512"] });
    expect(body.result.capabilities.tools).toBeDefined();
    // Stateless (FR-31, §9): no session to keep across serverless invocations.
    expect(res.headers.get("mcp-session-id")).toBeNull();
  });

  it("lists the six tools, the four wrappers each documented as wrapping their route", async () => {
    const { res, body } = await rpc("tools/list", {}, 2);

    expect(res.status).toBe(200);
    const tools: { name: string; description: string }[] = body.result.tools;
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());

    const description = (name: string) => tools.find((t) => t.name === name)?.description ?? "";
    expect(description("get_listing")).toContain("Wraps `GET /api/label/:owner/:slug`");
    expect(description("check_version")).toContain("Wraps `GET /api/v/:owner/:slug`");
    expect(description("purchase")).toContain("Wraps `GET /api/r/:owner/:slug`");
    expect(description("fetch_release")).toContain("Wraps `GET /api/r/:owner/:slug/v/:version`");
  });

  it("calls a tool and returns the transport spec's structured 402", async () => {
    seedListing(mock, { releases: [{ version: "1.2.0" }] });

    const { res, body } = await rpc("tools/call", { name: "purchase", arguments: { owner: "adrian", slug: "humanizer" } }, 3);

    expect(res.status).toBe(200);
    // FR-31 as amended: `isError: true` with `PaymentRequired` as structured content,
    // mirrored in `_meta["x402/error"]` for the Cloudflare Agents SDK client.
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent.x402Version).toBe(2);
    expect(body.result.structuredContent.accepts[0].maxAmountRequired).toBe("9000000");
    expect(body.result._meta["x402/error"].accepts).toHaveLength(1);
    expect(mock.rows("purchase")).toHaveLength(0);
  });

  it("answers CORS preflight with the session header exposed", async () => {
    const res = OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toContain("Mcp-Session-Id");
    expect(res.headers.get("access-control-expose-headers")).toContain("Mcp-Session-Id");
  });

  it("puts CORS headers on the JSON-RPC response too", async () => {
    const { res } = await rpc("tools/list", {}, 4);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("keeps refusing a body that is not JSON with the transport's own parse error", async () => {
    const req = new NextRequest("https://x402git.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-real-ip": "10.1.0.1" },
      body: "{not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32700);
  });

  it("keeps the transport's order of refusals: a bad Accept is 406 before the body is judged", async () => {
    const req = new NextRequest("https://x402git.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "x-real-ip": "10.1.0.2" },
      body: "{not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(406);
  });
});

/**
 * AGENT-3. The stateless server has no server→client stream to offer, and the spec lets
 * it say so with 405. Before, the transport opened an SSE stream it never wrote to and
 * kept it alive until the platform killed the function.
 */
describe("GET /api/mcp — 405, never a stream", () => {
  it("is 405 with Allow naming POST, and the body is JSON rather than an event stream", async () => {
    // The handler takes no request: what a client sends cannot change the answer.
    const res = GET();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("POST");
    expect(res.headers.get("allow")).not.toContain("GET");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-type")).not.toContain("text/event-stream");
  });

  it("answers with a JSON-RPC error a browser client can read", async () => {
    const res = GET();
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = await res.json();
    expect(body).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32000 } });
    expect(body.error.message).toContain("POST");
  });

  it("costs nothing: no rate-limit hit, no database", async () => {
    const from = vi.spyOn(mock.client, "from");
    GET();
    expect(mock.rpcCalls).toHaveLength(0);
    expect(from).not.toHaveBeenCalled();
  });

  it("still lets a browser preflight a GET, so the client sees the 405 rather than a CORS failure", () => {
    expect(OPTIONS().headers.get("access-control-allow-methods")).toContain("GET");
  });
});

/**
 * AGENT-2. One HTTP request used to take one rate-limit token and then hand the
 * transport an uncapped JSON-RPC batch: 20 `search_listings` calls for one token.
 */
describe("POST /api/mcp — what one request may cost (AGENT-2)", () => {
  const IP = "10.9.9.9";
  const HEADERS = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL_VERSION,
    "x-real-ip": IP,
  };

  const listCall = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/list", params: {} });
  const batch = (n: number) => Array.from({ length: n }, (_, i) => listCall(i + 1));
  const post = (body: BodyInit, headers: Record<string, string> = {}, init: Record<string, unknown> = {}) =>
    POST(new NextRequest("https://x402git.test/api/mcp", { method: "POST", headers: { ...HEADERS, ...headers }, body, ...init }));
  const hits = () => mock.rpcCalls.filter((c) => c.name === "rate_limit_hit").length;

  it("refuses a body whose Content-Length is over 64 KiB, before reading it or charging a token", async () => {
    const res = await post(JSON.stringify(listCall(1)), { "content-length": String(64 * 1024 + 1) });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32000 } });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(hits()).toBe(0);
  });

  it("refuses an oversized body that declares no Content-Length", async () => {
    const big = new TextEncoder().encode(JSON.stringify({ ...listCall(1), params: { pad: "x".repeat(70 * 1024) } }));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < big.length; i += 8192) controller.enqueue(big.subarray(i, i + 8192));
        controller.close();
      },
    });
    const res = await post(stream, {}, { duplex: "half" });
    expect(res.status).toBe(413);
    expect(hits()).toBe(0);
  });

  it("refuses an oversized body whose Content-Length lies", async () => {
    const res = await post(JSON.stringify({ ...listCall(1), params: { pad: "x".repeat(70 * 1024) } }), { "content-length": "64" });
    expect(res.status).toBe(413);
    expect(hits()).toBe(0);
  });

  it("refuses a batch of more than 10 messages whole, before charging or running any of it", async () => {
    const from = vi.spyOn(mock.client, "from");
    const res = await post(JSON.stringify(batch(11)));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32600 } });
    expect(body.error.message).toContain("10");
    expect(hits()).toBe(0);
    expect(from).not.toHaveBeenCalled();
  });

  it("runs a batch of up to 10 and charges one token per message", async () => {
    const res = await post(JSON.stringify(batch(3)));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.map((r: { id: number }) => r.id).sort()).toEqual([1, 2, 3]);
    expect(hits()).toBe(3);
    expect(mock.rows("rate_limit").find((r) => r.bucket === `resource:${IP}`)?.count).toBe(3);
  });

  it("refuses a batch the bucket cannot afford in full, and runs none of it", async () => {
    // 55 of 60 already spent this minute: five more fit, six do not.
    mock.seed("rate_limit", [{ bucket: `resource:${IP}`, count: 55, window_start: new Date().toISOString() }]);
    const from = vi.spyOn(mock.client, "from");

    const searches = Array.from({ length: 6 }, (_, i) => ({
      jsonrpc: "2.0",
      id: i + 1,
      method: "tools/call",
      params: { name: "search_listings", arguments: { query: "" } },
    }));
    const res = await post(JSON.stringify(searches));

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("rate_limited");
    expect(body.message).toContain("none of it was run");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    // Nothing reached a tool: the only database traffic was the counter.
    expect(from).not.toHaveBeenCalled();
  });

  it("lets a batch through that exactly fits the remaining allowance, and runs all of it", async () => {
    mock.seed("rate_limit", [{ bucket: `resource:${IP}`, count: 55, window_start: new Date().toISOString() }]);
    const from = vi.spyOn(mock.client, "from");
    const searches = Array.from({ length: 5 }, (_, i) => ({
      jsonrpc: "2.0",
      id: i + 1,
      method: "tools/call",
      params: { name: "search_listings", arguments: { query: "" } },
    }));
    const res = await post(JSON.stringify(searches));
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(5);
    // The control for the refusal above: a batch that runs does reach the database.
    expect(from).toHaveBeenCalled();
  });

  it("charges a single message exactly one token, as before", async () => {
    const res = await post(JSON.stringify(listCall(7)));
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(7);
    expect(hits()).toBe(1);
  });

  it("refuses a single message over the limit with the same 429 as before", async () => {
    mock.seed("rate_limit", [{ bucket: `resource:${IP}`, count: 60, window_start: new Date().toISOString() }]);
    const res = await post(JSON.stringify(listCall(8)));
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe("rate_limited");
  });
});
