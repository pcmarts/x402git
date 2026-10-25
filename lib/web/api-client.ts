/**
 * lib/web/api-client.ts — how the dashboard mutates anything.
 *
 * D9: the web app is a client of the API. Every button on the dashboard that changes
 * state does it by calling the same public creator endpoint an agent would call, over
 * HTTP, with a `Bearer` key. Not by importing the handler, not by writing to the
 * database — because a route that only the website's own imports exercise is a route
 * that will quietly stop matching its OpenAPI document.
 *
 * The key is the *session's* own `x4s_live_…` (D14, FR-55), never the creator's agent
 * key: `requireCreator` accepts either kind, so nothing here changes shape, but the
 * credential the browser holds is now one that signing out can revoke.
 *
 * The cost is one loopback request per form submission. That is the point: if the API
 * is broken, the website is broken, and we find out on the first click rather than at
 * launch.
 */

import { appUrl } from "@/lib/env";
import { type ErrorCode, ERRORS } from "@/lib/errors";

export type ApiFailure = {
  ok: false;
  status: number;
  code: ErrorCode | "unreachable";
  message: string;
  details?: unknown;
};

export type ApiSuccess<T> = { ok: true; status: number; data: T };

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

export type CallOptions = {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  apiKey: string;
  body?: unknown;
  /** Injected in tests. Defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
};

/**
 * Call a creator route. Never throws for an API-level failure: a 409 with `blocking[]`
 * is information the page has to render, not an exception, and a page that threw on it
 * would lose the reasons.
 */
export async function creatorApi<T = unknown>(options: CallOptions): Promise<ApiResult<T>> {
  const { method, path, apiKey, body, fetchImpl = fetch } = options;
  const url = path.startsWith("http") ? path : `${appUrl()}${path}`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch (e) {
    return {
      ok: false,
      status: 0,
      code: "unreachable",
      message: `The API did not respond: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (response.ok) return { ok: true, status: response.status, data: parsed as T };

  const errorBody = (parsed ?? {}) as { code?: string; message?: string; details?: unknown };
  const code = (errorBody.code && errorBody.code in ERRORS ? errorBody.code : "internal") as ErrorCode;
  return {
    ok: false,
    status: response.status,
    code,
    message: errorBody.message ?? ERRORS[code].message,
    details: errorBody.details,
  };
}

/** `{ blocking: [...] }` off a 409 `listing_not_ready`, when the route sent one. */
export function blockingFrom(failure: ApiFailure): string[] {
  const details = failure.details as { blocking?: unknown } | null | undefined;
  if (!details || !Array.isArray(details.blocking)) return [];
  return details.blocking.filter((b): b is string => typeof b === "string");
}
