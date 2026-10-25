import { afterEach, describe, expect, it } from "vitest";
import { resetDb, setDb } from "@/lib/db";
import { GET } from "./route";

/** The one query this route makes: `from("creator").select("id").limit(1)`. */
function stubDb(result: { error: unknown }) {
  return { from: () => ({ select: () => ({ limit: async () => result }) }) } as never;
}

afterEach(() => resetDb());

describe("GET /api/health", () => {
  it("is ok when the database answers", async () => {
    setDb(stubDb({ error: null }));
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.checks).toEqual({ database: "ok" });
    expect(typeof body.latency_ms).toBe("number");
  });

  it("is degraded, not down, when it cannot", async () => {
    setDb(stubDb({ error: { message: "connection refused" } }));
    const body = await (await GET()).json();
    expect(body.status).toBe("degraded");
    expect(body.checks.database).toBe("unreachable");
  });

  it("still answers 200 when the client throws rather than returning an error", async () => {
    setDb({
      from: () => {
        throw new Error("boom");
      },
    } as never);
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("degraded");
  });
});
