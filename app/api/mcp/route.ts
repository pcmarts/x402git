/**
 * /api/mcp — the buy-side MCP server over Streamable HTTP (FR-31, §9).
 *
 * Stateless: a fresh `McpServer` and transport per request, `sessionIdGenerator:
 * undefined`, so nothing is held between invocations of a serverless function that may
 * not be the same instance twice. `enableJsonResponse` makes a `tools/call` a plain
 * JSON response instead of an SSE stream, which is what a request/response function can
 * actually finish.
 *
 * `POST` carries every JSON-RPC message. `GET` is 405 (AGENT-3): it is the method that
 * would open a server→client notification stream, a stateless server has nothing to
 * send on one, and the transport's answer was a stream held open on keepalives until
 * the platform killed the function. The Streamable HTTP spec lets a server that offers
 * no such stream answer 405, and the reference client reads that as "no stream", not as
 * an error. `DELETE` ends a session; there is none, so the transport's own reply stands.
 *
 * What one POST may cost is bounded before any of it runs (AGENT-2): the body is capped
 * at `MAX_BODY_BYTES`, a JSON-RPC batch at `MAX_BATCH` messages, and the rate limiter is
 * charged one token per message rather than one per HTTP request. A batch the bucket
 * cannot afford in full is refused whole; nothing in it is executed.
 *
 * Point an agent at it with:
 *
 *   npx @modelcontextprotocol/inspector --transport http --server-url https://x402git.com/api/mcp
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { NextRequest } from "next/server";
import { clientIp, enforceLimit, hitLimit, LIMITS } from "@/lib/auth/rate-limit";
import { ApiError, handle } from "@/lib/errors";
import { buildMcpServer } from "@/lib/mcp/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 64 KiB. The largest legitimate message is a `purchase` call carrying a signed payment
 * payload, a few kilobytes; a full batch of them still fits.
 */
const MAX_BODY_BYTES = 64 * 1024;

/** The most JSON-RPC messages one POST may carry. Each one costs a rate-limit token. */
const MAX_BATCH = 10;

/**
 * `Mcp-Session-Id` has to be both sendable and readable by a browser client, and
 * `MCP-Protocol-Version` travels on every request after initialize. The origin is `*`
 * because every tool authenticates per call — a wallet signature, a payment
 * authorization — and none of them trusts an ambient credential, so there is no cookie
 * for a hostile page to ride.
 *
 * `GET` stays in the allowed methods although it is always 405: a browser client's GET
 * carries `MCP-Protocol-Version`, so it is preflighted, and a preflight that refused GET
 * would turn the 405 the client knows how to read into a network error it does not.
 */
const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  "access-control-expose-headers": "Mcp-Session-Id, MCP-Protocol-Version",
  "access-control-max-age": "86400",
};

/**
 * A JSON-RPC error with no `id`, the shape the transport itself uses for a request it
 * refuses before reading any message: -32000 for a transport-level refusal, -32600 for
 * a body that is not an acceptable request.
 */
function rpcError(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function tooLarge(): Response {
  return rpcError(413, -32000, `Payload Too Large: an MCP request body may be at most ${MAX_BODY_BYTES} bytes.`);
}

/**
 * The body as text, or `null` as soon as it passes `max` bytes. Measured as it is read:
 * the caller checks `Content-Length` first, but a chunked request has none and a client
 * can send one that lies.
 */
async function readBounded(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Charge `cost` tokens to the §9 `resource` bucket, all or nothing. A single message is
 * exactly the call it always was. A batch takes one hit per message, and if any of them
 * lands over the limit the whole batch is refused. The hits it took stay counted, as a
 * refused single request's does: the counter is a fixed window, not a reservation.
 */
async function charge(ip: string, cost: number): Promise<void> {
  if (cost <= 1) {
    await enforceLimit("resource", ip);
    return;
  }
  const results = await Promise.all(Array.from({ length: cost }, () => hitLimit("resource", ip)));
  const refused = results.filter((r) => !r.allowed);
  if (refused.length === 0) return;
  const { max, windowSec } = LIMITS.resource;
  throw new ApiError("rate_limited", {
    message: `Too many requests. Each message in a JSON-RPC batch counts as one request; this batch of ${cost} does not fit in the ${max} per ${windowSec}s this route allows per IP, so none of it was run.`,
    retryAfterSeconds: Math.max(...refused.map((r) => r.retryAfterSeconds)),
  });
}

/** `handle` turns the rate limiter's throw into the §9 error body; CORS is added after. */
const serve = handle(async (req: NextRequest): Promise<Response> => {
  let parsedBody: unknown;
  let forward: Request = req;
  let cost = 1;

  if (req.method === "POST") {
    const declared = req.headers.get("content-length")?.trim();
    if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_BODY_BYTES) return tooLarge();

    const text = await readBounded(req, MAX_BODY_BYTES);
    if (text === null) return tooLarge();

    try {
      parsedBody = JSON.parse(text);
    } catch {
      // Not JSON. Hand the transport the same bytes and let it refuse them in its own
      // order — Accept, then Content-Type, then the parse error — exactly as before.
      forward = new Request(req.url, { method: req.method, headers: req.headers, body: text });
    }

    if (Array.isArray(parsedBody)) {
      if (parsedBody.length > MAX_BATCH) {
        return rpcError(400, -32600, `Invalid Request: a JSON-RPC batch may carry at most ${MAX_BATCH} messages; this one has ${parsedBody.length}.`);
      }
      cost = Math.max(1, parsedBody.length);
    }
  }

  // §9: the `resource` bucket, 60/min. An MCP client has no address until it calls a
  // tool, so the bucket is the IP.
  await charge(clientIp(req), cost);

  // The tools that move money re-check FR-38 themselves; the server carries the geo.
  const server = buildMcpServer(req);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);

  // In JSON mode a POST or DELETE response is complete when `handleRequest` resolves,
  // so closing here frees the transport.
  const res = await transport.handleRequest(forward, parsedBody === undefined ? undefined : { parsedBody });
  await server.close();
  return res;
});

function withCorsHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [name, value] of Object.entries(CORS)) headers.set(name, value);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function withCors(req: NextRequest): Promise<Response> {
  return withCorsHeaders(await serve(req));
}

/**
 * AGENT-3. No rate-limit token and no transport: the answer is a constant. `Allow`
 * names the methods this route still serves; OPTIONS is only the preflight.
 */
export function GET(): Response {
  return withCorsHeaders(
    rpcError(405, -32000, "Method Not Allowed: this server is stateless and offers no server-to-client stream. Send JSON-RPC with POST.", {
      allow: "POST, DELETE",
    }),
  );
}

export const POST = withCors;
export const DELETE = withCors;

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}
